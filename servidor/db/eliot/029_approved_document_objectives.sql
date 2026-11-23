-- 029: Explicitly consented immutable objective snapshots. Apply ONCE after 028.
BEGIN;
SET LOCAL ROLE eliot_migrator;
ALTER TABLE eliot.ai_document_jobs
 ADD COLUMN document_mode text NOT NULL DEFAULT 'standard_v1',
 ADD COLUMN plan_id_snapshot uuid,
 ADD COLUMN plan_objective_snapshot text,
 ADD CONSTRAINT fk_job_objective_plan FOREIGN KEY(organization_id,plan_id_snapshot) REFERENCES eliot.ai_document_plans(organization_id,id),
 ADD CONSTRAINT ck_job_objective_snapshot CHECK(
 (document_mode='standard_v1' AND plan_id_snapshot IS NULL AND plan_objective_snapshot IS NULL)
 OR (document_mode='objective_v1' AND plan_id_snapshot IS NOT NULL AND plan_objective_snapshot IS NOT NULL AND length(trim(plan_objective_snapshot)) BETWEEN 10 AND 1000));
CREATE FUNCTION eliot.guard_document_objective_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF (NEW.document_mode,NEW.plan_id_snapshot,NEW.plan_objective_snapshot) IS DISTINCT FROM
    (OLD.document_mode,OLD.plan_id_snapshot,OLD.plan_objective_snapshot)
 AND (OLD.document_mode<>'standard_v1' OR OLD.state<>'queued' OR NEW.state<>'queued') THEN
  RAISE EXCEPTION 'Objective snapshot immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION eliot.guard_document_objective_snapshot() FROM PUBLIC;
CREATE TRIGGER guard_document_objective_snapshot BEFORE UPDATE OF document_mode,plan_id_snapshot,plan_objective_snapshot ON eliot.ai_document_jobs
FOR EACH ROW EXECUTE FUNCTION eliot.guard_document_objective_snapshot();

CREATE FUNCTION eliot.owner_enqueue_objective_document_job(p_org uuid,p_task uuid,p_worker uuid,p_lease uuid,p_approval uuid,p_key uuid,p_plan uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; existed boolean; j eliot.ai_document_jobs; p eliot.ai_document_plans; result_id uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 -- Same lock order as planned enqueue/control, and retain original owner checks.
 PERFORM 1 FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 SELECT * INTO p FROM eliot.ai_document_plans WHERE organization_id=p_org AND task_id=p_task AND id=p_plan FOR UPDATE;
 SELECT EXISTS(SELECT 1 FROM eliot.ai_document_jobs WHERE organization_id=p_org AND request_key=p_key) INTO existed;
 result_id:=eliot.owner_enqueue_planned_document_job(p_org,p_task,p_worker,p_lease,p_approval,p_key,p_plan);
 SELECT * INTO j FROM eliot.ai_document_jobs WHERE organization_id=p_org AND id=result_id FOR UPDATE;
 IF existed THEN
  IF j.document_mode<>'objective_v1' OR j.plan_id_snapshot IS DISTINCT FROM p_plan OR j.plan_objective_snapshot IS DISTINCT FROM p.objective THEN
   RAISE EXCEPTION 'Cannot retrofit objective consent' USING ERRCODE='55000'; END IF;
  RETURN result_id;
 END IF;
 IF j.state<>'queued' OR p.id IS NULL OR p.job_id IS NOT NULL THEN RAISE EXCEPTION 'Objective job unavailable' USING ERRCODE='55000'; END IF;
 UPDATE eliot.ai_document_jobs SET document_mode='objective_v1',plan_id_snapshot=p_plan,plan_objective_snapshot=p.objective
 WHERE organization_id=p_org AND id=result_id;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,p_task,p_worker,'reported','Approved documentary objective snapshot for plan '||p_plan::text||'; job '||result_id::text);
 RETURN result_id;
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_enqueue_objective_document_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_enqueue_objective_document_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid) TO eliot_identity;

CREATE FUNCTION eliot.worker_take_document_job_with_objective(p_org uuid)
RETURNS TABLE(job_id uuid,claim_token uuid,task_title text,repository text,path text,ref text,sha text,objective_context jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE c record; j eliot.ai_document_jobs;
BEGIN
 FOR c IN SELECT * FROM eliot.worker_take_document_job(p_org) LOOP
  SELECT * INTO j FROM eliot.ai_document_jobs q WHERE q.organization_id=p_org AND q.id=c.job_id
   AND q.claim_token=c.claim_token AND q.claimed_by=session_user::name;
  IF NOT FOUND THEN RAISE EXCEPTION 'Worker context unavailable' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT c.job_id,c.claim_token,c.task_title,c.repository,c.path,c.ref,c.sha,
   CASE WHEN j.document_mode='objective_v1' THEN jsonb_build_object('mode',j.document_mode,'organization_id',p_org,
    'job_id',j.id,'plan_id',j.plan_id_snapshot,'objective',j.plan_objective_snapshot)
   ELSE jsonb_build_object('mode','standard_v1') END;
 END LOOP;
END $fn$;
REVOKE ALL ON FUNCTION eliot.worker_take_document_job_with_objective(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.worker_take_document_job_with_objective(uuid) TO eliot_execution_worker;
-- Old workers must not silently claim objective jobs without reading their context.
REVOKE EXECUTE ON FUNCTION eliot.worker_take_document_job(uuid) FROM eliot_execution_worker;
CREATE OR REPLACE FUNCTION eliot.my_document_plans(p_org uuid,p_task uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object(
  'id',p.id,'task_id',p.task_id,'worker_id',p.worker_id,'objective',p.objective,'request_key',p.request_key,
  'repository',p.source_repo,'path',p.source_path,'ref',p.source_ref,'sha',p.source_sha,
  'version',p.plan_version,'max_jobs',p.max_jobs,'estimated_token_units',p.estimated_token_units,'steps',p.steps,
  'created_at',p.created_at,'owner_is_creator',p.created_by=actor,
  'control_available',true,'control_state',p.control_state,'control_revision',p.control_revision,
  'scope_current',t.status='pending' AND t.updated_at=p.task_updated_at AND t.assignee_worker_id=p.worker_id
   AND w.department_id=t.department_id AND w.operating_state='idle',
  'analysis_mode',j.document_mode,'objective_snapshot',j.plan_objective_snapshot,'objective_plan_id',j.plan_id_snapshot,
  'job_id',p.job_id,'run_id',j.run_id,'job_state',j.state,'source_verified_at',j.source_verified_at,
  'review_decision',r.decision,'task_status',t.status)
 FROM eliot.ai_document_plans p JOIN eliot.ai_tasks t ON t.organization_id=p.organization_id AND t.id=p.task_id
 JOIN eliot.ai_workers w ON w.organization_id=p.organization_id AND w.id=p.worker_id
 LEFT JOIN eliot.ai_document_jobs j ON j.organization_id=p.organization_id AND j.id=p.job_id
 LEFT JOIN eliot.ai_document_work_reviews r ON r.organization_id=j.organization_id AND r.run_id=j.run_id
 WHERE p.organization_id=p_org AND p.task_id=p_task ORDER BY p.created_at DESC,p.id DESC LIMIT 20;
END $fn$;


COMMIT;

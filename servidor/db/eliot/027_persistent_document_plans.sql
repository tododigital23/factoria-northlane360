-- 027: Persist one-document plans and bind their single job atomically.
-- Apply ONCE as administrator after 026. Creates no LOGIN or provider permission.
BEGIN;
SET LOCAL ROLE eliot_migrator;
ALTER TABLE eliot.ai_document_jobs ADD CONSTRAINT uq_document_job_plan_scope UNIQUE(organization_id,task_id,id);
CREATE TABLE eliot.ai_document_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 created_by uuid NOT NULL,
 request_key uuid NOT NULL,
 objective text NOT NULL CHECK(length(trim(objective)) BETWEEN 10 AND 1000),
 task_updated_at timestamptz NOT NULL,
 source_repo text NOT NULL CHECK(length(source_repo) BETWEEN 3 AND 210),
 source_path text NOT NULL CHECK(length(source_path) BETWEEN 6 AND 400 AND source_path LIKE 'docs/%'
  AND source_path !~ '(^|/)\.\.(/|$)' AND source_path NOT LIKE '%//%'),
 source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 160),
 source_sha text NOT NULL CHECK(source_sha ~ '^[0-9a-f]{40}$'),
 plan_version text NOT NULL DEFAULT 'document_plan_v1' CHECK(plan_version='document_plan_v1'),
 max_jobs integer NOT NULL DEFAULT 1 CHECK(max_jobs=1),
 estimated_token_units integer NOT NULL DEFAULT 2500 CHECK(estimated_token_units=2500),
 steps jsonb NOT NULL DEFAULT '[{"id":"verify_source","responsible":"worker","depends_on":[]},{"id":"analyze_document","responsible":"worker","depends_on":["verify_source"]},{"id":"review_result","responsible":"owner","depends_on":["analyze_document"]}]'::jsonb
 CHECK(steps='[{"id":"verify_source","responsible":"worker","depends_on":[]},{"id":"analyze_document","responsible":"worker","depends_on":["verify_source"]},{"id":"review_result","responsible":"owner","depends_on":["analyze_document"]}]'::jsonb),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 job_id uuid,
 CONSTRAINT fk_document_plan_task FOREIGN KEY(task_id,organization_id) REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_document_plan_worker FOREIGN KEY(worker_id,organization_id) REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_document_plan_actor FOREIGN KEY(organization_id,created_by) REFERENCES eliot.organization_memberships(organization_id,user_id),
 CONSTRAINT fk_document_plan_job FOREIGN KEY(organization_id,task_id,job_id) REFERENCES eliot.ai_document_jobs(organization_id,task_id,id),
 CONSTRAINT uq_document_plan_request UNIQUE(organization_id,request_key),
 CONSTRAINT uq_document_plan_job UNIQUE(organization_id,job_id)
);
CREATE INDEX idx_document_plans_task ON eliot.ai_document_plans(organization_id,task_id,created_at DESC);
ALTER TABLE eliot.ai_document_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_document_plans ON eliot.ai_document_plans FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_create_document_plan(p_org uuid,p_task uuid,p_worker uuid,p_objective text,p_repo text,p_path text,p_ref text,p_sha text,p_key uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; t eliot.ai_tasks; saved eliot.ai_document_plans; result_id uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_worker IS NULL OR p_objective IS NULL OR length(trim(p_objective)) NOT BETWEEN 10 AND 1000
 OR p_repo IS NULL OR length(p_repo) NOT BETWEEN 3 AND 210 OR p_path IS NULL OR length(p_path) NOT BETWEEN 6 AND 400
 OR p_path NOT LIKE 'docs/%' OR p_path~'(^|/)\.\.(/|$)' OR p_path LIKE '%//%'
 OR p_ref IS NULL OR length(p_ref) NOT BETWEEN 1 AND 160 OR p_sha IS NULL OR p_sha!~'^[0-9a-f]{40}$'
 THEN RAISE EXCEPTION 'Invalid plan scope' USING ERRCODE='22023'; END IF;
 SELECT * INTO t FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task unavailable' USING ERRCODE='22023'; END IF;
 SELECT * INTO saved FROM eliot.ai_document_plans WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF saved.task_id IS DISTINCT FROM p_task OR saved.worker_id IS DISTINCT FROM p_worker OR saved.created_by IS DISTINCT FROM actor
  OR saved.objective IS DISTINCT FROM trim(p_objective) OR saved.source_repo IS DISTINCT FROM p_repo OR saved.source_path IS DISTINCT FROM p_path
  OR saved.source_ref IS DISTINCT FROM p_ref OR saved.source_sha IS DISTINCT FROM p_sha THEN
   RAISE EXCEPTION 'Conflicting plan retry' USING ERRCODE='22023'; END IF;
  RETURN saved.id;
 END IF;
 IF t.status<>'pending' OR t.assignee_worker_id IS DISTINCT FROM p_worker
 OR NOT EXISTS(SELECT 1 FROM eliot.ai_workers WHERE organization_id=p_org AND id=p_worker AND department_id=t.department_id AND operating_state='idle')
 OR eliot.task_has_unconfirmed_execution(p_org,p_task) THEN
  RAISE EXCEPTION 'Task not eligible for plan' USING ERRCODE='55000'; END IF;
 INSERT INTO eliot.ai_document_plans(organization_id,task_id,worker_id,created_by,request_key,objective,task_updated_at,source_repo,source_path,source_ref,source_sha)
 VALUES(p_org,p_task,p_worker,actor,p_key,trim(p_objective),t.updated_at,p_repo,p_path,p_ref,p_sha) RETURNING id INTO result_id;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,p_task,p_worker,'reported','Document plan saved: '||result_id::text||'; no execution or provider approval');
 RETURN result_id;
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_create_document_plan(uuid,uuid,uuid,text,text,text,text,text,uuid) FROM PUBLIC;

CREATE FUNCTION eliot.owner_enqueue_planned_document_job(p_org uuid,p_task uuid,p_worker uuid,p_lease uuid,p_approval uuid,p_key uuid,p_plan uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; t eliot.ai_tasks; plan eliot.ai_document_plans; job eliot.ai_document_jobs; a eliot.ai_document_approvals; result_id uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO t FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task unavailable' USING ERRCODE='22023'; END IF;
 SELECT * INTO plan FROM eliot.ai_document_plans WHERE organization_id=p_org AND task_id=p_task AND id=p_plan FOR UPDATE;
 IF NOT FOUND OR plan.created_by IS DISTINCT FROM actor OR plan.worker_id IS DISTINCT FROM p_worker THEN
  RAISE EXCEPTION 'Plan unavailable' USING ERRCODE='22023'; END IF;
 IF plan.job_id IS NOT NULL THEN
  SELECT * INTO job FROM eliot.ai_document_jobs WHERE id=plan.job_id AND organization_id=p_org AND task_id=p_task;
  IF NOT FOUND OR job.request_key IS DISTINCT FROM p_key OR job.lease_id IS DISTINCT FROM p_lease
  OR job.approval_id IS DISTINCT FROM p_approval OR job.worker_id IS DISTINCT FROM p_worker OR job.requested_by IS DISTINCT FROM actor THEN
   RAISE EXCEPTION 'Plan job already assigned' USING ERRCODE='55000'; END IF;
  RETURN job.id;
 END IF;
 IF t.status<>'pending' OR t.updated_at IS DISTINCT FROM plan.task_updated_at OR t.assignee_worker_id IS DISTINCT FROM plan.worker_id
 OR eliot.task_has_unconfirmed_execution(p_org,p_task)
 OR EXISTS(SELECT 1 FROM eliot.ai_document_jobs WHERE organization_id=p_org AND request_key=p_key) THEN
  RAISE EXCEPTION 'Plan is stale or request already used' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM eliot.ai_document_approvals WHERE organization_id=p_org AND task_id=p_task AND id=p_approval FOR UPDATE;
 IF NOT FOUND OR a.worker_id IS DISTINCT FROM plan.worker_id OR a.source_repo IS DISTINCT FROM plan.source_repo
 OR a.source_path IS DISTINCT FROM plan.source_path OR a.source_ref IS DISTINCT FROM plan.source_ref OR a.source_sha IS DISTINCT FROM plan.source_sha THEN
  RAISE EXCEPTION 'Approval does not match plan' USING ERRCODE='22023'; END IF;
 result_id:=eliot.owner_enqueue_document_job(p_org,p_task,p_worker,p_lease,p_approval,p_key);
 UPDATE eliot.ai_document_plans SET job_id=result_id WHERE id=p_plan AND organization_id=p_org;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,p_task,p_worker,'progress','Document plan '||p_plan::text||' linked to job '||result_id::text);
 RETURN result_id;
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_enqueue_planned_document_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION eliot.my_document_plans(p_org uuid,p_task uuid) RETURNS SETOF jsonb
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
  'scope_current',t.status='pending' AND t.updated_at=p.task_updated_at AND t.assignee_worker_id=p.worker_id
   AND w.department_id=t.department_id AND w.operating_state='idle',
  'job_id',p.job_id,'run_id',j.run_id,'job_state',j.state,'source_verified_at',j.source_verified_at,
  'review_decision',r.decision,'task_status',t.status)
 FROM eliot.ai_document_plans p JOIN eliot.ai_tasks t ON t.organization_id=p.organization_id AND t.id=p.task_id
 JOIN eliot.ai_workers w ON w.organization_id=p.organization_id AND w.id=p.worker_id
 LEFT JOIN eliot.ai_document_jobs j ON j.organization_id=p.organization_id AND j.id=p.job_id
 LEFT JOIN eliot.ai_document_work_reviews r ON r.organization_id=j.organization_id AND r.run_id=j.run_id
 WHERE p.organization_id=p_org AND p.task_id=p_task ORDER BY p.created_at DESC,p.id DESC LIMIT 20;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_document_plans(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_create_document_plan(uuid,uuid,uuid,text,text,text,text,text,uuid),
 eliot.owner_enqueue_planned_document_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid),eliot.my_document_plans(uuid,uuid) TO eliot_identity;
COMMIT;

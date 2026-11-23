-- 028: Control only plans which have never been linked to a job.
-- Apply ONCE as administrator after 027. No provider calls or new LOGINs.
BEGIN;
SET LOCAL ROLE eliot_migrator;
ALTER TABLE eliot.ai_document_plans
 ADD COLUMN control_state text NOT NULL DEFAULT 'active' CHECK(control_state IN ('active','paused','cancelled')),
 ADD COLUMN control_revision integer NOT NULL DEFAULT 0 CHECK(control_revision>=0),
 ADD CONSTRAINT uq_document_plan_org UNIQUE(organization_id,id),
 ADD CONSTRAINT ck_document_plan_control_job CHECK(job_id IS NULL OR control_state='active');
CREATE TABLE eliot.ai_document_plan_controls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 plan_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 request_key uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('pause','resume','cancel')),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
 expected_revision integer NOT NULL CHECK(expected_revision>=0),
 result_state text NOT NULL CHECK(result_state IN ('active','paused','cancelled')),
 result_revision integer NOT NULL CHECK(result_revision=expected_revision+1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,plan_id) REFERENCES eliot.ai_document_plans(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES eliot.organization_memberships(organization_id,user_id),
 UNIQUE(organization_id,request_key),
 UNIQUE(organization_id,plan_id,result_revision)
);
ALTER TABLE eliot.ai_document_plan_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_plan_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_document_plan_controls ON eliot.ai_document_plan_controls FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_control_document_plan(p_org uuid,p_task uuid,p_plan uuid,p_action text,p_reason text,p_revision integer,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; t eliot.ai_tasks; plan eliot.ai_document_plans; prior eliot.ai_document_plan_controls; next_state text; action_id uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('pause','resume','cancel') OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 500
 OR p_revision IS NULL OR p_revision<0 OR p_key IS NULL THEN RAISE EXCEPTION 'Invalid plan control' USING ERRCODE='22023'; END IF;
 -- Same lock order as planned enqueue: task, then plan. A race has one winner.
 SELECT * INTO t FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task unavailable' USING ERRCODE='22023'; END IF;
 SELECT * INTO plan FROM eliot.ai_document_plans WHERE organization_id=p_org AND task_id=p_task AND id=p_plan FOR UPDATE;
 IF NOT FOUND OR plan.created_by IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Plan unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO prior FROM eliot.ai_document_plan_controls WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF prior.plan_id IS DISTINCT FROM p_plan OR prior.actor_id IS DISTINCT FROM actor OR prior.action IS DISTINCT FROM p_action
  OR prior.reason IS DISTINCT FROM trim(p_reason) OR prior.expected_revision IS DISTINCT FROM p_revision THEN
   RAISE EXCEPTION 'Conflicting control retry' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('action_id',prior.id,'plan_id',p_plan,'recorded_state',prior.result_state,'recorded_revision',prior.result_revision);
 END IF;
 IF plan.job_id IS NOT NULL OR plan.control_state='cancelled' OR plan.control_revision<>p_revision
 OR (p_action='pause' AND plan.control_state<>'active') OR (p_action='resume' AND plan.control_state<>'paused') THEN
  RAISE EXCEPTION 'Plan control no longer available' USING ERRCODE='55000'; END IF;
 IF p_action='resume' AND (t.status<>'pending' OR t.updated_at IS DISTINCT FROM plan.task_updated_at OR t.assignee_worker_id IS DISTINCT FROM plan.worker_id
 OR NOT EXISTS(SELECT 1 FROM eliot.ai_workers WHERE organization_id=p_org AND id=plan.worker_id AND department_id=t.department_id AND operating_state='idle')
 OR eliot.task_has_unconfirmed_execution(p_org,p_task)) THEN
  RAISE EXCEPTION 'Plan context no longer valid' USING ERRCODE='55000'; END IF;
 next_state:=CASE p_action WHEN 'pause' THEN 'paused' WHEN 'resume' THEN 'active' ELSE 'cancelled' END;
 UPDATE eliot.ai_document_plans SET control_state=next_state,control_revision=control_revision+1 WHERE organization_id=p_org AND id=p_plan;
 INSERT INTO eliot.ai_document_plan_controls(organization_id,plan_id,actor_id,request_key,action,reason,expected_revision,result_state,result_revision)
 VALUES(p_org,p_plan,actor,p_key,p_action,trim(p_reason),p_revision,next_state,p_revision+1) RETURNING id INTO action_id;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,p_task,plan.worker_id,'reported','Document plan '||p_plan::text||': '||p_action||'; control '||action_id::text||'; no dispatch');
 RETURN jsonb_build_object('action_id',action_id,'plan_id',p_plan,'recorded_state',next_state,'recorded_revision',p_revision+1);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_control_document_plan(uuid,uuid,uuid,text,text,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_control_document_plan(uuid,uuid,uuid,text,text,integer,uuid) TO eliot_identity;

CREATE OR REPLACE FUNCTION eliot.owner_enqueue_planned_document_job(p_org uuid,p_task uuid,p_worker uuid,p_lease uuid,p_approval uuid,p_key uuid,p_plan uuid)
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
 IF plan.control_state<>'active' THEN RAISE EXCEPTION 'Plan paused or cancelled' USING ERRCODE='55000'; END IF;
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
  'job_id',p.job_id,'run_id',j.run_id,'job_state',j.state,'source_verified_at',j.source_verified_at,
  'review_decision',r.decision,'task_status',t.status)
 FROM eliot.ai_document_plans p JOIN eliot.ai_tasks t ON t.organization_id=p.organization_id AND t.id=p.task_id
 JOIN eliot.ai_workers w ON w.organization_id=p.organization_id AND w.id=p.worker_id
 LEFT JOIN eliot.ai_document_jobs j ON j.organization_id=p.organization_id AND j.id=p.job_id
 LEFT JOIN eliot.ai_document_work_reviews r ON r.organization_id=j.organization_id AND r.run_id=j.run_id
 WHERE p.organization_id=p_org AND p.task_id=p_task ORDER BY p.created_at DESC,p.id DESC LIMIT 20;
END $fn$;

COMMIT;

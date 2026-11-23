-- 032: Explicit, audited reopening of a saved plan whose ONLY job finished as a known failure.
-- Apply ONCE as administrator AFTER 031, only after the PG test pipeline passes on a
-- disposable database. Creates no LOGIN, grant of provider access, approval, lease or job.
--
-- Why: 027 binds one job per plan and 030 pins the exact plan of each mission step. A step
-- whose job ended 'failed' (e.g. invalid_response) therefore blocked its mission forever:
-- the plan could not receive another job and a new plan could not join the mission.
--
-- What it does: the owner reopens the plan. The failed job, its run, approval and events
-- stay untouched; an immutable attempt row records them. The plan's job_id returns to NULL
-- and its task snapshot is re-confirmed. Nothing is dispatched: the next job still needs
-- the ordinary path (fresh lease, fresh single-use approval with consent, durable budget,
-- mission state and accepted predecessors via guard_document_mission_dispatch).
--
-- Never reopened: needs_review/uncertain outcomes, completed or cancelled jobs, jobs whose
-- source changed (the plan is pinned to that SHA: save a new plan instead), cancelled
-- plans, cancelled missions, or more than 2 reopenings per plan (3 jobs in total).
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_document_plan_attempts (
 organization_id uuid NOT NULL,
 plan_id uuid NOT NULL,
 attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 2),
 task_id uuid NOT NULL,
 failed_job_id uuid NOT NULL,
 failed_error_code text NOT NULL CHECK(length(failed_error_code) BETWEEN 1 AND 60),
 reopened_by uuid NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
 request_key uuid NOT NULL,
 reopened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,plan_id,attempt),
 CONSTRAINT uq_plan_attempt_job UNIQUE(organization_id,failed_job_id),
 CONSTRAINT uq_plan_attempt_request UNIQUE(organization_id,request_key),
 CONSTRAINT fk_plan_attempt_plan FOREIGN KEY(organization_id,plan_id) REFERENCES eliot.ai_document_plans(organization_id,id),
 CONSTRAINT fk_plan_attempt_job FOREIGN KEY(organization_id,task_id,failed_job_id) REFERENCES eliot.ai_document_jobs(organization_id,task_id,id),
 CONSTRAINT fk_plan_attempt_actor FOREIGN KEY(organization_id,reopened_by) REFERENCES eliot.organization_memberships(organization_id,user_id)
);
ALTER TABLE eliot.ai_document_plan_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_plan_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_document_plan_attempts ON eliot.ai_document_plan_attempts FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

-- Attempt history is append-only.
CREATE FUNCTION eliot.guard_document_plan_attempts_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 RAISE EXCEPTION 'Plan attempt history is immutable' USING ERRCODE='55000';
END $fn$;
REVOKE ALL ON FUNCTION eliot.guard_document_plan_attempts_immutable() FROM PUBLIC;
CREATE TRIGGER guard_document_plan_attempts_immutable BEFORE UPDATE OR DELETE ON eliot.ai_document_plan_attempts
FOR EACH ROW EXECUTE FUNCTION eliot.guard_document_plan_attempts_immutable();

-- A linked job may only be unlinked (never swapped) and only with its attempt row recorded
-- in the same transaction. Protects history even against privileged direct writes.
CREATE FUNCTION eliot.guard_document_plan_job_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF OLD.job_id IS NOT NULL AND NEW.job_id IS DISTINCT FROM OLD.job_id THEN
  IF NEW.job_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM eliot.ai_document_plan_attempts a
    WHERE a.organization_id=OLD.organization_id AND a.plan_id=OLD.id AND a.failed_job_id=OLD.job_id) THEN
   RAISE EXCEPTION 'Plan job link is immutable without an audited reopening' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION eliot.guard_document_plan_job_history() FROM PUBLIC;
CREATE TRIGGER guard_document_plan_job_history BEFORE UPDATE OF job_id ON eliot.ai_document_plans
FOR EACH ROW EXECUTE FUNCTION eliot.guard_document_plan_job_history();

CREATE FUNCTION eliot.owner_reopen_failed_document_plan(p_org uuid,p_task uuid,p_plan uuid,p_failed_job uuid,p_reason text,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_task_id uuid; t eliot.ai_tasks; plan eliot.ai_document_plans; j eliot.ai_document_jobs;
 saved eliot.ai_document_plan_attempts; v_mission uuid; v_mission_state text; next_attempt integer;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Recovery function ownership must be corrected' USING ERRCODE='55000'; END IF;
 IF p_task IS NULL OR p_plan IS NULL OR p_failed_job IS NULL OR p_key IS NULL OR p_reason IS NULL
 OR length(trim(p_reason)) NOT BETWEEN 10 AND 500 THEN
  RAISE EXCEPTION 'Invalid reopen request' USING ERRCODE='22023'; END IF;
 -- Task-first lock order, the same as enqueue and mission creation.
 SELECT task_id INTO v_task_id FROM eliot.ai_document_plans WHERE organization_id=p_org AND id=p_plan AND task_id=p_task;
 IF NOT FOUND THEN RAISE EXCEPTION 'Plan unavailable' USING ERRCODE='22023'; END IF;
 SELECT * INTO t FROM eliot.ai_tasks WHERE organization_id=p_org AND id=v_task_id FOR UPDATE;
 SELECT * INTO plan FROM eliot.ai_document_plans WHERE organization_id=p_org AND id=p_plan FOR UPDATE;
 IF plan.created_by IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Plan unavailable' USING ERRCODE='22023'; END IF;
 -- Idempotent retry of the same decision returns the recorded result; changed content is a conflict.
 SELECT * INTO saved FROM eliot.ai_document_plan_attempts WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF saved.plan_id IS DISTINCT FROM p_plan OR saved.failed_job_id IS DISTINCT FROM p_failed_job
  OR saved.reopened_by IS DISTINCT FROM actor OR saved.reason IS DISTINCT FROM trim(p_reason) THEN
   RAISE EXCEPTION 'Conflicting reopen retry' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('plan_id',saved.plan_id,'attempt',saved.attempt,'failed_job_id',saved.failed_job_id,
   'replayed',true,'dispatched',false);
 END IF;
 IF plan.job_id IS DISTINCT FROM p_failed_job THEN
  RAISE EXCEPTION 'Plan is not linked to that job' USING ERRCODE='55000'; END IF;
 SELECT * INTO j FROM eliot.ai_document_jobs WHERE organization_id=p_org AND task_id=plan.task_id AND id=plan.job_id FOR UPDATE;
 -- Only a KNOWN failure. needs_review stays a human investigation, never a retry.
 IF NOT FOUND OR j.state<>'failed' OR j.error_code IS NULL OR j.error_code='source_changed' THEN
  RAISE EXCEPTION 'Only a known, recoverable failure can be reopened' USING ERRCODE='55000'; END IF;
 IF plan.control_state<>'active' THEN RAISE EXCEPTION 'Plan paused or cancelled' USING ERRCODE='55000'; END IF;
 SELECT s.mission_id INTO v_mission FROM eliot.ai_document_mission_steps s WHERE s.organization_id=p_org AND s.plan_id=p_plan;
 IF v_mission IS NOT NULL THEN
  SELECT control_state INTO v_mission_state FROM eliot.ai_document_missions WHERE organization_id=p_org AND id=v_mission FOR UPDATE;
  IF v_mission_state='cancelled' THEN RAISE EXCEPTION 'Mission cancelled' USING ERRCODE='55000'; END IF;
 END IF;
 IF t.status<>'pending' OR t.assignee_worker_id IS DISTINCT FROM plan.worker_id
 OR NOT EXISTS(SELECT 1 FROM eliot.ai_workers w WHERE w.organization_id=p_org AND w.id=plan.worker_id
   AND w.department_id=t.department_id AND w.operating_state='idle')
 OR eliot.task_has_unconfirmed_execution(p_org,plan.task_id) THEN
  RAISE EXCEPTION 'Task not eligible for reopening' USING ERRCODE='55000'; END IF;
 SELECT count(*)+1 INTO next_attempt FROM eliot.ai_document_plan_attempts WHERE organization_id=p_org AND plan_id=p_plan;
 IF next_attempt>2 THEN RAISE EXCEPTION 'Reopen limit reached; save a new plan' USING ERRCODE='55000'; END IF;
 INSERT INTO eliot.ai_document_plan_attempts(organization_id,plan_id,attempt,task_id,failed_job_id,failed_error_code,reopened_by,reason,request_key)
 VALUES(p_org,p_plan,next_attempt,plan.task_id,j.id,j.error_code,actor,trim(p_reason),p_key);
 -- Re-confirms the current task snapshot: the owner reviewed this exact scope now.
 UPDATE eliot.ai_document_plans SET job_id=NULL,task_updated_at=t.updated_at WHERE organization_id=p_org AND id=p_plan;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,plan.task_id,plan.worker_id,'reported','Document plan '||p_plan::text||' reopened after failed job '||j.id::text
  ||' ('||j.error_code||'); attempt '||next_attempt::text||'; no dispatch, approval, lease or provider call');
 RETURN jsonb_build_object('plan_id',p_plan,'attempt',next_attempt,'failed_job_id',j.id,'replayed',false,'dispatched',false);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_reopen_failed_document_plan(uuid,uuid,uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_reopen_failed_document_plan(uuid,uuid,uuid,uuid,text,uuid) TO eliot_identity;

CREATE FUNCTION eliot.my_document_plan_attempts(p_org uuid,p_plan uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object('plan_id',a.plan_id,'attempt',a.attempt,'failed_job_id',a.failed_job_id,
  'failed_run_id',j.run_id,'failed_error_code',a.failed_error_code,'reason',a.reason,'reopened_at',a.reopened_at,
  'reopened_by_me',a.reopened_by=actor)
 FROM eliot.ai_document_plan_attempts a
 JOIN eliot.ai_document_jobs j ON j.organization_id=a.organization_id AND j.id=a.failed_job_id
 WHERE a.organization_id=p_org AND a.plan_id=p_plan ORDER BY a.attempt;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_document_plan_attempts(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_document_plan_attempts(uuid,uuid) TO eliot_identity;
COMMIT;

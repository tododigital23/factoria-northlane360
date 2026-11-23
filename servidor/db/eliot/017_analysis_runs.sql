-- 017: First bounded, on-demand analysis execution. Never calls a provider from SQL.
-- Requires audited owner approval 016; apply ONCE in eliot_dev.
-- Old, revoked, expired, mismatched and previously consumed approvals cannot start.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_analysis_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 approval_id uuid NOT NULL,
 requested_by uuid NOT NULL,
 request_key uuid NOT NULL,
 status text NOT NULL DEFAULT 'running'
  CHECK(status IN ('running','completed','failed')),
 result_text text,
 error_code text,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CONSTRAINT fk_analysis_run_task FOREIGN KEY(task_id,organization_id)
   REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_analysis_run_worker FOREIGN KEY(worker_id,organization_id)
   REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_analysis_run_approval FOREIGN KEY(organization_id,approval_id)
   REFERENCES eliot.ai_execution_approvals(organization_id,id),
 CONSTRAINT fk_analysis_run_actor FOREIGN KEY(organization_id,requested_by)
   REFERENCES eliot.organization_memberships(organization_id,user_id),
 CONSTRAINT uq_analysis_run_approval UNIQUE(organization_id,approval_id),
 CONSTRAINT uq_analysis_run_request UNIQUE(organization_id,request_key),
 CONSTRAINT ck_analysis_run_result CHECK(
   (status='running' AND result_text IS NULL AND error_code IS NULL AND finished_at IS NULL)
   OR (status='completed' AND length(result_text) BETWEEN 1 AND 4000
       AND error_code IS NULL AND finished_at IS NOT NULL)
   OR (status='failed' AND result_text IS NULL
       AND error_code IN ('provider_error','rate_limited','invalid_response','internal_error')
       AND finished_at IS NOT NULL)
 )
);
CREATE INDEX idx_analysis_runs_task
 ON eliot.ai_analysis_runs(organization_id,task_id,started_at DESC);
ALTER TABLE eliot.ai_analysis_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_analysis_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_analysis_runs_select ON eliot.ai_analysis_runs
 FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY migrator_analysis_runs_insert ON eliot.ai_analysis_runs
 FOR INSERT TO eliot_migrator WITH CHECK(true);
CREATE POLICY migrator_analysis_runs_update ON eliot.ai_analysis_runs
 FOR UPDATE TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_claim_analysis_run(
 p_org uuid,p_task uuid,p_approval uuid,p_request_key uuid
)
RETURNS TABLE(run_id uuid,should_execute boolean,run_status text,task_title text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_actor uuid;
 v_task record;
 v_approval record;
 v_existing record;
 v_worker_state text;
 v_run_id uuid;
BEGIN
 SELECT u.id INTO v_actor FROM eliot.users u
 JOIN eliot.organization_memberships m ON m.user_id=u.id
 WHERE u.external_subject=v_subject AND m.organization_id=p_org
 AND m.status='active' AND m.role='owner';
 IF v_actor IS NULL THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_request_key IS NULL OR p_approval IS NULL THEN
  RAISE EXCEPTION 'Missing execution request key or approval' USING ERRCODE='22023';
 END IF;
 SELECT id,department_id,assignee_worker_id,status,title INTO v_task
 FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Task not found' USING ERRCODE='22023';
 END IF;

 SELECT id,approval_id,task_id,requested_by,status INTO v_existing
 FROM eliot.ai_analysis_runs
 WHERE organization_id=p_org AND request_key=p_request_key;
 IF FOUND THEN
  IF v_existing.approval_id IS DISTINCT FROM p_approval
     OR v_existing.task_id IS DISTINCT FROM p_task
     OR v_existing.requested_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Conflicting execution retry' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT v_existing.id,false,v_existing.status::text,v_task.title::text;
  RETURN;
 END IF;

 SELECT id,task_id,worker_id,approved_by,state,expires_at,capability INTO v_approval
 FROM eliot.ai_execution_approvals
 WHERE organization_id=p_org AND id=p_approval FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Approval not in authorized organization' USING ERRCODE='22023';
 END IF;
 IF v_approval.state<>'approved' OR v_approval.expires_at<=now()
    OR v_approval.capability<>'analysis_draft_v1'
    OR v_approval.task_id IS DISTINCT FROM p_task
    OR v_approval.approved_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'Approval revoked, expired, consumed or mismatched'
   USING ERRCODE='22023';
 END IF;
 IF v_task.status<>'pending'
    OR v_task.assignee_worker_id IS DISTINCT FROM v_approval.worker_id THEN
  RAISE EXCEPTION 'Task is not pending with its approved worker'
   USING ERRCODE='22023';
 END IF;
 SELECT operating_state INTO v_worker_state FROM eliot.ai_workers
 WHERE organization_id=p_org AND id=v_approval.worker_id
  AND department_id=v_task.department_id FOR SHARE;
 IF NOT FOUND OR v_worker_state<>'idle' THEN
  RAISE EXCEPTION 'Worker is not available' USING ERRCODE='22023';
 END IF;

 UPDATE eliot.ai_execution_approvals SET state='claimed'
 WHERE organization_id=p_org AND id=p_approval;
 INSERT INTO eliot.ai_analysis_runs(
  organization_id,task_id,worker_id,approval_id,requested_by,request_key
 ) VALUES(p_org,p_task,v_approval.worker_id,p_approval,v_actor,p_request_key)
 RETURNING id INTO v_run_id;
 INSERT INTO eliot.ai_task_events(
  organization_id,task_id,worker_id,event_type,message,action_key
 ) VALUES(
  p_org,p_task,v_approval.worker_id,'progress',
  'Read-only analysis request claimed; provider call is bounded, no external tools',
  p_request_key
 );
 RETURN QUERY SELECT v_run_id,true,'running'::text,v_task.title::text;
END
$fn$;

CREATE FUNCTION eliot.owner_finish_analysis_run(
 p_org uuid,p_run uuid,p_status text,p_text text,p_error_code text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_actor uuid;
 v_run record;
BEGIN
 SELECT u.id INTO v_actor FROM eliot.users u
 JOIN eliot.organization_memberships m ON m.user_id=u.id
 WHERE u.external_subject=v_subject AND m.organization_id=p_org
 AND m.status='active' AND m.role='owner';
 IF v_actor IS NULL THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 SELECT id,task_id,worker_id,approval_id,requested_by,status,result_text,error_code
 INTO v_run FROM eliot.ai_analysis_runs
 WHERE organization_id=p_org AND id=p_run FOR UPDATE;
 IF NOT FOUND OR v_run.requested_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'Run unavailable' USING ERRCODE='22023';
 END IF;
 IF p_status NOT IN ('completed','failed')
   OR (p_status='completed' AND
       (p_text IS NULL OR length(p_text) NOT BETWEEN 1 AND 4000 OR p_error_code IS NOT NULL))
   OR (p_status='failed' AND
       (p_text IS NOT NULL OR p_error_code IS NULL OR
        p_error_code NOT IN ('provider_error','rate_limited','invalid_response','internal_error'))) THEN
  RAISE EXCEPTION 'Invalid completion payload' USING ERRCODE='22023';
 END IF;
 IF v_run.status<>'running' THEN
  IF v_run.status IS DISTINCT FROM p_status
   OR v_run.result_text IS DISTINCT FROM p_text
   OR v_run.error_code IS DISTINCT FROM p_error_code THEN
    RAISE EXCEPTION 'Conflicting completion retry' USING ERRCODE='22023';
  END IF;
  RETURN v_run.status;
 END IF;
 UPDATE eliot.ai_analysis_runs
 SET status=p_status,result_text=p_text,error_code=p_error_code,finished_at=now()
 WHERE organization_id=p_org AND id=p_run;
 UPDATE eliot.ai_execution_approvals
 SET state=CASE WHEN p_status='completed' THEN 'finished' ELSE 'failed' END
 WHERE organization_id=p_org AND id=v_run.approval_id AND state='claimed';
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Approval no longer claimed' USING ERRCODE='22023';
 END IF;
 INSERT INTO eliot.ai_task_events(
  organization_id,task_id,worker_id,event_type,message
 ) VALUES(
  p_org,v_run.task_id,v_run.worker_id,
  CASE WHEN p_status='completed' THEN 'reported' ELSE 'failed' END,
  CASE WHEN p_status='completed'
       THEN 'Read-only analysis draft recorded; task remains pending for review'
       ELSE 'Read-only analysis attempt failed; task remains pending' END
 );
 RETURN p_status;
END
$fn$;

CREATE FUNCTION eliot.my_analysis_runs(p_org uuid,p_task uuid)
RETURNS TABLE(run_id uuid,run_status text,run_result text,run_error text,
 started_at timestamptz,finished_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT r.id,r.status,r.result_text,r.error_code,r.started_at,r.finished_at
 FROM eliot.ai_analysis_runs r
 WHERE r.organization_id=p_org AND r.task_id=p_task
 AND EXISTS(
  SELECT 1 FROM eliot.users u
  JOIN eliot.organization_memberships m ON m.user_id=u.id
  WHERE u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
  AND m.organization_id=p_org AND m.status='active' AND m.role='owner'
 )
 ORDER BY r.started_at DESC,r.id DESC LIMIT 20
$fn$;

-- Keep a worker available until any claimed analysis finishes. The
-- task itself remains pending, so 015's queued/running check alone is insufficient.
CREATE FUNCTION eliot.prevent_deactivate_running_analysis()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
BEGIN
 IF OLD.operating_state='idle' AND NEW.operating_state='inactive'
 AND EXISTS(
  SELECT 1 FROM eliot.ai_analysis_runs r
  WHERE r.organization_id=OLD.organization_id AND r.worker_id=OLD.id
  AND r.status='running'
 ) THEN
  RAISE EXCEPTION 'Worker has an active approved analysis'
    USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION eliot.prevent_deactivate_running_analysis() FROM PUBLIC;
CREATE TRIGGER prevent_deactivate_running_analysis
 BEFORE UPDATE OF operating_state ON eliot.ai_workers
 FOR EACH ROW EXECUTE FUNCTION eliot.prevent_deactivate_running_analysis();

REVOKE ALL ON FUNCTION eliot.owner_claim_analysis_run(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_finish_analysis_run(uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_analysis_runs(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_claim_analysis_run(uuid,uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_finish_analysis_run(uuid,uuid,text,text,text) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_analysis_runs(uuid,uuid) TO eliot_identity;
COMMIT;

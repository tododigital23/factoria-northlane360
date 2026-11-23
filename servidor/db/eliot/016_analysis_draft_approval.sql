-- 016: Authorize one bounded, read-only analysis draft (NO execution engine).
-- Apply ONCE in eliot_dev AFTER 015, as database administrator.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_execution_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  task_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  approved_by uuid NOT NULL,
  action_key uuid NOT NULL,
  capability text NOT NULL DEFAULT 'analysis_draft_v1'
    CHECK (capability='analysis_draft_v1'),
  state text NOT NULL DEFAULT 'approved'
    CHECK (state IN ('approved','expired','revoked','claimed','finished','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '15 minutes'),
  revoked_at timestamptz,
  revocation_key uuid,
  CONSTRAINT fk_execution_approval_task FOREIGN KEY(task_id,organization_id)
    REFERENCES eliot.ai_tasks(id,organization_id),
  CONSTRAINT fk_execution_approval_worker FOREIGN KEY(worker_id,organization_id)
    REFERENCES eliot.ai_workers(id,organization_id),
  CONSTRAINT fk_execution_approval_owner FOREIGN KEY(organization_id,approved_by)
    REFERENCES eliot.organization_memberships(organization_id,user_id),
  CONSTRAINT uq_execution_approval_request UNIQUE(organization_id,action_key),
  CONSTRAINT uq_execution_approval_org_id UNIQUE(organization_id,id),
  CONSTRAINT ck_execution_approval_expiry CHECK(expires_at>created_at),
  CONSTRAINT ck_execution_approval_revoke CHECK(
    (state='revoked')=(revoked_at IS NOT NULL AND revocation_key IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_execution_approval_active_task
 ON eliot.ai_execution_approvals(organization_id,task_id)
 WHERE state='approved';
CREATE INDEX idx_execution_approvals_org_task
 ON eliot.ai_execution_approvals(organization_id,task_id,created_at DESC);
ALTER TABLE eliot.ai_execution_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_execution_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_execution_approvals_select
 ON eliot.ai_execution_approvals FOR SELECT TO eliot_migrator USING (true);
CREATE POLICY migrator_execution_approvals_insert
 ON eliot.ai_execution_approvals FOR INSERT TO eliot_migrator WITH CHECK (true);
CREATE POLICY migrator_execution_approvals_update
 ON eliot.ai_execution_approvals FOR UPDATE TO eliot_migrator
 USING (true) WITH CHECK (true);

CREATE FUNCTION eliot.owner_approve_analysis_draft(
 p_org uuid,p_task uuid,p_worker uuid,p_key uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_actor uuid;
 v_task record;
 v_state text;
 v_saved record;
 v_id uuid;
BEGIN
 SELECT u.id INTO v_actor
 FROM eliot.organization_memberships m
 JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
   AND u.external_subject=v_subject;
 IF v_actor IS NULL THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_key IS NULL OR p_worker IS NULL THEN
   RAISE EXCEPTION 'Worker and request key required' USING ERRCODE='22023';
 END IF;

 SELECT id,department_id,assignee_worker_id,status INTO v_task
 FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'Task not found' USING ERRCODE='22023';
 END IF;

 SELECT id,task_id,worker_id,approved_by INTO v_saved
 FROM eliot.ai_execution_approvals
 WHERE organization_id=p_org AND action_key=p_key;
 IF FOUND THEN
   IF v_saved.task_id IS DISTINCT FROM p_task
      OR v_saved.worker_id IS DISTINCT FROM p_worker
      OR v_saved.approved_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Conflicting approval retry' USING ERRCODE='22023';
   END IF;
   RETURN v_saved.id;
 END IF;

 IF v_task.status<>'pending'
    OR v_task.assignee_worker_id IS DISTINCT FROM p_worker THEN
   RAISE EXCEPTION 'Task must be pending and assigned to selected worker'
     USING ERRCODE='22023';
 END IF;
 SELECT operating_state INTO v_state
 FROM eliot.ai_workers
 WHERE organization_id=p_org AND id=p_worker
  AND department_id=v_task.department_id FOR SHARE;
 IF NOT FOUND OR v_state<>'idle' THEN
   RAISE EXCEPTION 'Assigned worker must be available' USING ERRCODE='22023';
 END IF;

 UPDATE eliot.ai_execution_approvals
 SET state='expired'
 WHERE organization_id=p_org AND task_id=p_task AND state='approved'
   AND expires_at<=now();

 IF EXISTS(
   SELECT 1 FROM eliot.ai_execution_approvals
   WHERE organization_id=p_org AND task_id=p_task AND state='approved'
 ) THEN
   RAISE EXCEPTION 'An unexpired approval already exists for this task'
     USING ERRCODE='22023';
 END IF;

 INSERT INTO eliot.ai_execution_approvals(
  organization_id,task_id,worker_id,approved_by,action_key
 ) VALUES(p_org,p_task,p_worker,v_actor,p_key)
 RETURNING id INTO v_id;

 INSERT INTO eliot.ai_task_events(
  organization_id,task_id,worker_id,event_type,message,action_key
 ) VALUES(
  p_org,p_task,p_worker,'reported',
  'Owner approved one analysis draft, expiring in 15 minutes; no execution started',
  p_key
 );
 RETURN v_id;
END
$fn$;

CREATE FUNCTION eliot.owner_revoke_analysis_draft(
 p_org uuid,p_approval uuid,p_key uuid
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_actor uuid;
 v_approval record;
BEGIN
 SELECT u.id INTO v_actor
 FROM eliot.organization_memberships m
 JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
   AND u.external_subject=v_subject;
 IF v_actor IS NULL THEN
   RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_key IS NULL THEN
   RAISE EXCEPTION 'Request key required' USING ERRCODE='22023';
 END IF;
 SELECT id,task_id,worker_id,state,expires_at,revocation_key INTO v_approval
 FROM eliot.ai_execution_approvals
 WHERE organization_id=p_org AND id=p_approval FOR UPDATE;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'Approval not found' USING ERRCODE='22023';
 END IF;
 IF v_approval.state='revoked' THEN
   IF v_approval.revocation_key IS DISTINCT FROM p_key THEN
     RAISE EXCEPTION 'Conflicting revocation retry' USING ERRCODE='22023';
   END IF;
   RETURN 'revoked';
 END IF;
 IF v_approval.state<>'approved' THEN
   RAISE EXCEPTION 'Approval not revocable' USING ERRCODE='22023';
 END IF;
 IF v_approval.expires_at<=now() THEN
   UPDATE eliot.ai_execution_approvals SET state='expired'
     WHERE id=p_approval AND organization_id=p_org;
   RETURN 'expired';
 END IF;
 UPDATE eliot.ai_execution_approvals
 SET state='revoked',revoked_at=now(),revocation_key=p_key
 WHERE organization_id=p_org AND id=p_approval;
 INSERT INTO eliot.ai_task_events(
  organization_id,task_id,worker_id,event_type,message,action_key
 ) VALUES(
  p_org,v_approval.task_id,v_approval.worker_id,'reported',
  'Owner revoked the unconsumed analysis approval; no execution started',p_key
 );
 RETURN 'revoked';
END
$fn$;

CREATE FUNCTION eliot.my_analysis_approvals(p_org uuid,p_task uuid)
RETURNS TABLE(
 approval_id uuid,worker_id uuid,approval_state text,
 created_at timestamptz,expires_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT a.id,a.worker_id,
  CASE WHEN a.state='approved' AND a.expires_at<=now() THEN 'expired'
       ELSE a.state END,
  a.created_at,a.expires_at
 FROM eliot.ai_execution_approvals a
 WHERE a.organization_id=p_org AND a.task_id=p_task
 AND EXISTS(
  SELECT 1 FROM eliot.organization_memberships m
  JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
   AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
 )
 ORDER BY a.created_at DESC,a.id DESC LIMIT 20
$fn$;

REVOKE ALL ON FUNCTION eliot.owner_approve_analysis_draft(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_revoke_analysis_draft(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_analysis_approvals(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_approve_analysis_draft(uuid,uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_revoke_analysis_draft(uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_analysis_approvals(uuid,uuid) TO eliot_identity;
COMMIT;

-- 043: Caducar de verdad las autorizaciones vencidas antes de bloquear un alta nueva.
-- Antes, un approved con expires_at pasado podía seguir ocupando el índice único
-- y devolver 409 aunque el listado ya las mostrara como expired.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE OR REPLACE FUNCTION eliot.analysis_approval_expiry_fix_v1()
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;

UPDATE eliot.ai_execution_approvals
   SET state = 'expired'
 WHERE state = 'approved' AND expires_at <= now();

CREATE OR REPLACE FUNCTION eliot.owner_approve_analysis_draft(
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
     AND expires_at > now()
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

REVOKE ALL ON FUNCTION eliot.owner_approve_analysis_draft(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.analysis_approval_expiry_fix_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_approve_analysis_draft(uuid,uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.analysis_approval_expiry_fix_v1() TO eliot_identity;
COMMIT;

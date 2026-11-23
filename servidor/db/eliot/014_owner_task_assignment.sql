-- Owner-only task reassignment. No agent execution or status changes.
-- Run once in eliot_dev after audited task-status migration 012.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE FUNCTION eliot.owner_assign_task(
  p_org uuid, p_task uuid, p_worker uuid, p_action_key uuid
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, eliot
AS $fn$
DECLARE
  v_sub text := NULLIF(current_setting('app.verified_subject', true), '');
  v_task record;
  v_worker_name text;
  v_message text;
  v_type text;
  v_previous record;
BEGIN
  IF v_sub IS NULL OR NOT EXISTS (
    SELECT 1 FROM eliot.organization_memberships m
    JOIN eliot.users u ON u.id=m.user_id
    WHERE u.external_subject=v_sub
      AND m.organization_id=p_org
      AND m.status='active' AND m.role='owner'
  ) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END IF;
  IF p_action_key IS NULL THEN
    RAISE EXCEPTION 'Idempotency key required' USING ERRCODE='22023';
  END IF;
  SELECT id,department_id,assignee_worker_id,status INTO v_task
    FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found' USING ERRCODE='22023';
  END IF;

  IF p_worker IS NOT NULL THEN
    SELECT display_name INTO v_worker_name
    FROM eliot.ai_workers
    WHERE id=p_worker AND organization_id=p_org
      AND department_id=v_task.department_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Worker not in authorized task department' USING ERRCODE='22023';
    END IF;
    v_type := 'assigned';
    v_message := 'Owner assigned AI worker: ' || v_worker_name;
  ELSE
    v_type := 'reported';
    v_message := 'Owner unassigned AI worker';
  END IF;

  SELECT e.event_type,e.worker_id,e.message INTO v_previous
  FROM eliot.ai_task_events e
  WHERE e.organization_id=p_org AND e.task_id=p_task
    AND e.action_key=p_action_key;
  IF FOUND THEN
    IF v_previous.event_type IS DISTINCT FROM v_type
       OR v_previous.worker_id IS DISTINCT FROM p_worker
       OR v_previous.message IS DISTINCT FROM v_message THEN
       RAISE EXCEPTION 'Conflicting retry' USING ERRCODE='22023';
    END IF;
    RETURN v_previous.worker_id;
  END IF;

  IF v_task.status NOT IN ('pending','blocked') THEN
    RAISE EXCEPTION 'Task not reassignable in its current state' USING ERRCODE='22023';
  END IF;
  IF v_task.assignee_worker_id IS NOT DISTINCT FROM p_worker THEN
    RAISE EXCEPTION 'No assignment change' USING ERRCODE='22023';
  END IF;

  UPDATE eliot.ai_tasks SET assignee_worker_id=p_worker, updated_at=now()
  WHERE organization_id=p_org AND id=p_task;
  INSERT INTO eliot.ai_task_events(
    organization_id,task_id,worker_id,event_type,message,action_key
  ) VALUES(p_org,p_task,p_worker,v_type,v_message,p_action_key);
  RETURN p_worker;
END
$fn$;
REVOKE ALL ON FUNCTION eliot.owner_assign_task(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_assign_task(uuid,uuid,uuid,uuid) TO eliot_identity;
COMMIT;

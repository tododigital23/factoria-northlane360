-- 012: Owner-only manual task controls. NO AI execution.
-- Run on eliot_dev as postgres administrator; table and function owners remain eliot_migrator.
BEGIN;
SET LOCAL ROLE eliot_migrator;

ALTER TABLE eliot.ai_task_events ADD COLUMN action_key uuid;
CREATE UNIQUE INDEX uq_task_event_action_key
 ON eliot.ai_task_events(organization_id,task_id,action_key)
 WHERE action_key IS NOT NULL;

CREATE POLICY migrator_tasks_update
 ON eliot.ai_tasks FOR UPDATE TO eliot_migrator
 USING (true) WITH CHECK (true);

CREATE FUNCTION eliot.owner_change_task_status(
 p_org uuid, p_task uuid, p_action text, p_reason text, p_action_key uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_sub text:=NULLIF(current_setting('app.verified_subject',true),'');
 v_before text;
 v_after text;
 v_type text;
 v_message text;
 v_saved record;
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

 IF p_action_key IS NULL OR p_action IS NULL
    OR p_action NOT IN ('block','resume','cancel')
    OR length(coalesce(p_reason,''))>1000 THEN
  RAISE EXCEPTION 'Invalid task action' USING ERRCODE='22023';
 END IF;

 v_message:=CASE p_action
  WHEN 'block' THEN 'Owner blocked task'
  WHEN 'resume' THEN 'Owner returned task to pending'
  WHEN 'cancel' THEN 'Owner cancelled task'
 END;
 IF length(trim(coalesce(p_reason,'')))>0 THEN
  v_message:=v_message||': '||trim(p_reason);
 END IF;
 v_type:=CASE p_action
  WHEN 'block' THEN 'blocked'
  WHEN 'resume' THEN 'reported'
  WHEN 'cancel' THEN 'cancelled'
 END;

 SELECT t.status INTO v_before FROM eliot.ai_tasks t
 WHERE t.organization_id=p_org AND t.id=p_task FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Task not found' USING ERRCODE='22023';
 END IF;

 SELECT e.event_type,e.message INTO v_saved
 FROM eliot.ai_task_events e
 WHERE e.organization_id=p_org AND e.task_id=p_task AND e.action_key=p_action_key;
 IF FOUND THEN
  IF v_saved.event_type IS DISTINCT FROM v_type OR v_saved.message IS DISTINCT FROM v_message THEN
   RAISE EXCEPTION 'Conflicting retry' USING ERRCODE='22023';
  END IF;
  RETURN v_before;
 END IF;

 IF (p_action='block' AND v_before<>'pending')
 OR (p_action='resume' AND v_before<>'blocked')
 OR (p_action='cancel' AND v_before NOT IN ('pending','blocked')) THEN
  RAISE EXCEPTION 'Invalid task transition' USING ERRCODE='22023';
 END IF;

 v_after:=CASE p_action
  WHEN 'block' THEN 'blocked'
  WHEN 'resume' THEN 'pending'
  WHEN 'cancel' THEN 'cancelled'
 END;

 UPDATE eliot.ai_tasks SET status=v_after,updated_at=now()
 WHERE id=p_task AND organization_id=p_org;
 INSERT INTO eliot.ai_task_events(
  organization_id,task_id,event_type,message,action_key
 ) VALUES(p_org,p_task,v_type,v_message,p_action_key);

 RETURN v_after;
END
$fn$;

REVOKE ALL ON FUNCTION eliot.owner_change_task_status(uuid,uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_change_task_status(uuid,uuid,text,text,uuid)
 TO eliot_identity;
COMMIT;

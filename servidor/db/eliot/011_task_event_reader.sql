-- Manual migration: authenticated per-task event history, bounded to 100 entries.
BEGIN;
SET LOCAL ROLE eliot_migrator;
CREATE POLICY migrator_task_events_read ON eliot.ai_task_events FOR SELECT TO eliot_migrator USING(true);
CREATE FUNCTION eliot.my_task_events(p_org uuid,p_task uuid)
RETURNS TABLE(event_id uuid,event_type text,event_message text,event_timestamp timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT e.id,e.event_type,e.message,e.created_at
 FROM eliot.ai_task_events e
 WHERE e.organization_id=p_org AND e.task_id=p_task
 AND EXISTS(SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=e.organization_id AND m.status='active'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),''))
 ORDER BY e.created_at DESC,e.id LIMIT 100
$fn$;
REVOKE ALL ON FUNCTION eliot.my_task_events(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_task_events(uuid,uuid) TO eliot_identity;
COMMIT;

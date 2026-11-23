-- Install in eliot_dev as eliot_migrator, after 008_tasks_events.sql.
-- Existing RLS FORCE remains enabled; only the migration owner receives read policy.
CREATE POLICY migrator_tasks_read ON eliot.ai_tasks FOR SELECT TO eliot_migrator USING (true);
CREATE FUNCTION eliot.my_tasks(p_org_id uuid)
RETURNS TABLE(task_id uuid,department_id uuid,assignee_worker_id uuid,task_title text,task_status text,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT t.id,t.department_id,t.assignee_worker_id,t.title,t.status,t.created_at
 FROM eliot.ai_tasks t
 WHERE t.organization_id=p_org_id
   AND EXISTS (SELECT 1 FROM eliot.organization_memberships m
     JOIN eliot.users u ON u.id=m.user_id
     WHERE m.organization_id=t.organization_id AND m.status='active'
     AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),''))
 ORDER BY t.created_at DESC,t.id
 LIMIT 100
$fn$;
REVOKE ALL ON FUNCTION eliot.my_tasks(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_tasks(uuid) TO eliot_identity;

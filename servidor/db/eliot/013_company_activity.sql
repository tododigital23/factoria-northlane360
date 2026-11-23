-- Read-only per-company activity feed. Apply as eliot_migrator in eliot_dev.
-- Requires the existing owner SELECT policies for users, memberships, tasks,
-- task events and departments. Does not grant direct table reads to API roles.
BEGIN;
SET LOCAL ROLE eliot_migrator;
CREATE FUNCTION eliot.my_company_activity(p_org uuid, p_limit integer DEFAULT 50)
RETURNS TABLE (
  event_id uuid,
  task_id uuid,
  task_title text,
  department_id uuid,
  department_name text,
  event_type text,
  event_message text,
  event_time timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $activity$
  SELECT e.id, t.id, t.title, d.id, d.name, e.event_type, e.message, e.created_at
  FROM eliot.ai_task_events e
  JOIN eliot.ai_tasks t ON t.id=e.task_id AND t.organization_id=e.organization_id
  JOIN eliot.departments d ON d.id=t.department_id AND d.organization_id=t.organization_id
  WHERE e.organization_id=p_org
    AND p_limit BETWEEN 1 AND 100
    AND EXISTS (
      SELECT 1 FROM eliot.organization_memberships m
      JOIN eliot.users u ON u.id=m.user_id
      WHERE m.organization_id=p_org
        AND m.status='active'
        AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
    )
  ORDER BY e.created_at DESC,e.id DESC
  LIMIT p_limit
$activity$;
REVOKE ALL ON FUNCTION eliot.my_company_activity(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_company_activity(uuid,integer) TO eliot_identity;
COMMIT;

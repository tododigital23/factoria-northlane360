-- Read-only worker lookup scoped to active membership.
CREATE POLICY migrator_ai_workers_read ON eliot.ai_workers FOR SELECT TO eliot_migrator USING (true);
CREATE FUNCTION eliot.my_workers(p_organization_id uuid)
RETURNS TABLE(worker_id uuid,department_id uuid,worker_name text,specialty text,worker_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT w.id,w.department_id,w.display_name,w.specialty,w.operating_state
 FROM eliot.ai_workers w
 WHERE w.organization_id=p_organization_id
 AND EXISTS (
  SELECT 1 FROM eliot.organization_memberships m
  JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=w.organization_id AND m.status='active'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
 )
 ORDER BY w.display_name
$fn$;
REVOKE ALL ON FUNCTION eliot.my_workers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_workers(uuid) TO eliot_identity;

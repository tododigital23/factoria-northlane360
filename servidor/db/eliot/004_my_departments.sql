-- Optional membership-scoped read function for development.
-- Apply only after reviewing grants and migrations in eliot_dev.
CREATE POLICY migrator_departments_read ON eliot.departments FOR SELECT TO eliot_migrator USING (true);
CREATE FUNCTION eliot.my_departments(p_organization_id uuid)
RETURNS TABLE(department_id uuid, department_name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, eliot
AS $func$
 SELECT d.id, d.name
 FROM eliot.departments d
 JOIN eliot.organization_memberships m ON m.organization_id=d.organization_id
 JOIN eliot.users u ON u.id=m.user_id
 WHERE d.organization_id=p_organization_id
   AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
   AND m.status='active'
 ORDER BY d.name
$func$;
REVOKE ALL ON FUNCTION eliot.my_departments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_departments(uuid) TO eliot_identity;

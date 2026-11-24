-- Lectura de empresas del usuario autenticado. SECURITY DEFINER: eliot_identity solo EXECUTE.
CREATE FUNCTION eliot.my_organizations()
RETURNS TABLE(organization_id uuid, organization_name text, member_role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, eliot
AS $func$
 SELECT o.id, o.name, m.role
 FROM eliot.organization_memberships m
 JOIN eliot.organizations o ON o.id = m.organization_id
 JOIN eliot.users u ON u.id = m.user_id
 WHERE m.status = 'active'
   AND u.external_subject = NULLIF(current_setting('app.verified_subject', true), '')
 ORDER BY o.created_at, o.name
$func$;
REVOKE ALL ON FUNCTION eliot.my_organizations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_organizations() TO eliot_identity;

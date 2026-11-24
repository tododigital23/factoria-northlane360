-- 042: conectores de hosting (FTP/FTPS) y base de datos remota por empresa + gestores autónomos.
-- Aplicar UNA vez como administrador DESPUÉS de 041.
--
-- * La contraseña NUNCA se guarda en claro: solo texto cifrado nl360:v1: (llave maestra en el entorno).
-- * Host, puerto, usuario y ruta/base sí se guardan (necesarios para mostrar y probar).
-- * El propietario del holding o el gestor de ESA empresa conectan, prueban y desconectan.
-- * Un gestor es un perfil único que el propietario invita; solo administra conectores de su empresa.
BEGIN;
SET LOCAL ROLE eliot_migrator;

ALTER TABLE eliot.holding_audit DROP CONSTRAINT holding_audit_action_check;
ALTER TABLE eliot.holding_audit ADD CONSTRAINT holding_audit_action_check
 CHECK(action IN ('company_provisioned','profile_updated','capability_changed','company_renamed',
  'holding_renamed','storage_connected','storage_disconnected','company_storage_created','company_retired',
  'viewer_invited','viewer_joined','viewer_revoked',
  'connector_saved','connector_tested','connector_removed',
  'manager_invited','manager_joined','manager_revoked'));

CREATE TABLE eliot.company_connectors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 kind text NOT NULL CHECK(kind IN ('ftp','ftps','mysql','mariadb','postgresql','mssql','mongodb')),
 label text NOT NULL CHECK(length(trim(label)) BETWEEN 2 AND 80),
 host text NOT NULL CHECK(length(trim(host)) BETWEEN 1 AND 253 AND host !~ '[[:space:]/]'),
 port integer NOT NULL CHECK(port BETWEEN 1 AND 65535),
 username text NOT NULL CHECK(length(trim(username)) BETWEEN 1 AND 120),
 remote_path text CHECK(remote_path IS NULL OR (length(trim(remote_path)) BETWEEN 1 AND 400 AND remote_path !~ '[[:cntrl:]]')),
 database_name text CHECK(database_name IS NULL OR (length(trim(database_name)) BETWEEN 1 AND 120 AND database_name !~ '[[:space:]]')),
 secret_cipher text NOT NULL CHECK(secret_cipher LIKE 'nl360:v1:%' AND length(secret_cipher) BETWEEN 40 AND 8000),
 status text NOT NULL DEFAULT 'configured' CHECK(status IN ('configured','failed','disabled')),
 last_tested_at timestamptz,
 last_error text CHECK(last_error IS NULL OR length(last_error) <= 240),
 created_by uuid NOT NULL REFERENCES eliot.users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id, kind, label)
);
CREATE INDEX company_connectors_org ON eliot.company_connectors(organization_id);

CREATE TABLE eliot.company_managers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 manager_subject text NOT NULL CHECK(length(manager_subject) BETWEEN 3 AND 500),
 label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 80),
 invited_by uuid NOT NULL REFERENCES eliot.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz
);
CREATE UNIQUE INDEX company_managers_active ON eliot.company_managers(manager_subject, organization_id) WHERE revoked_at IS NULL;

CREATE TABLE eliot.manager_invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 label text NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 80),
 created_by uuid NOT NULL REFERENCES eliot.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 redeemed_at timestamptz,
 cancelled_at timestamptz
);

DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['company_connectors','company_managers','manager_invites'] LOOP
  EXECUTE format('ALTER TABLE eliot.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE eliot.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY migrator_%s ON eliot.%I FOR ALL TO eliot_migrator USING(true) WITH CHECK(true)', t, t);
 END LOOP;
END $rls$;

-- Actor con derecho a gestionar conectores: propietario de la empresa o gestor activo.
CREATE FUNCTION eliot.company_connector_actor(p_org uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_subject text:=NULLIF(current_setting('app.verified_subject',true),'');
 v_user uuid;
BEGIN
 IF v_subject IS NULL THEN RETURN NULL; END IF;
 SELECT u.id INTO v_user FROM eliot.users u
  JOIN eliot.organization_memberships m ON m.user_id=u.id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
   AND u.external_subject=v_subject;
 IF v_user IS NOT NULL THEN RETURN v_user; END IF;
 SELECT u.id INTO v_user FROM eliot.users u
  JOIN eliot.company_managers cm ON cm.manager_subject=u.external_subject
 WHERE cm.organization_id=p_org AND cm.revoked_at IS NULL AND u.external_subject=v_subject;
 RETURN v_user;
END $fn$;
REVOKE ALL ON FUNCTION eliot.company_connector_actor(uuid) FROM PUBLIC;

CREATE FUNCTION eliot.my_company_connectors(p_org uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.company_connector_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object(
  'id',c.id,'organization_id',c.organization_id,'kind',c.kind,'label',c.label,
  'host',c.host,'port',c.port,'username',c.username,
  'remote_path',c.remote_path,'database_name',c.database_name,
  'status',c.status,'last_tested_at',c.last_tested_at,'last_error',c.last_error,
  'updated_at',c.updated_at,'has_secret',true)
 FROM eliot.company_connectors c WHERE c.organization_id=p_org ORDER BY c.kind,c.label;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_company_connectors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_company_connectors(uuid) TO eliot_identity;

CREATE FUNCTION eliot.owner_save_company_connector(p_org uuid,p_kind text,p_label text,p_host text,p_port integer,
 p_username text,p_remote_path text,p_database_name text,p_secret_cipher text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_id uuid; v_holding uuid; v_label text:=trim(p_label); v_host text:=trim(p_host);
 v_user text:=trim(p_username); v_path text:=NULLIF(trim(coalesce(p_remote_path,'')),'');
 v_db text:=NULLIF(trim(coalesce(p_database_name,'')),'');
BEGIN
 actor:=eliot.company_connector_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_kind NOT IN ('ftp','ftps','mysql','mariadb','postgresql','mssql','mongodb')
  OR length(v_label) NOT BETWEEN 2 AND 80 OR v_label ~ '[[:cntrl:]]'
  OR length(v_host) NOT BETWEEN 1 AND 253 OR v_host ~ '[[:space:]/]'
  OR p_port IS NULL OR p_port NOT BETWEEN 1 AND 65535
  OR length(v_user) NOT BETWEEN 1 AND 120
  OR p_secret_cipher IS NULL OR p_secret_cipher NOT LIKE 'nl360:v1:%' OR length(p_secret_cipher) NOT BETWEEN 40 AND 8000 THEN
  RAISE EXCEPTION 'Invalid connector' USING ERRCODE='22023'; END IF;
 IF p_kind IN ('ftp','ftps') AND (v_path IS NOT NULL AND (length(v_path)>400 OR v_path ~ '[[:cntrl:]]')) THEN
  RAISE EXCEPTION 'Invalid connector path' USING ERRCODE='22023'; END IF;
 IF p_kind IN ('mysql','mariadb','postgresql','mssql','mongodb') AND (v_db IS NULL OR length(v_db)>120 OR v_db ~ '[[:space:]]') THEN
  RAISE EXCEPTION 'Invalid connector database' USING ERRCODE='22023'; END IF;
 IF p_kind IN ('ftp','ftps') THEN v_db:=NULL; ELSE v_path:=NULL; END IF;
 INSERT INTO eliot.company_connectors(organization_id,kind,label,host,port,username,remote_path,database_name,secret_cipher,status,created_by,updated_at)
 VALUES(p_org,p_kind,v_label,v_host,p_port,v_user,v_path,v_db,p_secret_cipher,'configured',actor,clock_timestamp())
 ON CONFLICT (organization_id,kind,label) DO UPDATE SET
  host=EXCLUDED.host,port=EXCLUDED.port,username=EXCLUDED.username,remote_path=EXCLUDED.remote_path,
  database_name=EXCLUDED.database_name,secret_cipher=EXCLUDED.secret_cipher,status='configured',
  last_error=NULL,updated_at=clock_timestamp()
 RETURNING id INTO v_id;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NOT NULL THEN
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
  VALUES(v_holding,p_org,actor,'connector_saved',jsonb_build_object('connector_id',v_id,'kind',p_kind,'label',v_label));
 END IF;
 RETURN jsonb_build_object('id',v_id,'organization_id',p_org,'kind',p_kind,'label',v_label,'status','configured','saved',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_save_company_connector(uuid,text,text,text,integer,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_save_company_connector(uuid,text,text,text,integer,text,text,text,text) TO eliot_identity;

CREATE FUNCTION eliot.owner_connector_secret(p_org uuid,p_connector uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_cipher text;
BEGIN
 IF eliot.company_connector_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT secret_cipher INTO v_cipher FROM eliot.company_connectors WHERE id=p_connector AND organization_id=p_org;
 IF v_cipher IS NULL THEN RAISE EXCEPTION 'Connector not found' USING ERRCODE='22023'; END IF;
 RETURN v_cipher;
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_connector_secret(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_connector_secret(uuid,uuid) TO eliot_identity;

CREATE FUNCTION eliot.owner_set_connector_test(p_org uuid,p_connector uuid,p_ok boolean,p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_holding uuid; v_err text:=NULLIF(left(trim(coalesce(p_error,'')),240),'');
BEGIN
 actor:=eliot.company_connector_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 UPDATE eliot.company_connectors SET status=CASE WHEN p_ok THEN 'configured' ELSE 'failed' END,
  last_tested_at=clock_timestamp(), last_error=CASE WHEN p_ok THEN NULL ELSE v_err END, updated_at=clock_timestamp()
 WHERE id=p_connector AND organization_id=p_org;
 IF NOT FOUND THEN RAISE EXCEPTION 'Connector not found' USING ERRCODE='22023'; END IF;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NOT NULL THEN
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
  VALUES(v_holding,p_org,actor,'connector_tested',jsonb_build_object('connector_id',p_connector,'ok',p_ok));
 END IF;
 RETURN jsonb_build_object('organization_id',p_org,'connector_id',p_connector,'ok',p_ok,'tested',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_set_connector_test(uuid,uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_set_connector_test(uuid,uuid,boolean,text) TO eliot_identity;

CREATE FUNCTION eliot.owner_remove_company_connector(p_org uuid,p_connector uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_holding uuid; v_kind text; v_label text;
BEGIN
 actor:=eliot.company_connector_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 DELETE FROM eliot.company_connectors WHERE id=p_connector AND organization_id=p_org
  RETURNING kind,label INTO v_kind,v_label;
 IF NOT FOUND THEN RAISE EXCEPTION 'Connector not found' USING ERRCODE='22023'; END IF;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NOT NULL THEN
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
  VALUES(v_holding,p_org,actor,'connector_removed',jsonb_build_object('connector_id',p_connector,'kind',v_kind,'label',v_label));
 END IF;
 RETURN jsonb_build_object('organization_id',p_org,'connector_id',p_connector,'removed',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_remove_company_connector(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_remove_company_connector(uuid,uuid) TO eliot_identity;

-- Gestores: el propietario de la empresa invita; el invitado conecta FTP/BD de esa empresa solo.
CREATE FUNCTION eliot.owner_create_manager_invite(p_org uuid,p_label text,p_token_hash text,p_hours integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_id uuid; v_exp timestamptz; v_label text:=trim(coalesce(p_label,'')); v_holding uuid;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF length(v_label) NOT BETWEEN 1 AND 80 OR v_label ~ '[[:cntrl:]]' OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
  OR p_hours IS NULL OR p_hours NOT BETWEEN 1 AND 168 THEN
  RAISE EXCEPTION 'Invalid invite' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM eliot.organizations WHERE id=p_org FOR UPDATE;
 IF (SELECT count(*) FROM eliot.company_managers WHERE organization_id=p_org AND revoked_at IS NULL)
  +(SELECT count(*) FROM eliot.manager_invites WHERE organization_id=p_org AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at>clock_timestamp())>=8 THEN
  RAISE EXCEPTION 'Manager limit reached' USING ERRCODE='55000'; END IF;
 v_exp:=clock_timestamp()+make_interval(hours=>p_hours);
 INSERT INTO eliot.manager_invites(organization_id,token_hash,label,created_by,expires_at)
 VALUES(p_org,p_token_hash,v_label,actor,v_exp) RETURNING id INTO v_id;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NOT NULL THEN
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
  VALUES(v_holding,p_org,actor,'manager_invited',jsonb_build_object('invite_id',v_id,'label',v_label));
 END IF;
 RETURN jsonb_build_object('invite_id',v_id,'organization_id',p_org,'label',v_label,'expires_at',v_exp,'created',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_create_manager_invite(uuid,text,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_create_manager_invite(uuid,text,text,integer) TO eliot_identity;

CREATE FUNCTION eliot.redeem_manager_invite(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_subject text:=NULLIF(current_setting('app.verified_subject',true),'');
 inv eliot.manager_invites%ROWTYPE; v_name text; v_holding uuid;
BEGIN
 IF v_subject IS NULL OR length(v_subject) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO inv FROM eliot.manager_invites WHERE token_hash=p_token_hash FOR UPDATE;
 IF NOT FOUND OR inv.redeemed_at IS NOT NULL OR inv.cancelled_at IS NOT NULL OR inv.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'Invite not valid' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
           WHERE m.organization_id=inv.organization_id AND m.role='owner' AND m.status='active' AND u.external_subject=v_subject) THEN
  RAISE EXCEPTION 'Owners cannot be managers' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.company_managers WHERE organization_id=inv.organization_id AND manager_subject=v_subject AND revoked_at IS NULL) THEN
  RAISE EXCEPTION 'Already a manager' USING ERRCODE='55000'; END IF;
 INSERT INTO eliot.users(external_subject) VALUES(v_subject)
  ON CONFLICT (external_subject) DO UPDATE SET external_subject=EXCLUDED.external_subject;
 INSERT INTO eliot.company_managers(organization_id,manager_subject,label,invited_by)
 VALUES(inv.organization_id,v_subject,inv.label,inv.created_by);
 UPDATE eliot.manager_invites SET redeemed_at=clock_timestamp() WHERE id=inv.id;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=inv.organization_id;
 IF v_holding IS NOT NULL THEN
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
  VALUES(v_holding,inv.organization_id,inv.created_by,'manager_joined',jsonb_build_object('invite_id',inv.id,'label',inv.label));
 END IF;
 SELECT name INTO v_name FROM eliot.organizations WHERE id=inv.organization_id;
 RETURN jsonb_build_object('organization_id',inv.organization_id,'company',v_name,'joined',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.redeem_manager_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.redeem_manager_invite(text) TO eliot_identity;

CREATE FUNCTION eliot.owner_company_managers(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.company_owner_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('organization_id',p_org,
  'managers',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'label',m.label,'since',m.created_at) ORDER BY m.created_at)
    FROM eliot.company_managers m WHERE m.organization_id=p_org AND m.revoked_at IS NULL),'[]'::jsonb),
  'invites',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',i.id,'label',i.label,'expires_at',i.expires_at) ORDER BY i.created_at)
    FROM eliot.manager_invites i WHERE i.organization_id=p_org AND i.redeemed_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at>clock_timestamp()),'[]'::jsonb));
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_company_managers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_company_managers(uuid) TO eliot_identity;

CREATE FUNCTION eliot.owner_revoke_manager(p_org uuid,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_label text; v_kind text; v_holding uuid;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 UPDATE eliot.company_managers SET revoked_at=clock_timestamp()
  WHERE id=p_id AND organization_id=p_org AND revoked_at IS NULL RETURNING label INTO v_label;
 IF FOUND THEN v_kind:='manager';
 ELSE
  UPDATE eliot.manager_invites SET cancelled_at=clock_timestamp()
   WHERE id=p_id AND organization_id=p_org AND redeemed_at IS NULL AND cancelled_at IS NULL RETURNING label INTO v_label;
  IF NOT FOUND THEN RAISE EXCEPTION 'Nothing to revoke' USING ERRCODE='22023'; END IF;
  v_kind:='invite';
 END IF;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NOT NULL THEN
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
  VALUES(v_holding,p_org,actor,'manager_revoked',jsonb_build_object('id',p_id,'label',v_label,'kind',v_kind));
 END IF;
 RETURN jsonb_build_object('organization_id',p_org,'id',p_id,'kind',v_kind,'revoked',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_revoke_manager(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_revoke_manager(uuid,uuid) TO eliot_identity;

CREATE FUNCTION eliot.my_managed_organizations() RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT jsonb_build_object('organization_id',o.id,'name',o.name,'label',cm.label,'role','manager')
 FROM eliot.company_managers cm
 JOIN eliot.organizations o ON o.id=cm.organization_id
 WHERE cm.revoked_at IS NULL
   AND cm.manager_subject=NULLIF(current_setting('app.verified_subject',true),'')
 ORDER BY o.name
$fn$;
REVOKE ALL ON FUNCTION eliot.my_managed_organizations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_managed_organizations() TO eliot_identity;

COMMIT;

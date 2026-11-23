-- 037: almacén cifrado por empresa (Northlane360) y nombre del holding. Aplicar UNA vez como
-- administrador DESPUÉS de 036, tras pasar el pipeline PG desechable.
--
-- * La base de datos NUNCA ve llaves en claro. La API cifra con la llave maestra (que vive solo en
--   el entorno del servidor) el acceso al proveedor y la llave propia de cada empresa, y aquí se
--   guarda únicamente ese texto cifrado.
-- * Un holding tiene UNA conexión con el proveedor (hoy Google Drive, cuenta exclusiva). Cada
--   empresa tiene SU llave y SU carpeta: los archivos de una empresa no se pueden leer con la
--   llave de otra.
-- * Solo el propietario del holding conecta o desconecta; solo el propietario de una empresa
--   obtiene la llave cifrada de ESA empresa. Todo queda auditado, sin llaves en la auditoría.
BEGIN;
SET LOCAL ROLE eliot_migrator;

ALTER TABLE eliot.holding_audit DROP CONSTRAINT holding_audit_action_check;
ALTER TABLE eliot.holding_audit ADD CONSTRAINT holding_audit_action_check
 CHECK(action IN ('company_provisioned','profile_updated','capability_changed','company_renamed',
  'holding_renamed','storage_connected','storage_disconnected','company_storage_created'));

CREATE TABLE eliot.holding_storage (
 holding_id uuid PRIMARY KEY REFERENCES eliot.holdings(id),
 provider text NOT NULL CHECK(provider IN ('google_drive')),
 token_cipher text NOT NULL CHECK(token_cipher LIKE 'nl360:v1:%' AND length(token_cipher) BETWEEN 40 AND 6000),
 root_folder_id text NOT NULL CHECK(root_folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
 connected_by uuid NOT NULL REFERENCES eliot.users(id),
 connected_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE eliot.company_storage (
 organization_id uuid PRIMARY KEY REFERENCES eliot.organizations(id),
 key_cipher text NOT NULL CHECK(key_cipher LIKE 'nl360:v1:%' AND length(key_cipher) BETWEEN 40 AND 600),
 folder_id text NOT NULL CHECK(folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
 created_by uuid NOT NULL REFERENCES eliot.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['holding_storage','company_storage'] LOOP
  EXECUTE format('ALTER TABLE eliot.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE eliot.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY migrator_%s ON eliot.%I FOR ALL TO eliot_migrator USING(true) WITH CHECK(true)',t,t);
 END LOOP;
END $rls$;
CREATE POLICY holding037_holdings_update ON eliot.holdings FOR UPDATE TO eliot_migrator USING(true) WITH CHECK(true);

-- Propietario del holding según la identidad verificada por la API. NULL si no lo es.
CREATE FUNCTION eliot.holding_owner_actor(p_holding uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT u.id FROM eliot.holding_owners ho JOIN eliot.users u ON u.id=ho.user_id
 WHERE ho.holding_id=p_holding AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
$fn$;
REVOKE ALL ON FUNCTION eliot.holding_owner_actor(uuid) FROM PUBLIC;

CREATE FUNCTION eliot.owner_rename_holding(p_holding uuid,p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_old text; v_new text;
BEGIN
 actor:=eliot.holding_owner_actor(p_holding);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 v_new:=trim(p_name);
 IF v_new IS NULL OR length(v_new) NOT BETWEEN 2 AND 120 OR v_new ~ '[[:cntrl:]]' THEN
  RAISE EXCEPTION 'Invalid holding name' USING ERRCODE='22023'; END IF;
 SELECT name INTO v_old FROM eliot.holdings WHERE id=p_holding FOR UPDATE;
 IF v_old=v_new THEN RETURN jsonb_build_object('holding_id',p_holding,'name',v_new,'renamed',false); END IF;
 UPDATE eliot.holdings SET name=v_new WHERE id=p_holding;
 INSERT INTO eliot.holding_audit(holding_id,actor,action,detail)
 VALUES(p_holding,actor,'holding_renamed',jsonb_build_object('from',v_old,'to',v_new));
 RETURN jsonb_build_object('holding_id',p_holding,'name',v_new,'renamed',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_rename_holding(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_rename_holding(uuid,text) TO eliot_identity;

-- Estado de la conexión. Devuelve el acceso CIFRADO solo al propietario del holding.
CREATE FUNCTION eliot.owner_holding_storage(p_holding uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE s eliot.holding_storage;
BEGIN
 IF eliot.holding_owner_actor(p_holding) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM eliot.holding_storage WHERE holding_id=p_holding;
 IF NOT FOUND THEN RETURN jsonb_build_object('holding_id',p_holding,'connected',false); END IF;
 RETURN jsonb_build_object('holding_id',p_holding,'connected',true,'provider',s.provider,'token_cipher',s.token_cipher,
  'root_folder_id',s.root_folder_id,'connected_at',s.connected_at,
  'companies_with_storage',(SELECT count(*) FROM eliot.company_storage cs JOIN eliot.holding_companies c ON c.organization_id=cs.organization_id WHERE c.holding_id=p_holding));
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_holding_storage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_holding_storage(uuid) TO eliot_identity;

-- Conecta (o vuelve a conectar) el proveedor. La carpeta raíz no cambia mientras haya empresas con almacén.
CREATE FUNCTION eliot.owner_connect_holding_storage(p_holding uuid,p_provider text,p_token_cipher text,p_root_folder_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; s eliot.holding_storage; v_reconnected boolean:=false;
BEGIN
 actor:=eliot.holding_owner_actor(p_holding);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_provider IS DISTINCT FROM 'google_drive' OR p_token_cipher IS NULL OR p_token_cipher NOT LIKE 'nl360:v1:%'
  OR length(p_token_cipher) NOT BETWEEN 40 AND 6000 OR p_root_folder_id IS NULL OR p_root_folder_id !~ '^[A-Za-z0-9_-]{10,200}$' THEN
  RAISE EXCEPTION 'Invalid storage connection' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM eliot.holdings WHERE id=p_holding FOR UPDATE;
 SELECT * INTO s FROM eliot.holding_storage WHERE holding_id=p_holding;
 IF FOUND THEN
  v_reconnected:=true;
  IF s.root_folder_id<>p_root_folder_id AND EXISTS(SELECT 1 FROM eliot.company_storage cs
     JOIN eliot.holding_companies c ON c.organization_id=cs.organization_id WHERE c.holding_id=p_holding) THEN
   RAISE EXCEPTION 'Storage already holds company folders' USING ERRCODE='55000'; END IF;
  UPDATE eliot.holding_storage SET provider=p_provider,token_cipher=p_token_cipher,root_folder_id=p_root_folder_id,
   connected_by=actor,connected_at=clock_timestamp() WHERE holding_id=p_holding;
 ELSE
  INSERT INTO eliot.holding_storage(holding_id,provider,token_cipher,root_folder_id,connected_by)
  VALUES(p_holding,p_provider,p_token_cipher,p_root_folder_id,actor);
 END IF;
 INSERT INTO eliot.holding_audit(holding_id,actor,action,detail)
 VALUES(p_holding,actor,'storage_connected',jsonb_build_object('provider',p_provider,'reconnected',v_reconnected));
 RETURN jsonb_build_object('holding_id',p_holding,'connected',true,'provider',p_provider,'reconnected',v_reconnected);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_connect_holding_storage(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_connect_holding_storage(uuid,text,text,text) TO eliot_identity;

-- Desconectar borra el acceso al proveedor. Las llaves y carpetas de cada empresa se conservan:
-- sin ellas los archivos ya subidos serían irrecuperables.
CREATE FUNCTION eliot.owner_disconnect_holding_storage(p_holding uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; n integer;
BEGIN
 actor:=eliot.holding_owner_actor(p_holding);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 DELETE FROM eliot.holding_storage WHERE holding_id=p_holding;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n>0 THEN INSERT INTO eliot.holding_audit(holding_id,actor,action) VALUES(p_holding,actor,'storage_disconnected'); END IF;
 RETURN jsonb_build_object('holding_id',p_holding,'connected',false,'removed',n>0);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_disconnect_holding_storage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_disconnect_holding_storage(uuid) TO eliot_identity;

-- Almacén de UNA empresa: su llave cifrada y su carpeta, más el acceso cifrado del holding.
-- Solo para el propietario de esa empresa.
CREATE FUNCTION eliot.owner_company_storage(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_holding uuid; s eliot.holding_storage; cs eliot.company_storage;
BEGIN
 IF eliot.company_owner_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 SELECT * INTO s FROM eliot.holding_storage WHERE holding_id=v_holding;
 IF v_holding IS NULL OR NOT FOUND THEN RETURN jsonb_build_object('organization_id',p_org,'connected',false,'ready',false); END IF;
 SELECT * INTO cs FROM eliot.company_storage WHERE organization_id=p_org;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('organization_id',p_org,'connected',true,'ready',false,'provider',s.provider,
   'token_cipher',s.token_cipher,'root_folder_id',s.root_folder_id,'holding_id',v_holding);
 END IF;
 RETURN jsonb_build_object('organization_id',p_org,'connected',true,'ready',true,'provider',s.provider,
  'token_cipher',s.token_cipher,'root_folder_id',s.root_folder_id,'holding_id',v_holding,
  'key_cipher',cs.key_cipher,'folder_id',cs.folder_id);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_company_storage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_company_storage(uuid) TO eliot_identity;

-- Da de alta el almacén de una empresa UNA sola vez. Si ya existe, devuelve el existente y NO lo
-- cambia: sustituir la llave dejaría ilegibles los archivos ya subidos.
CREATE FUNCTION eliot.owner_create_company_storage(p_org uuid,p_key_cipher text,p_folder_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_holding uuid; cs eliot.company_storage;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_key_cipher IS NULL OR p_key_cipher NOT LIKE 'nl360:v1:%' OR length(p_key_cipher) NOT BETWEEN 40 AND 600
  OR p_folder_id IS NULL OR p_folder_id !~ '^[A-Za-z0-9_-]{10,200}$' THEN
  RAISE EXCEPTION 'Invalid company storage' USING ERRCODE='22023'; END IF;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NULL OR NOT EXISTS(SELECT 1 FROM eliot.holding_storage WHERE holding_id=v_holding) THEN
  RAISE EXCEPTION 'Holding storage is not connected' USING ERRCODE='55000'; END IF;
 INSERT INTO eliot.company_storage(organization_id,key_cipher,folder_id,created_by) VALUES(p_org,p_key_cipher,p_folder_id,actor)
 ON CONFLICT(organization_id) DO NOTHING;
 IF FOUND THEN
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action) VALUES(v_holding,p_org,actor,'company_storage_created');
  RETURN jsonb_build_object('organization_id',p_org,'created',true,'key_cipher',p_key_cipher,'folder_id',p_folder_id);
 END IF;
 SELECT * INTO cs FROM eliot.company_storage WHERE organization_id=p_org;
 RETURN jsonb_build_object('organization_id',p_org,'created',false,'key_cipher',cs.key_cipher,'folder_id',cs.folder_id);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_create_company_storage(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_create_company_storage(uuid,text,text) TO eliot_identity;
COMMIT;

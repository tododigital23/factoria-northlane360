-- 038: el propietario puede RETIRAR una empresa de La Factoría para dejar su parcela libre.
-- Aplicar UNA vez como administrador DESPUÉS de 037, tras pasar el pipeline PG desechable.
--
-- * Retirar NO borra nada: departamentos, agentes, tareas, memoria y documentos se conservan.
--   La empresa sale del holding (su parcela queda libre) y deja de aparecer en las listas del propietario.
-- * Sus tareas recurrentes se pausan, para que una empresa retirada no siga generando trabajo.
-- * No se puede retirar con pilotos automáticos de misión en marcha: primero hay que pararlos.
-- * Solo quien es propietario del holding Y de esa empresa. Queda auditado (nombre y parcela).
-- * Deshacerlo es una operación de administrador (volver a insertar en holding_companies).
BEGIN;
SET LOCAL ROLE eliot_migrator;

ALTER TABLE eliot.holding_audit DROP CONSTRAINT holding_audit_action_check;
ALTER TABLE eliot.holding_audit ADD CONSTRAINT holding_audit_action_check
 CHECK(action IN ('company_provisioned','profile_updated','capability_changed','company_renamed',
  'holding_renamed','storage_connected','storage_disconnected','company_storage_created','company_retired'));

CREATE TABLE eliot.retired_companies (
 organization_id uuid PRIMARY KEY REFERENCES eliot.organizations(id),
 holding_id uuid NOT NULL REFERENCES eliot.holdings(id),
 slot integer NOT NULL,
 name text NOT NULL,
 retired_by uuid NOT NULL REFERENCES eliot.users(id),
 retired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE eliot.retired_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.retired_companies FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_retired_companies ON eliot.retired_companies FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_retire_company(p_org uuid,p_confirm_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_holding uuid; v_slot integer; v_name text; v_paused integer;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT holding_id,slot INTO v_holding,v_slot FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NULL THEN RAISE EXCEPTION 'Company is not part of a holding' USING ERRCODE='55000'; END IF;
 IF eliot.holding_actor(v_holding) IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 -- Mismo cerrojo que el alta y el renombrado: nadie ocupa ni cambia la parcela a la vez.
 PERFORM 1 FROM eliot.holdings WHERE id=v_holding FOR UPDATE;
 SELECT name INTO v_name FROM eliot.organizations WHERE id=p_org;
 -- Hay que escribir el nombre exacto de la empresa: evita retirar la que no es.
 IF p_confirm_name IS NULL OR trim(p_confirm_name)<>v_name THEN RAISE EXCEPTION 'Company name does not match' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.ai_document_mission_autopilots a WHERE a.organization_id=p_org AND a.state='active' AND a.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Company has active mission autopilots' USING ERRCODE='55000'; END IF;
 UPDATE eliot.department_routines SET state='paused' WHERE organization_id=p_org AND state='active';
 GET DIAGNOSTICS v_paused=ROW_COUNT;
 DELETE FROM eliot.holding_companies WHERE organization_id=p_org AND holding_id=v_holding;
 INSERT INTO eliot.retired_companies(organization_id,holding_id,slot,name,retired_by) VALUES(p_org,v_holding,v_slot,v_name,actor)
 ON CONFLICT(organization_id) DO UPDATE SET holding_id=EXCLUDED.holding_id,slot=EXCLUDED.slot,name=EXCLUDED.name,retired_by=EXCLUDED.retired_by,retired_at=clock_timestamp();
 INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
 VALUES(v_holding,p_org,actor,'company_retired',jsonb_build_object('name',v_name,'slot',v_slot,'routines_paused',v_paused));
 RETURN jsonb_build_object('organization_id',p_org,'name',v_name,'slot',v_slot,'retired',true,'routines_paused',v_paused);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_retire_company(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_retire_company(uuid,text) TO eliot_identity;

-- Las empresas que quien llama ha retirado: sirve para no enseñárselas en sus listas.
CREATE FUNCTION eliot.my_retired_companies() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT r.organization_id FROM eliot.retired_companies r
 JOIN eliot.organization_memberships m ON m.organization_id=r.organization_id AND m.status='active'
 JOIN eliot.users u ON u.id=m.user_id
 WHERE u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
   AND NOT EXISTS(SELECT 1 FROM eliot.holding_companies c WHERE c.organization_id=r.organization_id)
$fn$;
REVOKE ALL ON FUNCTION eliot.my_retired_companies() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_retired_companies() TO eliot_identity;
COMMIT;

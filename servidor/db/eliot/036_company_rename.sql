-- 036: el propietario puede cambiar el NOMBRE de una de sus empresas (p. ej. distinguir
-- «Nova Demo Portal» de «Nova Demo LLC»). Aplicar UNA vez como administrador
-- DESPUÉS de 035, tras pasar el pipeline PG desechable.
--
-- * Solo cambia eliot.organizations.name. No mueve datos, agentes, tareas ni permisos.
-- * Solo el propietario activo de ESA empresa. El nombre no puede repetirse dentro del holding.
-- * Queda auditado (nombre anterior y nuevo) en eliot.holding_audit, que sigue siendo solo de alta.
BEGIN;
SET LOCAL ROLE eliot_migrator;

ALTER TABLE eliot.holding_audit DROP CONSTRAINT holding_audit_action_check;
ALTER TABLE eliot.holding_audit ADD CONSTRAINT holding_audit_action_check
 CHECK(action IN ('company_provisioned','profile_updated','capability_changed','company_renamed'));

-- Política mínima para que la función SECURITY DEFINER (propiedad de eliot_migrator) pueda renombrar.
-- Ningún rol de aplicación gana acceso directo a la tabla.
CREATE POLICY holding036_organizations_update ON eliot.organizations FOR UPDATE TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_rename_company(p_org uuid,p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_holding uuid; v_old text; v_new text;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 v_new:=trim(p_name);
 IF v_new IS NULL OR length(v_new) NOT BETWEEN 2 AND 120 OR v_new ~ '[[:cntrl:]]' THEN
  RAISE EXCEPTION 'Invalid company name' USING ERRCODE='22023'; END IF;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NULL THEN RAISE EXCEPTION 'Company is not part of a holding' USING ERRCODE='55000'; END IF;
 -- Mismo cerrojo que el alta de empresas: dos cambios simultáneos no pueden dejar dos nombres iguales.
 PERFORM 1 FROM eliot.holdings WHERE id=v_holding FOR UPDATE;
 SELECT name INTO v_old FROM eliot.organizations WHERE id=p_org FOR UPDATE;
 IF v_old=v_new THEN RETURN jsonb_build_object('organization_id',p_org,'name',v_new,'renamed',false); END IF;
 IF EXISTS(SELECT 1 FROM eliot.holding_companies c JOIN eliot.organizations o ON o.id=c.organization_id
    WHERE c.holding_id=v_holding AND c.organization_id<>p_org AND lower(o.name)=lower(v_new)) THEN
  RAISE EXCEPTION 'Company name already used in this holding' USING ERRCODE='55000'; END IF;
 UPDATE eliot.organizations SET name=v_new WHERE id=p_org;
 INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
 VALUES(v_holding,p_org,actor,'company_renamed',jsonb_build_object('from',v_old,'to',v_new));
 RETURN jsonb_build_object('organization_id',p_org,'name',v_new,'renamed',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_rename_company(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_rename_company(uuid,text) TO eliot_identity;
COMMIT;

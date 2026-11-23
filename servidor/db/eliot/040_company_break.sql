-- 040: MODO DESCANSO por empresa. El propietario manda a todos los agentes de una empresa a la sala de descanso:
-- mientras dura, esa empresa no arranca trabajo de IA (el servidor y el trabajador en segundo plano lo consultan antes de empezar).
-- Aplicar UNA vez como administrador DESPUÉS de 039, tras pasar el pipeline PG desechable.
--
-- * No cambia el estado de ningún agente ni toca tareas: al terminar el descanso todo sigue donde estaba.
-- * Solo el propietario de la empresa lo enciende y lo apaga. Queda el historial (quién y cuándo).
-- * Un trabajo que ya estaba en marcha termina; lo que no se hace es empezar otro.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.company_breaks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 started_by uuid NOT NULL REFERENCES eliot.users(id),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ended_by uuid REFERENCES eliot.users(id),
 ended_at timestamptz,
 CHECK((ended_at IS NULL)=(ended_by IS NULL))
);
CREATE UNIQUE INDEX uq_company_break_open ON eliot.company_breaks(organization_id) WHERE ended_at IS NULL;
ALTER TABLE eliot.company_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.company_breaks FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_company_breaks ON eliot.company_breaks FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

-- Solo para el trabajador en segundo plano: ¿está esta empresa en descanso? Sí o no. El servidor web usa my_company_break, que exige ser miembro.
CREATE FUNCTION eliot.company_on_break(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT EXISTS(SELECT 1 FROM eliot.company_breaks b WHERE b.organization_id=p_org AND b.ended_at IS NULL)
$fn$;

-- Para la pantalla: cualquier miembro de la empresa ve si hay descanso y desde cuándo.
CREATE FUNCTION eliot.my_company_break(p_org uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_since timestamptz;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id WHERE m.organization_id=p_org AND m.status='active'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT started_at INTO v_since FROM eliot.company_breaks WHERE organization_id=p_org AND ended_at IS NULL;
 RETURN jsonb_build_object('organization_id',p_org,'on_break',v_since IS NOT NULL,'since',v_since);
END $fn$;

CREATE FUNCTION eliot.owner_set_company_break(p_org uuid,p_on boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_since timestamptz; v_changed boolean:=false;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_on IS NULL THEN RAISE EXCEPTION 'Missing value' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM eliot.organizations WHERE id=p_org FOR UPDATE;      -- dos pulsaciones a la vez no abren dos descansos
 SELECT started_at INTO v_since FROM eliot.company_breaks WHERE organization_id=p_org AND ended_at IS NULL;
 IF p_on AND v_since IS NULL THEN
  INSERT INTO eliot.company_breaks(organization_id,started_by) VALUES(p_org,actor) RETURNING started_at INTO v_since;
  v_changed:=true;
 ELSIF NOT p_on AND v_since IS NOT NULL THEN
  UPDATE eliot.company_breaks SET ended_at=clock_timestamp(),ended_by=actor WHERE organization_id=p_org AND ended_at IS NULL;
  v_since:=NULL; v_changed:=true;
 END IF;
 RETURN jsonb_build_object('organization_id',p_org,'on_break',v_since IS NOT NULL,'since',v_since,'changed',v_changed);
END $fn$;

REVOKE ALL ON FUNCTION eliot.company_on_break(uuid),eliot.my_company_break(uuid),eliot.owner_set_company_break(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_company_break(uuid),eliot.owner_set_company_break(uuid,boolean) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.company_on_break(uuid) TO eliot_execution_worker;
COMMIT;

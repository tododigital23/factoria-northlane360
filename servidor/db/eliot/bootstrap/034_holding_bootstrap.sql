-- Arranque del holding de Freddy (ejecutar UNA vez, como administrador, DESPUÉS de 034).
-- No contiene secretos. Variables psql obligatorias:
--   -v holding_name='Superempresa Freddy'
--   -v owner_subject='auth0|...'              (sujeto Auth0 del propietario; ya existe en eliot.users)
--   -v first_org='11111111-2222-4333-8444-555555555555'   (Nova Demo → hueco 1)
--   -v first_project='Centro de Mando IA'
--   -v first_summary='Plataforma ELIOT/Freddy de dirección y agentes IA'
--   -v first_repo='tu-organizacion/factoria-northlane360'
-- Ejemplo: psql -v ON_ERROR_STOP=1 -v holding_name=... -f db/eliot/bootstrap/034_holding_bootstrap.sql
BEGIN;
SET LOCAL ROLE eliot_migrator;
DO $chk$ BEGIN
 IF to_regclass('eliot.holdings') IS NULL THEN RAISE EXCEPTION '034 no está instalada'; END IF;
END $chk$;
CREATE TEMP TABLE bootstrap_input ON COMMIT DROP AS
 SELECT :'holding_name'::text AS holding_name, :'owner_subject'::text AS owner_subject, :'first_org'::uuid AS first_org,
  :'first_project'::text AS first_project, :'first_summary'::text AS first_summary, :'first_repo'::text AS first_repo;
DO $boot$
DECLARE i record; v_user uuid; v_holding uuid;
BEGIN
 SELECT * INTO i FROM bootstrap_input;
 SELECT id INTO v_user FROM eliot.users WHERE external_subject=i.owner_subject;
 IF v_user IS NULL THEN RAISE EXCEPTION 'El propietario indicado no existe en eliot.users'; END IF;
 IF NOT EXISTS(SELECT 1 FROM eliot.organization_memberships WHERE organization_id=i.first_org AND user_id=v_user
   AND role='owner' AND status='active') THEN RAISE EXCEPTION 'El propietario no es owner activo de la primera empresa'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.holding_companies WHERE organization_id=i.first_org) THEN
  RAISE NOTICE 'La primera empresa ya pertenece a un holding: no se hace nada'; RETURN; END IF;
 INSERT INTO eliot.holdings(name,max_companies) VALUES(i.holding_name,5) RETURNING id INTO v_holding;
 INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(v_holding,v_user);
 INSERT INTO eliot.holding_companies(holding_id,organization_id,slot,created_by) VALUES(v_holding,i.first_org,1,v_user);
 INSERT INTO eliot.organization_profiles(organization_id,project_name,project_summary,repository,updated_by)
 VALUES(i.first_org,i.first_project,i.first_summary,NULLIF(i.first_repo,''),v_user) ON CONFLICT(organization_id) DO NOTHING;
 INSERT INTO eliot.organization_capabilities(organization_id,capability) VALUES(i.first_org,'repository') ON CONFLICT DO NOTHING;
 INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
 VALUES(v_holding,i.first_org,v_user,'company_provisioned',jsonb_build_object('slot',1,'bootstrap',true));
 RAISE NOTICE 'Holding % creado; empresa % en el hueco 1',v_holding,i.first_org;
END $boot$;
COMMIT;

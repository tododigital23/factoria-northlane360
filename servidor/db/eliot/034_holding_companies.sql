-- 034: Holding de Freddy con empresas aisladas, perfil de proyecto, capacidades por sector,
-- comunicación de agentes SOLO dentro de su empresa y tareas recurrentes por departamento.
-- Aplicar UNA vez como administrador DESPUÉS de 033, tras pasar el pipeline PG desechable.
-- No crea LOGIN, credenciales, conectores ni permisos de proveedor. Las capacidades (email,
-- pedidos, SEO…) quedan como 'planned': conectarlas exige un flujo propio con secretos fuera
-- de la base de datos.
--
-- Aislamiento:
-- * Cada empresa sigue siendo una organización independiente con sus FKs compuestas y RLS.
-- * El holding solo agrega RECUENTOS; nunca lee títulos, informes, mensajes ni documentos.
-- * Los mensajes entre agentes tienen FK compuesta (remitente, empresa) y (destinatario,
--   empresa): un mensaje entre empresas distintas es imposible por construcción.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.holdings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 2 AND 120),
 max_companies integer NOT NULL DEFAULT 5 CHECK(max_companies BETWEEN 1 AND 20),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE eliot.holding_owners (
 holding_id uuid NOT NULL REFERENCES eliot.holdings(id),
 user_id uuid NOT NULL REFERENCES eliot.users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(holding_id,user_id)
);
CREATE TABLE eliot.holding_companies (
 holding_id uuid NOT NULL REFERENCES eliot.holdings(id),
 organization_id uuid NOT NULL UNIQUE REFERENCES eliot.organizations(id),
 slot integer NOT NULL CHECK(slot BETWEEN 1 AND 20),
 created_by uuid REFERENCES eliot.users(id),
 request_key uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(holding_id,slot),
 UNIQUE(holding_id,request_key)
);
CREATE TABLE eliot.organization_profiles (
 organization_id uuid PRIMARY KEY REFERENCES eliot.organizations(id),
 project_name text NOT NULL CHECK(length(trim(project_name)) BETWEEN 2 AND 120),
 project_summary text NOT NULL CHECK(length(trim(project_summary)) BETWEEN 10 AND 600),
 repository text CHECK(repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
 website_url text CHECK(website_url ~ '^https://[A-Za-z0-9.-]{3,200}(:[0-9]{2,5})?(/[^[:space:]]*)?$' AND length(website_url)<=500),
 updated_by uuid REFERENCES eliot.users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE eliot.organization_capabilities (
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 capability text NOT NULL CHECK(capability IN ('repository','website','seo','marketing','email','orders','monitoring','automation')),
 state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','configured','enabled','disabled')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,capability)
);
CREATE TABLE eliot.holding_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 holding_id uuid NOT NULL REFERENCES eliot.holdings(id),
 organization_id uuid REFERENCES eliot.organizations(id),
 actor uuid NOT NULL REFERENCES eliot.users(id),
 action text NOT NULL CHECK(action IN ('company_provisioned','profile_updated','capability_changed')),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE eliot.ai_worker_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 from_worker_id uuid NOT NULL,
 to_worker_id uuid NOT NULL,
 task_id uuid,
 job_id uuid,
 body text NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT ck_worker_message_distinct CHECK(from_worker_id<>to_worker_id),
 CONSTRAINT fk_worker_message_from FOREIGN KEY(from_worker_id,organization_id) REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_worker_message_to FOREIGN KEY(to_worker_id,organization_id) REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_worker_message_task FOREIGN KEY(task_id,organization_id) REFERENCES eliot.ai_tasks(id,organization_id)
);
CREATE INDEX idx_worker_messages_org ON eliot.ai_worker_messages(organization_id,created_at DESC);
CREATE TABLE eliot.department_routines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 department_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 title text NOT NULL CHECK(length(trim(title)) BETWEEN 3 AND 160),
 instructions text NOT NULL CHECK(length(trim(instructions)) BETWEEN 10 AND 2000),
 cadence text NOT NULL CHECK(cadence IN ('daily','weekly','monthly')),
 capability text CHECK(capability IN ('repository','website','seo','marketing','email','orders','monitoring','automation')),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused')),
 created_by uuid NOT NULL REFERENCES eliot.users(id),
 request_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT uq_routine_org_id UNIQUE(organization_id,id),
 CONSTRAINT uq_routine_request UNIQUE(organization_id,request_key),
 CONSTRAINT fk_routine_department FOREIGN KEY(department_id,organization_id) REFERENCES eliot.departments(id,organization_id),
 CONSTRAINT fk_routine_worker FOREIGN KEY(worker_id,organization_id) REFERENCES eliot.ai_workers(id,organization_id)
);
CREATE TABLE eliot.department_routine_runs (
 organization_id uuid NOT NULL,
 routine_id uuid NOT NULL,
 period_key text NOT NULL CHECK(period_key ~ '^[0-9]{4}-(W[0-9]{2}|[0-9]{2}(-[0-9]{2})?)$'),
 task_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,routine_id,period_key),
 CONSTRAINT fk_routine_run_routine FOREIGN KEY(organization_id,routine_id) REFERENCES eliot.department_routines(organization_id,id),
 CONSTRAINT fk_routine_run_task FOREIGN KEY(task_id,organization_id) REFERENCES eliot.ai_tasks(id,organization_id)
);

DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['holdings','holding_owners','holding_companies','organization_profiles','organization_capabilities',
  'holding_audit','ai_worker_messages','department_routines','department_routine_runs'] LOOP
  EXECUTE format('ALTER TABLE eliot.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE eliot.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY migrator_%s ON eliot.%I FOR ALL TO eliot_migrator USING(true) WITH CHECK(true)',t,t);
 END LOOP;
END $rls$;

-- Políticas mínimas para que las funciones SECURITY DEFINER (propiedad de eliot_migrator) den de
-- alta empresas. Solo afectan al rol propietario de las funciones; ningún rol de aplicación gana acceso.
CREATE POLICY holding034_organizations_select ON eliot.organizations FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY holding034_organizations_insert ON eliot.organizations FOR INSERT TO eliot_migrator WITH CHECK(true);
CREATE POLICY holding034_users_select ON eliot.users FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY holding034_memberships_select ON eliot.organization_memberships FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY holding034_memberships_insert ON eliot.organization_memberships FOR INSERT TO eliot_migrator
 WITH CHECK(role='owner' AND status='active');
CREATE POLICY holding034_departments_select ON eliot.departments FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY holding034_departments_insert ON eliot.departments FOR INSERT TO eliot_migrator WITH CHECK(true);
CREATE POLICY holding034_workers_select ON eliot.ai_workers FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY holding034_workers_insert ON eliot.ai_workers FOR INSERT TO eliot_migrator WITH CHECK(operating_state='inactive');

-- Historial inmutable de auditoría y de mensajes.
CREATE FUNCTION eliot.guard_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='55000'; END $fn$;
REVOKE ALL ON FUNCTION eliot.guard_append_only() FROM PUBLIC;
CREATE TRIGGER guard_holding_audit_append_only BEFORE UPDATE OR DELETE ON eliot.holding_audit FOR EACH ROW EXECUTE FUNCTION eliot.guard_append_only();
CREATE TRIGGER guard_worker_messages_append_only BEFORE UPDATE OR DELETE ON eliot.ai_worker_messages FOR EACH ROW EXECUTE FUNCTION eliot.guard_append_only();
CREATE TRIGGER guard_routine_runs_append_only BEFORE UPDATE OR DELETE ON eliot.department_routine_runs FOR EACH ROW EXECUTE FUNCTION eliot.guard_append_only();

-- Plantilla de departamentos: base + por capacidad. Un agente inactivo por departamento.
CREATE FUNCTION eliot.company_department_template() RETURNS TABLE(sort integer,department text,capability text,worker text,specialty text)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 VALUES
 (1,'Dirección IA',NULL,'Director de empresa IA','Dirección, coordinación y escalado de la empresa'),
 (2,'Desarrollo',NULL,'Programador IA','Repositorio, web y desarrollo de software'),
 (3,'Calidad',NULL,'Verificador QA','Verificación de entregas y pruebas'),
 (4,'Operaciones',NULL,'Coordinador operativo IA','Operaciones y seguimiento del proyecto'),
 (5,'Marketing',NULL,'Especialista de marketing IA','Marketing digital y campañas'),
 (6,'Administración',NULL,'Analista administrativo IA','Administración, costes e informes'),
 (7,'SEO y Contenidos','seo','Especialista SEO IA','Posicionamiento web y contenidos'),
 (8,'Atención y Email','email','Gestor de email IA','Lectura y clasificación del email de la empresa'),
 (9,'Pedidos','orders','Gestor de pedidos IA','Control y seguimiento de pedidos'),
 (10,'Monitorización y Fallos','monitoring','Vigilante de fallos IA','Control automático de fallos y disponibilidad'),
 (11,'Automatizaciones','automation','Ingeniero de automatizaciones IA','Automatizaciones y flujos de la empresa')
$fn$;
REVOKE ALL ON FUNCTION eliot.company_department_template() FROM PUBLIC;

CREATE FUNCTION eliot.valid_company_links(p_repository text,p_website text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT (NULLIF(trim(p_repository),'') IS NULL OR trim(p_repository) ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$')
 AND (NULLIF(trim(p_website),'') IS NULL OR trim(p_website) ~ '^https://[A-Za-z0-9.-]{3,200}(:[0-9]{2,5})?(/[^[:space:]]*)?$' AND length(trim(p_website))<=500)
$fn$;
REVOKE ALL ON FUNCTION eliot.valid_company_links(text,text) FROM PUBLIC;

CREATE FUNCTION eliot.holding_actor(p_holding uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT u.id FROM eliot.users u JOIN eliot.holding_owners o ON o.user_id=u.id
 WHERE o.holding_id=p_holding AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
$fn$;
REVOKE ALL ON FUNCTION eliot.holding_actor(uuid) FROM PUBLIC;

CREATE FUNCTION eliot.company_owner_actor(p_org uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT u.id FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
$fn$;
REVOKE ALL ON FUNCTION eliot.company_owner_actor(uuid) FROM PUBLIC;

-- Crea los departamentos/agentes que falten para una capacidad (idempotente).
CREATE FUNCTION eliot.ensure_capability_departments(p_org uuid,p_capability text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE r record; d uuid; created integer:=0;
BEGIN
 FOR r IN SELECT * FROM eliot.company_department_template() WHERE capability IS NOT DISTINCT FROM p_capability ORDER BY sort LOOP
  SELECT id INTO d FROM eliot.departments WHERE organization_id=p_org AND name=r.department;
  IF NOT FOUND THEN
   INSERT INTO eliot.departments(organization_id,name) VALUES(p_org,r.department) RETURNING id INTO d;
   created:=created+1;
  END IF;
  INSERT INTO eliot.ai_workers(organization_id,department_id,display_name,specialty,operating_state)
  VALUES(p_org,d,r.worker,r.specialty,'inactive') ON CONFLICT (department_id,display_name) DO NOTHING;
 END LOOP;
 RETURN created;
END $fn$;
REVOKE ALL ON FUNCTION eliot.ensure_capability_departments(uuid,text) FROM PUBLIC;

CREATE FUNCTION eliot.owner_provision_company(p_holding uuid,p_name text,p_project_name text,p_project_summary text,
 p_repository text,p_website text,p_capabilities text[],p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; h eliot.holdings; saved eliot.holding_companies; v_org uuid; v_slot integer; cap text; n integer;
 caps text[]; result jsonb;
BEGIN
 actor:=eliot.holding_actor(p_holding);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Holding function ownership must be corrected' USING ERRCODE='55000'; END IF;
 caps:=COALESCE(p_capabilities,ARRAY[]::text[]);
 IF p_key IS NULL OR p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 2 AND 120
 OR p_project_name IS NULL OR length(trim(p_project_name)) NOT BETWEEN 2 AND 120
 OR p_project_summary IS NULL OR length(trim(p_project_summary)) NOT BETWEEN 10 AND 600
 OR NOT eliot.valid_company_links(p_repository,p_website)
 OR array_ndims(caps)>1 OR cardinality(caps)>8 OR array_position(caps,NULL) IS NOT NULL
 OR (SELECT count(DISTINCT x) FROM unnest(caps) x)<>cardinality(caps)
 OR EXISTS(SELECT 1 FROM unnest(caps) x WHERE x NOT IN ('repository','website','seo','marketing','email','orders','monitoring','automation')) THEN
  RAISE EXCEPTION 'Invalid company request' USING ERRCODE='22023'; END IF;
 SELECT * INTO h FROM eliot.holdings WHERE id=p_holding FOR UPDATE;
 SELECT * INTO saved FROM eliot.holding_companies WHERE holding_id=p_holding AND request_key=p_key;
 IF FOUND THEN
  IF saved.created_by IS DISTINCT FROM actor OR (SELECT name FROM eliot.organizations WHERE id=saved.organization_id) IS DISTINCT FROM trim(p_name) THEN
   RAISE EXCEPTION 'Conflicting company retry' USING ERRCODE='22023'; END IF;
  v_org:=saved.organization_id; v_slot:=saved.slot;
 ELSE
  IF EXISTS(SELECT 1 FROM eliot.holding_companies c JOIN eliot.organizations o ON o.id=c.organization_id
     WHERE c.holding_id=p_holding AND lower(o.name)=lower(trim(p_name))) THEN
   RAISE EXCEPTION 'Company name already used in this holding' USING ERRCODE='55000'; END IF;
  SELECT min(s) INTO v_slot FROM generate_series(1,h.max_companies) s
   WHERE NOT EXISTS(SELECT 1 FROM eliot.holding_companies c WHERE c.holding_id=p_holding AND c.slot=s);
  IF v_slot IS NULL THEN RAISE EXCEPTION 'Holding company limit reached' USING ERRCODE='55000'; END IF;
  INSERT INTO eliot.organizations(name) VALUES(trim(p_name)) RETURNING id INTO v_org;
  INSERT INTO eliot.organization_memberships(organization_id,user_id,role,status) VALUES(v_org,actor,'owner','active');
  INSERT INTO eliot.holding_companies(holding_id,organization_id,slot,created_by,request_key) VALUES(p_holding,v_org,v_slot,actor,p_key);
  INSERT INTO eliot.organization_profiles(organization_id,project_name,project_summary,repository,website_url,updated_by)
  VALUES(v_org,trim(p_project_name),trim(p_project_summary),NULLIF(trim(p_repository),''),NULLIF(trim(p_website),''),actor);
  PERFORM eliot.ensure_capability_departments(v_org,NULL);
  FOREACH cap IN ARRAY caps LOOP
   INSERT INTO eliot.organization_capabilities(organization_id,capability) VALUES(v_org,cap);
   PERFORM eliot.ensure_capability_departments(v_org,cap);
  END LOOP;
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
  VALUES(p_holding,v_org,actor,'company_provisioned',jsonb_build_object('slot',v_slot,'capabilities',to_jsonb(caps),'request_key',p_key));
 END IF;
 SELECT count(*) INTO n FROM eliot.ai_workers WHERE organization_id=v_org;
 SELECT jsonb_build_object('holding_id',p_holding,'organization_id',v_org,'slot',v_slot,'replayed',saved.organization_id IS NOT NULL,
  'departments',(SELECT jsonb_agg(jsonb_build_object('id',d.id,'name',d.name) ORDER BY t.sort)
    FROM eliot.departments d JOIN eliot.company_department_template() t ON t.department=d.name WHERE d.organization_id=v_org),
  'workers_created',n,'provider_called',false) INTO result;
 RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_provision_company(uuid,text,text,text,text,text,text[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_provision_company(uuid,text,text,text,text,text,text[],uuid) TO eliot_identity;

-- Perfil y capacidades: solo el propietario de esa empresa.
CREATE FUNCTION eliot.owner_update_company_profile(p_org uuid,p_project_name text,p_project_summary text,p_repository text,p_website text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_holding uuid;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_project_name IS NULL OR length(trim(p_project_name)) NOT BETWEEN 2 AND 120
 OR p_project_summary IS NULL OR length(trim(p_project_summary)) NOT BETWEEN 10 AND 600
 OR NOT eliot.valid_company_links(p_repository,p_website) THEN
  RAISE EXCEPTION 'Invalid profile' USING ERRCODE='22023'; END IF;
 INSERT INTO eliot.organization_profiles(organization_id,project_name,project_summary,repository,website_url,updated_by,updated_at)
 VALUES(p_org,trim(p_project_name),trim(p_project_summary),NULLIF(trim(p_repository),''),NULLIF(trim(p_website),''),actor,clock_timestamp())
 ON CONFLICT(organization_id) DO UPDATE SET project_name=EXCLUDED.project_name,project_summary=EXCLUDED.project_summary,
  repository=EXCLUDED.repository,website_url=EXCLUDED.website_url,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NOT NULL THEN
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action) VALUES(v_holding,p_org,actor,'profile_updated'); END IF;
 RETURN jsonb_build_object('organization_id',p_org,'updated',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_update_company_profile(uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_update_company_profile(uuid,text,text,text,text) TO eliot_identity;

-- 'enabled' se reserva a un flujo de conexión auditado posterior (credenciales fuera de la BD).
CREATE FUNCTION eliot.owner_set_company_capability(p_org uuid,p_capability text,p_state text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; v_holding uuid; created integer:=0;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_capability NOT IN ('repository','website','seo','marketing','email','orders','monitoring','automation')
 OR p_state NOT IN ('planned','disabled') THEN RAISE EXCEPTION 'Invalid capability change' USING ERRCODE='22023'; END IF;
 INSERT INTO eliot.organization_capabilities(organization_id,capability,state) VALUES(p_org,p_capability,p_state)
 ON CONFLICT(organization_id,capability) DO UPDATE SET state=EXCLUDED.state,updated_at=clock_timestamp();
 IF p_state='planned' THEN created:=eliot.ensure_capability_departments(p_org,p_capability); END IF;
 SELECT holding_id INTO v_holding FROM eliot.holding_companies WHERE organization_id=p_org;
 IF v_holding IS NOT NULL THEN
  INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
  VALUES(v_holding,p_org,actor,'capability_changed',jsonb_build_object('capability',p_capability,'state',p_state)); END IF;
 RETURN jsonb_build_object('organization_id',p_org,'capability',p_capability,'state',p_state,'departments_created',created);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_set_company_capability(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_set_company_capability(uuid,text,text) TO eliot_identity;

-- Vista del holding: solo recuentos agregados por empresa, nunca contenido.
CREATE FUNCTION eliot.my_holding() RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_user uuid;
BEGIN
 SELECT id INTO v_user FROM eliot.users WHERE external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF v_user IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',h.id,'name',h.name,'max_companies',h.max_companies,'is_owner',true,
  'companies',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'organization_id',o.id,'name',o.name,'slot',c.slot,'created_at',c.created_at,
    'project_name',p.project_name,'project_summary',p.project_summary,'repository',p.repository,'website_url',p.website_url,
    'capabilities',COALESCE((SELECT jsonb_agg(jsonb_build_object('capability',k.capability,'state',k.state) ORDER BY k.capability)
      FROM eliot.organization_capabilities k WHERE k.organization_id=o.id),'[]'::jsonb),
    'departments',(SELECT count(*) FROM eliot.departments d WHERE d.organization_id=o.id),
    'workers',(SELECT count(*) FROM eliot.ai_workers w WHERE w.organization_id=o.id),
    'active_workers',(SELECT count(*) FROM eliot.ai_workers w WHERE w.organization_id=o.id AND w.operating_state<>'inactive'),
    'tasks',jsonb_build_object(
      'pending',(SELECT count(*) FROM eliot.ai_tasks t WHERE t.organization_id=o.id AND t.status='pending'),
      'blocked',(SELECT count(*) FROM eliot.ai_tasks t WHERE t.organization_id=o.id AND t.status='blocked'),
      'completed',(SELECT count(*) FROM eliot.ai_tasks t WHERE t.organization_id=o.id AND t.status='completed'),
      'other',(SELECT count(*) FROM eliot.ai_tasks t WHERE t.organization_id=o.id AND t.status NOT IN ('pending','blocked','completed'))),
    'routines_active',(SELECT count(*) FROM eliot.department_routines r WHERE r.organization_id=o.id AND r.state='active'),
    'missions',(SELECT count(*) FROM eliot.ai_document_missions m WHERE m.organization_id=o.id),
    'autopilots_active',(SELECT count(*) FROM eliot.ai_document_mission_autopilots a WHERE a.organization_id=o.id
      AND a.state='active' AND a.expires_at>clock_timestamp())) ORDER BY c.slot)
   FROM eliot.holding_companies c JOIN eliot.organizations o ON o.id=c.organization_id
   LEFT JOIN eliot.organization_profiles p ON p.organization_id=o.id
   -- Doble barrera: solo empresas de las que el usuario sigue siendo propietario activo.
   JOIN eliot.organization_memberships mm ON mm.organization_id=o.id AND mm.user_id=v_user AND mm.status='active' AND mm.role='owner'
   WHERE c.holding_id=h.id),'[]'::jsonb))
 FROM eliot.holdings h JOIN eliot.holding_owners ho ON ho.holding_id=h.id AND ho.user_id=v_user ORDER BY h.created_at;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_holding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_holding() TO eliot_identity;

-- Mensajes entre agentes de la MISMA empresa. El agente remitente debe tener un trabajo
-- reclamado con su token (principal de ejecución de esa empresa); el propietario solo lee.
CREATE FUNCTION eliot.worker_post_agent_message(p_org uuid,p_job uuid,p_token uuid,p_to_worker uuid,p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE j eliot.ai_document_jobs; v_id uuid;
BEGIN
 j:=eliot.lock_worker_document_job(p_org,p_job,p_token);
 IF j.state NOT IN ('claimed','source_verified','provider_started') THEN RAISE EXCEPTION 'Job is not active' USING ERRCODE='55000'; END IF;
 IF p_body IS NULL OR length(trim(p_body)) NOT BETWEEN 1 AND 2000 THEN RAISE EXCEPTION 'Invalid message' USING ERRCODE='22023'; END IF;
 INSERT INTO eliot.ai_worker_messages(organization_id,from_worker_id,to_worker_id,task_id,job_id,body)
 VALUES(p_org,j.worker_id,p_to_worker,j.task_id,j.id,trim(p_body)) RETURNING id INTO v_id;
 RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION eliot.worker_post_agent_message(uuid,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.worker_post_agent_message(uuid,uuid,uuid,uuid,text) TO eliot_execution_worker;

CREATE FUNCTION eliot.my_agent_messages(p_org uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.company_owner_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',m.id,'from_worker_id',m.from_worker_id,'from_worker',fw.display_name,
  'to_worker_id',m.to_worker_id,'to_worker',tw.display_name,'task_id',m.task_id,'body',m.body,'created_at',m.created_at)
 FROM eliot.ai_worker_messages m
 JOIN eliot.ai_workers fw ON fw.organization_id=m.organization_id AND fw.id=m.from_worker_id
 JOIN eliot.ai_workers tw ON tw.organization_id=m.organization_id AND tw.id=m.to_worker_id
 WHERE m.organization_id=p_org ORDER BY m.created_at DESC LIMIT 50;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_agent_messages(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_agent_messages(uuid) TO eliot_identity;

-- Tareas recurrentes: el propietario las define; al vencer su periodo se crea UNA tarea
-- pendiente asignada (idempotente por periodo). Crear la tarea no ejecuta nada ni gasta cuota.
CREATE FUNCTION eliot.owner_create_routine(p_org uuid,p_department uuid,p_worker uuid,p_title text,p_instructions text,
 p_cadence text,p_capability text,p_key uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; saved eliot.department_routines; v_id uuid;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_title IS NULL OR length(trim(p_title)) NOT BETWEEN 3 AND 160 OR p_instructions IS NULL
 OR length(trim(p_instructions)) NOT BETWEEN 10 AND 2000 OR p_cadence NOT IN ('daily','weekly','monthly') THEN
  RAISE EXCEPTION 'Invalid routine' USING ERRCODE='22023'; END IF;
 IF p_capability IS NOT NULL AND p_capability NOT IN ('repository','website','seo','marketing','email','orders','monitoring','automation') THEN
  RAISE EXCEPTION 'Invalid routine capability' USING ERRCODE='22023'; END IF;
 SELECT * INTO saved FROM eliot.department_routines WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF saved.department_id IS DISTINCT FROM p_department OR saved.worker_id IS DISTINCT FROM p_worker OR saved.title IS DISTINCT FROM trim(p_title)
  OR saved.cadence IS DISTINCT FROM p_cadence THEN RAISE EXCEPTION 'Conflicting routine retry' USING ERRCODE='22023'; END IF;
  RETURN saved.id;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM eliot.ai_workers WHERE organization_id=p_org AND id=p_worker AND department_id=p_department) THEN
  RAISE EXCEPTION 'Worker must belong to the department of this company' USING ERRCODE='22023'; END IF;
 INSERT INTO eliot.department_routines(organization_id,department_id,worker_id,title,instructions,cadence,capability,created_by,request_key)
 VALUES(p_org,p_department,p_worker,trim(p_title),trim(p_instructions),p_cadence,p_capability,actor,p_key) RETURNING id INTO v_id;
 RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_create_routine(uuid,uuid,uuid,text,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_create_routine(uuid,uuid,uuid,text,text,text,text,uuid) TO eliot_identity;

CREATE FUNCTION eliot.owner_control_routine(p_org uuid,p_routine uuid,p_state text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.company_owner_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_state NOT IN ('active','paused') THEN RAISE EXCEPTION 'Invalid routine state' USING ERRCODE='22023'; END IF;
 UPDATE eliot.department_routines SET state=p_state WHERE organization_id=p_org AND id=p_routine;
 IF NOT FOUND THEN RAISE EXCEPTION 'Routine unavailable' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('routine_id',p_routine,'state',p_state);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_control_routine(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_control_routine(uuid,uuid,text) TO eliot_identity;

CREATE FUNCTION eliot.routine_period_key(p_cadence text,p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT CASE p_cadence WHEN 'daily' THEN to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD')
  WHEN 'weekly' THEN to_char(p_at AT TIME ZONE 'UTC','IYYY-"W"IW') ELSE to_char(p_at AT TIME ZONE 'UTC','YYYY-MM') END
$fn$;
REVOKE ALL ON FUNCTION eliot.routine_period_key(text,timestamptz) FROM PUBLIC;

CREATE FUNCTION eliot.materialize_due_routines_internal(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE r record; v_period text; v_task uuid; created integer:=0;
BEGIN
 FOR r IN SELECT * FROM eliot.department_routines WHERE organization_id=p_org AND state='active' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LOOP
  v_period:=eliot.routine_period_key(r.cadence,clock_timestamp());
  CONTINUE WHEN EXISTS(SELECT 1 FROM eliot.department_routine_runs WHERE organization_id=p_org AND routine_id=r.id AND period_key=v_period);
  INSERT INTO eliot.ai_tasks(organization_id,department_id,assignee_worker_id,title)
  VALUES(p_org,r.department_id,r.worker_id,left(r.title,180)||' · '||v_period) RETURNING id INTO v_task;
  INSERT INTO eliot.department_routine_runs(organization_id,routine_id,period_key,task_id) VALUES(p_org,r.id,v_period,v_task);
  INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
  VALUES(p_org,v_task,r.worker_id,'reported','Recurring routine '||r.id::text||' created this pending task for period '||v_period||'; no execution');
  created:=created+1;
 END LOOP;
 RETURN created;
END $fn$;
REVOKE ALL ON FUNCTION eliot.materialize_due_routines_internal(uuid) FROM PUBLIC;

CREATE FUNCTION eliot.owner_run_due_routines(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.company_owner_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN eliot.materialize_due_routines_internal(p_org);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_run_due_routines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_run_due_routines(uuid) TO eliot_identity;

-- El trabajador de ejecución de ESA empresa también puede materializarlas (sin dueño presente).
CREATE FUNCTION eliot.worker_run_due_routines(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF NOT eliot.document_job_worker_allowed(p_org) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN eliot.materialize_due_routines_internal(p_org);
END $fn$;
REVOKE ALL ON FUNCTION eliot.worker_run_due_routines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.worker_run_due_routines(uuid) TO eliot_execution_worker;

CREATE FUNCTION eliot.my_routines(p_org uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.company_owner_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',r.id,'department_id',r.department_id,'department',d.name,'worker_id',r.worker_id,
  'worker',w.display_name,'title',r.title,'instructions',r.instructions,'cadence',r.cadence,'capability',r.capability,'state',r.state,
  'created_at',r.created_at,'last_period',(SELECT max(x.period_key) FROM eliot.department_routine_runs x WHERE x.organization_id=r.organization_id AND x.routine_id=r.id),
  'runs',(SELECT count(*) FROM eliot.department_routine_runs x WHERE x.organization_id=r.organization_id AND x.routine_id=r.id))
 FROM eliot.department_routines r
 JOIN eliot.departments d ON d.organization_id=r.organization_id AND d.id=r.department_id
 JOIN eliot.ai_workers w ON w.organization_id=r.organization_id AND w.id=r.worker_id
 WHERE r.organization_id=p_org ORDER BY r.created_at DESC LIMIT 100;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_routines(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_routines(uuid) TO eliot_identity;
COMMIT;

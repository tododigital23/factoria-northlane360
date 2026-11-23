-- 035: «Pedir una tarea» a un agente concreto con el encargo completo, y memoria compartida
-- de cada empresa (lo que saben todos sus agentes). Aplicar UNA vez como administrador
-- DESPUÉS de 034, tras pasar el pipeline PG desechable.
--
-- * El encargo crea una tarea PENDIENTE asignada al agente reutilizando create_task_for_owner
--   (idempotente, solo propietario). No ejecuta nada, no gasta cuota ni envía datos a proveedores.
-- * La memoria es por empresa (PK compuesta con organization_id): ningún agente ni usuario de otra
--   empresa puede leerla. Su envío a un proveedor de IA requerirá consentimiento propio (no aquí).
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_task_requests (
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 department_id uuid NOT NULL,
 request text NOT NULL CHECK(length(trim(request)) BETWEEN 10 AND 2000),
 deliverable text CHECK(deliverable IS NULL OR length(trim(deliverable)) BETWEEN 1 AND 300),
 requested_by uuid NOT NULL REFERENCES eliot.users(id),
 request_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,task_id),
 CONSTRAINT uq_task_request_key UNIQUE(organization_id,request_key),
 CONSTRAINT fk_task_request_task FOREIGN KEY(task_id,organization_id) REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_task_request_worker FOREIGN KEY(worker_id,organization_id) REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_task_request_department FOREIGN KEY(department_id,organization_id) REFERENCES eliot.departments(id,organization_id)
);
CREATE INDEX idx_task_requests_recent ON eliot.ai_task_requests(organization_id,created_at DESC);
CREATE TABLE eliot.company_memory (
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 key text NOT NULL CHECK(key IN ('audience','pricing','value_proposition','brand_tone','products','faq')),
 content text NOT NULL CHECK(length(content)<=2000),
 updated_by uuid NOT NULL REFERENCES eliot.users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,key)
);
DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['ai_task_requests','company_memory'] LOOP
  EXECUTE format('ALTER TABLE eliot.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE eliot.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY migrator_%s ON eliot.%I FOR ALL TO eliot_migrator USING(true) WITH CHECK(true)',t,t);
 END LOOP;
END $rls$;
CREATE TRIGGER guard_task_requests_append_only BEFORE UPDATE OR DELETE ON eliot.ai_task_requests
 FOR EACH ROW EXECUTE FUNCTION eliot.guard_append_only();

CREATE FUNCTION eliot.owner_request_agent_task(p_org uuid,p_worker uuid,p_request text,p_deliverable text,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; w eliot.ai_workers; saved eliot.ai_task_requests; v_title text; v_task uuid; v_first text;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Request function ownership must be corrected' USING ERRCODE='55000'; END IF;
 IF p_key IS NULL OR p_worker IS NULL OR p_request IS NULL OR length(trim(p_request)) NOT BETWEEN 10 AND 2000
 OR (p_deliverable IS NOT NULL AND length(trim(p_deliverable)) NOT BETWEEN 1 AND 300) THEN
  RAISE EXCEPTION 'Invalid request' USING ERRCODE='22023'; END IF;
 SELECT * INTO saved FROM eliot.ai_task_requests WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF saved.worker_id IS DISTINCT FROM p_worker OR saved.request IS DISTINCT FROM trim(p_request)
  OR saved.deliverable IS DISTINCT FROM NULLIF(trim(p_deliverable),'') OR saved.requested_by IS DISTINCT FROM actor THEN
   RAISE EXCEPTION 'Conflicting request retry' USING ERRCODE='22023'; END IF;
  SELECT title INTO v_title FROM eliot.ai_tasks WHERE organization_id=p_org AND id=saved.task_id;
  RETURN jsonb_build_object('organization_id',p_org,'worker_id',saved.worker_id,'task_id',saved.task_id,
   'department_id',saved.department_id,'title',v_title,'status','pending','replayed',true,'execution_started',false);
 END IF;
 SELECT * INTO w FROM eliot.ai_workers WHERE organization_id=p_org AND id=p_worker;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker unavailable' USING ERRCODE='22023'; END IF;
 -- Título legible: primera línea del encargo, recortada en una palabra.
 v_first:=trim(regexp_replace(split_part(trim(p_request),E'\n',1),'\s+',' ','g'));
 v_title:=CASE WHEN length(v_first)<=150 THEN v_first ELSE regexp_replace(left(v_first,150),'\s+\S*$','')||'…' END;
 IF length(v_title)<3 THEN v_title:='Encargo para '||w.display_name; END IF;
 v_task:=eliot.create_task_for_owner(p_org,w.department_id,p_worker,v_title,p_key);
 INSERT INTO eliot.ai_task_requests(organization_id,task_id,worker_id,department_id,request,deliverable,requested_by,request_key)
 VALUES(p_org,v_task,p_worker,w.department_id,trim(p_request),NULLIF(trim(p_deliverable),''),actor,p_key);
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,v_task,p_worker,'reported','Owner request recorded for '||w.display_name||'; pending, no execution or provider call');
 RETURN jsonb_build_object('organization_id',p_org,'worker_id',p_worker,'task_id',v_task,'department_id',w.department_id,
  'title',v_title,'status','pending','replayed',false,'execution_started',false);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_request_agent_task(uuid,uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_request_agent_task(uuid,uuid,text,text,uuid) TO eliot_identity;

CREATE FUNCTION eliot.my_task_requests(p_org uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.company_owner_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object('task_id',r.task_id,'worker_id',r.worker_id,'department_id',r.department_id,'title',t.title,
  'request',r.request,'deliverable',r.deliverable,'task_status',t.status,'created_at',r.created_at)
 FROM eliot.ai_task_requests r JOIN eliot.ai_tasks t ON t.organization_id=r.organization_id AND t.id=r.task_id
 WHERE r.organization_id=p_org ORDER BY r.created_at DESC LIMIT 50;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_task_requests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_task_requests(uuid) TO eliot_identity;

CREATE FUNCTION eliot.my_company_memory(p_org uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.company_owner_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object('key',m.key,'content',m.content,'updated_at',m.updated_at)
 FROM eliot.company_memory m WHERE m.organization_id=p_org
 ORDER BY array_position(ARRAY['audience','pricing','value_proposition','brand_tone','products','faq'],m.key);
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_company_memory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_company_memory(uuid) TO eliot_identity;

CREATE FUNCTION eliot.owner_set_company_memory(p_org uuid,p_key text,p_content text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid;
BEGIN
 actor:=eliot.company_owner_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_key NOT IN ('audience','pricing','value_proposition','brand_tone','products','faq') OR p_content IS NULL OR length(p_content)>2000 THEN
  RAISE EXCEPTION 'Invalid memory item' USING ERRCODE='22023'; END IF;
 INSERT INTO eliot.company_memory(organization_id,key,content,updated_by) VALUES(p_org,p_key,trim(p_content),actor)
 ON CONFLICT(organization_id,key) DO UPDATE SET content=EXCLUDED.content,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp();
 RETURN jsonb_build_object('organization_id',p_org,'key',p_key,'updated',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_set_company_memory(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_set_company_memory(uuid,text,text) TO eliot_identity;
COMMIT;

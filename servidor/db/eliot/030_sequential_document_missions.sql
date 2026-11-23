-- 030: Group 2-5 saved documentary plans; exact predecessor reviews gate dispatch.
-- Apply ONCE as administrator AFTER 029. Execute BEGIN separately before pasting the remainder.
BEGIN;
SET LOCAL ROLE eliot_migrator;
CREATE TABLE eliot.ai_document_missions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 created_by uuid NOT NULL,
 request_key uuid NOT NULL,
 objective text NOT NULL CHECK(length(trim(objective)) BETWEEN 10 AND 1000),
 plan_ids uuid[] NOT NULL CHECK(cardinality(plan_ids) BETWEEN 2 AND 5 AND array_position(plan_ids,NULL) IS NULL),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,created_by) REFERENCES eliot.organization_memberships(organization_id,user_id),
 UNIQUE(organization_id,id),UNIQUE(organization_id,request_key)
);
CREATE TABLE eliot.ai_document_mission_steps (
 organization_id uuid NOT NULL,
 mission_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 5),
 plan_id uuid NOT NULL,
 PRIMARY KEY(organization_id,mission_id,position),
 UNIQUE(organization_id,plan_id),
 FOREIGN KEY(organization_id,mission_id) REFERENCES eliot.ai_document_missions(organization_id,id),
 FOREIGN KEY(organization_id,plan_id) REFERENCES eliot.ai_document_plans(organization_id,id)
);
CREATE INDEX idx_document_missions_company ON eliot.ai_document_missions(organization_id,created_at DESC,id DESC);
ALTER TABLE eliot.ai_document_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_missions FORCE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_mission_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_mission_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_document_missions ON eliot.ai_document_missions FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);
CREATE POLICY migrator_document_mission_steps ON eliot.ai_document_mission_steps FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

-- Checks the whole chain, never a bounded UI window. Reviews are immutable decisions
-- on the exact linked job/run; later unrelated work does not replace that evidence.
CREATE FUNCTION eliot.document_mission_dependencies(p_org uuid,p_mission uuid,p_position integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT NOT EXISTS(
  SELECT 1 FROM eliot.ai_document_mission_steps s
  JOIN eliot.ai_document_plans p ON p.organization_id=s.organization_id AND p.id=s.plan_id
  LEFT JOIN eliot.ai_document_jobs j ON j.organization_id=p.organization_id AND j.id=p.job_id
  LEFT JOIN eliot.ai_document_work_reviews r ON r.organization_id=j.organization_id AND r.run_id=j.run_id
  WHERE s.organization_id=p_org AND s.mission_id=p_mission AND s.position<p_position
   AND (j.state IS DISTINCT FROM 'completed' OR r.decision IS DISTINCT FROM 'accepted'))
$fn$;
REVOKE ALL ON FUNCTION eliot.document_mission_dependencies(uuid,uuid,integer) FROM PUBLIC;

CREATE FUNCTION eliot.guard_document_mission_dispatch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE s record;
BEGIN
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Mission guard ownership must be corrected' USING ERRCODE='55000'; END IF;
 IF NEW.job_id IS NOT NULL AND OLD.job_id IS NULL THEN
  SELECT mission_id,position INTO s FROM eliot.ai_document_mission_steps
   WHERE organization_id=NEW.organization_id AND plan_id=NEW.id;
  IF FOUND AND NOT eliot.document_mission_dependencies(NEW.organization_id,s.mission_id,s.position) THEN
   RAISE EXCEPTION 'Previous mission reports require acceptance' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION eliot.guard_document_mission_dispatch() FROM PUBLIC;
CREATE TRIGGER guard_document_mission_dispatch BEFORE UPDATE OF job_id ON eliot.ai_document_plans
FOR EACH ROW EXECUTE FUNCTION eliot.guard_document_mission_dispatch();

CREATE FUNCTION eliot.owner_create_document_mission(p_org uuid,p_objective text,p_plans uuid[],p_key uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; saved eliot.ai_document_missions; v_plan eliot.ai_document_plans; v_task eliot.ai_tasks; result_id uuid; pid uuid; pos integer:=0;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Mission function ownership must be corrected' USING ERRCODE='55000'; END IF;
 IF p_key IS NULL OR p_objective IS NULL OR length(trim(p_objective)) NOT BETWEEN 10 AND 1000
 OR p_plans IS NULL OR cardinality(p_plans) NOT BETWEEN 2 AND 5 OR array_ndims(p_plans)<>1
 OR array_position(p_plans,NULL) IS NOT NULL OR (SELECT count(DISTINCT x) FROM unnest(p_plans) x)<>cardinality(p_plans) THEN
  RAISE EXCEPTION 'Invalid mission scope' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='eliot.ai_document_plans'::regclass AND tgname='guard_document_mission_dispatch' AND tgenabled IN ('O','A')) THEN
  RAISE EXCEPTION 'Mission dispatch guard unavailable' USING ERRCODE='55000'; END IF;
 -- Same task-first order as enqueue; sorted locks serialize overlapping creations.
 PERFORM x.id FROM eliot.ai_tasks x WHERE x.organization_id=p_org AND x.id IN
  (SELECT task_id FROM eliot.ai_document_plans WHERE organization_id=p_org AND id=ANY(p_plans)) ORDER BY x.id FOR UPDATE;
 PERFORM x.id FROM eliot.ai_document_plans x WHERE x.organization_id=p_org AND x.id=ANY(p_plans) ORDER BY x.id FOR UPDATE;
 SELECT * INTO saved FROM eliot.ai_document_missions WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF saved.created_by IS DISTINCT FROM actor OR saved.objective IS DISTINCT FROM trim(p_objective) OR saved.plan_ids IS DISTINCT FROM p_plans THEN
   RAISE EXCEPTION 'Conflicting mission retry' USING ERRCODE='22023'; END IF;
  RETURN saved.id;
 END IF;
 IF (SELECT count(DISTINCT task_id) FROM eliot.ai_document_plans WHERE organization_id=p_org AND id=ANY(p_plans))<>cardinality(p_plans) THEN
  RAISE EXCEPTION 'Distinct scoped tasks required' USING ERRCODE='22023'; END IF;
 FOREACH pid IN ARRAY p_plans LOOP
  SELECT * INTO v_plan FROM eliot.ai_document_plans WHERE organization_id=p_org AND id=pid;
  SELECT * INTO v_task FROM eliot.ai_tasks WHERE organization_id=p_org AND id=v_plan.task_id;
  IF v_plan.id IS NULL OR v_plan.created_by IS DISTINCT FROM actor OR v_plan.job_id IS NOT NULL OR v_plan.control_state<>'active'
   OR v_task.status<>'pending' OR v_task.assignee_worker_id IS DISTINCT FROM v_plan.worker_id OR v_task.updated_at IS DISTINCT FROM v_plan.task_updated_at
   OR NOT EXISTS(SELECT 1 FROM eliot.ai_workers w WHERE w.organization_id=p_org AND w.id=v_plan.worker_id AND w.department_id=v_task.department_id AND w.operating_state='idle')
   OR eliot.task_has_unconfirmed_execution(p_org,v_plan.task_id)
   OR EXISTS(SELECT 1 FROM eliot.ai_document_mission_steps WHERE organization_id=p_org AND plan_id=v_plan.id) THEN
   RAISE EXCEPTION 'Plan not eligible for mission' USING ERRCODE='55000'; END IF;
 END LOOP;
 INSERT INTO eliot.ai_document_missions(organization_id,created_by,request_key,objective,plan_ids)
 VALUES(p_org,actor,p_key,trim(p_objective),p_plans) RETURNING id INTO result_id;
 FOREACH pid IN ARRAY p_plans LOOP
  pos:=pos+1;
  INSERT INTO eliot.ai_document_mission_steps(organization_id,mission_id,position,plan_id) VALUES(p_org,result_id,pos,pid);
  SELECT * INTO v_plan FROM eliot.ai_document_plans WHERE organization_id=p_org AND id=pid;
  INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
  VALUES(p_org,v_plan.task_id,v_plan.worker_id,'reported','Document mission '||result_id::text||'; step '||pos::text||'; no dispatch');
 END LOOP;
 RETURN result_id;
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_create_document_mission(uuid,text,uuid[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_create_document_mission(uuid,text,uuid[],uuid) TO eliot_identity;

CREATE FUNCTION eliot.my_document_missions(p_org uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Mission function ownership must be corrected' USING ERRCODE='55000'; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',m.id,'objective',m.objective,'created_at',m.created_at,
  'owner_is_creator',m.created_by=actor,'max_jobs',cardinality(m.plan_ids),'estimated_token_units',cardinality(m.plan_ids)*2500,
  'steps',(SELECT jsonb_agg(jsonb_build_object('position',s.position,'plan_id',p.id,'task_id',p.task_id,
   'task_title',t.title,'worker_id',p.worker_id,'objective',p.objective,'repository',p.source_repo,'path',p.source_path,'ref',p.source_ref,'sha',p.source_sha,
   'job_id',p.job_id,'run_id',j.run_id,'job_state',j.state,'review_decision',r.decision,'control_state',p.control_state,
   'scope_current',t.status='pending' AND t.updated_at=p.task_updated_at AND t.assignee_worker_id=p.worker_id AND w.department_id=t.department_id AND w.operating_state='idle',
   'dependency_satisfied',eliot.document_mission_dependencies(p_org,m.id,s.position)) ORDER BY s.position)
  FROM eliot.ai_document_mission_steps s JOIN eliot.ai_document_plans p ON p.organization_id=s.organization_id AND p.id=s.plan_id
  JOIN eliot.ai_tasks t ON t.organization_id=p.organization_id AND t.id=p.task_id
  JOIN eliot.ai_workers w ON w.organization_id=p.organization_id AND w.id=p.worker_id
  LEFT JOIN eliot.ai_document_jobs j ON j.organization_id=p.organization_id AND j.id=p.job_id
  LEFT JOIN eliot.ai_document_work_reviews r ON r.organization_id=j.organization_id AND r.run_id=j.run_id
  WHERE s.organization_id=m.organization_id AND s.mission_id=m.id))
 FROM eliot.ai_document_missions m WHERE m.organization_id=p_org ORDER BY m.created_at DESC,m.id DESC LIMIT 20;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_document_missions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_document_missions(uuid) TO eliot_identity;
CREATE OR REPLACE FUNCTION eliot.my_document_plans(p_org uuid,p_task uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object(
  'id',p.id,'task_id',p.task_id,'worker_id',p.worker_id,'objective',p.objective,'request_key',p.request_key,
  'repository',p.source_repo,'path',p.source_path,'ref',p.source_ref,'sha',p.source_sha,
  'version',p.plan_version,'max_jobs',p.max_jobs,'estimated_token_units',p.estimated_token_units,'steps',p.steps,
  'created_at',p.created_at,'owner_is_creator',p.created_by=actor,
  'control_available',true,'control_state',p.control_state,'control_revision',p.control_revision,
  'scope_current',t.status='pending' AND t.updated_at=p.task_updated_at AND t.assignee_worker_id=p.worker_id
   AND w.department_id=t.department_id AND w.operating_state='idle',
  'mission_id',ms.mission_id,'mission_position',ms.position,
  'mission_dependency_satisfied',CASE WHEN ms.mission_id IS NULL THEN true ELSE eliot.document_mission_dependencies(p_org,ms.mission_id,ms.position) END,
  'analysis_mode',j.document_mode,'objective_snapshot',j.plan_objective_snapshot,'objective_plan_id',j.plan_id_snapshot,
  'job_id',p.job_id,'run_id',j.run_id,'job_state',j.state,'source_verified_at',j.source_verified_at,
  'review_decision',r.decision,'task_status',t.status)
 FROM eliot.ai_document_plans p JOIN eliot.ai_tasks t ON t.organization_id=p.organization_id AND t.id=p.task_id
 JOIN eliot.ai_workers w ON w.organization_id=p.organization_id AND w.id=p.worker_id
 LEFT JOIN eliot.ai_document_mission_steps ms ON ms.organization_id=p.organization_id AND ms.plan_id=p.id
 LEFT JOIN eliot.ai_document_jobs j ON j.organization_id=p.organization_id AND j.id=p.job_id
 LEFT JOIN eliot.ai_document_work_reviews r ON r.organization_id=j.organization_id AND r.run_id=j.run_id
 WHERE p.organization_id=p_org AND p.task_id=p_task ORDER BY p.created_at DESC,p.id DESC LIMIT 20;
END $fn$;



COMMIT;

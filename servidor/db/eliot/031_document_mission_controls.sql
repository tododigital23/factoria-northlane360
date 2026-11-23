-- 031: Global control of FUTURE mission dispatches; existing jobs keep their state.
-- Apply ONCE as administrator AFTER 030. BEGIN must execute as a separate command.
BEGIN;
SET LOCAL ROLE eliot_migrator;
ALTER TABLE eliot.ai_document_missions
 ADD COLUMN control_state text NOT NULL DEFAULT 'active' CHECK(control_state IN ('active','paused','cancelled')),
 ADD COLUMN control_revision integer NOT NULL DEFAULT 0 CHECK(control_revision>=0);
CREATE TABLE eliot.ai_document_mission_controls (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, mission_id uuid NOT NULL,
 actor_id uuid NOT NULL, request_key uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('pause','resume','cancel')),
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
 expected_revision integer NOT NULL CHECK(expected_revision>=0),
 result_state text NOT NULL CHECK(result_state IN ('active','paused','cancelled')),
 result_revision integer NOT NULL CHECK(result_revision=expected_revision+1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(organization_id,mission_id) REFERENCES eliot.ai_document_missions(organization_id,id),
 FOREIGN KEY(organization_id,actor_id) REFERENCES eliot.organization_memberships(organization_id,user_id),
 UNIQUE(organization_id,request_key), UNIQUE(organization_id,mission_id,result_revision)
);
ALTER TABLE eliot.ai_document_mission_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_mission_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_document_mission_controls ON eliot.ai_document_mission_controls
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_control_document_mission(p_org uuid,p_mission uuid,p_action text,p_reason text,p_revision integer,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; mission eliot.ai_document_missions; prior eliot.ai_document_mission_controls; next_state text; action_id uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Mission control ownership must be corrected' USING ERRCODE='55000'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('pause','resume','cancel') OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 500
 OR p_revision IS NULL OR p_revision<0 OR p_revision>=2147483647 OR p_key IS NULL THEN
  RAISE EXCEPTION 'Invalid mission control' USING ERRCODE='22023'; END IF;
 -- Control locks ONLY the mission. Enqueue locks task/plan/job first, then this
 -- same mission in its linking trigger. No inverse task/plan locks or deadlock.
 SELECT * INTO mission FROM eliot.ai_document_missions WHERE organization_id=p_org AND id=p_mission FOR UPDATE;
 IF NOT FOUND OR mission.created_by IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Mission unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO prior FROM eliot.ai_document_mission_controls WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF prior.mission_id IS DISTINCT FROM p_mission OR prior.actor_id IS DISTINCT FROM actor OR prior.action IS DISTINCT FROM p_action
  OR prior.reason IS DISTINCT FROM trim(p_reason) OR prior.expected_revision IS DISTINCT FROM p_revision THEN
   RAISE EXCEPTION 'Conflicting mission control retry' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('action_id',prior.id,'mission_id',p_mission,'recorded_state',prior.result_state,'recorded_revision',prior.result_revision);
 END IF;
 IF mission.control_state='cancelled' OR mission.control_revision<>p_revision
 OR (p_action='pause' AND mission.control_state<>'active') OR (p_action='resume' AND mission.control_state<>'paused')
 OR NOT EXISTS(SELECT 1 FROM eliot.ai_document_mission_steps s JOIN eliot.ai_document_plans p ON p.organization_id=s.organization_id AND p.id=s.plan_id
  WHERE s.organization_id=p_org AND s.mission_id=p_mission AND p.job_id IS NULL) THEN
  RAISE EXCEPTION 'Mission control no longer available' USING ERRCODE='55000'; END IF;
 next_state:=CASE p_action WHEN 'pause' THEN 'paused' WHEN 'resume' THEN 'active' ELSE 'cancelled' END;
 UPDATE eliot.ai_document_missions SET control_state=next_state,control_revision=control_revision+1 WHERE organization_id=p_org AND id=p_mission;
 INSERT INTO eliot.ai_document_mission_controls(organization_id,mission_id,actor_id,request_key,action,reason,expected_revision,result_state,result_revision)
 VALUES(p_org,p_mission,actor,p_key,p_action,trim(p_reason),p_revision,next_state,p_revision+1) RETURNING id INTO action_id;
 RETURN jsonb_build_object('action_id',action_id,'mission_id',p_mission,'recorded_state',next_state,'recorded_revision',p_revision+1);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_control_document_mission(uuid,uuid,text,text,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_control_document_mission(uuid,uuid,text,text,integer,uuid) TO eliot_identity;

CREATE OR REPLACE FUNCTION eliot.guard_document_mission_dispatch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE s record; mission_state text;
BEGIN
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Mission guard ownership must be corrected' USING ERRCODE='55000'; END IF;
 IF NEW.job_id IS NOT NULL AND OLD.job_id IS NULL THEN
  SELECT mission_id,position INTO s FROM eliot.ai_document_mission_steps WHERE organization_id=NEW.organization_id AND plan_id=NEW.id;
  IF FOUND THEN
   SELECT control_state INTO mission_state FROM eliot.ai_document_missions WHERE organization_id=NEW.organization_id AND id=s.mission_id FOR UPDATE;
   IF mission_state IS DISTINCT FROM 'active' OR NOT eliot.document_mission_dependencies(NEW.organization_id,s.mission_id,s.position) THEN
    RAISE EXCEPTION 'Mission paused, cancelled or previous reports not accepted' USING ERRCODE='55000'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION eliot.guard_document_mission_dispatch() FROM PUBLIC;

CREATE OR REPLACE FUNCTION eliot.my_document_missions(p_org uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid;
BEGIN
 SELECT u.id INTO actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Mission function ownership must be corrected' USING ERRCODE='55000'; END IF;
 RETURN QUERY SELECT jsonb_build_object('id',m.id,'objective',m.objective,'created_at',m.created_at,
  'owner_is_creator',m.created_by=actor,'mission_control_available',true,'mission_control_state',m.control_state,'mission_control_revision',m.control_revision,
  'last_control',(SELECT jsonb_build_object('action',c.action,'reason',c.reason,'created_at',c.created_at) FROM eliot.ai_document_mission_controls c WHERE c.organization_id=m.organization_id AND c.mission_id=m.id ORDER BY c.result_revision DESC LIMIT 1),'max_jobs',cardinality(m.plan_ids),'estimated_token_units',cardinality(m.plan_ids)*2500,
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
  'mission_id',ms.mission_id,'mission_position',ms.position,'mission_control_state',mc.control_state,
  'mission_control_revision',mc.control_revision,
  'mission_dependency_satisfied',CASE WHEN ms.mission_id IS NULL THEN true ELSE mc.control_state='active' AND eliot.document_mission_dependencies(p_org,ms.mission_id,ms.position) END,
  'analysis_mode',j.document_mode,'objective_snapshot',j.plan_objective_snapshot,'objective_plan_id',j.plan_id_snapshot,
  'job_id',p.job_id,'run_id',j.run_id,'job_state',j.state,'source_verified_at',j.source_verified_at,
  'review_decision',r.decision,'task_status',t.status)
 FROM eliot.ai_document_plans p JOIN eliot.ai_tasks t ON t.organization_id=p.organization_id AND t.id=p.task_id
 JOIN eliot.ai_workers w ON w.organization_id=p.organization_id AND w.id=p.worker_id
 LEFT JOIN eliot.ai_document_mission_steps ms ON ms.organization_id=p.organization_id AND ms.plan_id=p.id
 LEFT JOIN eliot.ai_document_missions mc ON mc.organization_id=ms.organization_id AND mc.id=ms.mission_id
 LEFT JOIN eliot.ai_document_jobs j ON j.organization_id=p.organization_id AND j.id=p.job_id
 LEFT JOIN eliot.ai_document_work_reviews r ON r.organization_id=j.organization_id AND r.run_id=j.run_id
 WHERE p.organization_id=p_org AND p.task_id=p_task ORDER BY p.created_at DESC,p.id DESC LIMIT 20;
END $fn$;



COMMIT;

-- 033: Mission autopilot. The owner approves a mission ONCE with an explicit budget and
-- Freddy advances it step by step inside that grant. Apply ONCE as administrator AFTER 032,
-- only after the PG pipeline passes on a disposable database.
--
-- Scope of autonomy (deliberately bounded):
-- * Advancing always runs inside an authenticated action of the SAME owner who granted it
--   (grant, "continue", or immediately after accepting a report). No JWT-less dispatcher,
--   no impersonation in the worker, no new LOGIN.
-- * Every internal action reuses the existing owner functions unchanged: lease claim or
--   reviewed renewal (020/024), single-use document approval (018), planned/objective
--   enqueue (027/029) with the mission guard (030/031), and 032 reopening for retries.
--   Any refusal of those functions stops the advance; it is never bypassed.
-- * Business acceptance of each report stays human: a step only starts when every
--   predecessor is completed AND accepted (030 guard).
-- * Bounded: max_jobs (1-10) per grant, expiry (1-168 h), optional automatic retry ONLY
--   for known failures (never needs_review/source_changed, at most 2 per plan), and the
--   durable daily model budget still applies to every job. Objective text is sent to the
--   provider only with explicit objective consent in the grant.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_document_mission_autopilots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 mission_id uuid NOT NULL,
 granted_by uuid NOT NULL,
 request_key uuid NOT NULL,
 max_jobs integer NOT NULL CHECK(max_jobs BETWEEN 1 AND 10),
 objective_consent boolean NOT NULL,
 auto_retry boolean NOT NULL,
 expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
 jobs_dispatched integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked_at timestamptz,
 revoke_reason text,
 CONSTRAINT ck_autopilot_budget CHECK(jobs_dispatched BETWEEN 0 AND max_jobs),
 CONSTRAINT ck_autopilot_revoked CHECK((state='revoked')=(revoked_at IS NOT NULL)),
 CONSTRAINT uq_autopilot_org_id UNIQUE(organization_id,id),
 CONSTRAINT uq_autopilot_request UNIQUE(organization_id,request_key),
 CONSTRAINT fk_autopilot_mission FOREIGN KEY(organization_id,mission_id) REFERENCES eliot.ai_document_missions(organization_id,id),
 CONSTRAINT fk_autopilot_actor FOREIGN KEY(organization_id,granted_by) REFERENCES eliot.organization_memberships(organization_id,user_id)
);
CREATE UNIQUE INDEX uq_one_active_autopilot ON eliot.ai_document_mission_autopilots(organization_id,mission_id) WHERE state='active';

CREATE TABLE eliot.ai_document_mission_autopilot_dispatches (
 organization_id uuid NOT NULL,
 autopilot_id uuid NOT NULL,
 seq integer NOT NULL CHECK(seq BETWEEN 1 AND 10),
 mission_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 5),
 plan_id uuid NOT NULL,
 task_id uuid NOT NULL,
 job_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('dispatch','retry')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,autopilot_id,seq),
 CONSTRAINT uq_autopilot_dispatch_job UNIQUE(organization_id,job_id),
 CONSTRAINT fk_autopilot_dispatch_grant FOREIGN KEY(organization_id,autopilot_id) REFERENCES eliot.ai_document_mission_autopilots(organization_id,id),
 CONSTRAINT fk_autopilot_dispatch_plan FOREIGN KEY(organization_id,plan_id) REFERENCES eliot.ai_document_plans(organization_id,id),
 CONSTRAINT fk_autopilot_dispatch_job FOREIGN KEY(organization_id,task_id,job_id) REFERENCES eliot.ai_document_jobs(organization_id,task_id,id)
);
ALTER TABLE eliot.ai_document_mission_autopilots ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_mission_autopilots FORCE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_mission_autopilot_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_mission_autopilot_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_autopilots ON eliot.ai_document_mission_autopilots FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);
CREATE POLICY migrator_autopilot_dispatches ON eliot.ai_document_mission_autopilot_dispatches FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.guard_autopilot_dispatch_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN RAISE EXCEPTION 'Autopilot dispatch history is immutable' USING ERRCODE='55000'; END $fn$;
REVOKE ALL ON FUNCTION eliot.guard_autopilot_dispatch_immutable() FROM PUBLIC;
CREATE TRIGGER guard_autopilot_dispatch_immutable BEFORE UPDATE OR DELETE ON eliot.ai_document_mission_autopilot_dispatches
FOR EACH ROW EXECUTE FUNCTION eliot.guard_autopilot_dispatch_immutable();

-- Grant terms are frozen; only the counter and revocation may change.
CREATE FUNCTION eliot.guard_autopilot_terms() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Autopilot grants are retained' USING ERRCODE='55000'; END IF;
 IF (NEW.organization_id,NEW.mission_id,NEW.granted_by,NEW.request_key,NEW.max_jobs,NEW.objective_consent,NEW.auto_retry,NEW.expires_at,NEW.created_at)
  IS DISTINCT FROM (OLD.organization_id,OLD.mission_id,OLD.granted_by,OLD.request_key,OLD.max_jobs,OLD.objective_consent,OLD.auto_retry,OLD.expires_at,OLD.created_at)
 OR NEW.jobs_dispatched<OLD.jobs_dispatched OR (OLD.state='revoked' AND NEW.state<>'revoked') THEN
  RAISE EXCEPTION 'Autopilot grant terms are immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION eliot.guard_autopilot_terms() FROM PUBLIC;
CREATE TRIGGER guard_autopilot_terms BEFORE UPDATE OR DELETE ON eliot.ai_document_mission_autopilots
FOR EACH ROW EXECUTE FUNCTION eliot.guard_autopilot_terms();

CREATE FUNCTION eliot.autopilot_actor(p_org uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT u.id FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
$fn$;
REVOKE ALL ON FUNCTION eliot.autopilot_actor(uuid) FROM PUBLIC;

-- Deterministic idempotency keys per grant, plan, attempt and action.
CREATE FUNCTION eliot.autopilot_key(p_grant uuid,p_plan uuid,p_attempt integer,p_action text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT md5(p_grant::text||':'||p_plan::text||':'||p_attempt::text||':'||p_action)::uuid
$fn$;
REVOKE ALL ON FUNCTION eliot.autopilot_key(uuid,uuid,integer,text) FROM PUBLIC;

-- Internal: called only from owner functions below, with the caller's verified subject.
CREATE FUNCTION eliot.autopilot_advance_internal(p_org uuid,p_mission uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; g eliot.ai_document_mission_autopilots; m eliot.ai_document_missions;
 s record; p eliot.ai_document_plans; j eliot.ai_document_jobs; decision text; attempt_no integer;
 prev record; v_lease uuid; v_approval uuid; v_job uuid; kind text; stop text:=NULL; stop_position integer:=NULL;
 dispatched jsonb:='[]'::jsonb;
BEGIN
 actor:=eliot.autopilot_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT * INTO g FROM eliot.ai_document_mission_autopilots
  WHERE organization_id=p_org AND mission_id=p_mission AND state='active' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('mission_id',p_mission,'stopped','no_active_autopilot','dispatched',dispatched); END IF;
 IF g.granted_by IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Autopilot belongs to another owner' USING ERRCODE='42501'; END IF;
 IF g.expires_at<=clock_timestamp() THEN
  RETURN jsonb_build_object('mission_id',p_mission,'autopilot_id',g.id,'stopped','autopilot_expired','dispatched',dispatched); END IF;
 SELECT * INTO m FROM eliot.ai_document_missions WHERE organization_id=p_org AND id=p_mission;
 IF m.control_state<>'active' THEN
  RETURN jsonb_build_object('mission_id',p_mission,'autopilot_id',g.id,'stopped','mission_'||m.control_state,'dispatched',dispatched); END IF;
 FOR s IN SELECT position,plan_id FROM eliot.ai_document_mission_steps
   WHERE organization_id=p_org AND mission_id=p_mission ORDER BY position LOOP
  SELECT * INTO p FROM eliot.ai_document_plans WHERE organization_id=p_org AND id=s.plan_id;
  kind:='dispatch';
  IF p.job_id IS NOT NULL THEN
   SELECT * INTO j FROM eliot.ai_document_jobs WHERE organization_id=p_org AND id=p.job_id;
   IF j.state='completed' THEN
    SELECT r.decision INTO decision FROM eliot.ai_document_work_reviews r WHERE r.organization_id=p_org AND r.run_id=j.run_id;
    IF decision='accepted' THEN CONTINUE; END IF;
    stop:=CASE WHEN decision IS NULL THEN 'awaiting_owner_review' ELSE 'changes_requested' END; stop_position:=s.position; EXIT;
   ELSIF j.state IN ('queued','claimed','source_verified','provider_started') THEN
    stop:='job_in_progress'; stop_position:=s.position; EXIT;
   ELSIF j.state='needs_review' THEN
    stop:='needs_human_investigation'; stop_position:=s.position; EXIT;
   ELSIF j.state='failed' AND g.auto_retry AND j.error_code IS DISTINCT FROM 'source_changed' THEN
    kind:='retry';
   ELSE
    stop:='step_failed_not_retryable'; stop_position:=s.position; EXIT;
   END IF;
  END IF;
  IF g.jobs_dispatched>=g.max_jobs THEN stop:='budget_exhausted'; stop_position:=s.position; EXIT; END IF;
  SELECT count(*) INTO attempt_no FROM eliot.ai_document_plan_attempts WHERE organization_id=p_org AND plan_id=p.id;
  IF kind='retry' AND attempt_no>=2 THEN stop:='retry_limit_reached'; stop_position:=s.position; EXIT; END IF;
  BEGIN
   IF kind='retry' THEN
    PERFORM eliot.owner_reopen_failed_document_plan(p_org,p.task_id,p.id,p.job_id,
     'Autopilot retry within the mission budget approved by the owner',eliot.autopilot_key(g.id,p.id,attempt_no,'reopen'));
    attempt_no:=attempt_no+1;
   END IF;
   SELECT l.lease_id,l.state,l.expires_at INTO prev FROM eliot.ai_task_execution_leases l
    WHERE l.organization_id=p_org AND l.task_id=p.task_id ORDER BY l.lease_generation DESC LIMIT 1;
   IF NOT FOUND THEN
    v_lease:=eliot.owner_claim_task_lease(p_org,p.task_id,p.worker_id,eliot.autopilot_key(g.id,p.id,attempt_no,'lease'));
   ELSE
    IF prev.state='held' AND prev.expires_at>clock_timestamp() THEN
     PERFORM eliot.owner_release_task_lease(p_org,p.task_id,prev.lease_id); END IF;
    v_lease:=eliot.owner_review_and_renew_lease(p_org,p.task_id,prev.lease_id,p.worker_id,
     'Autopilot renewal within the mission budget approved by the owner',eliot.autopilot_key(g.id,p.id,attempt_no,'lease'));
   END IF;
   v_approval:=eliot.owner_approve_document_analysis(p_org,p.task_id,p.worker_id,p.source_repo,p.source_path,
    p.source_ref,p.source_sha,eliot.autopilot_key(g.id,p.id,attempt_no,'approval'));
   IF g.objective_consent THEN
    v_job:=eliot.owner_enqueue_objective_document_job(p_org,p.task_id,p.worker_id,v_lease,v_approval,eliot.autopilot_key(g.id,p.id,attempt_no,'job'),p.id);
   ELSE
    v_job:=eliot.owner_enqueue_planned_document_job(p_org,p.task_id,p.worker_id,v_lease,v_approval,eliot.autopilot_key(g.id,p.id,attempt_no,'job'),p.id);
   END IF;
  EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '22023' OR SQLSTATE '55P03' THEN
   -- Every partial action of this step is rolled back; the existing control said no.
   stop:='step_not_eligible'; stop_position:=s.position; EXIT;
  END;
  UPDATE eliot.ai_document_mission_autopilots SET jobs_dispatched=jobs_dispatched+1 WHERE id=g.id;
  g.jobs_dispatched:=g.jobs_dispatched+1;
  INSERT INTO eliot.ai_document_mission_autopilot_dispatches(organization_id,autopilot_id,seq,mission_id,position,plan_id,task_id,job_id,kind)
  VALUES(p_org,g.id,g.jobs_dispatched,p_mission,s.position,p.id,p.task_id,v_job,kind);
  INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
  VALUES(p_org,p.task_id,p.worker_id,'progress','Freddy autopilot '||kind||' of mission '||p_mission::text||' step '||s.position::text
   ||': job '||v_job::text||' ('||g.jobs_dispatched::text||'/'||g.max_jobs::text||' jobs of the approved budget)');
  dispatched:=dispatched||jsonb_build_array(jsonb_build_object('position',s.position,'plan_id',p.id,'job_id',v_job,'kind',kind));
  -- Strictly sequential: the next step waits for this job and its human acceptance.
  stop:='job_in_progress'; stop_position:=s.position; EXIT;
 END LOOP;
 RETURN jsonb_build_object('mission_id',p_mission,'autopilot_id',g.id,'stopped',COALESCE(stop,'mission_complete'),
  'stopped_at_position',stop_position,'dispatched',dispatched,'jobs_dispatched',g.jobs_dispatched,'max_jobs',g.max_jobs);
END $fn$;
REVOKE ALL ON FUNCTION eliot.autopilot_advance_internal(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION eliot.owner_grant_mission_autopilot(p_org uuid,p_mission uuid,p_max_jobs integer,p_objective_consent boolean,
 p_auto_retry boolean,p_hours integer,p_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; m eliot.ai_document_missions; saved eliot.ai_document_mission_autopilots; steps integer; result_id uuid;
BEGIN
 actor:=eliot.autopilot_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Autopilot function ownership must be corrected' USING ERRCODE='55000'; END IF;
 IF p_mission IS NULL OR p_key IS NULL OR p_max_jobs IS NULL OR p_objective_consent IS NULL OR p_auto_retry IS NULL
 OR p_hours IS NULL OR p_hours NOT BETWEEN 1 AND 168 THEN
  RAISE EXCEPTION 'Invalid autopilot terms' USING ERRCODE='22023'; END IF;
 SELECT * INTO saved FROM eliot.ai_document_mission_autopilots WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF saved.mission_id IS DISTINCT FROM p_mission OR saved.granted_by IS DISTINCT FROM actor OR saved.max_jobs IS DISTINCT FROM p_max_jobs
  OR saved.objective_consent IS DISTINCT FROM p_objective_consent OR saved.auto_retry IS DISTINCT FROM p_auto_retry THEN
   RAISE EXCEPTION 'Conflicting autopilot retry' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('autopilot_id',saved.id,'replayed',true,'advance',eliot.autopilot_advance_internal(p_org,p_mission));
 END IF;
 SELECT * INTO m FROM eliot.ai_document_missions WHERE organization_id=p_org AND id=p_mission FOR UPDATE;
 IF NOT FOUND OR m.created_by IS DISTINCT FROM actor THEN RAISE EXCEPTION 'Mission unavailable' USING ERRCODE='22023'; END IF;
 IF m.control_state<>'active' THEN RAISE EXCEPTION 'Mission paused or cancelled' USING ERRCODE='55000'; END IF;
 steps:=cardinality(m.plan_ids);
 IF p_max_jobs<steps OR p_max_jobs>LEAST(10,steps*3) THEN
  RAISE EXCEPTION 'Budget must cover each step once and at most three attempts per step' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.ai_document_mission_autopilots WHERE organization_id=p_org AND mission_id=p_mission AND state='active') THEN
  RAISE EXCEPTION 'Mission already has an active autopilot' USING ERRCODE='55000'; END IF;
 INSERT INTO eliot.ai_document_mission_autopilots(organization_id,mission_id,granted_by,request_key,max_jobs,objective_consent,auto_retry,expires_at)
 VALUES(p_org,p_mission,actor,p_key,p_max_jobs,p_objective_consent,p_auto_retry,clock_timestamp()+make_interval(hours=>p_hours))
 RETURNING id INTO result_id;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 SELECT p_org,p.task_id,p.worker_id,'reported','Owner approved Freddy autopilot '||result_id::text||' for mission '||p_mission::text
  ||': up to '||p_max_jobs::text||' jobs (~'||(p_max_jobs*2500)::text||' token units), objective consent '||p_objective_consent::text
  ||', automatic retry '||p_auto_retry::text||', '||p_hours::text||' h'
 FROM eliot.ai_document_mission_steps s JOIN eliot.ai_document_plans p ON p.organization_id=s.organization_id AND p.id=s.plan_id
 WHERE s.organization_id=p_org AND s.mission_id=p_mission;
 RETURN jsonb_build_object('autopilot_id',result_id,'replayed',false,'advance',eliot.autopilot_advance_internal(p_org,p_mission));
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_grant_mission_autopilot(uuid,uuid,integer,boolean,boolean,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_grant_mission_autopilot(uuid,uuid,integer,boolean,boolean,integer,uuid) TO eliot_identity;

CREATE FUNCTION eliot.owner_advance_mission_autopilot(p_org uuid,p_mission uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 IF eliot.autopilot_actor(p_org) IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF current_user<>'eliot_migrator' THEN RAISE EXCEPTION 'Autopilot function ownership must be corrected' USING ERRCODE='55000'; END IF;
 IF NOT EXISTS(SELECT 1 FROM eliot.ai_document_missions WHERE organization_id=p_org AND id=p_mission) THEN
  RAISE EXCEPTION 'Mission unavailable' USING ERRCODE='22023'; END IF;
 RETURN eliot.autopilot_advance_internal(p_org,p_mission);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_advance_mission_autopilot(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_advance_mission_autopilot(uuid,uuid) TO eliot_identity;

CREATE FUNCTION eliot.owner_revoke_mission_autopilot(p_org uuid,p_mission uuid,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid; g eliot.ai_document_mission_autopilots;
BEGIN
 actor:=eliot.autopilot_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 500 THEN RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;
 SELECT * INTO g FROM eliot.ai_document_mission_autopilots WHERE organization_id=p_org AND mission_id=p_mission AND state='active' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('mission_id',p_mission,'revoked',false,'reason','no_active_autopilot'); END IF;
 UPDATE eliot.ai_document_mission_autopilots SET state='revoked',revoked_at=clock_timestamp(),revoke_reason=trim(p_reason) WHERE id=g.id;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 SELECT p_org,p.task_id,p.worker_id,'reported','Owner revoked Freddy autopilot '||g.id::text||'; jobs already queued are not aborted'
 FROM eliot.ai_document_mission_steps s JOIN eliot.ai_document_plans p ON p.organization_id=s.organization_id AND p.id=s.plan_id
 WHERE s.organization_id=p_org AND s.mission_id=p_mission;
 RETURN jsonb_build_object('mission_id',p_mission,'autopilot_id',g.id,'revoked',true);
END $fn$;
REVOKE ALL ON FUNCTION eliot.owner_revoke_mission_autopilot(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_revoke_mission_autopilot(uuid,uuid,text) TO eliot_identity;

CREATE FUNCTION eliot.my_mission_autopilot(p_org uuid,p_mission uuid) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE actor uuid;
BEGIN
 actor:=eliot.autopilot_actor(p_org);
 IF actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT jsonb_build_object('autopilot_id',g.id,'mission_id',g.mission_id,'state',
   CASE WHEN g.state='active' AND g.expires_at<=clock_timestamp() THEN 'expired' ELSE g.state END,
  'max_jobs',g.max_jobs,'jobs_dispatched',g.jobs_dispatched,'estimated_token_units',g.max_jobs*2500,
  'objective_consent',g.objective_consent,'auto_retry',g.auto_retry,'expires_at',g.expires_at,'created_at',g.created_at,
  'revoked_at',g.revoked_at,'granted_by_me',g.granted_by=actor,
  'dispatches',COALESCE((SELECT jsonb_agg(jsonb_build_object('seq',d.seq,'position',d.position,'plan_id',d.plan_id,'job_id',d.job_id,
    'kind',d.kind,'created_at',d.created_at) ORDER BY d.seq) FROM eliot.ai_document_mission_autopilot_dispatches d
    WHERE d.organization_id=g.organization_id AND d.autopilot_id=g.id),'[]'::jsonb))
 FROM eliot.ai_document_mission_autopilots g WHERE g.organization_id=p_org AND g.mission_id=p_mission
 ORDER BY g.created_at DESC LIMIT 10;
END $fn$;
REVOKE ALL ON FUNCTION eliot.my_mission_autopilot(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.my_mission_autopilot(uuid,uuid) TO eliot_identity;
COMMIT;

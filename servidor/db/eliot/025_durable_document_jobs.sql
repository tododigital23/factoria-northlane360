-- 025: Durable one-document jobs. Administrative migration, ONCE after 024.
-- Does not provision a LOGIN, bind an organization, enable flags or start a worker.
BEGIN;
CREATE ROLE eliot_execution_worker NOLOGIN;
GRANT USAGE ON SCHEMA eliot TO eliot_execution_worker;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_execution_principals (
 principal name PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES eliot.organizations(id),
 enabled boolean NOT NULL DEFAULT false
);
ALTER TABLE eliot.ai_execution_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_execution_principals FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_execution_principals ON eliot.ai_execution_principals
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE TABLE eliot.ai_document_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 lease_id uuid NOT NULL,
 approval_id uuid NOT NULL,
 run_id uuid NOT NULL UNIQUE REFERENCES eliot.ai_document_runs(id),
 requested_by uuid NOT NULL,
 request_key uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued'
  CHECK(state IN ('queued','claimed','source_verified','provider_started',
                  'completed','failed','cancelled','needs_review')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 valid_until timestamptz NOT NULL,
 claimed_at timestamptz,
 claimed_by name,
 claim_token uuid,
 source_verified_at timestamptz,
 byte_count integer CHECK(byte_count BETWEEN 0 AND 16384),
 provider_started_at timestamptz,
 finished_at timestamptz,
 cancel_requested boolean NOT NULL DEFAULT false,
 error_code text CHECK(error_code IN
  ('source_unavailable','source_changed','invalid_response','rate_limited',
   'provider_error','internal_error','eligibility_changed','cancelled')),
 CONSTRAINT fk_document_job_task FOREIGN KEY(task_id,organization_id)
  REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_document_job_worker FOREIGN KEY(worker_id,organization_id)
  REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_document_job_lease FOREIGN KEY(organization_id,lease_id)
  REFERENCES eliot.ai_task_execution_leases(organization_id,lease_id),
 CONSTRAINT fk_document_job_approval FOREIGN KEY(organization_id,approval_id)
  REFERENCES eliot.ai_document_approvals(organization_id,id),
 CONSTRAINT fk_document_job_actor FOREIGN KEY(organization_id,requested_by)
  REFERENCES eliot.organization_memberships(organization_id,user_id),
 CONSTRAINT uq_document_job_request UNIQUE(organization_id,request_key),
 CONSTRAINT uq_document_job_approval UNIQUE(organization_id,approval_id),
 CONSTRAINT ck_document_job_claim CHECK(
  (claimed_at IS NULL AND claimed_by IS NULL AND claim_token IS NULL)
  OR (claimed_at IS NOT NULL AND claimed_by IS NOT NULL AND claim_token IS NOT NULL)),
 CONSTRAINT ck_document_job_finished CHECK(
  (state IN ('completed','failed','cancelled'))=(finished_at IS NOT NULL)),
 CONSTRAINT ck_document_job_source CHECK(
  (source_verified_at IS NULL)=(byte_count IS NULL))
);
CREATE UNIQUE INDEX uq_document_job_active_task
 ON eliot.ai_document_jobs(organization_id,task_id)
 WHERE state IN ('queued','claimed','source_verified','provider_started','needs_review');
CREATE INDEX idx_document_job_queue ON eliot.ai_document_jobs(organization_id,created_at,id)
 WHERE state='queued';
ALTER TABLE eliot.ai_document_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_document_jobs ON eliot.ai_document_jobs
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

-- Private helpers: callers only receive EXECUTE on the narrow public functions.
CREATE FUNCTION eliot.document_job_worker_allowed(p_org uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT pg_has_role(session_user,'eliot_execution_worker','MEMBER')
 AND EXISTS(SELECT 1 FROM eliot.ai_execution_principals p
  WHERE p.principal=session_user AND p.organization_id=p_org AND p.enabled)
$fn$;

CREATE FUNCTION eliot.document_job_eligible(p_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT EXISTS(
  SELECT 1 FROM eliot.ai_document_jobs j
  JOIN eliot.ai_tasks t ON t.organization_id=j.organization_id AND t.id=j.task_id
  JOIN eliot.ai_workers w ON w.organization_id=j.organization_id AND w.id=j.worker_id
  JOIN eliot.ai_task_execution_leases l
   ON l.organization_id=j.organization_id AND l.lease_id=j.lease_id
  JOIN eliot.ai_document_approvals a
   ON a.organization_id=j.organization_id AND a.id=j.approval_id
  JOIN eliot.organization_memberships m
   ON m.organization_id=j.organization_id AND m.user_id=j.requested_by
  WHERE j.id=p_id AND eliot.document_job_worker_allowed(j.organization_id)
   AND NOT j.cancel_requested AND j.valid_until>clock_timestamp()
   AND t.status='pending' AND t.assignee_worker_id=j.worker_id
   AND w.department_id=t.department_id AND w.operating_state='idle'
   AND l.task_id=j.task_id AND l.worker_id=j.worker_id
   AND l.state='held' AND l.expires_at>clock_timestamp()
   AND a.state='claimed' AND a.approved_by=j.requested_by
   AND m.status='active' AND m.role='owner')
$fn$;

CREATE FUNCTION eliot.finish_document_job_internal(
 p_id uuid,p_status text,p_report text,p_error text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE j record; v_legacy_error text;
BEGIN
 SELECT * INTO j FROM eliot.ai_document_jobs WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job unavailable' USING ERRCODE='22023'; END IF;
 IF j.state IN ('completed','failed','cancelled','needs_review') THEN
  RAISE EXCEPTION 'Job already finalized or uncertain' USING ERRCODE='55000'; END IF;
 IF p_status NOT IN ('completed','failed','cancelled','needs_review')
 OR (p_status='completed' AND (p_report IS NULL OR length(p_report) NOT BETWEEN 1 AND 5800
                             OR p_error IS NOT NULL OR j.state<>'provider_started'))
 OR (p_status<>'completed' AND (p_report IS NOT NULL OR p_error IS NULL)) THEN
  RAISE EXCEPTION 'Invalid job result' USING ERRCODE='22023'; END IF;
 UPDATE eliot.ai_document_jobs SET state=p_status,error_code=p_error,
  finished_at=CASE WHEN p_status='needs_review' THEN NULL ELSE clock_timestamp() END
 WHERE id=p_id;
 IF p_status<>'needs_review' THEN
  v_legacy_error:=CASE WHEN p_error IN ('source_unavailable','source_changed',
   'invalid_response','rate_limited','provider_error') THEN p_error ELSE 'internal_error' END;
  UPDATE eliot.ai_document_runs SET
   status=CASE WHEN p_status='completed' THEN 'completed' ELSE 'failed' END,
   result_text=p_report,error_code=CASE WHEN p_status='completed' THEN NULL ELSE v_legacy_error END,
   finished_at=clock_timestamp()
  WHERE id=j.run_id AND organization_id=j.organization_id AND status='running';
  IF NOT FOUND THEN RAISE EXCEPTION 'Run no longer active' USING ERRCODE='55000'; END IF;
  UPDATE eliot.ai_document_approvals
   SET state=CASE WHEN p_status='completed' THEN 'finished' ELSE 'failed' END
   WHERE id=j.approval_id AND organization_id=j.organization_id AND state='claimed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Approval no longer claimed' USING ERRCODE='55000'; END IF;
 END IF;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(j.organization_id,j.task_id,j.worker_id,'reported',
  'Durable document job '||j.id::text||': '||p_status||'; task awaits human review');
 RETURN p_status;
END $fn$;

CREATE FUNCTION eliot.owner_enqueue_document_job(
 p_org uuid,p_task uuid,p_worker uuid,p_lease uuid,p_approval uuid,p_key uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_actor uuid; v_saved record; v_lease record; v_approval record;
 v_run record; v_job uuid;
BEGIN
 SELECT u.id INTO v_actor FROM eliot.organization_memberships m
 JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_worker IS NULL OR p_lease IS NULL OR p_approval IS NULL THEN
  RAISE EXCEPTION 'Invalid job scope' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task unavailable' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_saved FROM eliot.ai_document_jobs
 WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF v_saved.task_id IS DISTINCT FROM p_task OR v_saved.worker_id IS DISTINCT FROM p_worker
   OR v_saved.lease_id IS DISTINCT FROM p_lease OR v_saved.approval_id IS DISTINCT FROM p_approval
   OR v_saved.requested_by IS DISTINCT FROM v_actor THEN
   RAISE EXCEPTION 'Conflicting job retry' USING ERRCODE='22023'; END IF;
  RETURN v_saved.id;
 END IF;
 IF eliot.task_has_unconfirmed_execution(p_org,p_task) THEN
  RAISE EXCEPTION 'Unconfirmed execution' USING ERRCODE='55000'; END IF;
 -- Shared locks serialize eligibility changes until the queue insertion commits.
 PERFORM 1 FROM eliot.ai_workers WHERE organization_id=p_org AND id=p_worker FOR SHARE;
 SELECT * INTO v_lease FROM eliot.ai_task_execution_leases
 WHERE organization_id=p_org AND lease_id=p_lease FOR UPDATE;
 IF NOT FOUND OR v_lease.task_id IS DISTINCT FROM p_task
  OR v_lease.worker_id IS DISTINCT FROM p_worker OR v_lease.state<>'held'
  OR v_lease.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'Lease not eligible' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_approval FROM eliot.ai_document_approvals
 WHERE organization_id=p_org AND id=p_approval FOR UPDATE;
 IF NOT FOUND OR v_approval.task_id IS DISTINCT FROM p_task
  OR v_approval.worker_id IS DISTINCT FROM p_worker OR v_approval.approved_by IS DISTINCT FROM v_actor
  OR v_approval.state<>'approved' OR v_approval.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'Approval not eligible' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_run FROM eliot.owner_claim_document_run(p_org,p_task,p_approval,p_key);
 IF NOT v_run.should_execute THEN
  RAISE EXCEPTION 'Approval already used outside queue' USING ERRCODE='55000'; END IF;
 INSERT INTO eliot.ai_document_jobs(
  organization_id,task_id,worker_id,lease_id,approval_id,run_id,requested_by,request_key,valid_until
 ) VALUES(p_org,p_task,p_worker,p_lease,p_approval,v_run.run_id,v_actor,p_key,
          LEAST(v_lease.expires_at,v_approval.expires_at)) RETURNING id INTO v_job;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,p_task,p_worker,'progress',
  'Document job queued: '||v_job::text||'; no provider called');
 RETURN v_job;
END $fn$;

CREATE FUNCTION eliot.my_document_jobs(p_org uuid,p_task uuid)
RETURNS TABLE(job_id uuid,run_id uuid,lease_id uuid,job_state text,
 created_at timestamptz,valid_until timestamptz,cancel_requested boolean,
 attention_required boolean,error_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
 SELECT j.id,j.run_id,j.lease_id,j.state,j.created_at,j.valid_until,j.cancel_requested,
  j.state='needs_review' OR (j.state IN ('claimed','source_verified','provider_started')
   AND j.claimed_at<clock_timestamp()-interval '2 minutes'),j.error_code
 FROM eliot.ai_document_jobs j
 WHERE j.organization_id=p_org AND j.task_id=p_task AND EXISTS(
  SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),''))
 ORDER BY j.created_at DESC,j.id DESC LIMIT 20
$fn$;

CREATE FUNCTION eliot.owner_cancel_document_job(p_org uuid,p_job uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_task uuid; j record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')) THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT task_id INTO v_task FROM eliot.ai_document_jobs WHERE organization_id=p_org AND id=p_job;
 PERFORM 1 FROM eliot.ai_tasks WHERE organization_id=p_org AND id=v_task FOR UPDATE;
 SELECT * INTO j FROM eliot.ai_document_jobs WHERE organization_id=p_org AND id=p_job FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Job unavailable' USING ERRCODE='22023'; END IF;
 IF j.state IN ('completed','failed','cancelled','needs_review') THEN RETURN j.state; END IF;
 UPDATE eliot.ai_document_jobs SET cancel_requested=true WHERE id=p_job;
 IF j.state='queued' THEN
  RETURN eliot.finish_document_job_internal(p_job,'cancelled',NULL,'cancelled');
 END IF;
 -- A sent provider request cannot be recalled; preserve the real outcome.
 RETURN 'cancellation_requested';
END $fn$;

CREATE FUNCTION eliot.worker_take_document_job(p_org uuid)
RETURNS TABLE(job_id uuid,claim_token uuid,task_title text,
 repository text,path text,ref text,sha text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_task uuid; j record; r record; v_token uuid;
BEGIN
 IF NOT eliot.document_job_worker_allowed(p_org) THEN
  RAISE EXCEPTION 'Worker principal not authorized' USING ERRCODE='42501'; END IF;
 -- Task first, then job: same lock order as enqueue/cancel and legacy actions.
 SELECT t.id INTO v_task FROM eliot.ai_tasks t JOIN eliot.ai_document_jobs q
  ON q.organization_id=t.organization_id AND q.task_id=t.id
 WHERE q.organization_id=p_org AND q.state='queued'
 ORDER BY q.created_at,q.id LIMIT 1 FOR UPDATE OF t SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO j FROM eliot.ai_document_jobs
 WHERE organization_id=p_org AND task_id=v_task AND state='queued' FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM 1 FROM eliot.ai_workers WHERE organization_id=p_org AND id=j.worker_id FOR SHARE;
 IF NOT eliot.document_job_eligible(j.id) THEN
  PERFORM eliot.finish_document_job_internal(j.id,'failed',NULL,'eligibility_changed');
  RETURN;
 END IF;
 v_token:=gen_random_uuid();
 UPDATE eliot.ai_document_jobs SET state='claimed',claimed_at=clock_timestamp(),
  claimed_by=session_user,claim_token=v_token WHERE id=j.id;
 SELECT * INTO r FROM eliot.ai_document_runs WHERE id=j.run_id;
 RETURN QUERY SELECT j.id,v_token,t.title::text,r.source_repo,r.source_path,r.source_ref,r.source_sha
 FROM eliot.ai_tasks t WHERE t.organization_id=p_org AND t.id=v_task;
END $fn$;

-- Claim-bound helper also acquires task then job locks. Not granted to runtimes.
CREATE FUNCTION eliot.lock_worker_document_job(p_org uuid,p_job uuid,p_token uuid)
RETURNS eliot.ai_document_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot AS $fn$
DECLARE v_task uuid; j eliot.ai_document_jobs;
BEGIN
 IF NOT eliot.document_job_worker_allowed(p_org) THEN
  RAISE EXCEPTION 'Worker principal not authorized' USING ERRCODE='42501'; END IF;
 SELECT task_id INTO v_task FROM eliot.ai_document_jobs WHERE organization_id=p_org AND id=p_job;
 PERFORM 1 FROM eliot.ai_tasks WHERE organization_id=p_org AND id=v_task FOR UPDATE;
 SELECT * INTO j FROM eliot.ai_document_jobs WHERE organization_id=p_org AND id=p_job FOR UPDATE;
 IF NOT FOUND OR p_token IS NULL OR j.claim_token IS DISTINCT FROM p_token
  OR j.claimed_by IS DISTINCT FROM session_user::name THEN
  RAISE EXCEPTION 'Worker claim unavailable' USING ERRCODE='42501'; END IF;
 RETURN j;
END $fn$;

CREATE FUNCTION eliot.worker_verify_document_source(
 p_org uuid,p_job uuid,p_token uuid,p_sha text,p_bytes integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE j eliot.ai_document_jobs; v_sha text;
BEGIN
 j:=eliot.lock_worker_document_job(p_org,p_job,p_token);
 IF j.state<>'claimed' THEN RETURN false; END IF;
 SELECT source_sha INTO v_sha FROM eliot.ai_document_runs WHERE id=j.run_id;
 IF p_sha IS DISTINCT FROM v_sha OR p_bytes IS NULL OR p_bytes NOT BETWEEN 0 AND 16384 THEN
  RAISE EXCEPTION 'Source not verified' USING ERRCODE='22023'; END IF;
 UPDATE eliot.ai_document_jobs SET state='source_verified',
  source_verified_at=clock_timestamp(),byte_count=p_bytes WHERE id=p_job;
 RETURN true;
END $fn$;

CREATE FUNCTION eliot.worker_begin_document_provider(p_org uuid,p_job uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot AS $fn$
DECLARE j eliot.ai_document_jobs; v_day date; v_budget record;
BEGIN
 j:=eliot.lock_worker_document_job(p_org,p_job,p_token);
 IF j.state<>'source_verified' THEN RETURN false; END IF;
 -- Recheck the live worker, owner, lease and cancellation immediately before I/O.
 PERFORM 1 FROM eliot.ai_workers WHERE organization_id=p_org AND id=j.worker_id FOR SHARE;
 PERFORM 1 FROM eliot.organization_memberships
  WHERE organization_id=p_org AND user_id=j.requested_by FOR SHARE;
 PERFORM 1 FROM eliot.ai_task_execution_leases
  WHERE organization_id=p_org AND lease_id=j.lease_id FOR SHARE;
 IF NOT eliot.document_job_eligible(p_job) THEN RETURN false; END IF;
 -- Same ledger, row lock and hard limits as 019, authorized by the job claim.
 -- Never impersonate a user or set app.verified_subject in the worker session.
 v_day:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
 INSERT INTO eliot.ai_model_budget_daily(organization_id,day_utc)
 VALUES(p_org,v_day) ON CONFLICT DO NOTHING;
 SELECT calls_reserved,token_units_reserved INTO v_budget
 FROM eliot.ai_model_budget_daily WHERE organization_id=p_org AND day_utc=v_day FOR UPDATE;
 -- Waiting for another reservation can outlast the lease or a principal revocation.
 IF NOT eliot.document_job_eligible(p_job) THEN RETURN false; END IF;
 IF v_budget.calls_reserved>=30 OR v_budget.token_units_reserved+2500>90000
 OR EXISTS(SELECT 1 FROM eliot.ai_model_budget_reservations
           WHERE organization_id=p_org AND request_key=p_job) THEN RETURN false; END IF;
 INSERT INTO eliot.ai_model_budget_reservations(
  organization_id,day_utc,request_key,reserved_token_units) VALUES(p_org,v_day,p_job,2500);
 UPDATE eliot.ai_model_budget_daily SET calls_reserved=calls_reserved+1,
  token_units_reserved=token_units_reserved+2500,updated_at=clock_timestamp()
 WHERE organization_id=p_org AND day_utc=v_day;
 UPDATE eliot.ai_document_jobs SET state='provider_started',
  provider_started_at=clock_timestamp() WHERE id=p_job;
 RETURN true;
END $fn$;

CREATE FUNCTION eliot.worker_reconcile_document_budget(
 p_org uuid,p_job uuid,p_token uuid,p_input integer,p_output integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE j eliot.ai_document_jobs; b record;
BEGIN
 j:=eliot.lock_worker_document_job(p_org,p_job,p_token);
 IF j.state<>'provider_started' OR p_input IS NULL OR p_output IS NULL
  OR p_input NOT BETWEEN 0 AND 1000000 OR p_output NOT BETWEEN 0 AND 1000000 THEN
  RETURN false; END IF;
 SELECT * INTO b FROM eliot.ai_model_budget_reservations
 WHERE organization_id=p_org AND request_key=p_job FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF b.reconciled_at IS NOT NULL THEN
  IF b.input_tokens_reported IS DISTINCT FROM p_input OR b.output_tokens_reported IS DISTINCT FROM p_output THEN
   RAISE EXCEPTION 'Conflicting reconciliation' USING ERRCODE='22023'; END IF;
  RETURN true;
 END IF;
 UPDATE eliot.ai_model_budget_reservations SET input_tokens_reported=p_input,
  output_tokens_reported=p_output,reconciled_at=clock_timestamp()
 WHERE organization_id=p_org AND request_key=p_job;
 UPDATE eliot.ai_model_budget_daily SET input_tokens_reported=input_tokens_reported+p_input,
  output_tokens_reported=output_tokens_reported+p_output,updated_at=clock_timestamp()
 WHERE organization_id=p_org AND day_utc=b.day_utc;
 RETURN true;
END $fn$;

CREATE FUNCTION eliot.worker_finish_document_job(
 p_org uuid,p_job uuid,p_token uuid,p_report text,p_error text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE j eliot.ai_document_jobs;
BEGIN
 j:=eliot.lock_worker_document_job(p_org,p_job,p_token);
 IF j.state NOT IN ('claimed','source_verified','provider_started') THEN
  RAISE EXCEPTION 'Job is not active' USING ERRCODE='55000'; END IF;
 IF p_report IS NOT NULL THEN
  RETURN eliot.finish_document_job_internal(p_job,'completed',p_report,p_error);
 END IF;
 -- Network errors after dispatch can be ambiguous: never call them a safe failure.
 RETURN eliot.finish_document_job_internal(p_job,
  CASE WHEN j.state='provider_started' AND p_error IN ('provider_error','internal_error')
       THEN 'needs_review' ELSE 'failed' END,NULL,p_error);
END $fn$;

-- Protect legacy synchronous paths while a queued job owns the task/run.
CREATE FUNCTION eliot.guard_durable_document_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
BEGIN
 PERFORM 1 FROM eliot.ai_tasks WHERE organization_id=NEW.organization_id AND id=NEW.task_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM eliot.ai_document_jobs j
  WHERE j.organization_id=NEW.organization_id AND j.task_id=NEW.task_id
  AND j.state IN ('queued','claimed','source_verified','provider_started','needs_review')) THEN
  RAISE EXCEPTION 'Task has a durable execution' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER guard_durable_document_run BEFORE INSERT ON eliot.ai_document_runs
 FOR EACH ROW EXECUTE FUNCTION eliot.guard_durable_document_job();
CREATE TRIGGER guard_durable_analysis_run BEFORE INSERT ON eliot.ai_analysis_runs
 FOR EACH ROW EXECUTE FUNCTION eliot.guard_durable_document_job();
CREATE TRIGGER guard_durable_github_invocation BEFORE INSERT ON eliot.ai_github_tool_invocations
 FOR EACH ROW EXECUTE FUNCTION eliot.guard_durable_document_job();
CREATE TRIGGER guard_durable_github_claim BEFORE UPDATE OF state ON eliot.ai_tool_read_grants
 FOR EACH ROW WHEN (NEW.state='claimed' AND OLD.state IS DISTINCT FROM NEW.state)
 EXECUTE FUNCTION eliot.guard_durable_document_job();
CREATE TRIGGER guard_durable_run_finish BEFORE UPDATE OF status ON eliot.ai_document_runs
 FOR EACH ROW WHEN (OLD.status='running' AND NEW.status IS DISTINCT FROM OLD.status)
 EXECUTE FUNCTION eliot.guard_durable_document_job();
-- Internal finish updates the job to terminal BEFORE updating its document run.
-- needs_review keeps the run running and blocks renewal through migration 024.

REVOKE ALL ON FUNCTION eliot.document_job_worker_allowed(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.document_job_eligible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.finish_document_job_internal(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.lock_worker_document_job(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.guard_durable_document_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_enqueue_document_job(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_document_jobs(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_cancel_document_job(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.worker_take_document_job(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.worker_verify_document_source(uuid,uuid,uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.worker_begin_document_provider(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.worker_reconcile_document_budget(uuid,uuid,uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.worker_finish_document_job(uuid,uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_enqueue_document_job(uuid,uuid,uuid,uuid,uuid,uuid),
 eliot.my_document_jobs(uuid,uuid),eliot.owner_cancel_document_job(uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.worker_take_document_job(uuid),
 eliot.worker_verify_document_source(uuid,uuid,uuid,text,integer),
 eliot.worker_begin_document_provider(uuid,uuid,uuid),
 eliot.worker_reconcile_document_budget(uuid,uuid,uuid,integer,integer),
 eliot.worker_finish_document_job(uuid,uuid,uuid,text,text) TO eliot_execution_worker;
COMMIT;


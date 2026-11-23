-- 018: document-specific, single-use owner authorization and audited run.
-- APPLY ONCE, only as database administrator in eliot_dev after 017.
-- No document content is persisted; only approved source coordinates + SHA.
-- "analysis_draft_v1" approval (016) CANNOT authorize documentary access.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_document_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 approved_by uuid NOT NULL,
 action_key uuid NOT NULL,
 capability text NOT NULL DEFAULT 'document_analysis_v1'
  CHECK (capability='document_analysis_v1'),
 source_repo text NOT NULL CHECK(length(source_repo) BETWEEN 3 AND 210),
 source_path text NOT NULL CHECK(length(source_path) BETWEEN 5 AND 400 AND source_path LIKE 'docs/%'),
 source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 160),
 source_sha text NOT NULL CHECK(source_sha ~ '^[0-9a-f]{40}$'),
 state text NOT NULL DEFAULT 'approved'
  CHECK(state IN ('approved','expired','revoked','claimed','finished','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '15 minutes'),
 revoked_at timestamptz,
 revocation_key uuid,
 CONSTRAINT fk_doc_approval_task FOREIGN KEY(task_id,organization_id)
   REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_doc_approval_worker FOREIGN KEY(worker_id,organization_id)
   REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_doc_approval_actor FOREIGN KEY(organization_id,approved_by)
   REFERENCES eliot.organization_memberships(organization_id,user_id),
 CONSTRAINT uq_doc_approval_request UNIQUE(organization_id,action_key),
 CONSTRAINT uq_doc_approval_org_id UNIQUE(organization_id,id),
 CONSTRAINT ck_doc_approval_expiry CHECK(expires_at>created_at),
 CONSTRAINT ck_doc_approval_revoke CHECK(
   (state='revoked')=(revoked_at IS NOT NULL AND revocation_key IS NOT NULL)
 )
);
CREATE UNIQUE INDEX uq_doc_approval_pending_task
 ON eliot.ai_document_approvals(organization_id,task_id) WHERE state='approved';
CREATE INDEX idx_doc_approval_history
 ON eliot.ai_document_approvals(organization_id,task_id,created_at DESC);
ALTER TABLE eliot.ai_document_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_doc_approvals_select ON eliot.ai_document_approvals
 FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY migrator_doc_approvals_insert ON eliot.ai_document_approvals
 FOR INSERT TO eliot_migrator WITH CHECK(true);
CREATE POLICY migrator_doc_approvals_update ON eliot.ai_document_approvals
 FOR UPDATE TO eliot_migrator USING(true) WITH CHECK(true);

CREATE TABLE eliot.ai_document_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 approval_id uuid NOT NULL,
 requested_by uuid NOT NULL,
 request_key uuid NOT NULL,
 source_repo text NOT NULL,
 source_path text NOT NULL,
 source_ref text NOT NULL,
 source_sha text NOT NULL CHECK(source_sha ~ '^[0-9a-f]{40}$'),
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
 result_text text,
 error_code text,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CONSTRAINT fk_doc_run_task FOREIGN KEY(task_id,organization_id)
   REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_doc_run_worker FOREIGN KEY(worker_id,organization_id)
   REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_doc_run_approval FOREIGN KEY(organization_id,approval_id)
   REFERENCES eliot.ai_document_approvals(organization_id,id),
 CONSTRAINT fk_doc_run_actor FOREIGN KEY(organization_id,requested_by)
   REFERENCES eliot.organization_memberships(organization_id,user_id),
 CONSTRAINT uq_doc_run_approval UNIQUE(organization_id,approval_id),
 CONSTRAINT uq_doc_run_request UNIQUE(organization_id,request_key),
 CONSTRAINT ck_doc_run_result CHECK(
  (status='running' AND result_text IS NULL AND error_code IS NULL AND finished_at IS NULL)
  OR (status='completed' AND length(result_text) BETWEEN 1 AND 6000
    AND error_code IS NULL AND finished_at IS NOT NULL)
  OR (status='failed' AND result_text IS NULL
    AND error_code IN ('provider_error','rate_limited','invalid_response','source_changed','source_unavailable','internal_error')
    AND finished_at IS NOT NULL)
 )
);
CREATE INDEX idx_document_run_history
 ON eliot.ai_document_runs(organization_id,task_id,started_at DESC);
ALTER TABLE eliot.ai_document_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_document_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_document_runs_select ON eliot.ai_document_runs
 FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY migrator_document_runs_insert ON eliot.ai_document_runs
 FOR INSERT TO eliot_migrator WITH CHECK(true);
CREATE POLICY migrator_document_runs_update ON eliot.ai_document_runs
 FOR UPDATE TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_approve_document_analysis(
 p_org uuid,p_task uuid,p_worker uuid,p_repo text,p_path text,
 p_ref text,p_sha text,p_key uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_actor uuid;
 v_task record;
 v_worker_state text;
 v_existing record;
 v_id uuid;
BEGIN
 SELECT u.id INTO v_actor
 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
   AND u.external_subject=v_subject;
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_worker IS NULL OR p_key IS NULL OR p_repo IS NULL OR p_path IS NULL
 OR p_ref IS NULL OR p_sha IS NULL OR length(p_repo) NOT BETWEEN 3 AND 210
 OR length(p_path) NOT BETWEEN 5 AND 400 OR p_path NOT LIKE 'docs/%'
 OR length(p_ref) NOT BETWEEN 1 AND 160 OR p_sha !~ '^[0-9a-f]{40}$' THEN
  RAISE EXCEPTION 'Invalid document parameters' USING ERRCODE='22023';
 END IF;
 SELECT id,department_id,assignee_worker_id,status INTO v_task
 FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task not found' USING ERRCODE='22023'; END IF;
 SELECT id,task_id,worker_id,approved_by,source_repo,source_path,source_ref,source_sha
 INTO v_existing FROM eliot.ai_document_approvals
 WHERE organization_id=p_org AND action_key=p_key;
 IF FOUND THEN
   IF v_existing.task_id IS DISTINCT FROM p_task
   OR v_existing.worker_id IS DISTINCT FROM p_worker
   OR v_existing.approved_by IS DISTINCT FROM v_actor
   OR v_existing.source_repo IS DISTINCT FROM p_repo
   OR v_existing.source_path IS DISTINCT FROM p_path
   OR v_existing.source_ref IS DISTINCT FROM p_ref
   OR v_existing.source_sha IS DISTINCT FROM p_sha THEN
     RAISE EXCEPTION 'Conflicting request retry' USING ERRCODE='22023';
   END IF;
   RETURN v_existing.id;
 END IF;
 IF v_task.status<>'pending' OR v_task.assignee_worker_id IS DISTINCT FROM p_worker THEN
  RAISE EXCEPTION 'Pending task and assigned worker required' USING ERRCODE='22023';
 END IF;
 SELECT operating_state INTO v_worker_state FROM eliot.ai_workers
 WHERE organization_id=p_org AND id=p_worker AND department_id=v_task.department_id
 FOR SHARE;
 IF NOT FOUND OR v_worker_state<>'idle' THEN
  RAISE EXCEPTION 'Assigned worker not idle' USING ERRCODE='22023';
 END IF;
 UPDATE eliot.ai_document_approvals SET state='expired'
 WHERE organization_id=p_org AND task_id=p_task AND state='approved'
 AND expires_at<=now();
 IF EXISTS(SELECT 1 FROM eliot.ai_document_approvals
           WHERE organization_id=p_org AND task_id=p_task AND state='approved') THEN
  RAISE EXCEPTION 'An active documentary approval already exists' USING ERRCODE='22023';
 END IF;
 INSERT INTO eliot.ai_document_approvals(
  organization_id,task_id,worker_id,approved_by,action_key,
  source_repo,source_path,source_ref,source_sha
 ) VALUES(p_org,p_task,p_worker,v_actor,p_key,p_repo,p_path,p_ref,p_sha)
 RETURNING id INTO v_id;
 INSERT INTO eliot.ai_task_events(
  organization_id,task_id,worker_id,event_type,message,action_key
 ) VALUES(
  p_org,p_task,p_worker,'reported',
  'Owner approved one documentary analysis for an exact GitHub SHA; no model called',p_key
 );
 RETURN v_id;
END
$fn$;

CREATE FUNCTION eliot.owner_revoke_document_analysis(
 p_org uuid,p_approval uuid,p_key uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_actor uuid;
 v_approval record;
BEGIN
 SELECT u.id INTO v_actor FROM eliot.organization_memberships m
 JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
   AND u.external_subject=v_subject;
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL THEN RAISE EXCEPTION 'Missing request key' USING ERRCODE='22023'; END IF;
 SELECT task_id,worker_id,state,expires_at,revocation_key INTO v_approval
 FROM eliot.ai_document_approvals
 WHERE organization_id=p_org AND id=p_approval FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Not found' USING ERRCODE='22023'; END IF;
 IF v_approval.state='revoked' THEN
  IF v_approval.revocation_key IS DISTINCT FROM p_key THEN
   RAISE EXCEPTION 'Conflicting retry' USING ERRCODE='22023';
  END IF;
  RETURN 'revoked';
 END IF;
 IF v_approval.state<>'approved' THEN
   RAISE EXCEPTION 'Not revocable' USING ERRCODE='22023';
 END IF;
 IF v_approval.expires_at<=now() THEN
  UPDATE eliot.ai_document_approvals SET state='expired'
   WHERE organization_id=p_org AND id=p_approval;
  RETURN 'expired';
 END IF;
 UPDATE eliot.ai_document_approvals SET state='revoked',revoked_at=now(),
  revocation_key=p_key WHERE organization_id=p_org AND id=p_approval;
 INSERT INTO eliot.ai_task_events(
  organization_id,task_id,worker_id,event_type,message,action_key
 ) VALUES(p_org,v_approval.task_id,v_approval.worker_id,'reported',
          'Documentary analysis authorization revoked without provider call',p_key);
 RETURN 'revoked';
END
$fn$;

CREATE FUNCTION eliot.my_document_approvals(p_org uuid,p_task uuid)
RETURNS TABLE(
 approval_id uuid, worker_id uuid, approval_state text, source_repo text,
 source_path text, source_ref text, source_sha text,
 created_at timestamptz, expires_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT a.id,a.worker_id,
  CASE WHEN a.state='approved' AND a.expires_at<=now() THEN 'expired'
       ELSE a.state END,
  a.source_repo,a.source_path,a.source_ref,a.source_sha,a.created_at,a.expires_at
 FROM eliot.ai_document_approvals a
 WHERE a.organization_id=p_org AND a.task_id=p_task
 AND EXISTS(
  SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
 )
 ORDER BY a.created_at DESC,a.id DESC LIMIT 20
$fn$;

CREATE FUNCTION eliot.owner_claim_document_run(
 p_org uuid,p_task uuid,p_approval uuid,p_key uuid
) RETURNS TABLE(
 run_id uuid,should_execute boolean,run_status text,task_title text,
 source_repo text,source_path text,source_ref text,source_sha text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_actor uuid;
 v_task record;
 v_approval record;
 v_saved record;
 v_state text;
 v_run_id uuid;
BEGIN
 SELECT u.id INTO v_actor FROM eliot.users u JOIN eliot.organization_memberships m
  ON m.user_id=u.id
 WHERE u.external_subject=v_subject AND m.organization_id=p_org
 AND m.status='active' AND m.role='owner';
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_key IS NULL OR p_approval IS NULL THEN
  RAISE EXCEPTION 'Missing run key or approval' USING ERRCODE='22023'; END IF;
 SELECT id,department_id,assignee_worker_id,status,title INTO v_task
 FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task not found' USING ERRCODE='22023'; END IF;
 SELECT r.id,r.approval_id,r.task_id,r.requested_by,r.status,r.source_repo,r.source_path,r.source_ref,r.source_sha
 INTO v_saved FROM eliot.ai_document_runs r
 WHERE organization_id=p_org AND request_key=p_key;
 IF FOUND THEN
  IF v_saved.approval_id IS DISTINCT FROM p_approval
  OR v_saved.task_id IS DISTINCT FROM p_task
  OR v_saved.requested_by IS DISTINCT FROM v_actor THEN
   RAISE EXCEPTION 'Conflicting retry' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT v_saved.id,false,v_saved.status::text,v_task.title::text,
   v_saved.source_repo,v_saved.source_path,v_saved.source_ref,v_saved.source_sha;
  RETURN;
 END IF;
 SELECT a.id,a.task_id,a.worker_id,a.approved_by,a.state,a.expires_at,a.capability,
  a.source_repo,a.source_path,a.source_ref,a.source_sha
 INTO v_approval FROM eliot.ai_document_approvals a
 WHERE organization_id=p_org AND id=p_approval FOR UPDATE;
 IF NOT FOUND OR v_approval.state<>'approved' OR v_approval.expires_at<=now()
 OR v_approval.capability<>'document_analysis_v1' OR v_approval.task_id IS DISTINCT FROM p_task
 OR v_approval.approved_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'Document approval expired, revoked or mismatched' USING ERRCODE='22023';
 END IF;
 IF v_task.status<>'pending' OR
 v_task.assignee_worker_id IS DISTINCT FROM v_approval.worker_id THEN
  RAISE EXCEPTION 'Task not eligible' USING ERRCODE='22023';
 END IF;
 SELECT operating_state INTO v_state FROM eliot.ai_workers
 WHERE organization_id=p_org AND id=v_approval.worker_id AND department_id=v_task.department_id FOR SHARE;
 IF NOT FOUND OR v_state<>'idle' THEN
  RAISE EXCEPTION 'Worker not idle' USING ERRCODE='22023';
 END IF;
 UPDATE eliot.ai_document_approvals SET state='claimed'
 WHERE organization_id=p_org AND id=p_approval;
 INSERT INTO eliot.ai_document_runs(
  organization_id,task_id,worker_id,approval_id,requested_by,request_key,
  source_repo,source_path,source_ref,source_sha
 ) VALUES(p_org,p_task,v_approval.worker_id,p_approval,v_actor,p_key,
          v_approval.source_repo,v_approval.source_path,v_approval.source_ref,v_approval.source_sha)
 RETURNING id INTO v_run_id;
 INSERT INTO eliot.ai_task_events(
  organization_id,task_id,worker_id,event_type,message,action_key
 ) VALUES(p_org,p_task,v_approval.worker_id,'progress',
          'Owner claimed one approved documentary analysis for exact SHA',p_key);
 RETURN QUERY SELECT v_run_id,true,'running'::text,v_task.title::text,
  v_approval.source_repo,v_approval.source_path,v_approval.source_ref,v_approval.source_sha;
END
$fn$;

CREATE FUNCTION eliot.owner_finish_document_run(
 p_org uuid,p_run uuid,p_status text,p_text text,p_error text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_actor uuid;
 v_run record;
BEGIN
 SELECT u.id INTO v_actor FROM eliot.users u JOIN eliot.organization_memberships m
  ON m.user_id=u.id
 WHERE u.external_subject=v_subject AND m.organization_id=p_org
 AND m.status='active' AND m.role='owner';
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT id,task_id,worker_id,approval_id,requested_by,status,result_text,error_code
 INTO v_run FROM eliot.ai_document_runs
 WHERE organization_id=p_org AND id=p_run FOR UPDATE;
 IF NOT FOUND OR v_run.requested_by IS DISTINCT FROM v_actor THEN
   RAISE EXCEPTION 'Run unavailable' USING ERRCODE='22023';
 END IF;
 IF p_status NOT IN ('completed','failed')
 OR (p_status='completed' AND (p_text IS NULL OR length(p_text) NOT BETWEEN 1 AND 6000
    OR p_error IS NOT NULL))
 OR (p_status='failed' AND (p_text IS NOT NULL OR p_error IS NULL
    OR p_error NOT IN ('provider_error','rate_limited','invalid_response',
                         'source_changed','source_unavailable','internal_error'))) THEN
   RAISE EXCEPTION 'Invalid result' USING ERRCODE='22023';
 END IF;
 IF v_run.status<>'running' THEN
  IF v_run.status IS DISTINCT FROM p_status
  OR v_run.result_text IS DISTINCT FROM p_text
  OR v_run.error_code IS DISTINCT FROM p_error THEN
    RAISE EXCEPTION 'Conflicting completion retry' USING ERRCODE='22023';
  END IF;
  RETURN v_run.status;
 END IF;
 UPDATE eliot.ai_document_runs SET status=p_status,result_text=p_text,
  error_code=p_error,finished_at=now() WHERE organization_id=p_org AND id=p_run;
 UPDATE eliot.ai_document_approvals SET
  state=CASE WHEN p_status='completed' THEN 'finished' ELSE 'failed' END
 WHERE organization_id=p_org AND id=v_run.approval_id AND state='claimed';
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Approval state not claimable' USING ERRCODE='22023';
 END IF;
 INSERT INTO eliot.ai_task_events(
  organization_id,task_id,worker_id,event_type,message
 ) VALUES(p_org,v_run.task_id,v_run.worker_id,
 CASE WHEN p_status='completed' THEN 'reported' ELSE 'failed' END,
 CASE WHEN p_status='completed'
      THEN 'Documentary analysis saved with exact GitHub SHA, task awaits human review'
      ELSE 'Approved documentary analysis failed; task remains pending' END);
 RETURN p_status;
END
$fn$;

CREATE FUNCTION eliot.my_document_runs(p_org uuid,p_task uuid)
RETURNS TABLE(
 run_id uuid,run_status text,run_result text,run_error text,
 source_repo text,source_path text,source_ref text,source_sha text,
 started_at timestamptz,finished_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT r.id,r.status,r.result_text,r.error_code,r.source_repo,r.source_path,r.source_ref,
 r.source_sha,r.started_at,r.finished_at
 FROM eliot.ai_document_runs r
 WHERE r.organization_id=p_org AND r.task_id=p_task
 AND EXISTS(
  SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
 )
 ORDER BY r.started_at DESC,r.id DESC LIMIT 20
$fn$;

-- Existing worker-deactivation guard from 017 now protects documentary runs too.
CREATE OR REPLACE FUNCTION eliot.prevent_deactivate_running_analysis()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
BEGIN
 IF OLD.operating_state='idle' AND NEW.operating_state='inactive'
 AND (
  EXISTS(SELECT 1 FROM eliot.ai_analysis_runs r WHERE
    r.organization_id=OLD.organization_id AND r.worker_id=OLD.id AND r.status='running')
  OR EXISTS(SELECT 1 FROM eliot.ai_document_runs r WHERE
    r.organization_id=OLD.organization_id AND r.worker_id=OLD.id AND r.status='running')
 ) THEN
  RAISE EXCEPTION 'Worker has an active approved analysis' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION eliot.owner_approve_document_analysis(uuid,uuid,uuid,text,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_revoke_document_analysis(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_document_approvals(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_claim_document_run(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_finish_document_run(uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_document_runs(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_approve_document_analysis(uuid,uuid,uuid,text,text,text,text,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_revoke_document_analysis(uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_document_approvals(uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_claim_document_run(uuid,uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_finish_document_run(uuid,uuid,text,text,text) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_document_runs(uuid,uuid) TO eliot_identity;
COMMIT;

-- 023: Durable journal for one owner-requested GitHub read. Requires 022.
-- No scheduler, model calls or external requests are executed by PostgreSQL.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_github_tool_invocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 grant_id uuid NOT NULL,
 lease_id uuid NOT NULL,
 requested_by uuid NOT NULL,
 request_key uuid NOT NULL,
 source_repo text NOT NULL,
 source_path text NOT NULL,
 source_sha text NOT NULL CHECK(source_sha ~ '^[0-9a-f]{40}$'),
 status text NOT NULL DEFAULT 'claimed' CHECK(status IN ('claimed','completed','failed')),
 byte_count integer,
 error_code text,
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 CONSTRAINT fk_github_invocation_task FOREIGN KEY(task_id,organization_id)
  REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_github_invocation_worker FOREIGN KEY(worker_id,organization_id)
  REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_github_invocation_grant FOREIGN KEY(organization_id,grant_id)
  REFERENCES eliot.ai_tool_read_grants(organization_id,id),
 CONSTRAINT fk_github_invocation_lease FOREIGN KEY(organization_id,lease_id)
  REFERENCES eliot.ai_task_execution_leases(organization_id,lease_id),
 CONSTRAINT fk_github_invocation_actor FOREIGN KEY(organization_id,requested_by)
  REFERENCES eliot.organization_memberships(organization_id,user_id),
 CONSTRAINT uq_github_invocation_grant UNIQUE(organization_id,grant_id),
 CONSTRAINT uq_github_invocation_request UNIQUE(organization_id,request_key),
 CONSTRAINT ck_github_invocation_result CHECK(
  (status='claimed' AND byte_count IS NULL AND error_code IS NULL AND finished_at IS NULL)
  OR (status='completed' AND byte_count IS NOT NULL AND byte_count BETWEEN 0 AND 16384
      AND error_code IS NULL AND finished_at IS NOT NULL)
  OR (status='failed' AND byte_count IS NULL AND error_code IS NOT NULL
      AND error_code IN ('source_unavailable','revision_mismatch','invalid_document','internal_error')
      AND finished_at IS NOT NULL)
 )
);
CREATE INDEX idx_github_invocations_task ON eliot.ai_github_tool_invocations(
 organization_id,task_id,claimed_at DESC);
ALTER TABLE eliot.ai_github_tool_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_github_tool_invocations FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_github_invocations_all ON eliot.ai_github_tool_invocations
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_start_github_invocation(
 p_org uuid,p_task uuid,p_worker uuid,p_grant uuid,p_lease uuid,
 p_repo text,p_path text,p_sha text,p_request uuid
) RETURNS TABLE(invocation_id uuid,should_execute boolean,invocation_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE v_actor uuid; v_old record; v_id uuid;
BEGIN
 SELECT u.id INTO v_actor FROM eliot.users u
 JOIN eliot.organization_memberships m ON m.user_id=u.id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF v_actor IS NULL THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_request IS NULL THEN
  RAISE EXCEPTION 'Missing request key' USING ERRCODE='22023';
 END IF;
 -- Same task lock as 022: serialize retries before checking the journal.
 PERFORM 1 FROM eliot.ai_tasks WHERE organization_id=p_org AND id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task unavailable' USING ERRCODE='22023'; END IF;
 SELECT r.* INTO v_old FROM eliot.ai_github_tool_invocations r
 WHERE r.organization_id=p_org AND r.request_key=p_request;
 IF FOUND THEN
  IF v_old.task_id IS DISTINCT FROM p_task OR v_old.worker_id IS DISTINCT FROM p_worker
  OR v_old.grant_id IS DISTINCT FROM p_grant OR v_old.lease_id IS DISTINCT FROM p_lease
  OR v_old.requested_by IS DISTINCT FROM v_actor OR v_old.source_repo IS DISTINCT FROM p_repo
  OR v_old.source_path IS DISTINCT FROM p_path OR v_old.source_sha IS DISTINCT FROM p_sha THEN
   RAISE EXCEPTION 'Conflicting invocation retry' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT v_old.id,false,v_old.status;
  RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM eliot.ai_tool_read_grants g
  WHERE g.organization_id=p_org AND g.id=p_grant
  AND g.task_id=p_task AND g.worker_id=p_worker AND g.lease_id=p_lease) THEN
  RAISE EXCEPTION 'Grant scope unavailable' USING ERRCODE='22023';
 END IF;
 -- Claim uses 022's live state/assignment/expiry checks and exact source scope.
 PERFORM eliot.owner_claim_github_read(p_org,p_grant,p_lease,p_repo,p_path,p_sha);
 INSERT INTO eliot.ai_github_tool_invocations(
  organization_id,task_id,worker_id,grant_id,lease_id,requested_by,request_key,
  source_repo,source_path,source_sha
 ) VALUES(p_org,p_task,p_worker,p_grant,p_lease,v_actor,p_request,p_repo,p_path,p_sha)
 RETURNING id INTO v_id;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,p_task,p_worker,'progress','GitHub document read authorized; invocation '||v_id::text);
 RETURN QUERY SELECT v_id,true,'claimed'::text;
END
$fn$;

CREATE FUNCTION eliot.owner_finish_github_invocation(
 p_org uuid,p_invocation uuid,p_status text,p_bytes integer,p_error text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE v_actor uuid; v_run record;
BEGIN
 SELECT u.id INTO v_actor FROM eliot.users u
 JOIN eliot.organization_memberships m ON m.user_id=u.id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT r.* INTO v_run FROM eliot.ai_github_tool_invocations r
 WHERE r.organization_id=p_org AND r.id=p_invocation FOR UPDATE;
 IF NOT FOUND OR v_run.requested_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'Invocation unavailable' USING ERRCODE='22023';
 END IF;
 IF p_status IS NULL OR p_status NOT IN ('completed','failed')
 OR (p_status='completed' AND (p_bytes IS NULL OR p_bytes NOT BETWEEN 0 AND 16384 OR p_error IS NOT NULL))
 OR (p_status='failed' AND (p_bytes IS NOT NULL OR p_error IS NULL
     OR p_error NOT IN ('source_unavailable','revision_mismatch','invalid_document','internal_error'))) THEN
  RAISE EXCEPTION 'Invalid invocation result' USING ERRCODE='22023';
 END IF;
 IF v_run.status<>'claimed' THEN
  IF v_run.status IS DISTINCT FROM p_status OR v_run.byte_count IS DISTINCT FROM p_bytes
  OR v_run.error_code IS DISTINCT FROM p_error THEN
   RAISE EXCEPTION 'Conflicting invocation completion' USING ERRCODE='22023';
  END IF;
  RETURN v_run.status;
 END IF;
 UPDATE eliot.ai_github_tool_invocations
 SET status=p_status,byte_count=p_bytes,error_code=p_error,finished_at=clock_timestamp()
 WHERE organization_id=p_org AND id=p_invocation;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,v_run.task_id,v_run.worker_id,'reported',
  CASE WHEN p_status='completed' THEN 'GitHub document read completed; task remains pending; invocation '
  ELSE 'GitHub document read failed; permission remains consumed; invocation ' END || p_invocation::text);
 RETURN p_status;
END
$fn$;

CREATE FUNCTION eliot.my_github_invocations(p_org uuid,p_task uuid)
RETURNS TABLE(invocation_id uuid,grant_id uuid,invocation_status text,
 byte_count integer,error_code text,claimed_at timestamptz,finished_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT r.id,r.grant_id,r.status,r.byte_count,r.error_code,r.claimed_at,r.finished_at
 FROM eliot.ai_github_tool_invocations r
 WHERE r.organization_id=p_org AND r.task_id=p_task AND EXISTS(
  SELECT 1 FROM eliot.users u JOIN eliot.organization_memberships m ON m.user_id=u.id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
 ) ORDER BY r.claimed_at DESC,r.id DESC LIMIT 20
$fn$;

REVOKE ALL ON FUNCTION eliot.owner_start_github_invocation(uuid,uuid,uuid,uuid,uuid,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_finish_github_invocation(uuid,uuid,text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_github_invocations(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_start_github_invocation(uuid,uuid,uuid,uuid,uuid,text,text,text,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_finish_github_invocation(uuid,uuid,text,integer,text) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_github_invocations(uuid,uuid) TO eliot_identity;
COMMIT;

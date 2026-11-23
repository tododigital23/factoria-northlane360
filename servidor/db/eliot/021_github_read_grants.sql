-- 021: Durable owner-approved, single-use GitHub document read grant.
-- APPLY ONCE as database administrator AFTER migration 020.
-- Never grants GitHub write access; no external calls from PostgreSQL.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_tool_read_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 lease_id uuid NOT NULL,
 approved_by uuid NOT NULL,
 request_key uuid NOT NULL,
 capability text NOT NULL DEFAULT 'github_document_read_v1'
   CHECK(capability='github_document_read_v1'),
 source_repo text NOT NULL CHECK(length(source_repo) BETWEEN 3 AND 210),
 source_path text NOT NULL CHECK(length(source_path) BETWEEN 6 AND 400
   AND source_path LIKE 'docs/%'
   AND source_path !~ '(^|/)\.\.(/|$)'
   AND source_path NOT LIKE '%//%'),
 source_sha text NOT NULL CHECK(source_sha ~ '^[0-9a-f]{40}$'),
 state text NOT NULL DEFAULT 'approved'
   CHECK(state IN ('approved','claimed','revoked','expired')),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now()+interval '5 minutes'),
 claimed_at timestamptz,
 revoked_at timestamptz,
 CONSTRAINT fk_tool_grant_task FOREIGN KEY(task_id,organization_id)
  REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_tool_grant_worker FOREIGN KEY(worker_id,organization_id)
  REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_tool_grant_lease FOREIGN KEY(organization_id,lease_id)
  REFERENCES eliot.ai_task_execution_leases(organization_id,lease_id),
 CONSTRAINT fk_tool_grant_owner FOREIGN KEY(organization_id,approved_by)
  REFERENCES eliot.organization_memberships(organization_id,user_id),
 CONSTRAINT uq_tool_grant_request UNIQUE(organization_id,request_key),
 CONSTRAINT uq_tool_grant_org_id UNIQUE(organization_id,id),
 CONSTRAINT ck_tool_grant_state CHECK(
  (state='claimed')=(claimed_at IS NOT NULL)
  AND (state='revoked')=(revoked_at IS NOT NULL)
 )
);
CREATE INDEX idx_tool_grants_task ON eliot.ai_tool_read_grants(
 organization_id,task_id,created_at DESC);
ALTER TABLE eliot.ai_tool_read_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_tool_read_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_tool_grant_all ON eliot.ai_tool_read_grants
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_approve_github_read(
 p_org uuid,p_task uuid,p_worker uuid,p_lease uuid,
 p_repo text,p_path text,p_sha text,p_key uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_actor uuid;
 v_task record;
 v_lease record;
 v_id uuid;
BEGIN
 SELECT u.id INTO v_actor
 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.role='owner' AND m.status='active'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF v_actor IS NULL THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_key IS NULL OR p_lease IS NULL OR p_worker IS NULL
 OR p_repo IS NULL OR length(p_repo) NOT BETWEEN 3 AND 210
 OR p_path IS NULL OR length(p_path) NOT BETWEEN 6 AND 400
 OR p_path NOT LIKE 'docs/%' OR p_path LIKE '%//%'
 OR p_path ~ '(^|/)\.\.(/|$)'
 OR p_sha IS NULL OR p_sha !~ '^[0-9a-f]{40}$' THEN
  RAISE EXCEPTION 'Invalid source scope' USING ERRCODE='22023';
 END IF;
 SELECT t.department_id,t.assignee_worker_id,t.status INTO v_task
 FROM eliot.ai_tasks t WHERE t.organization_id=p_org AND t.id=p_task FOR UPDATE;
 IF NOT FOUND OR v_task.status<>'pending'
 OR v_task.assignee_worker_id IS DISTINCT FROM p_worker THEN
  RAISE EXCEPTION 'Task not eligible' USING ERRCODE='22023';
 END IF;
 SELECT l.worker_id,l.task_id,l.state,l.expires_at INTO v_lease
 FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.lease_id=p_lease FOR UPDATE;
 IF NOT FOUND OR v_lease.task_id IS DISTINCT FROM p_task
 OR v_lease.worker_id IS DISTINCT FROM p_worker
 OR v_lease.state<>'held' OR v_lease.expires_at<=now() THEN
  RAISE EXCEPTION 'Lease not eligible' USING ERRCODE='22023';
 END IF;
 SELECT g.id INTO v_id FROM eliot.ai_tool_read_grants g
 WHERE g.organization_id=p_org AND g.request_key=p_key
 AND g.task_id=p_task AND g.worker_id=p_worker AND g.lease_id=p_lease
 AND g.source_repo=p_repo AND g.source_path=p_path AND g.source_sha=p_sha;
 IF FOUND THEN RETURN v_id; END IF;
 IF EXISTS(SELECT 1 FROM eliot.ai_tool_read_grants g
  WHERE g.organization_id=p_org AND g.request_key=p_key) THEN
  RAISE EXCEPTION 'Conflicting grant request' USING ERRCODE='22023';
 END IF;
 INSERT INTO eliot.ai_tool_read_grants(
  organization_id,task_id,worker_id,lease_id,approved_by,
  request_key,source_repo,source_path,source_sha
 ) VALUES(p_org,p_task,p_worker,p_lease,v_actor,
          p_key,p_repo,p_path,p_sha)
 RETURNING id INTO v_id;
 RETURN v_id;
END
$fn$;

CREATE FUNCTION eliot.owner_claim_github_read(
 p_org uuid,p_grant uuid,p_lease uuid,
 p_repo text,p_path text,p_sha text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_grant record;
 v_lease record;
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM eliot.organization_memberships m
  JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.role='owner' AND m.status='active'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
 ) THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 SELECT g.task_id,g.worker_id,g.lease_id,g.source_repo,g.source_path,
        g.source_sha,g.state,g.expires_at
 INTO v_grant FROM eliot.ai_tool_read_grants g
 WHERE g.organization_id=p_org AND g.id=p_grant FOR UPDATE;
 IF NOT FOUND OR v_grant.state<>'approved'
 OR v_grant.expires_at<=now()
 OR v_grant.lease_id IS DISTINCT FROM p_lease
 OR v_grant.source_repo IS DISTINCT FROM p_repo
 OR v_grant.source_path IS DISTINCT FROM p_path
 OR v_grant.source_sha IS DISTINCT FROM p_sha THEN
  RAISE EXCEPTION 'Tool grant unavailable' USING ERRCODE='22023';
 END IF;
 SELECT l.task_id,l.worker_id,l.state,l.expires_at INTO v_lease
 FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.lease_id=p_lease FOR UPDATE;
 IF NOT FOUND OR v_lease.task_id IS DISTINCT FROM v_grant.task_id
 OR v_lease.worker_id IS DISTINCT FROM v_grant.worker_id
 OR v_lease.state<>'held' OR v_lease.expires_at<=now() THEN
  RAISE EXCEPTION 'Lease no longer valid' USING ERRCODE='22023';
 END IF;
 UPDATE eliot.ai_tool_read_grants
 SET state='claimed',claimed_at=now()
 WHERE organization_id=p_org AND id=p_grant;
 RETURN true;
END
$fn$;

CREATE FUNCTION eliot.my_github_read_grants(p_org uuid,p_task uuid)
RETURNS TABLE(
 grant_id uuid,lease_id uuid,source_repo text,source_path text,
 source_sha text,grant_state text,expires_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT g.id,g.lease_id,g.source_repo,g.source_path,g.source_sha,g.state,g.expires_at
 FROM eliot.ai_tool_read_grants g
 WHERE g.organization_id=p_org AND g.task_id=p_task
 AND EXISTS(
  SELECT 1 FROM eliot.organization_memberships m
  JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.role='owner' AND m.status='active'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
 )
 ORDER BY g.created_at DESC LIMIT 20
$fn$;

REVOKE ALL ON FUNCTION eliot.owner_approve_github_read(uuid,uuid,uuid,uuid,text,text,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_claim_github_read(uuid,uuid,uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_github_read_grants(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_approve_github_read(uuid,uuid,uuid,uuid,text,text,text,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_claim_github_read(uuid,uuid,uuid,text,text,text) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_github_read_grants(uuid,uuid) TO eliot_identity;
COMMIT;

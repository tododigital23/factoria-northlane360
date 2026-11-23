-- 022: Revalidate live task and worker atomically before consuming a read grant.
-- Apply ONCE as administrator after 021. No external execution is enabled.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE OR REPLACE FUNCTION eliot.owner_claim_github_read(
 p_org uuid,p_grant uuid,p_lease uuid,
 p_repo text,p_path text,p_sha text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_grant record;
 v_task record;
 v_worker record;
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
 -- Peek only to determine lock IDs. Re-read grant under lock before consumption.
 SELECT g.task_id,g.worker_id INTO v_grant
 FROM eliot.ai_tool_read_grants g
 WHERE g.organization_id=p_org AND g.id=p_grant;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Tool grant unavailable' USING ERRCODE='22023';
 END IF;
 -- Stable lock order: task -> worker -> lease -> grant. Task mutations and
 -- worker deactivation serialize against these locks until claim commits.
 SELECT t.department_id,t.assignee_worker_id,t.status INTO v_task
 FROM eliot.ai_tasks t
 WHERE t.organization_id=p_org AND t.id=v_grant.task_id FOR UPDATE;
 IF NOT FOUND OR v_task.status IS DISTINCT FROM 'pending'
 OR v_task.assignee_worker_id IS DISTINCT FROM v_grant.worker_id THEN
  RAISE EXCEPTION 'Task no longer eligible' USING ERRCODE='22023';
 END IF;
 SELECT w.department_id,w.operating_state INTO v_worker
 FROM eliot.ai_workers w
 WHERE w.organization_id=p_org AND w.id=v_grant.worker_id FOR UPDATE;
 IF NOT FOUND OR v_worker.operating_state IS DISTINCT FROM 'idle'
 OR v_worker.department_id IS DISTINCT FROM v_task.department_id THEN
  RAISE EXCEPTION 'Worker no longer eligible' USING ERRCODE='22023';
 END IF;
 SELECT l.task_id,l.worker_id,l.state,l.expires_at INTO v_lease
 FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.lease_id=p_lease FOR UPDATE;
 IF NOT FOUND OR v_lease.task_id IS DISTINCT FROM v_grant.task_id
 OR v_lease.worker_id IS DISTINCT FROM v_grant.worker_id
 OR v_lease.state IS DISTINCT FROM 'held'
 OR v_lease.expires_at<=clock_timestamp() THEN
  RAISE EXCEPTION 'Lease no longer valid' USING ERRCODE='22023';
 END IF;
 SELECT g.task_id,g.worker_id,g.lease_id,g.source_repo,g.source_path,
        g.source_sha,g.state,g.expires_at INTO v_grant
 FROM eliot.ai_tool_read_grants g
 WHERE g.organization_id=p_org AND g.id=p_grant FOR UPDATE;
 IF NOT FOUND OR v_grant.state IS DISTINCT FROM 'approved'
 OR v_grant.expires_at<=clock_timestamp()
 OR v_lease.expires_at<=clock_timestamp()
 OR v_grant.task_id IS DISTINCT FROM v_lease.task_id
 OR v_grant.worker_id IS DISTINCT FROM v_lease.worker_id
 OR v_grant.lease_id IS DISTINCT FROM p_lease
 OR v_grant.source_repo IS DISTINCT FROM p_repo
 OR v_grant.source_path IS DISTINCT FROM p_path
 OR v_grant.source_sha IS DISTINCT FROM p_sha THEN
  RAISE EXCEPTION 'Tool grant unavailable' USING ERRCODE='22023';
 END IF;
 UPDATE eliot.ai_tool_read_grants SET state='claimed',claimed_at=clock_timestamp()
 WHERE organization_id=p_org AND id=p_grant;
 RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION eliot.owner_claim_github_read(uuid,uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_claim_github_read(uuid,uuid,uuid,text,text,text) TO eliot_identity;
COMMIT;

-- 024: Preserve historical leases; renew only through an audited owner decision.
-- Administrative migration, APPLY ONCE after 023. No automatic recovery/execution.
BEGIN;
SET LOCAL ROLE eliot_migrator;

ALTER TABLE eliot.ai_task_execution_leases
 ADD COLUMN lease_generation bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE eliot.ai_task_execution_leases DROP CONSTRAINT pk_ai_task_execution_leases;
ALTER TABLE eliot.ai_task_execution_leases
 ADD CONSTRAINT pk_ai_task_execution_leases PRIMARY KEY(organization_id,lease_id);
-- Existing uq_ai_task_execution_lease_id is retained: historical FKs depend on it.
CREATE UNIQUE INDEX uq_one_held_task_lease
 ON eliot.ai_task_execution_leases(organization_id,task_id) WHERE state='held';
CREATE INDEX idx_task_lease_generations
 ON eliot.ai_task_execution_leases(organization_id,task_id,lease_generation DESC);

CREATE TABLE eliot.ai_lease_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 previous_lease_id uuid NOT NULL,
 new_lease_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 reviewed_by uuid NOT NULL,
 request_key uuid NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 1000),
 reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT fk_lease_review_task FOREIGN KEY(task_id,organization_id)
  REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_lease_review_previous FOREIGN KEY(organization_id,previous_lease_id)
  REFERENCES eliot.ai_task_execution_leases(organization_id,lease_id),
 CONSTRAINT fk_lease_review_new FOREIGN KEY(organization_id,new_lease_id)
  REFERENCES eliot.ai_task_execution_leases(organization_id,lease_id),
 CONSTRAINT fk_lease_review_worker FOREIGN KEY(worker_id,organization_id)
  REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT fk_lease_review_actor FOREIGN KEY(organization_id,reviewed_by)
  REFERENCES eliot.organization_memberships(organization_id,user_id),
 CONSTRAINT uq_lease_review_previous UNIQUE(organization_id,previous_lease_id),
 CONSTRAINT uq_lease_review_request UNIQUE(organization_id,request_key),
 CONSTRAINT ck_lease_review_distinct CHECK(previous_lease_id<>new_lease_id)
);
ALTER TABLE eliot.ai_lease_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_lease_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_lease_review_all ON eliot.ai_lease_reviews
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

-- Private helper: no runtime grant; checks ALL rows, never a 20-item UI window.
CREATE FUNCTION eliot.task_has_unconfirmed_execution(p_org uuid,p_task uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT EXISTS(SELECT 1 FROM eliot.ai_github_tool_invocations i
  WHERE i.organization_id=p_org AND i.task_id=p_task AND i.status='claimed')
 OR EXISTS(SELECT 1 FROM eliot.ai_tool_read_grants g
  WHERE g.organization_id=p_org AND g.task_id=p_task AND g.state='claimed'
  AND NOT EXISTS(SELECT 1 FROM eliot.ai_github_tool_invocations i
   WHERE i.organization_id=g.organization_id AND i.grant_id=g.id
   AND i.status IN ('completed','failed')))
 OR EXISTS(SELECT 1 FROM eliot.ai_analysis_runs r
  WHERE r.organization_id=p_org AND r.task_id=p_task AND r.status='running')
 OR EXISTS(SELECT 1 FROM eliot.ai_document_runs r
  WHERE r.organization_id=p_org AND r.task_id=p_task AND r.status='running')
$fn$;
REVOKE ALL ON FUNCTION eliot.task_has_unconfirmed_execution(uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION eliot.owner_claim_task_lease(
 p_org uuid,p_task uuid,p_worker uuid,p_request uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE v_task record; v_worker record; v_old record; v_retry record; v_id uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')) THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_request IS NULL OR p_worker IS NULL THEN
  RAISE EXCEPTION 'Invalid lease request' USING ERRCODE='22023'; END IF;
 SELECT t.department_id,t.assignee_worker_id,t.status INTO v_task FROM eliot.ai_tasks t
 WHERE t.organization_id=p_org AND t.id=p_task FOR UPDATE;
 IF NOT FOUND OR v_task.status IS DISTINCT FROM 'pending'
 OR v_task.assignee_worker_id IS DISTINCT FROM p_worker THEN
  RAISE EXCEPTION 'Task is not eligible' USING ERRCODE='22023'; END IF;
 SELECT w.department_id,w.operating_state INTO v_worker FROM eliot.ai_workers w
 WHERE w.organization_id=p_org AND w.id=p_worker FOR UPDATE;
 IF NOT FOUND OR v_worker.department_id IS DISTINCT FROM v_task.department_id
 OR v_worker.operating_state IS DISTINCT FROM 'idle' THEN
  RAISE EXCEPTION 'Worker is not eligible' USING ERRCODE='22023'; END IF;
 SELECT l.* INTO v_old FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.task_id=p_task
 ORDER BY l.lease_generation DESC LIMIT 1 FOR UPDATE;
 IF FOUND THEN
  IF v_old.state='held' AND v_old.expires_at>clock_timestamp() THEN
   IF v_old.request_key=p_request AND v_old.worker_id=p_worker THEN RETURN v_old.lease_id; END IF;
   RAISE EXCEPTION 'Task already leased' USING ERRCODE='55P03';
  END IF;
  RAISE EXCEPTION 'Previous lease requires manual review' USING ERRCODE='55000';
 END IF;
 IF eliot.task_has_unconfirmed_execution(p_org,p_task) THEN
  RAISE EXCEPTION 'Execution outcome requires review' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.ai_task_execution_leases l
  WHERE l.organization_id=p_org AND l.request_key=p_request) THEN
  RAISE EXCEPTION 'Conflicting lease request' USING ERRCODE='22023'; END IF;
 INSERT INTO eliot.ai_task_execution_leases(organization_id,task_id,worker_id,request_key,acquired_at,expires_at)
 VALUES(p_org,p_task,p_worker,p_request,clock_timestamp(),clock_timestamp()+interval '10 minutes')
 RETURNING lease_id INTO v_id;
 RETURN v_id;
END
$fn$;

CREATE OR REPLACE FUNCTION eliot.owner_release_task_lease(p_org uuid,p_task uuid,p_lease uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE v_lease record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')) THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM eliot.ai_tasks t WHERE t.organization_id=p_org AND t.id=p_task FOR UPDATE;
 SELECT l.state INTO v_lease FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.task_id=p_task AND l.lease_id=p_lease FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Lease not found' USING ERRCODE='22023'; END IF;
 IF v_lease.state='released' THEN RETURN false; END IF;
 UPDATE eliot.ai_task_execution_leases SET state='released',released_at=clock_timestamp()
 WHERE organization_id=p_org AND task_id=p_task AND lease_id=p_lease;
 RETURN true;
END
$fn$;

CREATE OR REPLACE FUNCTION eliot.my_task_execution_lease(p_org uuid,p_task uuid)
RETURNS TABLE(lease_id uuid,worker_id uuid,lease_state text,acquired_at timestamptz,expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT l.lease_id,l.worker_id,l.state,l.acquired_at,l.expires_at FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.task_id=p_task AND EXISTS(
 SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),''))
 ORDER BY l.lease_generation DESC LIMIT 1
$fn$;

CREATE FUNCTION eliot.owner_review_and_renew_lease(
 p_org uuid,p_task uuid,p_previous uuid,p_worker uuid,p_reason text,p_request uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
DECLARE v_actor uuid; v_task record; v_worker record; v_old record; v_retry record; v_new uuid;
BEGIN
 SELECT u.id INTO v_actor FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'');
 IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_request IS NULL OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 1000 THEN
  RAISE EXCEPTION 'Reason and request key required' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM eliot.ai_tasks t WHERE t.organization_id=p_org AND t.id=p_task FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Task unavailable' USING ERRCODE='22023'; END IF;
 SELECT r.* INTO v_retry FROM eliot.ai_lease_reviews r
 WHERE r.organization_id=p_org AND r.request_key=p_request;
 IF FOUND THEN
  IF v_retry.task_id IS DISTINCT FROM p_task OR v_retry.previous_lease_id IS DISTINCT FROM p_previous
  OR v_retry.worker_id IS DISTINCT FROM p_worker OR v_retry.reviewed_by IS DISTINCT FROM v_actor
  OR v_retry.reason IS DISTINCT FROM trim(p_reason) THEN
   RAISE EXCEPTION 'Conflicting review retry' USING ERRCODE='22023'; END IF;
  RETURN v_retry.new_lease_id;
 END IF;
 SELECT t.department_id,t.assignee_worker_id,t.status INTO v_task FROM eliot.ai_tasks t
 WHERE t.organization_id=p_org AND t.id=p_task;
 IF v_task.status IS DISTINCT FROM 'pending' OR v_task.assignee_worker_id IS DISTINCT FROM p_worker THEN
  RAISE EXCEPTION 'Task no longer eligible' USING ERRCODE='22023'; END IF;
 SELECT w.department_id,w.operating_state INTO v_worker FROM eliot.ai_workers w
 WHERE w.organization_id=p_org AND w.id=p_worker FOR UPDATE;
 IF NOT FOUND OR v_worker.operating_state IS DISTINCT FROM 'idle'
 OR v_worker.department_id IS DISTINCT FROM v_task.department_id THEN
  RAISE EXCEPTION 'Worker no longer eligible' USING ERRCODE='22023'; END IF;
 SELECT l.* INTO v_old FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.task_id=p_task
 ORDER BY l.lease_generation DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR v_old.lease_id IS DISTINCT FROM p_previous
 OR (v_old.state='held' AND v_old.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Previous lease not reviewable' USING ERRCODE='22023'; END IF;
 IF eliot.task_has_unconfirmed_execution(p_org,p_task) THEN
  RAISE EXCEPTION 'Unconfirmed execution prevents renewal' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM eliot.ai_task_execution_leases l
  WHERE l.organization_id=p_org AND l.request_key=p_request) THEN
  RAISE EXCEPTION 'Request key already used' USING ERRCODE='22023'; END IF;
 UPDATE eliot.ai_task_execution_leases SET state='released',released_at=COALESCE(released_at,clock_timestamp())
 WHERE organization_id=p_org AND lease_id=p_previous;
 UPDATE eliot.ai_tool_read_grants SET state='revoked',revoked_at=clock_timestamp()
 WHERE organization_id=p_org AND lease_id=p_previous AND state='approved';
 INSERT INTO eliot.ai_task_execution_leases(organization_id,task_id,worker_id,request_key,acquired_at,expires_at)
 VALUES(p_org,p_task,p_worker,p_request,clock_timestamp(),clock_timestamp()+interval '10 minutes')
 RETURNING lease_id INTO v_new;
 INSERT INTO eliot.ai_lease_reviews(organization_id,task_id,previous_lease_id,new_lease_id,worker_id,reviewed_by,request_key,reason)
 VALUES(p_org,p_task,p_previous,v_new,p_worker,v_actor,p_request,trim(p_reason));
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,p_task,p_worker,'reported','Owner reviewed prior lease; new lease '||v_new::text||'; no execution started');
 RETURN v_new;
END
$fn$;

CREATE FUNCTION eliot.my_lease_reviews(p_org uuid,p_task uuid)
RETURNS TABLE(review_id uuid,previous_lease_id uuid,new_lease_id uuid,reason text,reviewed_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT r.id,r.previous_lease_id,r.new_lease_id,r.reason,r.reviewed_at FROM eliot.ai_lease_reviews r
 WHERE r.organization_id=p_org AND r.task_id=p_task AND EXISTS(
 SELECT 1 FROM eliot.organization_memberships m JOIN eliot.users u ON u.id=m.user_id
 WHERE m.organization_id=p_org AND m.status='active' AND m.role='owner'
 AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),''))
 ORDER BY r.reviewed_at DESC,r.id DESC LIMIT 20
$fn$;

REVOKE ALL ON FUNCTION eliot.owner_claim_task_lease(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_release_task_lease(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_task_execution_lease(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_review_and_renew_lease(uuid,uuid,uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_lease_reviews(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_claim_task_lease(uuid,uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_release_task_lease(uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_task_execution_lease(uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_review_and_renew_lease(uuid,uuid,uuid,uuid,text,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_lease_reviews(uuid,uuid) TO eliot_identity;
COMMIT;

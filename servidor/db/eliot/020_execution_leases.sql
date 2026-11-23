-- 020: Exclusive task execution leases. No model or tool execution.
-- Admin migration, run ONCE after 019. Disabled until separately integrated.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE TABLE eliot.ai_task_execution_leases (
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 worker_id uuid NOT NULL,
 lease_id uuid NOT NULL DEFAULT gen_random_uuid(),
 request_key uuid NOT NULL,
 state text NOT NULL DEFAULT 'held'
   CHECK(state IN ('held','released','expired')),
 acquired_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 released_at timestamptz,
 CONSTRAINT pk_ai_task_execution_leases PRIMARY KEY(organization_id,task_id),
 CONSTRAINT uq_ai_task_execution_lease_id UNIQUE(organization_id,lease_id),
 CONSTRAINT uq_ai_task_execution_request UNIQUE(organization_id,request_key),
 CONSTRAINT fk_ai_task_execution_task FOREIGN KEY(task_id,organization_id)
   REFERENCES eliot.ai_tasks(id,organization_id),
 CONSTRAINT fk_ai_task_execution_worker FOREIGN KEY(worker_id,organization_id)
   REFERENCES eliot.ai_workers(id,organization_id),
 CONSTRAINT ck_ai_task_execution_expiry CHECK(expires_at>acquired_at)
);
CREATE INDEX idx_ai_task_lease_expiry
 ON eliot.ai_task_execution_leases(organization_id,expires_at)
 WHERE state='held';
ALTER TABLE eliot.ai_task_execution_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_task_execution_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_lease_all ON eliot.ai_task_execution_leases
 FOR ALL TO eliot_migrator USING(true) WITH CHECK(true);

CREATE FUNCTION eliot.owner_claim_task_lease(
 p_org uuid,p_task uuid,p_worker uuid,p_request uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_task record;
 v_worker record;
 v_old record;
 v_lease uuid;
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM eliot.organization_memberships m
  JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active'
   AND m.role='owner' AND u.external_subject=v_subject
 ) THEN
  RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
 END IF;
 IF p_org IS NULL OR p_task IS NULL OR p_worker IS NULL OR p_request IS NULL THEN
  RAISE EXCEPTION 'Invalid lease request' USING ERRCODE='22023';
 END IF;
 -- Serialize all contenders for this task even when no lease row exists yet.
 SELECT t.department_id,t.assignee_worker_id,t.status
 INTO v_task FROM eliot.ai_tasks t
 WHERE t.organization_id=p_org AND t.id=p_task FOR UPDATE;
 IF NOT FOUND OR v_task.assignee_worker_id IS DISTINCT FROM p_worker
 OR v_task.status<>'pending' THEN
  RAISE EXCEPTION 'Task is not eligible' USING ERRCODE='22023';
 END IF;
 SELECT w.department_id,w.operating_state INTO v_worker
 FROM eliot.ai_workers w
 WHERE w.organization_id=p_org AND w.id=p_worker;
 IF NOT FOUND OR v_worker.department_id IS DISTINCT FROM v_task.department_id
 OR v_worker.operating_state<>'idle' THEN
  RAISE EXCEPTION 'Worker is not eligible' USING ERRCODE='22023';
 END IF;
 SELECT l.lease_id,l.request_key,l.worker_id,l.state,l.expires_at
 INTO v_old FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.task_id=p_task FOR UPDATE;
 IF FOUND THEN
  IF v_old.state='held' AND v_old.expires_at>now() THEN
   IF v_old.request_key=p_request AND v_old.worker_id=p_worker THEN
    RETURN v_old.lease_id;
   END IF;
   RAISE EXCEPTION 'Task already leased' USING ERRCODE='55P03';
  END IF;
  -- Expired lease is NOT automatically recoverable: provider outcome
  -- may be unknown, and a second model call could duplicate charges.
  RAISE EXCEPTION 'Previous lease requires manual review'
   USING ERRCODE='55000';
 END IF;
 INSERT INTO eliot.ai_task_execution_leases(
  organization_id,task_id,worker_id,request_key,expires_at
 ) VALUES(p_org,p_task,p_worker,p_request,now()+interval '10 minutes')
 RETURNING lease_id INTO v_lease;
 RETURN v_lease;
END
$fn$;

CREATE FUNCTION eliot.owner_release_task_lease(
 p_org uuid,p_task uuid,p_lease uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
 v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
 v_lease record;
BEGIN
 IF NOT EXISTS(
  SELECT 1 FROM eliot.organization_memberships m
  JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active'
  AND m.role='owner' AND u.external_subject=v_subject
 ) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 SELECT l.lease_id,l.state INTO v_lease
 FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.task_id=p_task FOR UPDATE;
 IF NOT FOUND OR v_lease.lease_id IS DISTINCT FROM p_lease THEN
  RAISE EXCEPTION 'Lease not found' USING ERRCODE='22023';
 END IF;
 IF v_lease.state='released' THEN RETURN false; END IF;
 UPDATE eliot.ai_task_execution_leases
 SET state='released',released_at=now()
 WHERE organization_id=p_org AND task_id=p_task;
 RETURN true;
END
$fn$;

CREATE FUNCTION eliot.my_task_execution_lease(p_org uuid,p_task uuid)
RETURNS TABLE(
 lease_id uuid,worker_id uuid,lease_state text,
 acquired_at timestamptz,expires_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,eliot
AS $fn$
 SELECT l.lease_id,l.worker_id,l.state,l.acquired_at,l.expires_at
 FROM eliot.ai_task_execution_leases l
 WHERE l.organization_id=p_org AND l.task_id=p_task
 AND EXISTS(
  SELECT 1 FROM eliot.organization_memberships m
  JOIN eliot.users u ON u.id=m.user_id
  WHERE m.organization_id=p_org AND m.status='active'
  AND m.role='owner'
  AND u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
 )
$fn$;

REVOKE ALL ON FUNCTION eliot.owner_claim_task_lease(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.owner_release_task_lease(uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_task_execution_lease(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_claim_task_lease(uuid,uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.owner_release_task_lease(uuid,uuid,uuid) TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_task_execution_lease(uuid,uuid) TO eliot_identity;
COMMIT;

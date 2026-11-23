-- 015: Owner-controlled worker availability. Marking 'idle' never executes an agent.
-- Apply ONCE as postgres to eliot_dev, AFTER migration 014. No scheduler,
-- tool permissions, task transitions, or external calls are added.
BEGIN;
SET LOCAL ROLE eliot_migrator;

CREATE POLICY migrator_worker_availability_update
  ON eliot.ai_workers FOR UPDATE TO eliot_migrator
  USING (true) WITH CHECK (true);

CREATE TABLE eliot.ai_worker_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  worker_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  previous_state text NOT NULL CHECK (previous_state IN ('inactive','idle')),
  new_state text NOT NULL CHECK (new_state IN ('inactive','idle')),
  action_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_worker_state_event_worker FOREIGN KEY (worker_id,organization_id)
    REFERENCES eliot.ai_workers(id,organization_id),
  CONSTRAINT fk_worker_state_event_owner FOREIGN KEY (organization_id,actor_user_id)
    REFERENCES eliot.organization_memberships(organization_id,user_id),
  CONSTRAINT uq_worker_state_action UNIQUE(organization_id,worker_id,action_key),
  CONSTRAINT ck_worker_state_changes CHECK(previous_state<>new_state)
);
CREATE INDEX idx_worker_state_events_scoped
  ON eliot.ai_worker_state_events(organization_id,worker_id,created_at DESC);
ALTER TABLE eliot.ai_worker_state_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE eliot.ai_worker_state_events FORCE ROW LEVEL SECURITY;
CREATE POLICY migrator_worker_state_events_insert
  ON eliot.ai_worker_state_events FOR INSERT TO eliot_migrator WITH CHECK (true);
CREATE POLICY migrator_worker_state_events_read
  ON eliot.ai_worker_state_events FOR SELECT TO eliot_migrator USING (true);

CREATE FUNCTION eliot.owner_set_worker_availability(
  p_org uuid, p_worker uuid, p_target text, p_key uuid
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
DECLARE
  v_subject text := NULLIF(current_setting('app.verified_subject',true),'');
  v_actor uuid;
  v_before text;
  v_prior record;
BEGIN
  SELECT u.id INTO v_actor
  FROM eliot.users u
  JOIN eliot.organization_memberships m ON m.user_id=u.id
  WHERE u.external_subject=v_subject AND m.organization_id=p_org
    AND m.status='active' AND m.role='owner';
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501';
  END IF;
  IF p_key IS NULL OR p_target IS NULL
     OR p_target NOT IN ('idle','inactive') THEN
    RAISE EXCEPTION 'Invalid availability request' USING ERRCODE='22023';
  END IF;
  SELECT operating_state INTO v_before
  FROM eliot.ai_workers
  WHERE organization_id=p_org AND id=p_worker FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Worker not in authorized company' USING ERRCODE='22023';
  END IF;
  SELECT new_state,actor_user_id INTO v_prior
  FROM eliot.ai_worker_state_events
  WHERE organization_id=p_org AND worker_id=p_worker AND action_key=p_key;
  IF FOUND THEN
    IF v_prior.new_state IS DISTINCT FROM p_target
       OR v_prior.actor_user_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Conflicting request retry' USING ERRCODE='22023';
    END IF;
    RETURN v_prior.new_state;
  END IF;
  IF v_before NOT IN ('inactive','idle') THEN
    RAISE EXCEPTION 'Worker state cannot be changed during operation'
      USING ERRCODE='22023';
  END IF;
  IF v_before=p_target THEN
    RAISE EXCEPTION 'No availability change' USING ERRCODE='22023';
  END IF;
  IF p_target='inactive' AND EXISTS(
    SELECT 1 FROM eliot.ai_tasks t
    WHERE t.organization_id=p_org AND t.assignee_worker_id=p_worker
      AND t.status IN ('queued','running')
  ) THEN
    RAISE EXCEPTION 'Worker has active or queued tasks' USING ERRCODE='22023';
  END IF;
  UPDATE eliot.ai_workers SET operating_state=p_target
  WHERE organization_id=p_org AND id=p_worker;
  INSERT INTO eliot.ai_worker_state_events(
    organization_id,worker_id,actor_user_id,previous_state,new_state,action_key
  ) VALUES(p_org,p_worker,v_actor,v_before,p_target,p_key);
  RETURN p_target;
END
$fn$;

CREATE FUNCTION eliot.my_worker_state_events(p_org uuid,p_worker uuid)
RETURNS TABLE(event_id uuid,previous_state text,new_state text,created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,eliot
AS $fn$
  SELECT e.id,e.previous_state,e.new_state,e.created_at
  FROM eliot.ai_worker_state_events e
  WHERE e.organization_id=p_org AND e.worker_id=p_worker
    AND EXISTS(
      SELECT 1 FROM eliot.users u
      JOIN eliot.organization_memberships m ON m.user_id=u.id
      WHERE u.external_subject=NULLIF(current_setting('app.verified_subject',true),'')
        AND m.organization_id=p_org AND m.status='active'
    )
  ORDER BY e.created_at DESC,e.id DESC LIMIT 50
$fn$;

REVOKE ALL ON FUNCTION eliot.owner_set_worker_availability(uuid,uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eliot.my_worker_state_events(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.owner_set_worker_availability(uuid,uuid,text,uuid)
  TO eliot_identity;
GRANT EXECUTE ON FUNCTION eliot.my_worker_state_events(uuid,uuid)
  TO eliot_identity;
COMMIT;

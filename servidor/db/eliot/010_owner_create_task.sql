-- Development-only authorized creation, called solely via authenticated FastAPI.
-- The caller sets app.verified_subject after JWT validation. This is a trusted API boundary.
BEGIN;
SET LOCAL ROLE eliot_migrator;
ALTER TABLE eliot.ai_tasks ADD COLUMN request_key uuid;
CREATE UNIQUE INDEX uq_tasks_org_request_key ON eliot.ai_tasks(organization_id,request_key) WHERE request_key IS NOT NULL;
CREATE POLICY migrator_tasks_insert ON eliot.ai_tasks FOR INSERT TO eliot_migrator WITH CHECK(true);
CREATE POLICY migrator_task_events_insert ON eliot.ai_task_events FOR INSERT TO eliot_migrator WITH CHECK(true);
CREATE FUNCTION eliot.create_task_for_owner(p_org uuid,p_dept uuid,p_assignee uuid,p_title text,p_request_key uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,eliot AS $fn$
DECLARE
 v_id uuid;
 v_prior record;
 v_sub text := NULLIF(current_setting('app.verified_subject',true),'');
BEGIN
 IF v_sub IS NULL OR NOT EXISTS(
  SELECT 1 FROM eliot.users u
  JOIN eliot.organization_memberships m ON m.user_id=u.id
  WHERE u.external_subject=v_sub AND m.organization_id=p_org AND m.status='active' AND m.role='owner'
 ) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE='42501'; END IF;
 IF p_title IS NULL OR length(trim(p_title))<3 OR length(trim(p_title))>200 THEN
  RAISE EXCEPTION 'Invalid title' USING ERRCODE='22023'; END IF;
 IF p_request_key IS NULL THEN RAISE EXCEPTION 'Missing idempotency key' USING ERRCODE='22023'; END IF;
 SELECT id,department_id,assignee_worker_id,title INTO v_prior FROM eliot.ai_tasks
 WHERE organization_id=p_org AND request_key=p_request_key;
 IF FOUND THEN
  IF v_prior.department_id<>p_dept OR v_prior.assignee_worker_id IS DISTINCT FROM p_assignee OR v_prior.title<>trim(p_title)
  THEN RAISE EXCEPTION 'Idempotency key reused with different parameters' USING ERRCODE='22023'; END IF;
  RETURN v_prior.id;
 END IF;
 INSERT INTO eliot.ai_tasks(organization_id,department_id,assignee_worker_id,title,request_key)
 VALUES(p_org,p_dept,p_assignee,trim(p_title),p_request_key)
 ON CONFLICT (organization_id,request_key) WHERE request_key IS NOT NULL DO NOTHING
 RETURNING id INTO v_id;
 IF v_id IS NULL THEN
  SELECT id,department_id,assignee_worker_id,title INTO STRICT v_prior FROM eliot.ai_tasks
  WHERE organization_id=p_org AND request_key=p_request_key;
  IF v_prior.department_id<>p_dept OR v_prior.assignee_worker_id IS DISTINCT FROM p_assignee OR v_prior.title<>trim(p_title)
  THEN RAISE EXCEPTION 'Conflicting retry' USING ERRCODE='22023'; END IF;
  RETURN v_prior.id;
 END IF;
 INSERT INTO eliot.ai_task_events(organization_id,task_id,worker_id,event_type,message)
 VALUES(p_org,v_id,p_assignee,'created','Task created by authorized owner');
 RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION eliot.create_task_for_owner(uuid,uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eliot.create_task_for_owner(uuid,uuid,uuid,text,uuid) TO eliot_identity;
COMMIT;

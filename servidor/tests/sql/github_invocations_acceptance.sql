-- Disposable PG18 after 023 and existing fixtures. All writes rolled back.
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
DECLARE
 v_org uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 v_task uuid:='77777777-7777-4777-8777-777777777777';
 v_worker uuid:='55555555-5555-4555-8555-555555555555';
 v_lease uuid; v_grant uuid; v_run record; v_retry record; v_state text;
 v_key uuid:=gen_random_uuid();
BEGIN
 v_lease:=eliot.owner_claim_task_lease(v_org,v_task,v_worker,gen_random_uuid());
 v_grant:=eliot.owner_approve_github_read(v_org,v_task,v_worker,v_lease,
  'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),gen_random_uuid());
 BEGIN
  PERFORM eliot.owner_start_github_invocation(v_org,v_task,gen_random_uuid(),v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),v_key);
  RAISE EXCEPTION 'Wrong worker accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF EXISTS(SELECT 1 FROM eliot.my_github_invocations(v_org,v_task)) THEN
  RAISE EXCEPTION 'Rejected start left journal'; END IF;
 SELECT * INTO v_run FROM eliot.owner_start_github_invocation(v_org,v_task,v_worker,v_grant,v_lease,
  'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),v_key);
 IF v_run.should_execute IS DISTINCT FROM true OR v_run.invocation_status<>'claimed' THEN
  RAISE EXCEPTION 'First invocation failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_read_grants(v_org,v_task) WHERE grant_state='claimed') THEN
  RAISE EXCEPTION 'Invocation did not consume grant'; END IF;
 SELECT * INTO v_retry FROM eliot.owner_start_github_invocation(v_org,v_task,v_worker,v_grant,v_lease,
  'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),v_key);
 IF v_retry.should_execute IS DISTINCT FROM false OR v_retry.invocation_id<>v_run.invocation_id THEN
  RAISE EXCEPTION 'Replay attempted execution'; END IF;
 BEGIN
  PERFORM eliot.owner_start_github_invocation(v_org,v_task,v_worker,v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/OTHER.md',repeat('a',40),v_key);
  RAISE EXCEPTION 'Changed request scope accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM eliot.owner_start_github_invocation(v_org,v_task,v_worker,v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),gen_random_uuid());
  RAISE EXCEPTION 'Same grant executed twice';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM eliot.owner_finish_github_invocation(v_org,v_run.invocation_id,'completed',NULL,NULL);
  RAISE EXCEPTION 'Null bytes accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM eliot.owner_finish_github_invocation(v_org,v_run.invocation_id,'failed',NULL,NULL);
  RAISE EXCEPTION 'Null failure accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 SELECT eliot.owner_finish_github_invocation(v_org,v_run.invocation_id,'completed',120,NULL) INTO v_state;
 IF v_state<>'completed' THEN RAISE EXCEPTION 'Completion failed'; END IF;
 PERFORM eliot.owner_finish_github_invocation(v_org,v_run.invocation_id,'completed',120,NULL);
 BEGIN
  PERFORM eliot.owner_finish_github_invocation(v_org,v_run.invocation_id,'failed',NULL,'internal_error');
  RAISE EXCEPTION 'Conflicting completion accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF (SELECT count(*) FROM eliot.my_github_invocations(v_org,v_task))<>1 THEN
  RAISE EXCEPTION 'Unexpected invocation count'; END IF;
 PERFORM set_config('app.verified_subject','test|ownerB',true);
 IF EXISTS(SELECT 1 FROM eliot.my_github_invocations(v_org,v_task)) THEN
  RAISE EXCEPTION 'Cross tenant journal read'; END IF;
 BEGIN
  PERFORM eliot.owner_finish_github_invocation(v_org,v_run.invocation_id,'completed',120,NULL);
  RAISE EXCEPTION 'Cross tenant finish accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM eliot.owner_start_github_invocation(v_org,v_task,v_worker,v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),gen_random_uuid());
  RAISE EXCEPTION 'Cross tenant start accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
DECLARE
 v_org uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 v_task uuid:='77777777-7777-4777-8777-777777777777';
 v_worker uuid:='55555555-5555-4555-8555-555555555555';
 v_lease uuid; v_grant uuid; v_run record;
BEGIN
 v_lease:=eliot.owner_claim_task_lease(v_org,v_task,v_worker,gen_random_uuid());
 v_grant:=eliot.owner_approve_github_read(v_org,v_task,v_worker,v_lease,
  'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),gen_random_uuid());
 SELECT * INTO v_run FROM eliot.owner_start_github_invocation(v_org,v_task,v_worker,v_grant,v_lease,
  'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),gen_random_uuid());
 PERFORM eliot.owner_finish_github_invocation(v_org,v_run.invocation_id,'failed',NULL,'revision_mismatch');
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_invocations(v_org,v_task)
  WHERE invocation_status='failed' AND error_code='revision_mismatch' AND byte_count IS NULL) THEN
  RAISE EXCEPTION 'Failure result not recorded'; END IF;
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_read_grants(v_org,v_task) WHERE grant_state='claimed') THEN
  RAISE EXCEPTION 'Failure restored a consumed grant'; END IF;
 BEGIN
  PERFORM count(*) FROM eliot.ai_github_tool_invocations;
  RAISE EXCEPTION 'Direct table access allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
ROLLBACK;

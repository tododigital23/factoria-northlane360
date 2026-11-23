-- Disposable PG18 only; fixtures from analysis_run_acceptance.sql.
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
SELECT eliot.owner_claim_task_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',
 '10000000-0000-4000-8000-000000000301') AS test_lease \gset
SELECT eliot.owner_approve_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',:'test_lease',
 'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),
 '10000000-0000-4000-8000-000000000302') AS test_grant \gset
SET LOCAL ROLE eliot_migrator;
UPDATE eliot.ai_tasks SET status='blocked' WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id='77777777-7777-4777-8777-777777777777';
SET LOCAL ROLE eliot_identity;
DO $test$
DECLARE v_lease uuid; v_grant uuid;
BEGIN
 SELECT lease_id INTO v_lease FROM eliot.my_task_execution_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 SELECT grant_id INTO v_grant FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 BEGIN
  PERFORM eliot.owner_claim_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40));
  RAISE EXCEPTION 'Unsafe claim accepted: task blocked';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777') WHERE grant_state='approved') THEN
  RAISE EXCEPTION 'Rejected claim consumed the grant';
 END IF;
END $test$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
SELECT eliot.owner_claim_task_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',
 '10000000-0000-4000-8000-000000000301') AS test_lease \gset
SELECT eliot.owner_approve_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',:'test_lease',
 'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),
 '10000000-0000-4000-8000-000000000302') AS test_grant \gset
SET LOCAL ROLE eliot_migrator;
UPDATE eliot.ai_tasks SET assignee_worker_id=NULL WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id='77777777-7777-4777-8777-777777777777';
SET LOCAL ROLE eliot_identity;
DO $test$
DECLARE v_lease uuid; v_grant uuid;
BEGIN
 SELECT lease_id INTO v_lease FROM eliot.my_task_execution_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 SELECT grant_id INTO v_grant FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 BEGIN
  PERFORM eliot.owner_claim_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40));
  RAISE EXCEPTION 'Unsafe claim accepted: task reassigned';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777') WHERE grant_state='approved') THEN
  RAISE EXCEPTION 'Rejected claim consumed the grant';
 END IF;
END $test$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
SELECT eliot.owner_claim_task_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',
 '10000000-0000-4000-8000-000000000301') AS test_lease \gset
SELECT eliot.owner_approve_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',:'test_lease',
 'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),
 '10000000-0000-4000-8000-000000000302') AS test_grant \gset
SET LOCAL ROLE eliot_migrator;
UPDATE eliot.ai_workers SET operating_state='inactive' WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND id='55555555-5555-4555-8555-555555555555';
SET LOCAL ROLE eliot_identity;
DO $test$
DECLARE v_lease uuid; v_grant uuid;
BEGIN
 SELECT lease_id INTO v_lease FROM eliot.my_task_execution_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 SELECT grant_id INTO v_grant FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 BEGIN
  PERFORM eliot.owner_claim_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40));
  RAISE EXCEPTION 'Unsafe claim accepted: worker inactive';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777') WHERE grant_state='approved') THEN
  RAISE EXCEPTION 'Rejected claim consumed the grant';
 END IF;
END $test$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
SELECT eliot.owner_claim_task_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',
 '10000000-0000-4000-8000-000000000301') AS test_lease \gset
SELECT eliot.owner_approve_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',:'test_lease',
 'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),
 '10000000-0000-4000-8000-000000000302') AS test_grant \gset
SET LOCAL ROLE eliot_migrator;
UPDATE eliot.ai_task_execution_leases SET state='released',released_at=now() WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND task_id='77777777-7777-4777-8777-777777777777';
SET LOCAL ROLE eliot_identity;
DO $test$
DECLARE v_lease uuid; v_grant uuid;
BEGIN
 SELECT lease_id INTO v_lease FROM eliot.my_task_execution_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 SELECT grant_id INTO v_grant FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 BEGIN
  PERFORM eliot.owner_claim_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40));
  RAISE EXCEPTION 'Unsafe claim accepted: lease released';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777') WHERE grant_state='approved') THEN
  RAISE EXCEPTION 'Rejected claim consumed the grant';
 END IF;
END $test$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
SELECT eliot.owner_claim_task_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',
 '10000000-0000-4000-8000-000000000301') AS test_lease \gset
SELECT eliot.owner_approve_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',:'test_lease',
 'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),
 '10000000-0000-4000-8000-000000000302') AS test_grant \gset
SET LOCAL ROLE eliot_migrator;
UPDATE eliot.ai_tool_read_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SET LOCAL ROLE eliot_identity;
DO $test$
DECLARE v_lease uuid; v_grant uuid;
BEGIN
 SELECT lease_id INTO v_lease FROM eliot.my_task_execution_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 SELECT grant_id INTO v_grant FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 BEGIN
  PERFORM eliot.owner_claim_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40));
  RAISE EXCEPTION 'Unsafe claim accepted: grant expired';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777') WHERE grant_state='approved') THEN
  RAISE EXCEPTION 'Rejected claim consumed the grant';
 END IF;
END $test$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
SELECT eliot.owner_claim_task_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',
 '10000000-0000-4000-8000-000000000301') AS test_lease \gset
SELECT eliot.owner_approve_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777','55555555-5555-4555-8555-555555555555',:'test_lease',
 'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),
 '10000000-0000-4000-8000-000000000302') AS test_grant \gset
SET LOCAL ROLE eliot_migrator;
UPDATE eliot.ai_task_execution_leases SET acquired_at=now()-interval '20 minutes',expires_at=now()-interval '1 second' WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND task_id='77777777-7777-4777-8777-777777777777';
SET LOCAL ROLE eliot_identity;
DO $test$
DECLARE v_lease uuid; v_grant uuid;
BEGIN
 SELECT lease_id INTO v_lease FROM eliot.my_task_execution_lease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 SELECT grant_id INTO v_grant FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 BEGIN
  PERFORM eliot.owner_claim_github_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_grant,v_lease,
   'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40));
  RAISE EXCEPTION 'Unsafe claim accepted: lease expired';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_read_grants('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777') WHERE grant_state='approved') THEN
  RAISE EXCEPTION 'Rejected claim consumed the grant';
 END IF;
END $test$;
ROLLBACK;

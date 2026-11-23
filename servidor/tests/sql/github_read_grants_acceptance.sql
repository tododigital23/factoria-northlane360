-- Run in disposable PG18 after existing acceptance fixtures and migration 021.
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
DECLARE
 org uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 task uuid:='77777777-7777-4777-8777-777777777777';
 worker uuid:='55555555-5555-4555-8555-555555555555';
 lease uuid;
 v_grant uuid;
 grant_again uuid;
 success boolean;
BEGIN
 SELECT eliot.owner_claim_task_lease(
 org,task,worker,'10000000-0000-4000-8000-000000000201') INTO lease;
 SELECT eliot.owner_approve_github_read(
 org,task,worker,lease,'tu-organizacion/factoria-northlane360',
 'docs/ARCHITECTURE.md',repeat('a',40),
 '10000000-0000-4000-8000-000000000202') INTO v_grant;
 SELECT eliot.owner_approve_github_read(
 org,task,worker,lease,'tu-organizacion/factoria-northlane360',
 'docs/ARCHITECTURE.md',repeat('a',40),
 '10000000-0000-4000-8000-000000000202') INTO grant_again;
 IF v_grant IS DISTINCT FROM grant_again THEN
  RAISE EXCEPTION 'Grant idempotency failed'; END IF;
 BEGIN
  PERFORM eliot.owner_approve_github_read(
   org,task,worker,lease,'tu-organizacion/factoria-northlane360',
   'docs/OTHER.md',repeat('a',40),
   '10000000-0000-4000-8000-000000000202');
  RAISE EXCEPTION 'Conflicting scope accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM eliot.owner_claim_github_read(
   org,v_grant,lease,'tu-organizacion/factoria-northlane360',
   'docs/ARCHITECTURE.md',repeat('b',40));
  RAISE EXCEPTION 'Wrong SHA accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 SELECT eliot.owner_claim_github_read(
 org,v_grant,lease,'tu-organizacion/factoria-northlane360',
 'docs/ARCHITECTURE.md',repeat('a',40)) INTO success;
 IF NOT success THEN RAISE EXCEPTION 'First claim denied'; END IF;
 BEGIN
  PERFORM eliot.owner_claim_github_read(
   org,v_grant,lease,'tu-organizacion/factoria-northlane360',
   'docs/ARCHITECTURE.md',repeat('a',40));
  RAISE EXCEPTION 'Duplicate claim allowed';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
END $test$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerB',true);
DO $test$
BEGIN
 BEGIN
  PERFORM eliot.owner_approve_github_read(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '77777777-7777-4777-8777-777777777777',
   '55555555-5555-4555-8555-555555555555',
   '11111111-1111-4111-8111-111111111111',
   'Other/repo','docs/ARCHITECTURE.md',repeat('a',40),
   '10000000-0000-4000-8000-000000000211');
  RAISE EXCEPTION 'Cross tenant approval allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
ROLLBACK;

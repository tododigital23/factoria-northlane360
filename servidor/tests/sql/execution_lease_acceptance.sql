-- Run after schema+019+020 and before analysis_run_acceptance.
-- Seed fixture from analysis_run_acceptance has not been applied yet;
-- this script is run AFTER that fixture, so task A has finished analysis.
-- Resetting a completed analysis does NOT modify task status.
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $check$
DECLARE
 org uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 task uuid:='77777777-7777-4777-8777-777777777777';
 worker uuid:='55555555-5555-4555-8555-555555555555';
 key uuid:='10000000-0000-4000-8000-000000000101';
 lease uuid;
 duplicate uuid;
 ok boolean;
BEGIN
 SELECT eliot.owner_claim_task_lease(org,task,worker,key) INTO lease;
 IF lease IS NULL THEN RAISE EXCEPTION 'Lease missing'; END IF;
 SELECT eliot.owner_claim_task_lease(org,task,worker,key) INTO duplicate;
 IF duplicate IS DISTINCT FROM lease THEN
  RAISE EXCEPTION 'Same request not idempotent'; END IF;
 BEGIN
  PERFORM eliot.owner_claim_task_lease(
   org,task,worker,'10000000-0000-4000-8000-000000000102');
  RAISE EXCEPTION 'Second lease granted';
 EXCEPTION WHEN lock_not_available THEN NULL; END;
 SELECT eliot.owner_release_task_lease(org,task,lease) INTO ok;
 IF NOT ok THEN RAISE EXCEPTION 'Release not acknowledged'; END IF;
 SELECT eliot.owner_release_task_lease(org,task,lease) INTO ok;
 IF ok THEN RAISE EXCEPTION 'Release not idempotent'; END IF;
 BEGIN
  PERFORM eliot.owner_claim_task_lease(
   org,task,worker,'10000000-0000-4000-8000-000000000103');
  RAISE EXCEPTION 'Released lease incorrectly reusable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
END $check$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerB',true);
DO $check$
BEGIN
 BEGIN
  PERFORM eliot.owner_claim_task_lease(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '77777777-7777-4777-8777-777777777777',
   '55555555-5555-4555-8555-555555555555',
   '20000000-0000-4000-8000-000000000101');
  RAISE EXCEPTION 'Cross tenant lease allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $check$;
ROLLBACK;

DO $check$
BEGIN
 IF has_table_privilege('eliot_identity','eliot.ai_task_execution_leases','INSERT')
 OR has_table_privilege('eliot_identity','eliot.ai_task_execution_leases','UPDATE') THEN
  RAISE EXCEPTION 'Identity role has direct lease table write'; END IF;
END $check$;

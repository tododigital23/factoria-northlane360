-- Disposable PG18: historical seed committed before 024. Test writes rolled back.
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
DECLARE
 org uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 task uuid:='77777777-7777-4777-8777-777777777777';
 worker uuid:='55555555-5555-4555-8555-555555555555';
 v_old uuid; v_new uuid; v_retry uuid; v_grant uuid; v_run record;
 v_key uuid:=gen_random_uuid(); v_next uuid;
BEGIN
 SELECT lease_id INTO v_old FROM eliot.my_task_execution_lease(org,task);
 IF (SELECT count(*) FROM eliot.my_github_invocations(org,task))<>1 THEN
  RAISE EXCEPTION 'Historical invocation lost during migration'; END IF;
 IF (SELECT count(*) FROM eliot.my_github_read_grants(org,task))<>1 THEN
  RAISE EXCEPTION 'Historical grant lost during migration'; END IF;
 BEGIN
  PERFORM eliot.owner_claim_task_lease(org,task,worker,gen_random_uuid());
  RAISE EXCEPTION 'Lease renewed without review';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 v_new:=eliot.owner_review_and_renew_lease(org,task,v_old,worker,'Previous read completed; explicit new reservation',v_key);
 IF v_new=v_old THEN RAISE EXCEPTION 'Historical lease ID reused'; END IF;
 SELECT lease_id INTO v_next FROM eliot.my_task_execution_lease(org,task);
 IF v_next<>v_new THEN RAISE EXCEPTION 'Reader did not return latest generation'; END IF;
 IF (SELECT count(*) FROM eliot.my_lease_reviews(org,task))<>1 THEN
  RAISE EXCEPTION 'Missing review audit'; END IF;
 v_retry:=eliot.owner_review_and_renew_lease(org,task,v_old,worker,'Previous read completed; explicit new reservation',v_key);
 IF v_retry<>v_new THEN RAISE EXCEPTION 'Review replay created a second lease'; END IF;
 BEGIN
  PERFORM eliot.owner_review_and_renew_lease(org,task,v_old,worker,'A different review reason',v_key);
  RAISE EXCEPTION 'Conflicting review retry accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM eliot.owner_review_and_renew_lease(org,task,v_new,worker,'A currently held lease must stay held',gen_random_uuid());
  RAISE EXCEPTION 'Live lease was renewed';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 PERFORM eliot.owner_release_task_lease(org,task,v_old);
 IF NOT EXISTS(SELECT 1 FROM eliot.my_task_execution_lease(org,task)
  WHERE lease_id=v_new AND lease_state='held') THEN
  RAISE EXCEPTION 'Old lease release altered new generation'; END IF;
 SELECT grant_id INTO v_grant FROM eliot.my_github_read_grants(org,task) WHERE lease_id=v_old;
 BEGIN
  PERFORM eliot.owner_claim_github_read(org,v_grant,v_old,
  'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40));
  RAISE EXCEPTION 'Historical grant reused';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 v_grant:=eliot.owner_approve_github_read(org,task,worker,v_new,
 'tu-organizacion/factoria-northlane360','docs/NEW.md',repeat('b',40),gen_random_uuid());
 SELECT * INTO v_run FROM eliot.owner_start_github_invocation(org,task,worker,v_grant,v_new,
 'tu-organizacion/factoria-northlane360','docs/NEW.md',repeat('b',40),gen_random_uuid());
 PERFORM eliot.owner_release_task_lease(org,task,v_new);
 BEGIN
  PERFORM eliot.owner_review_and_renew_lease(org,task,v_new,worker,'An unknown result must prevent renewal',gen_random_uuid());
  RAISE EXCEPTION 'Unconfirmed invocation allowed renewal';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 PERFORM eliot.owner_finish_github_invocation(org,v_run.invocation_id,'failed',NULL,'source_unavailable');
 -- A new generation requires a new permission; pending unused grants are revoked.
 v_next:=eliot.owner_review_and_renew_lease(org,task,v_new,worker,'Failure confirmed; explicit new reservation',gen_random_uuid());
 v_grant:=eliot.owner_approve_github_read(org,task,worker,v_next,
 'tu-organizacion/factoria-northlane360','docs/UNUSED.md',repeat('c',40),gen_random_uuid());
 PERFORM eliot.owner_release_task_lease(org,task,v_next);
 v_retry:=eliot.owner_review_and_renew_lease(org,task,v_next,worker,'Unused permission invalidated; new reservation',gen_random_uuid());
 IF NOT EXISTS(SELECT 1 FROM eliot.my_github_read_grants(org,task)
  WHERE grant_id=v_grant AND grant_state='revoked') THEN
  RAISE EXCEPTION 'Old unused permission not revoked'; END IF;
 -- Claimed without a journal is also unknown, even outside the 20-row UI window.
 v_grant:=eliot.owner_approve_github_read(org,task,worker,v_retry,
 'tu-organizacion/factoria-northlane360','docs/RAW.md',repeat('d',40),gen_random_uuid());
 PERFORM eliot.owner_claim_github_read(org,v_grant,v_retry,
 'tu-organizacion/factoria-northlane360','docs/RAW.md',repeat('d',40));
 PERFORM eliot.owner_release_task_lease(org,task,v_retry);
 BEGIN
  PERFORM eliot.owner_review_and_renew_lease(org,task,v_retry,worker,'Unjournaled claim must prevent renewal',gen_random_uuid());
  RAISE EXCEPTION 'Unjournaled claim allowed renewal';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL; END;
 PERFORM set_config('app.verified_subject','test|ownerB',true);
 IF EXISTS(SELECT 1 FROM eliot.my_lease_reviews(org,task)) THEN
  RAISE EXCEPTION 'Cross tenant review history leaked'; END IF;
 BEGIN
  PERFORM eliot.owner_review_and_renew_lease(org,task,v_retry,worker,'Other company cannot renew this reservation',gen_random_uuid());
  RAISE EXCEPTION 'Cross tenant renewal accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 PERFORM set_config('app.verified_subject','test|ownerA',true);
 BEGIN
  PERFORM count(*) FROM eliot.ai_lease_reviews;
  RAISE EXCEPTION 'Direct review table access granted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN
  PERFORM eliot.task_has_unconfirmed_execution(org,task);
  RAISE EXCEPTION 'Private helper executable by runtime';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE eliot_migrator;
UPDATE eliot.ai_task_execution_leases SET state='held',released_at=NULL,
 acquired_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second'
WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND task_id='77777777-7777-4777-8777-777777777777';
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $expired$
DECLARE v_old uuid; v_new uuid;
BEGIN
 SELECT lease_id INTO v_old FROM eliot.my_task_execution_lease(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 BEGIN
  PERFORM eliot.owner_review_and_renew_lease(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777',
   v_old,'55555555-5555-4555-8555-555555555555','   ',gen_random_uuid());
  RAISE EXCEPTION 'Blank review reason accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 v_new:=eliot.owner_review_and_renew_lease(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777',
  v_old,'55555555-5555-4555-8555-555555555555','Expired reservation reviewed with known prior result',gen_random_uuid());
 IF v_new=v_old THEN RAISE EXCEPTION 'Expired generation reused'; END IF;
END $expired$;
ROLLBACK;

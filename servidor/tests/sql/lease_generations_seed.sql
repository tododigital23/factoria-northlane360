-- Commit a historical lease with real grant and invocation BEFORE migrating.
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $seed$
DECLARE
 org uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 task uuid:='77777777-7777-4777-8777-777777777777';
 worker uuid:='55555555-5555-4555-8555-555555555555';
 v_lease uuid; v_grant uuid; v_run record;
BEGIN
 v_lease:=eliot.owner_claim_task_lease(org,task,worker,gen_random_uuid());
 v_grant:=eliot.owner_approve_github_read(org,task,worker,v_lease,
 'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),gen_random_uuid());
 SELECT * INTO v_run FROM eliot.owner_start_github_invocation(org,task,worker,v_grant,v_lease,
 'tu-organizacion/factoria-northlane360','docs/ARCHITECTURE.md',repeat('a',40),gen_random_uuid());
 PERFORM eliot.owner_finish_github_invocation(org,v_run.invocation_id,'completed',1,NULL);
 PERFORM eliot.owner_release_task_lease(org,task,v_lease);
END $seed$;
COMMIT;

-- Disposable PG18 integration test: claim/finish/retry/tenant boundaries.
CREATE POLICY ci_users_read ON eliot.users FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY ci_memberships_read ON eliot.organization_memberships FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY ci_tasks_read ON eliot.ai_tasks FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY ci_workers_read ON eliot.ai_workers FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY ci_events_read ON eliot.ai_task_events FOR SELECT TO eliot_migrator USING(true);
GRANT USAGE ON SCHEMA eliot TO eliot_identity;
INSERT INTO eliot.organizations(id,name) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Alpha'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Beta');
INSERT INTO eliot.users(id,external_subject) VALUES
 ('11111111-1111-4111-8111-111111111111','test|ownerA'),
 ('22222222-2222-4222-8222-222222222222','test|ownerB'),
 ('99999999-9999-4999-8999-999999999999','test|memberA');
INSERT INTO eliot.organization_memberships(organization_id,user_id,role,status) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner','active'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','owner','active'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','99999999-9999-4999-8999-999999999999','member','active');
INSERT INTO eliot.departments(id,organization_id,name) VALUES
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Development'),
 ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Development');
INSERT INTO eliot.ai_workers(id,organization_id,department_id,display_name,specialty,operating_state) VALUES
 ('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','Worker A','Software','idle'),
 ('66666666-6666-4666-8666-666666666666','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444','Worker B','Software','idle');
INSERT INTO eliot.ai_tasks(id,organization_id,department_id,assignee_worker_id,title) VALUES
 ('77777777-7777-4777-8777-777777777777','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','Review internal docs'),
 ('88888888-8888-4888-8888-888888888888','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444','66666666-6666-4666-8666-666666666666','Review beta docs');
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
SELECT eliot.owner_approve_analysis_draft(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777',
 '55555555-5555-4555-8555-555555555555',
 '11111111-aaaa-4aaa-8aaa-111111111111');
DO $test$
DECLARE approval uuid; v_run uuid; v_run_again uuid; flag boolean; st text; title text; count_runs int;
BEGIN
 SELECT approval_id INTO approval FROM eliot.my_analysis_approvals(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777') LIMIT 1;
 SELECT run_id,should_execute,run_status,task_title INTO v_run,flag,st,title
 FROM eliot.owner_claim_analysis_run(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '77777777-7777-4777-8777-777777777777',
   approval,'22222222-aaaa-4aaa-8aaa-222222222222');
 IF NOT flag OR st<>'running' OR title<>'Review internal docs' THEN
  RAISE EXCEPTION 'First claim incorrect'; END IF;
 SELECT run_id,should_execute,run_status,task_title INTO v_run_again,flag,st,title
 FROM eliot.owner_claim_analysis_run(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '77777777-7777-4777-8777-777777777777',
   approval,'22222222-aaaa-4aaa-8aaa-222222222222');
 IF flag OR v_run_again IS DISTINCT FROM v_run THEN
  RAISE EXCEPTION 'Retry created second run'; END IF;
 BEGIN
  PERFORM eliot.owner_claim_analysis_run(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '77777777-7777-4777-8777-777777777777',
   approval,'33333333-aaaa-4aaa-8aaa-333333333333');
  RAISE EXCEPTION 'Consumed approval claimed twice';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 BEGIN
  PERFORM eliot.owner_set_worker_availability(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '55555555-5555-4555-8555-555555555555',
   'inactive','33333333-bbbb-4bbb-8bbb-333333333333');
  RAISE EXCEPTION 'Deactivated worker while analysis in flight';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 BEGIN
  PERFORM eliot.owner_revoke_analysis_draft(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   approval,'44444444-aaaa-4aaa-8aaa-444444444444');
  RAISE EXCEPTION 'Claimed approval revoked';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 BEGIN
  PERFORM eliot.owner_claim_analysis_run(
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   '88888888-8888-4888-8888-888888888888',
   approval,'55555555-aaaa-4aaa-8aaa-555555555555');
  RAISE EXCEPTION 'Cross tenant claim succeeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 SELECT eliot.owner_finish_analysis_run(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_run,
   'completed','Borrador basado solo en título, sin documentos.',NULL) INTO st;
 IF st<>'completed' THEN RAISE EXCEPTION 'Completion not recorded'; END IF;
 SELECT eliot.owner_finish_analysis_run(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_run,
   'completed','Borrador basado solo en título, sin documentos.',NULL) INTO st;
 IF st<>'completed' THEN RAISE EXCEPTION 'Completion retry failed'; END IF;
 BEGIN
  PERFORM eliot.owner_finish_analysis_run(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_run,
   'completed','Different result',NULL);
  RAISE EXCEPTION 'Conflicting finish accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 SELECT count(*) INTO count_runs FROM eliot.my_analysis_runs(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '77777777-7777-4777-8777-777777777777');
 IF count_runs<>1 THEN RAISE EXCEPTION 'Owner cannot see result'; END IF;
 SELECT count(*) INTO count_runs FROM eliot.my_analysis_runs(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '88888888-8888-4888-8888-888888888888');
 IF count_runs<>0 THEN RAISE EXCEPTION 'Other tenant result leaked'; END IF;
END $test$;
COMMIT;
DO $test$
DECLARE cnt int;
BEGIN
 SELECT count(*) INTO cnt FROM eliot.ai_analysis_runs;
 IF cnt<>1 THEN RAISE EXCEPTION 'Duplicate runs'; END IF;
 SELECT count(*) INTO cnt FROM eliot.ai_execution_approvals WHERE state='finished';
 IF cnt<>1 THEN RAISE EXCEPTION 'Approval not finished'; END IF;
 SELECT count(*) INTO cnt FROM eliot.ai_task_events
 WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 IF cnt<>3 THEN RAISE EXCEPTION 'Missing or duplicate approval/run audit'; END IF;
 SELECT count(*) INTO cnt FROM eliot.ai_tasks WHERE status<>'pending';
 IF cnt<>0 THEN RAISE EXCEPTION 'Task status changed unexpectedly'; END IF;
 SELECT count(*) INTO cnt FROM eliot.ai_workers WHERE operating_state<>'idle';
 IF cnt<>0 THEN RAISE EXCEPTION 'Worker status changed unexpectedly'; END IF;
 IF has_table_privilege('eliot_identity','eliot.ai_analysis_runs','INSERT')
 OR has_table_privilege('eliot_identity','eliot.ai_analysis_runs','UPDATE') THEN
  RAISE EXCEPTION 'Runtime has direct table writes'; END IF;
END $test$;
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|memberA',true);
DO $test$
BEGIN
 BEGIN
  PERFORM eliot.owner_claim_analysis_run(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '77777777-7777-4777-8777-777777777777',
   '99999999-9999-4999-8999-999999999999',
   '66666666-aaaa-4aaa-8aaa-666666666666');
  RAISE EXCEPTION 'Non-owner claimed analysis';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $test$;
ROLLBACK;

-- PG18 disposable acceptance tests for migration 016. No execution engine.
CREATE POLICY ci_user_read ON eliot.users FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY ci_member_read ON eliot.organization_memberships FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY ci_task_read ON eliot.ai_tasks FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY ci_worker_read ON eliot.ai_workers FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY ci_event_read ON eliot.ai_task_events FOR SELECT TO eliot_migrator USING(true);
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
 ('77777777-7777-4777-8777-777777777777','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','Review docs'),
 ('88888888-8888-4888-8888-888888888888','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444','66666666-6666-4666-8666-666666666666','Review docs');

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
DECLARE v_id uuid; v_retry uuid; v_count integer; v_state text;
BEGIN
 SELECT eliot.owner_approve_analysis_draft(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777',
 '55555555-5555-4555-8555-555555555555',
 'aaaaaaaa-1111-4111-8111-111111111111') INTO v_id;
 IF v_id IS NULL THEN RAISE EXCEPTION 'Approval not recorded'; END IF;

 SELECT eliot.owner_approve_analysis_draft(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777',
 '55555555-5555-4555-8555-555555555555',
 'aaaaaaaa-1111-4111-8111-111111111111') INTO v_retry;
 IF v_retry IS DISTINCT FROM v_id THEN RAISE EXCEPTION 'Retry duplicated approval'; END IF;

 BEGIN
 PERFORM eliot.owner_approve_analysis_draft(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777',
 '66666666-6666-4666-8666-666666666666',
 'aaaaaaaa-1111-4111-8111-111111111111');
 RAISE EXCEPTION 'Conflicting retry accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;

 BEGIN
 PERFORM eliot.owner_approve_analysis_draft(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777',
 '55555555-5555-4555-8555-555555555555',
 'aaaaaaaa-2222-4222-8222-222222222222');
 RAISE EXCEPTION 'Double approval accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;

 BEGIN
 PERFORM eliot.owner_approve_analysis_draft(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 '88888888-8888-4888-8888-888888888888',
 '66666666-6666-4666-8666-666666666666',
 'aaaaaaaa-3333-4333-8333-333333333333');
 RAISE EXCEPTION 'Other company approval accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;

 SELECT count(*) INTO v_count FROM eliot.my_analysis_approvals(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777');
 IF v_count<>1 THEN RAISE EXCEPTION 'Approval not visible to owner'; END IF;
 SELECT count(*) INTO v_count FROM eliot.my_analysis_approvals(
 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
 '88888888-8888-4888-8888-888888888888');
 IF v_count<>0 THEN RAISE EXCEPTION 'Cross tenant approval visible'; END IF;

 SELECT eliot.owner_revoke_analysis_draft(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_id,
  'bbbbbbbb-1111-4111-8111-111111111111') INTO v_state;
 IF v_state<>'revoked' THEN RAISE EXCEPTION 'Revocation failed'; END IF;
 SELECT eliot.owner_revoke_analysis_draft(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_id,
  'bbbbbbbb-1111-4111-8111-111111111111') INTO v_state;
 IF v_state<>'revoked' THEN RAISE EXCEPTION 'Revocation retry failed'; END IF;
 BEGIN
  PERFORM eliot.owner_revoke_analysis_draft(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_id,
   'bbbbbbbb-2222-4222-8222-222222222222');
  RAISE EXCEPTION 'Conflicting revocation accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
END $test$;
COMMIT;

DO $test$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM eliot.ai_execution_approvals
 WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 IF n<>1 THEN RAISE EXCEPTION 'Duplicate approvals'; END IF;
 SELECT count(*) INTO n FROM eliot.ai_task_events
 WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 IF n<>2 THEN RAISE EXCEPTION 'Missing audit events or duplicates'; END IF;
 SELECT count(*) INTO n FROM eliot.ai_execution_approvals
 WHERE organization_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 IF n<>0 THEN RAISE EXCEPTION 'Other company mutated'; END IF;
 SELECT count(*) INTO n FROM eliot.ai_tasks WHERE status<>'pending';
 IF n<>0 THEN RAISE EXCEPTION 'Task status was modified'; END IF;
 SELECT count(*) INTO n FROM eliot.ai_workers WHERE operating_state<>'idle';
 IF n<>0 THEN RAISE EXCEPTION 'Worker state was modified'; END IF;
 IF has_table_privilege('eliot_identity','eliot.ai_execution_approvals','INSERT')
    OR has_table_privilege('eliot_identity','eliot.ai_execution_approvals','UPDATE') THEN
  RAISE EXCEPTION 'Identity role can mutate approvals directly';
 END IF;
END $test$;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|memberA',true);
DO $test$
BEGIN
 BEGIN
  PERFORM eliot.owner_approve_analysis_draft(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '77777777-7777-4777-8777-777777777777',
    '55555555-5555-4555-8555-555555555555',
    'dddddddd-1111-4111-8111-111111111111');
  RAISE EXCEPTION 'Member approval succeeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $test$;
SELECT count(*) AS no_approvals_for_member FROM eliot.my_analysis_approvals(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777');
ROLLBACK;

-- Expiry permits fresh approval, while old approval remains as audit.
UPDATE eliot.ai_execution_approvals SET state='expired'
 WHERE organization_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
 AND state='approved';
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
DECLARE v_id uuid;
BEGIN
 SELECT eliot.owner_approve_analysis_draft(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '77777777-7777-4777-8777-777777777777',
  '55555555-5555-4555-8555-555555555555',
  'dddddddd-2222-4222-8222-222222222222') INTO v_id;
 IF v_id IS NULL THEN RAISE EXCEPTION 'Reapproval after revocation failed'; END IF;
END $test$;
ROLLBACK;

-- Inactive workers are blocked (only unrelated seed state changed in disposable DB).
UPDATE eliot.ai_workers SET operating_state='inactive'
 WHERE id='55555555-5555-4555-8555-555555555555';
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
BEGIN
 BEGIN
  PERFORM eliot.owner_approve_analysis_draft(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '77777777-7777-4777-8777-777777777777',
   '55555555-5555-4555-8555-555555555555',
   'eeeeeeee-1111-4111-8111-111111111111');
  RAISE EXCEPTION 'Inactive worker approved';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
END $test$;
ROLLBACK;

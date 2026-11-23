-- Disposable PostgreSQL 18 acceptance tests for tenant-safe assignment.
CREATE POLICY test_users_read ON eliot.users FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_memberships_read ON eliot.organization_memberships FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_tasks_read ON eliot.ai_tasks FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_workers_read ON eliot.ai_workers FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_events_read ON eliot.ai_task_events FOR SELECT TO eliot_migrator USING(true);
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
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Develop'),
 ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Develop');
INSERT INTO eliot.ai_workers(id,organization_id,department_id,display_name,specialty) VALUES
 ('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','Worker A','Programmer'),
 ('66666666-6666-4666-8666-666666666666','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444','Worker B','Programmer'),
 ('77777777-7777-4777-8777-777777777777','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','Worker A2','Research');
INSERT INTO eliot.ai_tasks(id,organization_id,department_id,title) VALUES
 ('88888888-8888-4888-8888-888888888888','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','Test Alpha'),
 ('aaaaaaaa-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444','Test Beta');
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
DECLARE worker_id uuid; n integer;
BEGIN
 SELECT eliot.owner_assign_task(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '88888888-8888-4888-8888-888888888888',
  '55555555-5555-4555-8555-555555555555',
  'bbbbbbbb-1111-4111-8111-111111111111') INTO worker_id;
 IF worker_id <> '55555555-5555-4555-8555-555555555555' THEN RAISE EXCEPTION 'Assign failed'; END IF;
 SELECT eliot.owner_assign_task(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '88888888-8888-4888-8888-888888888888',
  '55555555-5555-4555-8555-555555555555',
  'bbbbbbbb-1111-4111-8111-111111111111') INTO worker_id;
 IF worker_id <> '55555555-5555-4555-8555-555555555555' THEN RAISE EXCEPTION 'Retry changed assignment'; END IF;
 BEGIN
  PERFORM eliot.owner_assign_task('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '88888888-8888-4888-8888-888888888888',
    '77777777-7777-4777-8777-777777777777',
    'bbbbbbbb-1111-4111-8111-111111111111');
  RAISE EXCEPTION 'Changed retry accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 BEGIN
  PERFORM eliot.owner_assign_task('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '88888888-8888-4888-8888-888888888888',
    '66666666-6666-4666-8666-666666666666',
    'bbbbbbbb-2222-4222-8222-222222222222');
  RAISE EXCEPTION 'Cross tenant assignment accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 BEGIN
  PERFORM eliot.owner_assign_task('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'aaaaaaaa-1111-4111-8111-111111111111',
    NULL,'bbbbbbbb-3333-4333-8333-333333333333');
  RAISE EXCEPTION 'Other company assignment accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM eliot.owner_assign_task('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '88888888-8888-4888-8888-888888888888',
    '55555555-5555-4555-8555-555555555555',
    'bbbbbbbb-4444-4444-8444-444444444444');
  RAISE EXCEPTION 'No-change assignment accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 SELECT eliot.owner_assign_task('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '88888888-8888-4888-8888-888888888888',
    NULL,'bbbbbbbb-5555-4555-8555-555555555555') INTO worker_id;
 IF worker_id IS NOT NULL THEN RAISE EXCEPTION 'Unassign failed'; END IF;
END $test$;
RESET ROLE;
DO $test$
DECLARE n integer; worker_id uuid;
BEGIN
 SELECT count(*) INTO n FROM eliot.ai_task_events WHERE task_id='88888888-8888-4888-8888-888888888888';
 IF n<>2 THEN RAISE EXCEPTION 'Duplicate events or missing audit: %',n; END IF;
 SELECT count(*) INTO n FROM eliot.ai_task_events WHERE organization_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 IF n<>0 THEN RAISE EXCEPTION 'Other tenant audit mutated'; END IF;
 SELECT assignee_worker_id INTO worker_id FROM eliot.ai_tasks WHERE id='88888888-8888-4888-8888-888888888888';
 IF worker_id IS NOT NULL THEN RAISE EXCEPTION 'Task still assigned'; END IF;
 SELECT count(*) INTO n FROM eliot.ai_tasks WHERE status<>'pending';
 IF n<>0 THEN RAISE EXCEPTION 'Assignment changed task lifecycle'; END IF;
END $test$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|memberA',true);
DO $test$
BEGIN
 BEGIN
  PERFORM eliot.owner_assign_task('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '88888888-8888-4888-8888-888888888888',
   '55555555-5555-4555-8555-555555555555','bbbbbbbb-6666-4666-8666-666666666666');
  RAISE EXCEPTION 'Member may not assign';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $test$;
ROLLBACK;

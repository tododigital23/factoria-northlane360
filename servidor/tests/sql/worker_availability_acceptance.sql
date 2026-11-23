-- Disposable PG18 acceptance. Owner-only availability; worker never executes.
CREATE POLICY test_users_read ON eliot.users FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_memberships_read ON eliot.organization_memberships FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_workers_read ON eliot.ai_workers FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_tasks_read ON eliot.ai_tasks FOR SELECT TO eliot_migrator USING(true);
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
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Desarrollo'),
 ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Marketing');
INSERT INTO eliot.ai_workers(id,organization_id,department_id,display_name,specialty) VALUES
 ('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','Programador A','Programación'),
 ('66666666-6666-4666-8666-666666666666','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444','Programador B','Programación');
INSERT INTO eliot.ai_tasks(id,organization_id,department_id,assignee_worker_id,title) VALUES
 ('88888888-8888-4888-8888-888888888888','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555','Review docs');

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
DECLARE state text; n int;
BEGIN
  SELECT eliot.owner_set_worker_availability(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '55555555-5555-4555-8555-555555555555','idle',
    'cccccccc-1111-4111-8111-111111111111') INTO state;
  IF state<>'idle' THEN RAISE EXCEPTION 'Worker availability failed'; END IF;
  SELECT eliot.owner_set_worker_availability(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '55555555-5555-4555-8555-555555555555','idle',
    'cccccccc-1111-4111-8111-111111111111') INTO state;
  IF state<>'idle' THEN RAISE EXCEPTION 'Idempotent retry failed'; END IF;
  BEGIN
    PERFORM eliot.owner_set_worker_availability(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '55555555-5555-4555-8555-555555555555','inactive',
      'cccccccc-1111-4111-8111-111111111111');
    RAISE EXCEPTION 'Changed retry was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM eliot.owner_set_worker_availability(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '55555555-5555-4555-8555-555555555555','idle',
      'cccccccc-2222-4222-8222-222222222222');
    RAISE EXCEPTION 'Duplicate no-op was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM eliot.owner_set_worker_availability(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '66666666-6666-4666-8666-666666666666','idle',
      'cccccccc-3333-4333-8333-333333333333');
    RAISE EXCEPTION 'Cross tenant change accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM eliot.owner_set_worker_availability(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '66666666-6666-4666-8666-666666666666','idle',
      'cccccccc-4444-4444-8444-444444444444');
    RAISE EXCEPTION 'Other tenant worker accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM eliot.owner_set_worker_availability(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '55555555-5555-4555-8555-555555555555','working',
      'cccccccc-5555-4555-8555-555555555555');
    RAISE EXCEPTION 'Working state was set directly';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  SELECT count(*) INTO n FROM eliot.my_worker_state_events(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '55555555-5555-4555-8555-555555555555');
  IF n<>1 THEN RAISE EXCEPTION 'Owner audit not readable'; END IF;
  SELECT count(*) INTO n FROM eliot.my_worker_state_events(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '66666666-6666-4666-8666-666666666666');
  IF n<>0 THEN RAISE EXCEPTION 'Other tenant audit visible'; END IF;
END $test$;
COMMIT;

DO $test$
DECLARE n int; state text;
BEGIN
  SELECT count(*) INTO n FROM eliot.ai_worker_state_events;
  IF n<>1 THEN RAISE EXCEPTION 'Unexpected audit count %',n; END IF;
  SELECT operating_state INTO state FROM eliot.ai_workers
  WHERE id='55555555-5555-4555-8555-555555555555';
  IF state<>'idle' THEN RAISE EXCEPTION 'Worker not available'; END IF;
  SELECT count(*) INTO n FROM eliot.ai_worker_state_events
  WHERE organization_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  IF n<>0 THEN RAISE EXCEPTION 'Other tenant mutated'; END IF;
  IF has_table_privilege('eliot_identity','eliot.ai_workers','UPDATE')
    OR has_table_privilege('eliot_identity','eliot.ai_worker_state_events','INSERT') THEN
    RAISE EXCEPTION 'Runtime has direct table write permissions';
  END IF;
END $test$;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|memberA',true);
DO $test$
BEGIN
  BEGIN
    PERFORM eliot.owner_set_worker_availability(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '55555555-5555-4555-8555-555555555555','inactive',
      'dddddddd-1111-4111-8111-111111111111');
    RAISE EXCEPTION 'Member was able to change worker';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $test$;
ROLLBACK;

UPDATE eliot.ai_tasks SET status='queued'
WHERE id='88888888-8888-4888-8888-888888888888';
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
BEGIN
  BEGIN
    PERFORM eliot.owner_set_worker_availability(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '55555555-5555-4555-8555-555555555555','inactive',
      'dddddddd-2222-4222-8222-222222222222');
    RAISE EXCEPTION 'Worker deactivated while task queued';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END $test$;
ROLLBACK;

-- PostgreSQL 18 disposable database integration test.
-- Administrative bootstrap policies for SECURITY DEFINER and test fixture.
CREATE POLICY test_users_read ON eliot.users FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_members_read ON eliot.organization_memberships FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_tasks_read ON eliot.ai_tasks FOR SELECT TO eliot_migrator USING(true);
GRANT USAGE ON SCHEMA eliot TO eliot_identity;

INSERT INTO eliot.organizations(id,name) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Test Alpha'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Test Beta');
INSERT INTO eliot.users(id,external_subject) VALUES
 ('11111111-1111-4111-8111-111111111111','test|ownerA'),
 ('22222222-2222-4222-8222-222222222222','test|ownerB');
INSERT INTO eliot.organization_memberships(organization_id,user_id,role,status) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner','active'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','owner','active');
INSERT INTO eliot.departments(id,organization_id,name) VALUES
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Development'),
 ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Development');
INSERT INTO eliot.ai_tasks(id,organization_id,department_id,title) VALUES
 ('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','Task A'),
 ('66666666-6666-4666-8666-666666666666','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444','Task B');

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $check$
DECLARE v_status text;
BEGIN
 SELECT eliot.owner_change_task_status(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '55555555-5555-4555-8555-555555555555','block',
  'Needs clarification','77777777-7777-4777-8777-777777777777'
 ) INTO v_status;
 IF v_status<>'blocked' THEN RAISE EXCEPTION 'Block failed'; END IF;
 SELECT eliot.owner_change_task_status(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '55555555-5555-4555-8555-555555555555','block',
  'Needs clarification','77777777-7777-4777-8777-777777777777'
 ) INTO v_status;
 IF v_status<>'blocked' THEN RAISE EXCEPTION 'Idempotent retry failed'; END IF;
 BEGIN
  PERFORM eliot.owner_change_task_status(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '55555555-5555-4555-8555-555555555555','block',
   'Changed reason','77777777-7777-4777-8777-777777777777');
  RAISE EXCEPTION 'Changed retry accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 BEGIN
  PERFORM eliot.owner_change_task_status(
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   '66666666-6666-4666-8666-666666666666','cancel',
   'Attempt cross tenant','88888888-8888-4888-8888-888888888888');
  RAISE EXCEPTION 'Cross tenant action accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM eliot.owner_change_task_status(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '55555555-5555-4555-8555-555555555555','start',
   'Attempt start','99999999-9999-4999-8999-999999999999');
  RAISE EXCEPTION 'Start action accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 SELECT eliot.owner_change_task_status(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '55555555-5555-4555-8555-555555555555','resume',
  'Owner reviewed','aaaaaaaa-1111-4111-8111-111111111111'
 ) INTO v_status;
 IF v_status<>'pending' THEN RAISE EXCEPTION 'Resume failed'; END IF;
 SELECT eliot.owner_change_task_status(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '55555555-5555-4555-8555-555555555555','cancel',
  'No longer needed','aaaaaaaa-2222-4222-8222-222222222222'
 ) INTO v_status;
 IF v_status<>'cancelled' THEN RAISE EXCEPTION 'Cancel failed'; END IF;
 BEGIN
  PERFORM eliot.owner_change_task_status(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '55555555-5555-4555-8555-555555555555','resume',
   'Improper reopen','aaaaaaaa-3333-4333-8333-333333333333');
  RAISE EXCEPTION 'Cancelled task reopened';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
END $check$;
RESET ROLE;
DO $check$
DECLARE n integer; status_value text;
BEGIN
 SELECT count(*) INTO n FROM eliot.ai_task_events
 WHERE task_id='55555555-5555-4555-8555-555555555555';
 IF n<>3 THEN RAISE EXCEPTION 'Expected 3 events, got %',n; END IF;
 SELECT status INTO status_value FROM eliot.ai_tasks
 WHERE id='55555555-5555-4555-8555-555555555555';
 IF status_value<>'cancelled' THEN RAISE EXCEPTION 'Task state not persisted'; END IF;
 SELECT count(*) INTO n FROM eliot.ai_task_events WHERE organization_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 IF n<>0 THEN RAISE EXCEPTION 'Other tenant event was written'; END IF;
END $check$;
COMMIT;

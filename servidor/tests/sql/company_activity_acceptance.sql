-- Disposable PostgreSQL 18 acceptance fixture: owner policies mirror eliot_dev.
CREATE POLICY test_migrator_users_read ON eliot.users FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_migrator_members_read ON eliot.organization_memberships FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_migrator_tasks_read ON eliot.ai_tasks FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_migrator_events_read ON eliot.ai_task_events FOR SELECT TO eliot_migrator USING(true);
CREATE POLICY test_migrator_depts_read ON eliot.departments FOR SELECT TO eliot_migrator USING(true);
GRANT USAGE ON SCHEMA eliot TO eliot_identity;

INSERT INTO eliot.organizations(id,name) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Alpha'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Beta');
INSERT INTO eliot.users(id,external_subject) VALUES
 ('11111111-1111-4111-8111-111111111111','test|alpha'),
 ('22222222-2222-4222-8222-222222222222','test|beta');
INSERT INTO eliot.organization_memberships(organization_id,user_id,role,status) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner','active'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','owner','active');
INSERT INTO eliot.departments(id,organization_id,name) VALUES
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Development'),
 ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Development');
INSERT INTO eliot.ai_tasks(id,organization_id,department_id,title) VALUES
 ('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','Alpha task'),
 ('66666666-6666-4666-8666-666666666666','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444','Beta task');
INSERT INTO eliot.ai_task_events(organization_id,task_id,event_type,message) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','55555555-5555-4555-8555-555555555555','created','Alpha event'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','55555555-5555-4555-8555-555555555555','blocked','Alpha blocked'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','66666666-6666-4666-8666-666666666666','created','Beta event');

DO $check$
BEGIN
 IF has_table_privilege('eliot_identity','eliot.ai_task_events','SELECT') THEN
  RAISE EXCEPTION 'Identity role has direct event table access';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='eliot' AND p.proname='my_company_activity' AND p.prosecdef
    AND pg_get_userbyid(p.proowner)='eliot_migrator') THEN
  RAISE EXCEPTION 'Activity function security misconfigured';
 END IF;
END $check$;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|alpha',true);
DO $check$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM eliot.my_company_activity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',50);
 IF n<>2 THEN RAISE EXCEPTION 'Expected 2 own events, got %',n; END IF;
 SELECT count(*) INTO n FROM eliot.my_company_activity('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',50);
 IF n<>0 THEN RAISE EXCEPTION 'Leaked cross-tenant event'; END IF;
 SELECT count(*) INTO n FROM eliot.my_company_activity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1);
 IF n<>1 THEN RAISE EXCEPTION 'Limit not enforced'; END IF;
 SELECT count(*) INTO n FROM eliot.my_company_activity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',101);
 IF n<>0 THEN RAISE EXCEPTION 'Over-limit accepted'; END IF;
END $check$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE eliot_identity;
DO $check$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM eliot.my_company_activity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',50);
 IF n<>0 THEN RAISE EXCEPTION 'Anonymous event leaked'; END IF;
END $check$;
ROLLBACK;

UPDATE eliot.organization_memberships SET status='suspended' WHERE organization_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|beta',true);
DO $check$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM eliot.my_company_activity('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',50);
 IF n<>0 THEN RAISE EXCEPTION 'Suspended member can read activity'; END IF;
END $check$;
ROLLBACK;

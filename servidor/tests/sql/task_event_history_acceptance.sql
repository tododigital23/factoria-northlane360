-- PostgreSQL 18 tenant event history acceptance test; CI only.
-- Must be run as postgres in a fresh disposable eliot_dev.
CREATE POLICY migrator_users_read ON eliot.users FOR SELECT TO eliot_migrator USING (true);
CREATE POLICY migrator_members_read ON eliot.organization_memberships FOR SELECT TO eliot_migrator USING (true);
GRANT USAGE ON SCHEMA eliot TO eliot_identity;
INSERT INTO eliot.organizations(id,name) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Company Alpha'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Company Beta');
INSERT INTO eliot.users(id,external_subject) VALUES
 ('11111111-1111-4111-8111-111111111111','issuer|alpha'),
 ('22222222-2222-4222-8222-222222222222','issuer|beta');
INSERT INTO eliot.organization_memberships(organization_id,user_id,role,status) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner','active'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','owner','active');
INSERT INTO eliot.departments(id,organization_id,name) VALUES
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Development'),
 ('44444444-4444-4444-8444-444444444444','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Development');
INSERT INTO eliot.ai_tasks(id,organization_id,department_id,title) VALUES
 ('55555555-5555-4555-8555-555555555555','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','Task Alpha'),
 ('66666666-6666-4666-8666-666666666666','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','44444444-4444-4444-8444-444444444444','Task Beta');
INSERT INTO eliot.ai_task_events(organization_id,task_id,event_type,message) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','55555555-5555-4555-8555-555555555555','created','Alpha event'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','66666666-6666-4666-8666-666666666666','created','Beta event');

DO $check$
BEGIN
 IF has_table_privilege('eliot_identity','eliot.ai_task_events','SELECT') THEN
  RAISE EXCEPTION 'Identity role must not read underlying events table directly';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='eliot' AND p.proname='my_task_events' AND p.prosecdef AND pg_get_userbyid(p.proowner)='eliot_migrator') THEN
  RAISE EXCEPTION 'Function owner or SECURITY DEFINER incorrect';
 END IF;
END $check$;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','issuer|alpha',true);
DO $test$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM eliot.my_task_events('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','55555555-5555-4555-8555-555555555555');
 IF n<>1 THEN RAISE EXCEPTION 'Own event invisible'; END IF;
 SELECT count(*) INTO n FROM eliot.my_task_events('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','66666666-6666-4666-8666-666666666666');
 IF n<>0 THEN RAISE EXCEPTION 'Cross-tenant event leaked'; END IF;
 SELECT count(*) INTO n FROM eliot.my_task_events('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','66666666-6666-4666-8666-666666666666');
 IF n<>0 THEN RAISE EXCEPTION 'Wrong organization+task combination leaked'; END IF;
END $test$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE eliot_identity;
DO $test$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM eliot.my_task_events('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','55555555-5555-4555-8555-555555555555');
 IF n<>0 THEN RAISE EXCEPTION 'Anonymous event leaked'; END IF;
END $test$;
ROLLBACK;

UPDATE eliot.organization_memberships SET status='suspended' WHERE organization_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','issuer|beta',true);
DO $test$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n FROM eliot.my_task_events('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','66666666-6666-4666-8666-666666666666');
 IF n<>0 THEN RAISE EXCEPTION 'Suspended member sees events'; END IF;
END $test$;
ROLLBACK;

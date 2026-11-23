-- Transactional acceptance test in disposable PostgreSQL 18.
BEGIN;
CREATE POLICY test_users_read ON eliot.users FOR SELECT TO eliot_migrator USING (true);
CREATE POLICY test_memberships_read ON eliot.organization_memberships FOR SELECT TO eliot_migrator USING (true);
CREATE POLICY test_departments_read ON eliot.departments FOR SELECT TO eliot_migrator USING (true);
CREATE POLICY test_workers_read ON eliot.ai_workers FOR SELECT TO eliot_migrator USING (true);
CREATE POLICY test_tasks_read ON eliot.ai_tasks FOR SELECT TO eliot_migrator USING (true);
DO $test$
DECLARE a uuid; b uuid; da uuid; db uuid; wa uuid; wb uuid; uid uuid; task uuid; again uuid; n int;
BEGIN
 INSERT INTO eliot.organizations(name) VALUES('Test A') RETURNING id INTO a;
 INSERT INTO eliot.organizations(name) VALUES('Test B') RETURNING id INTO b;
 INSERT INTO eliot.users(external_subject) VALUES('test|ownerA') RETURNING id INTO uid;
 INSERT INTO eliot.organization_memberships(organization_id,user_id,role,status) VALUES(a,uid,'owner','active');
 INSERT INTO eliot.departments(organization_id,name) VALUES(a,'Desarrollo') RETURNING id INTO da;
 INSERT INTO eliot.departments(organization_id,name) VALUES(b,'Desarrollo') RETURNING id INTO db;
 INSERT INTO eliot.ai_workers(organization_id,department_id,display_name,specialty) VALUES(a,da,'Worker A','coding') RETURNING id INTO wa;
 INSERT INTO eliot.ai_workers(organization_id,department_id,display_name,specialty) VALUES(b,db,'Worker B','coding') RETURNING id INTO wb;
 PERFORM set_config('app.verified_subject','test|ownerA',true);
 SELECT eliot.create_task_for_owner(a,da,wa,'Valid task','11111111-1111-4111-8111-111111111111') INTO task;
 SELECT eliot.create_task_for_owner(a,da,wa,'Valid task','11111111-1111-4111-8111-111111111111') INTO again;
 IF task <> again THEN RAISE EXCEPTION 'Idempotency failed'; END IF;
 SELECT count(*) INTO n FROM eliot.ai_task_events WHERE task_id=task;
 IF n<>1 THEN RAISE EXCEPTION 'Expected exactly one event, got %',n; END IF;
 BEGIN
  PERFORM eliot.create_task_for_owner(a,da,wa,'Changed title','11111111-1111-4111-8111-111111111111');
  RAISE EXCEPTION 'Changed payload accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 BEGIN
  PERFORM eliot.create_task_for_owner(b,db,wb,'Unauthorized task','22222222-2222-4222-8222-222222222222');
  RAISE EXCEPTION 'Other-tenant creation accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 BEGIN
  PERFORM eliot.create_task_for_owner(a,db,wb,'Wrong tenant worker','33333333-3333-4333-8333-333333333333');
  RAISE EXCEPTION 'Cross-tenant FK accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL;
 END;
 SELECT count(*) INTO n FROM eliot.ai_tasks;
 IF n<>1 THEN RAISE EXCEPTION 'Expected one persisted task, got %',n; END IF;
END
$test$;
ROLLBACK;

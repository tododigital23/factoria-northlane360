-- Disposable PG18 integration test following acceptance seeds 017 + 018.
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
DO $test$
DECLARE
 org uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 key uuid := '10000000-0000-4000-8000-000000000001';
 current_day date;
 calls int;
 reserved int;
 input_sum bigint;
 output_sum bigint;
 accepted boolean;
 i int;
BEGIN
 SELECT eliot.owner_reserve_model_budget(org,key,1000) INTO accepted;
 IF NOT accepted THEN RAISE EXCEPTION 'First budget reservation denied'; END IF;
 SELECT eliot.owner_reserve_model_budget(org,key,1000) INTO accepted;
 IF NOT accepted THEN RAISE EXCEPTION 'Idempotent reservation denied'; END IF;
 BEGIN
  PERFORM eliot.owner_reserve_model_budget(org,key,1001);
  RAISE EXCEPTION 'Conflicting key accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF NOT eliot.owner_reconcile_model_budget(org,key,123,45) THEN
  RAISE EXCEPTION 'First reconciliation not accepted'; END IF;
 IF eliot.owner_reconcile_model_budget(org,key,123,45) THEN
  RAISE EXCEPTION 'Duplicate reconciliation counted again'; END IF;
 BEGIN
  PERFORM eliot.owner_reconcile_model_budget(org,key,124,45);
  RAISE EXCEPTION 'Conflicting reconciliation accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;

 FOR i IN 2..30 LOOP
  SELECT eliot.owner_reserve_model_budget(
   org, ('10000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,1000
  ) INTO accepted;
  IF NOT accepted THEN RAISE EXCEPTION 'Denied reservation %',i; END IF;
 END LOOP;
 SELECT eliot.owner_reserve_model_budget(
  org,'10000000-0000-4000-8000-000000000031',1000
 ) INTO accepted;
 IF accepted THEN RAISE EXCEPTION '31st reservation exceeded daily cap'; END IF;

 SELECT day_utc,calls_reserved,token_units_reserved,input_tokens_reported,output_tokens_reported
 INTO current_day,calls,reserved,input_sum,output_sum
 FROM eliot.my_model_budget_status(org);
 IF current_day IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date
 OR calls<>30 OR reserved<>30000 OR input_sum<>123 OR output_sum<>45 THEN
  RAISE EXCEPTION 'Daily ledger counts wrong: %,%,%,%,%',
   current_day,calls,reserved,input_sum,output_sum;
 END IF;
END $test$;
COMMIT;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerB',true);
DO $test$
DECLARE
 org uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 accepted boolean; i int; calls int; reserved int;
BEGIN
 FOR i IN 1..9 LOOP
  SELECT eliot.owner_reserve_model_budget(
   org, ('20000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,10000
  ) INTO accepted;
  IF NOT accepted THEN RAISE EXCEPTION 'Token budget denied call %',i; END IF;
 END LOOP;
 SELECT eliot.owner_reserve_model_budget(
  org,'20000000-0000-4000-8000-000000000010',1
 ) INTO accepted;
 IF accepted THEN RAISE EXCEPTION 'Token cap exceeded'; END IF;
 SELECT calls_reserved,token_units_reserved INTO calls,reserved
 FROM eliot.my_model_budget_status(org);
 IF calls<>9 OR reserved<>90000 THEN RAISE EXCEPTION 'Token ledger corrupt'; END IF;

 BEGIN
  PERFORM eliot.owner_reserve_model_budget(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '20000000-0000-4000-8000-000000000011',1000);
  RAISE EXCEPTION 'Cross tenant reserve allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
COMMIT;

BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|memberA',true);
DO $test$
BEGIN
 BEGIN
  PERFORM eliot.owner_reserve_model_budget(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '30000000-0000-4000-8000-000000000001',1000);
  RAISE EXCEPTION 'Member reserve allowed';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 IF EXISTS(SELECT 1 FROM eliot.my_model_budget_status(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) THEN
  RAISE EXCEPTION 'Member can read company quota'; END IF;
END $test$;
ROLLBACK;

DO $test$
BEGIN
 IF has_table_privilege('eliot_identity','eliot.ai_model_budget_daily','INSERT')
 OR has_table_privilege('eliot_identity','eliot.ai_model_budget_reservations','UPDATE') THEN
  RAISE EXCEPTION 'Identity role has direct budget table access'; END IF;
END $test$;

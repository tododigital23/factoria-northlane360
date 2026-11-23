-- PG18: run AFTER tests/sql/analysis_run_acceptance.sql seeds companies.
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|ownerA',true);
SELECT eliot.owner_approve_document_analysis(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777',
 '55555555-5555-4555-8555-555555555555','tu-organizacion/factoria-northlane360',
 'docs/README.md','main','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 '11111111-cccc-4aaa-8aaa-111111111111'
);
DO $test$
DECLARE
 approval uuid; v_run uuid; v_retry uuid; allowed boolean; st text;
 title text; repo text; path text; ref text; sha text; count_results int;
BEGIN
 SELECT approval_id INTO approval FROM eliot.my_document_approvals(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777') LIMIT 1;
 IF approval IS NULL THEN RAISE EXCEPTION 'Missing document approval'; END IF;
 SELECT run_id,should_execute,run_status,task_title,source_repo,source_path,source_ref,source_sha
 INTO v_run,allowed,st,title,repo,path,ref,sha
 FROM eliot.owner_claim_document_run(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777',approval,
 '22222222-cccc-4aaa-8aaa-222222222222');
 IF NOT allowed OR st<>'running' OR sha<>'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
 OR path<>'docs/README.md' OR title<>'Review internal docs' THEN
  RAISE EXCEPTION 'Unverified document run claim';
 END IF;
 SELECT x.run_id,x.should_execute INTO v_retry,allowed
 FROM eliot.owner_claim_document_run(
 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
 '77777777-7777-4777-8777-777777777777',approval,
 '22222222-cccc-4aaa-8aaa-222222222222') AS x;
 IF allowed OR v_retry IS DISTINCT FROM v_run THEN
  RAISE EXCEPTION 'Retry duplicated model authorization'; END IF;
 BEGIN
  PERFORM eliot.owner_claim_document_run(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777',
  approval,'33333333-cccc-4aaa-8aaa-333333333333');
  RAISE EXCEPTION 'Second model claim accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM eliot.owner_revoke_document_analysis(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',approval,'44444444-cccc-4aaa-8aaa-444444444444');
  RAISE EXCEPTION 'Claimed approval revoked';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM eliot.owner_set_worker_availability(
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '55555555-5555-4555-8555-555555555555','inactive',
   '55555555-cccc-4aaa-8aaa-555555555555');
  RAISE EXCEPTION 'Worker deactivated during document run';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM eliot.owner_claim_document_run(
   'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
   '88888888-8888-4888-8888-888888888888',
   approval,'66666666-cccc-4aaa-8aaa-666666666666');
  RAISE EXCEPTION 'Cross-tenant claim accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 SELECT eliot.owner_finish_document_run(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_run,'completed',
  'Hallazgo sustentado: [L1-L2] con SHA aprobado.',NULL) INTO st;
 IF st<>'completed' THEN RAISE EXCEPTION 'Run not finished'; END IF;
 SELECT eliot.owner_finish_document_run(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_run,'completed',
  'Hallazgo sustentado: [L1-L2] con SHA aprobado.',NULL) INTO st;
 IF st<>'completed' THEN RAISE EXCEPTION 'Same result retry rejected'; END IF;
 BEGIN
  PERFORM eliot.owner_finish_document_run(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_run,'completed','different',NULL);
  RAISE EXCEPTION 'Conflicting completion accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 SELECT count(*) INTO count_results FROM eliot.my_document_runs(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777');
 IF count_results<>1 THEN RAISE EXCEPTION 'Missing owner run'; END IF;
 SELECT count(*) INTO count_results FROM eliot.my_document_runs(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','88888888-8888-4888-8888-888888888888');
 IF count_results<>0 THEN RAISE EXCEPTION 'Other tenant results leaked'; END IF;
END $test$;
COMMIT;
DO $test$
DECLARE cnt int;
BEGIN
 SELECT count(*) INTO cnt FROM eliot.ai_document_runs;
 IF cnt<>1 THEN RAISE EXCEPTION 'Duplicate document run'; END IF;
 SELECT count(*) INTO cnt FROM eliot.ai_document_approvals WHERE state='finished';
 IF cnt<>1 THEN RAISE EXCEPTION 'Approval not completed'; END IF;
 IF has_table_privilege('eliot_identity','eliot.ai_document_runs','INSERT')
 OR has_table_privilege('eliot_identity','eliot.ai_document_approvals','INSERT') THEN
  RAISE EXCEPTION 'Identity role can write tables directly'; END IF;
END $test$;
BEGIN;
SET LOCAL ROLE eliot_identity;
SELECT set_config('app.verified_subject','test|memberA',true);
DO $test$
BEGIN
 BEGIN
  PERFORM eliot.owner_approve_document_analysis(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','77777777-7777-4777-8777-777777777777',
  '55555555-5555-4555-8555-555555555555','tu-organizacion/factoria-northlane360',
  'docs/README.md','main','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '88888888-cccc-4aaa-8aaa-888888888888');
  RAISE EXCEPTION 'Nonowner approved document transfer';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
ROLLBACK;

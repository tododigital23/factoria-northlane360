#!/usr/bin/env bash
# Local replica of .github/workflows/durable-document-jobs-043.yml (pg18-grants job) against a
# DISPOSABLE database. Refuses to run unless ELIOT_TEST_DISPOSABLE_DB=1 and PGDATABASE=eliot_dev
# on a local socket/host. Never point this at Railway or any shared database.
# Usage: SCHEMA_DIR=<dir with foundation SQL from the historical branches> scripts/local_pg_pipeline.sh [--with-new]
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SCHEMA_DIR:?SCHEMA_DIR must hold 001/003/005/008 from feature/tenant-tasks-events-foundation, 010.sql and 012.sql}"
[ "${ELIOT_TEST_DISPOSABLE_DB:-}" = 1 ] || { echo "ELIOT_TEST_DISPOSABLE_DB=1 required" >&2; exit 2; }
case "${PGHOST:-}" in localhost|127.0.0.1|/tmp|/var/run/postgresql) ;; *) echo "Refusing non-local PGHOST" >&2; exit 2;; esac
export PGDATABASE=eliot_dev
q() { psql -q -v ON_ERROR_STOP=1 "$@" >/dev/null; }
psql -q -d postgres -c "DROP DATABASE IF EXISTS eliot_dev WITH (FORCE)" -c "CREATE DATABASE eliot_dev" >/dev/null
psql -q -d postgres -c "DO \$\$DECLARE r text; BEGIN FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'eliot%' OR rolname LIKE 'ci\_%' LOOP EXECUTE format('DROP ROLE %I', r); END LOOP; END\$\$" >/dev/null
q -c "CREATE ROLE eliot_migrator NOLOGIN; CREATE ROLE eliot_identity NOLOGIN; CREATE SCHEMA eliot AUTHORIZATION eliot_migrator;"
(echo 'SET ROLE eliot_migrator;'; cat "$SCHEMA_DIR"/001_core_identity.sql "$SCHEMA_DIR"/003_departments.sql "$SCHEMA_DIR"/005_ai_workers.sql "$SCHEMA_DIR"/008_tasks_events.sql) | q
q -c 'SET ROLE eliot_migrator' -f db/eliot/004_my_departments.sql -f db/eliot/007_my_workers.sql -f db/eliot/009_my_tasks.sql
q -f "$SCHEMA_DIR"/010.sql; q -f "$SCHEMA_DIR"/012.sql
for f in 014_owner_task_assignment 015_worker_availability 016_analysis_draft_approval 017_analysis_runs 018_document_analysis 019_durable_model_budget 020_execution_leases 021_github_read_grants; do q -f db/eliot/$f.sql; done
for f in analysis_run document_analysis durable_model_budget execution_lease; do q -f tests/sql/${f}_acceptance.sql; done
q -f db/eliot/022_github_claim_revalidation.sql
q -f tests/sql/github_read_grants_acceptance.sql; q -f tests/sql/github_claim_revalidation_acceptance.sql
q -f db/eliot/023_github_tool_invocations.sql; q -f tests/sql/github_invocations_acceptance.sql
q -f tests/sql/lease_generations_seed.sql; q -f db/eliot/024_reviewed_lease_generations.sql; q -f tests/sql/lease_generations_acceptance.sql
q -f db/eliot/025_durable_document_jobs.sql
run() { echo "== $1"; PYTHONPATH=. python "$1" | tail -1; }
run tests/pg/lease_review_concurrency.py; run tests/pg/durable_document_jobs.py
q -f db/eliot/026_document_work_reviews.sql; run tests/pg/document_work_reviews.py
q -f db/eliot/027_persistent_document_plans.sql; run tests/pg/document_plans.py; run tests/pg/plan_tracking.py
q -f db/eliot/028_document_plan_controls.sql; run tests/pg/document_plan_controls.py
q -f db/eliot/029_approved_document_objectives.sql; run tests/pg/document_objectives.py
q -f db/eliot/030_sequential_document_missions.sql; run tests/pg/document_missions.py; run tests/pg/office_overview.py
q -f db/eliot/031_document_mission_controls.sql
# With --with-new (032+033) the later suites also act as regression tests for them.
if [ "${1:-}" = --with-new ]; then q -f db/eliot/032_document_plan_recovery.sql; q -f db/eliot/033_mission_autopilot.sql; q -f db/eliot/034_holding_companies.sql; q -f db/eliot/035_agent_requests_memory.sql; q -f db/eliot/036_company_rename.sql; q -f db/eliot/037_holding_storage.sql; q -f db/eliot/038_company_retirement.sql; q -f db/eliot/039_holding_viewers.sql; q -f db/eliot/040_company_break.sql; q -f db/eliot/041_invite_open_check.sql; fi
run tests/pg/document_mission_controls.py; run tests/pg/mission_delivery.py
run tests/pg/objective_planning.py
if [ "${1:-}" = --with-new ]; then run tests/pg/document_plan_recovery.py; run tests/pg/mission_autopilot.py; run tests/pg/holding_companies.py; run tests/pg/agent_requests_memory.py; run tests/pg/company_rename.py; run tests/pg/holding_storage.py; run tests/pg/company_retirement.py; run tests/pg/holding_viewers.py; run tests/pg/company_break.py; run tests/pg/tenant_isolation_sweep.py; fi
echo "PIPELINE OK"

"""Instalación completa del esquema en un VPS o en local.

PostgreSQL nativo: aplica db/eliot/base y las migraciones numeradas, en orden.
Cualquier otro motor SQL: crea las tablas del almacén portable.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL_DIR = ROOT / "db" / "eliot"
BASE_DIR = SQL_DIR / "base"

ORDER = (
    BASE_DIR / "001_core_identity.sql",
    SQL_DIR / "002_my_organizations.sql",
    BASE_DIR / "003_departments.sql",
    BASE_DIR / "005_ai_workers.sql",
    BASE_DIR / "008_tasks_events.sql",
    SQL_DIR / "004_my_departments.sql",
    SQL_DIR / "007_my_workers.sql",
    SQL_DIR / "009_my_tasks.sql",
    SQL_DIR / "010_owner_create_task.sql",
    SQL_DIR / "011_task_event_reader.sql",
    SQL_DIR / "012_owner_task_status.sql",
    SQL_DIR / "013_company_activity.sql",
    SQL_DIR / "014_owner_task_assignment.sql",
    SQL_DIR / "015_worker_availability.sql",
    SQL_DIR / "016_analysis_draft_approval.sql",
    SQL_DIR / "017_analysis_runs.sql",
    SQL_DIR / "018_document_analysis.sql",
    SQL_DIR / "019_durable_model_budget.sql",
    SQL_DIR / "020_execution_leases.sql",
    SQL_DIR / "021_github_read_grants.sql",
    SQL_DIR / "022_github_claim_revalidation.sql",
    SQL_DIR / "023_github_tool_invocations.sql",
    SQL_DIR / "024_reviewed_lease_generations.sql",
    SQL_DIR / "025_durable_document_jobs.sql",
    SQL_DIR / "026_document_work_reviews.sql",
    SQL_DIR / "027_persistent_document_plans.sql",
    SQL_DIR / "028_document_plan_controls.sql",
    SQL_DIR / "029_approved_document_objectives.sql",
    SQL_DIR / "030_sequential_document_missions.sql",
    SQL_DIR / "031_document_mission_controls.sql",
    SQL_DIR / "032_document_plan_recovery.sql",
    SQL_DIR / "033_mission_autopilot.sql",
    SQL_DIR / "034_holding_companies.sql",
    SQL_DIR / "035_agent_requests_memory.sql",
    SQL_DIR / "036_company_rename.sql",
    SQL_DIR / "037_holding_storage.sql",
    SQL_DIR / "038_company_retirement.sql",
    SQL_DIR / "039_holding_viewers.sql",
    SQL_DIR / "040_company_break.sql",
    SQL_DIR / "041_invite_open_check.sql",
)


def log(msg):
    print("install:", msg, flush=True)


def _ensure_migrator_bypass_rls(cur):
    """FORCE RLS + SECURITY DEFINER: sin BYPASSRLS el alta de empresas responde 403 al propietario."""
    try:
        cur.execute("ALTER ROLE eliot_migrator BYPASSRLS")
        cur.execute("""
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'eliot' AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET row_security = off', r.sig);
  END LOOP;
END $$;
""")
        log("eliot_migrator BYPASSRLS")
    except Exception as exc:
        log("BYPASSRLS no se pudo aplicar (%s: %s)" % (type(exc).__name__, exc))


def _ensure_my_organizations(cur):
    """Instalaciones viejas no traían eliot.my_organizations(); sin ella el listado de empresas da 503."""
    try:
        cur.execute("SELECT to_regprocedure('eliot.my_organizations()')")
        if cur.fetchone()[0]:
            return
        sql = (SQL_DIR / "002_my_organizations.sql").read_text(encoding="utf-8")
        cur.execute("SET ROLE eliot_migrator")
        try:
            cur.execute(sql)
        finally:
            cur.execute("RESET ROLE")
        log("002_my_organizations.sql aplicada")
    except Exception as exc:
        try:
            cur.execute("RESET ROLE")
        except Exception:
            pass
        log("my_organizations no se pudo crear (%s: %s)" % (type(exc).__name__, exc))


def database_url():
    for name in ("DATABASE_URL", "DATABASE_PRIVATE_URL", "POSTGRES_URL",
                 "ELIOT_MIGRATE_URL", "ELIOT_DATABASE_URL"):
        value = os.getenv(name)
        if value:
            return value
    return ""


def apply_postgres():
    import psycopg
    url = database_url()
    if url:
        params = {"conninfo": url}
    elif os.getenv("PGHOST"):
        params = dict(host=os.environ["PGHOST"], port=int(os.getenv("PGPORT", "5432")),
                      user=os.environ["PGUSER"], password=os.environ["PGPASSWORD"],
                      dbname=os.getenv("ELIOT_DB_NAME") or os.getenv("PGDATABASE") or "eliot_dev")
    else:
        log("falta DATABASE_URL. En Railway: servicio de la API → Variables → New Variable → "
            "Add a variable reference → Postgres → DATABASE_URL. Luego Redeploy.")
        return 6
    with psycopg.connect(**params, autocommit=True, connect_timeout=15) as conn:
        cur = conn.cursor()
        cur.execute("SELECT current_database()")
        log("base=" + cur.fetchone()[0])
        cur.execute("""
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eliot_migrator') THEN
    CREATE ROLE eliot_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eliot_identity') THEN
    CREATE ROLE eliot_identity NOLOGIN;
  END IF;
END
$$;
""")
        cur.execute("CREATE SCHEMA IF NOT EXISTS eliot AUTHORIZATION eliot_migrator")
        cur.execute("GRANT eliot_migrator TO CURRENT_USER")
        cur.execute("GRANT eliot_identity TO CURRENT_USER")
        cur.execute("GRANT USAGE ON SCHEMA eliot TO eliot_identity")
        cur.execute("SELECT to_regclass('eliot.holdings')")
        if cur.fetchone()[0]:
            log("esquema ya presente")
            _ensure_my_organizations(cur)
            _ensure_migrator_bypass_rls(cur)
            return 0
        # 025 crea eliot_execution_worker; hace falta CREATEROLE solo durante el apply.
        cur.execute("ALTER ROLE eliot_migrator CREATEROLE")
        cur.execute("SET ROLE eliot_migrator")
        for path in ORDER:
            if not path.exists():
                cur.execute("RESET ROLE")
                cur.execute("ALTER ROLE eliot_migrator NOCREATEROLE")
                log(f"falta {path.name}; abortado")
                return 4
            sql = path.read_text(encoding="utf-8")
            try:
                cur.execute(sql)
            except psycopg.Error as orig:
                cur.execute("RESET ROLE")
                cur.execute("ALTER ROLE eliot_migrator NOCREATEROLE")
                log(f"{path.name} FALLÓ ({type(orig).__name__}: {orig})")
                return 5
            log(f"{path.name} aplicada")
        cur.execute("RESET ROLE")
        cur.execute("ALTER ROLE eliot_migrator NOCREATEROLE")
        cur.execute("GRANT USAGE ON SCHEMA eliot TO eliot_identity")
        cur.execute("GRANT eliot_execution_worker TO CURRENT_USER")
        _ensure_migrator_bypass_rls(cur)
    log("FIN OK")
    return 0


def main():
    sys.path.insert(0, str(ROOT))
    from app.eliot_db import detect_engine
    engine = detect_engine()
    if engine in ("postgresql", "postgres"):
        return apply_postgres()
    from app import eliot_portable
    eliot_portable.migrate()
    log(f"esquema portable ({engine}) creado")
    return 0


if __name__ == "__main__":
    sys.exit(main())

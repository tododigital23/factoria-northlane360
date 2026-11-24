"""Aplicación ÚNICA y verificada de 032-041 y del arranque del holding, ejecutada DENTRO de Railway.

Se lanza como servicio temporal en la red privada del proyecto (sin exponer la base a internet)
y se borra al terminar. Nunca imprime credenciales ni datos de negocio: solo marcadores estáticos.
Cada migración se aplica solo si su marcador NO existe; si existe, se omite (idempotente).
"""
import os
import sys
import psycopg

MIGRATIONS = (
    ("032", "db/eliot/032_document_plan_recovery.sql", "eliot.ai_document_plan_attempts"),
    ("033", "db/eliot/033_mission_autopilot.sql", "eliot.ai_document_mission_autopilots"),
    ("034", "db/eliot/034_holding_companies.sql", "eliot.holdings"),
    ("035", "db/eliot/035_agent_requests_memory.sql", "eliot.company_memory"),
    ("036", "db/eliot/036_company_rename.sql", "eliot.owner_rename_company(uuid,text)"),
    ("037", "db/eliot/037_holding_storage.sql", "eliot.holding_storage"),
    ("038", "db/eliot/038_company_retirement.sql", "eliot.retired_companies"),
    ("039", "db/eliot/039_holding_viewers.sql", "eliot.holding_viewers"),
    ("040", "db/eliot/040_company_break.sql", "eliot.company_breaks"),
    ("041", "db/eliot/041_invite_open_check.sql", "eliot.viewer_invite_is_open(text)"),
    ("043", "db/eliot/043_analysis_approval_expiry_fix.sql", "eliot.analysis_approval_expiry_fix_v1()"),
)
PREREQUISITE = "eliot.ai_document_mission_controls"  # 031


def log(msg):
    print("migrate:", msg, flush=True)


def main():
    if os.getenv("ELIOT_MIGRATION_CONFIRM") not in ("032-034", "032-035", "032-036", "032-037", "032-038", "032-039", "032-040", "032-041", "032-043"):
        log("confirmación ausente; no se hace nada")
        return 2
    first_org = os.environ["ELIOT_HOLDING_FIRST_ORG"]
    expected_db = os.getenv("ELIOT_DB_NAME", "eliot_dev")
    if os.getenv("DATABASE_URL"):  # pruebas locales o VPS con URL
        params = {"conninfo": os.environ["DATABASE_URL"]}
    else:
        params = dict(host=os.environ["PGHOST"], port=int(os.environ["PGPORT"]), user=os.environ["PGUSER"],
                      password=os.environ["PGPASSWORD"], dbname=expected_db)
    with psycopg.connect(**params, autocommit=True, connect_timeout=10) as conn:
        cur = conn.cursor()
        cur.execute("SELECT current_database(), current_setting('server_version_num')")
        db, version = cur.fetchone()
        log(f"base={db} version={version}")
        if db != expected_db:
            log("base inesperada; abortado")
            return 3
        cur.execute("SELECT to_regclass(%s) IS NOT NULL", (PREREQUISITE,))
        if not cur.fetchone()[0]:
            log("031 no está instalada; abortado")
            return 4
        for name, path, marker in MIGRATIONS:
            # El marcador es una tabla, o una función (con paréntesis) cuando la migración no crea tablas.
            present = "SELECT to_regprocedure(%s) IS NOT NULL" if "(" in marker else "SELECT to_regclass(%s) IS NOT NULL"
            cur.execute(present, (marker,))
            if cur.fetchone()[0]:
                log(f"{name} ya aplicada; se omite")
                continue
            sql = open(path, encoding="utf-8").read()
            try:
                cur.execute(sql)  # El fichero trae su propio BEGIN/COMMIT.
            except psycopg.Error as exc:
                try:
                    cur.execute("ROLLBACK")
                except psycopg.Error:
                    pass
                log(f"{name} FALLÓ ({type(exc).__name__}: {exc.diag.message_primary}); revertida")
                return 5
            cur.execute(present, (marker,))
            log(f"{name} aplicada={cur.fetchone()[0]}")
        # Arranque del holding (mismo contenido que db/eliot/bootstrap/034_holding_bootstrap.sql).
        cur.execute("SELECT count(*) FROM eliot.holding_companies WHERE organization_id=%s", (first_org,))
        if cur.fetchone()[0]:
            log("holding ya creado; se omite")
        else:
            cur.execute("""SELECT m.user_id FROM eliot.organization_memberships m
                WHERE m.organization_id=%s AND m.role='owner' AND m.status='active'""", (first_org,))
            owners = [r[0] for r in cur.fetchall()]
            if len(owners) != 1:
                log(f"se esperaba 1 propietario activo y hay {len(owners)}; holding no creado")
                return 6
            with conn.transaction():
                cur.execute("SET LOCAL ROLE eliot_migrator")
                cur.execute("INSERT INTO eliot.holdings(name,max_companies) VALUES(%s,5) RETURNING id",
                            (os.getenv("ELIOT_HOLDING_NAME", "Superempresa Freddy"),))
                holding = cur.fetchone()[0]
                cur.execute("INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(%s,%s)", (holding, owners[0]))
                cur.execute("INSERT INTO eliot.holding_companies(holding_id,organization_id,slot,created_by) VALUES(%s,%s,1,%s)",
                            (holding, first_org, owners[0]))
                cur.execute("""INSERT INTO eliot.organization_profiles(organization_id,project_name,project_summary,repository,updated_by)
                    VALUES(%s,'Centro de Mando IA','Plataforma ELIOT/Freddy de dirección y agentes IA',
                    'tu-organizacion/factoria-northlane360',%s) ON CONFLICT(organization_id) DO NOTHING""", (first_org, owners[0]))
                cur.execute("""INSERT INTO eliot.organization_capabilities(organization_id,capability)
                    VALUES(%s,'repository') ON CONFLICT DO NOTHING""", (first_org,))
                cur.execute("""INSERT INTO eliot.holding_audit(holding_id,organization_id,actor,action,detail)
                    VALUES(%s,%s,%s,'company_provisioned','{"slot":1,"bootstrap":true}'::jsonb)""", (holding, first_org, owners[0]))
            log("holding creado con la empresa en el hueco 1")
        # Verificación final: funciones clave presentes y concedidas al rol de aplicación.
        checks = ("eliot.owner_reopen_failed_document_plan(uuid,uuid,uuid,uuid,text,uuid)",
                  "eliot.owner_grant_mission_autopilot(uuid,uuid,integer,boolean,boolean,integer,uuid)",
                  "eliot.my_holding()", "eliot.owner_provision_company(uuid,text,text,text,text,text,text[],uuid)",
                  "eliot.worker_run_due_routines(uuid)",
                  "eliot.owner_request_agent_task(uuid,uuid,text,text,uuid)", "eliot.my_company_memory(uuid)",
                  "eliot.owner_rename_company(uuid,text)", "eliot.owner_holding_storage(uuid)",
                  "eliot.owner_create_company_storage(uuid,text,text)", "eliot.owner_rename_holding(uuid,text)")
        for sig in checks:
            cur.execute("SELECT to_regprocedure(%s) IS NOT NULL", (sig,))
            log(f"funcion {sig.split('(')[0]} presente={cur.fetchone()[0]}")
        cur.execute("SELECT has_function_privilege('eliot_identity','eliot.my_holding()','EXECUTE')")
        log(f"eliot_identity puede leer el holding={cur.fetchone()[0]}")
        cur.execute("SELECT count(*) FROM eliot.holding_companies")
        log(f"empresas en holding={cur.fetchone()[0]}")
    log("FIN OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

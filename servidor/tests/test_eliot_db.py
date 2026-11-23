from uuid import uuid4

import pytest

from app import eliot_db as db
from app import eliot_portable as portable


def test_parse_urls():
    p = db.parse_url("postgresql://eliot_identity_app:x@db:5432/eliot_dev")
    assert p["engine"] == "postgresql" and p["user"] == "eliot_identity_app" and p["dbname"] == "eliot_dev"
    m = db.parse_url("mysql://u:p@127.0.0.1:3306/tienda")
    assert m["engine"] == "mysql" and m["dbname"] == "tienda"
    s = db.parse_url("sqlite:///:memory:")
    assert s["engine"] == "sqlite" and s["path"] == ":memory:"
    g = db.parse_url("mongodb://u:p@127.0.0.1:27017/negocio")
    assert g["engine"] == "mongodb" and g["dbname"] == "negocio"
    with pytest.raises(RuntimeError):
        db.parse_url("redis://localhost/0")


def test_strict_identity_still_required(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("ELIOT_DATABASE_URL", raising=False)
    monkeypatch.delenv("ELIOT_DB_STRICT_ACCOUNTS", raising=False)
    monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_ID", raising=False)
    for k, v in {"ELIOT_IDENTITY_DB_HOST": "db", "ELIOT_IDENTITY_DB_PORT": "5432",
                 "ELIOT_IDENTITY_DB_NAME": "other", "ELIOT_IDENTITY_DB_USER": "eliot_identity_app",
                 "ELIOT_IDENTITY_DB_PASSWORD": "x"}.items():
        monkeypatch.setenv(k, v)
    with pytest.raises(RuntimeError, match="Restricted"):
        db.identity_params()


def test_database_url_sqlite_needs_strict_off(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "sqlite:///:memory:")
    monkeypatch.delenv("ELIOT_DB_STRICT_ACCOUNTS", raising=False)
    monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("RAILWAY_ENVIRONMENT_ID", raising=False)
    with pytest.raises(RuntimeError, match="Restricted"):
        db.identity_params()
    monkeypatch.setenv("ELIOT_DB_STRICT_ACCOUNTS", "off")
    assert db.identity_params()["engine"] == "sqlite"


def test_install_schema_needs_database_url(monkeypatch):
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[1] / "ops" / "install_schema.py"
    spec = importlib.util.spec_from_file_location("install_schema", path)
    install = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(install)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_PRIVATE_URL", raising=False)
    monkeypatch.delenv("POSTGRES_URL", raising=False)
    monkeypatch.delenv("ELIOT_MIGRATE_URL", raising=False)
    monkeypatch.delenv("ELIOT_DATABASE_URL", raising=False)
    monkeypatch.delenv("PGHOST", raising=False)
    assert install.database_url() == ""
    assert install.apply_postgres() == 6


def test_railway_postgres_url_is_accepted(monkeypatch):
    monkeypatch.setenv("RAILWAY_ENVIRONMENT", "production")
    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres:x@postgres.railway.internal:5432/railway")
    monkeypatch.delenv("ELIOT_DB_STRICT_ACCOUNTS", raising=False)
    params = db.identity_params()
    assert params["engine"] == "postgresql" and "postgres.railway.internal" in params["conninfo"]


def test_mongodb_rejected_as_app_database(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "mongodb://u:p@127.0.0.1:27017/x")
    monkeypatch.setenv("ELIOT_DB_STRICT_ACCOUNTS", "off")
    with pytest.raises(RuntimeError, match="MongoDB"):
        db.identity_params()


def test_frontend_origins_keep_default_whitelist(monkeypatch):
    monkeypatch.delenv("ELIOT_FRONTEND_ORIGINS", raising=False)
    monkeypatch.setenv("ELIOT_FRONTEND_ORIGIN", "https://untrusted.example")
    with pytest.raises(RuntimeError, match="approved"):
        db.frontend_origins()
    monkeypatch.setenv("ELIOT_FRONTEND_ORIGIN", "https://app.tu-factoria.example")
    assert "https://app.tu-factoria.example" in db.frontend_origins()


def test_frontend_origins_from_vps_list(monkeypatch):
    monkeypatch.setenv("ELIOT_FRONTEND_ORIGINS", "https://app.midominio.com,http://localhost:8080")
    monkeypatch.setenv("ELIOT_FRONTEND_ORIGIN", "https://app.midominio.com")
    assert db.frontend_origins() == ("https://app.midominio.com", "http://localhost:8080")


def test_frontend_origins_origin_defaults_to_first(monkeypatch):
    monkeypatch.setenv("ELIOT_FRONTEND_ORIGINS", "https://web-production.up.railway.app")
    monkeypatch.delenv("ELIOT_FRONTEND_ORIGIN", raising=False)
    assert db.frontend_origins() == ("https://web-production.up.railway.app",)


def test_portable_holding_office_and_isolation(monkeypatch, tmp_path):
    portable.reset_engine()
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + str(tmp_path / "t.db").replace("\\", "/"))
    monkeypatch.setenv("ELIOT_DB_STRICT_ACCOUNTS", "off")
    monkeypatch.setenv("ELIOT_AUTO_PROVISION_USER", "on")
    monkeypatch.setenv("ELIOT_BOOTSTRAP_SUBJECT", "auth|owner")
    params = db.identity_params()
    try:
        _run_portable_holding(params)
    finally:
        portable.reset_engine()


def _run_portable_holding(params):
    with db.connect(**params) as conn:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute("SELECT set_config('app.verified_subject', %s, true)", ("auth|owner",))
                cur.execute("SELECT to_regprocedure(%s)", ("eliot.my_holding()",))
                assert cur.fetchone()[0]
                cur.execute("SELECT * FROM eliot.my_holding()")
                holdings = [r[0] for r in cur.fetchall()]
                assert holdings and holdings[0]["is_owner"] is True
                hid = holdings[0]["id"]
                key = uuid4()
                cur.execute("SELECT eliot.owner_provision_company(%s,%s,%s,%s,%s,%s,%s,%s)",
                            (hid, "Tienda Aurora", "Tienda online", "Venta de ceramica artesanal.",
                             None, None, ["orders"], key))
                created = cur.fetchone()[0]
                org = created["organization_id"]
                assert created["slot"] == 1 and created["workers_created"] >= 6
                cur.execute("SELECT organization_id, organization_name, member_role FROM eliot.my_organizations()")
                rows = cur.fetchall()
                assert rows[0][1] == "Tienda Aurora" and rows[0][2] == "owner"
                cur.execute("SELECT department_id, department_name FROM eliot.my_departments(%s)", (org,))
                depts = cur.fetchall()
                assert any(d[1] == "Pedidos" for d in depts)
                cur.execute("SELECT worker_id, department_id, worker_name, specialty, worker_state FROM eliot.my_workers(%s)", (org,))
                workers = cur.fetchall()
                assert workers and all(w[4] == "inactive" for w in workers)
    with db.connect(**params) as conn:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute("SELECT set_config('app.verified_subject', %s, true)", ("auth|intruso",))
                cur.execute("SELECT count(*) FROM eliot.my_organizations()")
                assert cur.fetchone()[0] == 0
                with pytest.raises(db.errors.InsufficientPrivilege):
                    cur.execute("SELECT department_id, department_name FROM eliot.my_departments(%s)", (org,))


def test_portable_hides_document_functions(monkeypatch, tmp_path):
    portable.reset_engine()
    monkeypatch.setenv("DATABASE_URL", "sqlite:///" + str(tmp_path / "d.db").replace("\\", "/"))
    monkeypatch.setenv("ELIOT_DB_STRICT_ACCOUNTS", "off")
    with db.connect(**db.identity_params()) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT to_regprocedure(%s)", ("eliot.owner_enqueue_document_job(uuid,uuid,uuid,uuid,uuid,uuid)",))
            assert cur.fetchone()[0] is None
    portable.reset_engine()

import json
from uuid import uuid4

from app import eliot_company_db as company
from app import eliot_portal_agents_api as api


def test_sqlite_watcher_summary(tmp_path, monkeypatch):
    import sqlite3
    path = tmp_path / "tienda.db"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE orders(id INTEGER, paid_at TEXT, shipped_at TEXT, total REAL, created_at TEXT)")
    db.execute("INSERT INTO orders VALUES(1042,'2020-01-01',NULL,12.5,'2020-01-01')")
    db.commit()
    db.close()
    feed = {
        "kind": "database",
        "db_url": "sqlite:///" + str(path).replace("\\", "/"),
        "empresa": "mi-tienda",
        "watchers": [{
            "id": "pedidos", "nombre": "Vigilante de pedidos", "capacidad": "orders",
            "sql": "SELECT id FROM orders WHERE shipped_at IS NULL",
            "nivel": "urgente", "clave": "pedidos_atascados", "ref_prefix": "mt-ORD-",
            "id_field": "id", "titulo": "Hay pedidos pagados sin enviar",
            "propuesta": "Revisalos en el panel y avisa a los clientes.",
        }],
        "queries": {"ventas": "SELECT COUNT(*) AS pedidos, COALESCE(SUM(total),0) AS importe_eur FROM orders"},
    }
    payload, reason = company.summary(feed)
    assert reason is None and payload["ok"] is True
    agent = payload["agentes"][0]
    assert agent["estado"] == "alerta" and agent["avisos"][0]["refs"] == ["mt-ORD-1042"]
    cleaned = api.clean(payload)
    assert cleaned and cleaned["agents"][0]["notices"][0]["refs"] == ["mt-ORD-1042"]
    datos = company.query(feed, "ventas", {})
    assert datos["pedidos"] == 1


def test_rejects_non_select(tmp_path):
    path = tmp_path / "x.db"
    path.write_text("")
    assert company.run_select("sqlite:///" + str(path).replace("\\", "/"), "DELETE FROM orders") == []


def test_summary_lista_vigilante_en_error_si_sql_falla(tmp_path):
    path = tmp_path / "vacia.db"
    path.write_text("")
    feed = {
        "kind": "database",
        "db_url": "sqlite:///" + str(path).replace("\\", "/"),
        "empresa": "mi-tienda",
        "watchers": [{
            "id": "pedidos", "nombre": "Vigilante de pedidos", "capacidad": "orders",
            "sql": "SELECT id FROM tabla_que_no_existe",
            "nivel": "urgente", "clave": "pedidos_atascados", "ref_prefix": "mt-ORD-",
            "id_field": "id",
        }],
        "queries": {},
    }
    payload, reason = company.summary(feed)
    assert reason is None and payload["agentes"][0]["estado"] == "error"
    assert payload["agentes"][0]["avisos"][0]["clave"] == "consulta_fallida"
    cleaned = api.clean(payload)
    assert cleaned and cleaned["agents"][0]["state"] == "error"
    assert cleaned["agents"][0]["notices"][0]["proposal"]


def test_explain_db_error_clasifica_accesos():
    assert "Remote MySQL" in company.explain_db_error(RuntimeError("Access denied for user 'u'@'h'"))
    assert "prefijo" in company.explain_db_error(RuntimeError("Table 'x.wp_posts' doesn't exist")).lower()
    assert "1234" in company.explain_db_error(RuntimeError("(1234, 'weird')"))
    assert "OperationalError" in company.explain_db_error(type("OperationalError", (Exception,), {})("weird failure"))


def test_portal_feed_accepts_company_database(monkeypatch, tmp_path):
    org = uuid4()
    monkeypatch.setenv("ELIOT_PORTAL_SECRET_NOVA", "clave-compartida-con-el-portal-0123456789")
    monkeypatch.setenv("ELIOT_COMPANY_DB_NOVA", "sqlite:///" + str(tmp_path / "n.db").replace("\\", "/"))
    monkeypatch.setenv("ELIOT_PORTAL_FEEDS", json.dumps({
        str(org): {"kind": "database", "db_url_env": "ELIOT_COMPANY_DB_NOVA",
                   "secret_env": "ELIOT_PORTAL_SECRET_NOVA", "panel_url": "https://tienda.example/admin",
                   "empresa": "mi-tienda", "watchers": []}
    }))
    feed = api.feed_for(org)
    assert feed["kind"] == "database" and feed["db_url"].startswith("sqlite:") and "secret" in feed


def test_portal_feed_refuses_bad_db_env(monkeypatch):
    org = uuid4()
    monkeypatch.setenv("ELIOT_PORTAL_SECRET_NOVA", "clave-compartida-con-el-portal-0123456789")
    monkeypatch.setenv("ELIOT_PORTAL_FEEDS", json.dumps({
        str(org): {"kind": "database", "db_url_env": "DATABASE_URL",
                   "secret_env": "ELIOT_PORTAL_SECRET_NOVA"}
    }))
    assert api.feed_for(org) is None

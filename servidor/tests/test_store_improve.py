"""Mejora continua custom: allowlist FTP/settings y confirmación «sí»."""
from uuid import uuid4
from unittest.mock import MagicMock, patch

from app import eliot_connectors as conn
from app import eliot_store_improve as improve
from app import eliot_company_db as company


def test_safe_ftp_relpath_rechaza_dotdot_y_secretos():
    assert conn.safe_ftp_relpath("../x.php") is None
    assert conn.safe_ftp_relpath("/etc/passwd") is None
    assert conn.safe_ftp_relpath(".env") is None
    assert conn.safe_ftp_relpath("wp-config.php") is None
    assert conn.safe_ftp_relpath("lib/foo.exe") is None
    assert conn.safe_ftp_relpath("js/app.js", "public_html/tienda") == "public_html/tienda/js/app.js"
    assert conn.safe_ftp_relpath("readme.md") == "readme.md"


def test_settings_key_ok():
    assert improve.settings_key_ok("feature_banner") is True
    assert improve.settings_key_ok("ui_home_title") is True
    assert improve.settings_key_ok("chat_enabled") is True
    assert improve.settings_key_ok("api_key") is False
    assert improve.settings_key_ok("db_password") is False
    assert improve.settings_key_ok("x") is False


def test_draft_proposals_desde_avisos():
    summary = {
        "agents": [{
            "id": "chats", "name": "Vigilante de atencion", "state": "aviso",
            "notices": [{"code": "chats_pendientes", "title": "Hay chats abiertos"}],
        }],
    }
    props = improve.draft_proposals(summary, "Digital services llc")
    assert props and props[0]["accion"] == "tarea_mejora"
    assert "chats" in props[0]["resumen"].lower() or "Atención" in props[0]["titulo"]


def test_custom_actions_requieren_writes(monkeypatch):
    monkeypatch.delenv("ELIOT_COMPANY_DB_WRITES", raising=False)
    assert improve.custom_improve_actions() == {}
    monkeypatch.setenv("ELIOT_COMPANY_DB_WRITES", "on")
    keys = set(improve.custom_improve_actions())
    assert keys == {"settings_set", "ftp_patch", "tarea_mejora"}


def test_act_settings_set_previa_y_bloquea_clave_mala(monkeypatch):
    monkeypatch.setenv("ELIOT_COMPANY_DB_WRITES", "on")
    feed = {
        "db_url": "sqlite:///:memory:",
        "actions": improve.custom_improve_actions(),
        "organization_id": str(uuid4()),
    }
    previa = company.act(feed, {"accion": "settings_set", "modo": "previa", "clave": "feature_banner", "valor": "on"})
    assert previa and previa["ok"] is True and previa["hecho"] is False and "feature_banner" in previa["resumen"]
    bad = company.act(feed, {"accion": "settings_set", "modo": "ejecutar", "clave": "api_secret", "valor": "x"})
    assert bad and bad["ok"] is False and bad["hecho"] is False


def test_confirm_pending_si_ejecuta():
    notifier = MagicMock()
    feed = {"db_url": "x", "actions": {}, "organization_id": str(uuid4())}
    notifier.improve_pending = {
        "feed": feed,
        "payload": {"accion": "tarea_mejora", "titulo": "Revisar chat", "detalle": "ok"},
        "resumen": "previa",
        "company": "Tienda",
        "org": "o",
        "until": 9e12,
    }
    with patch.object(company, "act", return_value={"ok": True, "hecho": True, "resumen": "Hecho mejora."}):
        text = improve.confirm_pending(notifier, "sí")
    assert text and text.startswith("✅") and notifier.improve_pending is None


def test_confirm_pending_cancela_con_otro_texto():
    notifier = MagicMock()
    notifier.improve_pending = {
        "feed": {}, "payload": {}, "resumen": "x", "company": "T", "org": "o", "until": 9e12,
    }
    assert improve.confirm_pending(notifier, "estado") is None
    assert notifier.improve_pending is None

import importlib
from fastapi.testclient import TestClient

def test_organization_endpoint_disabled_by_default(monkeypatch):
    monkeypatch.delenv("ELIOT_ENABLE_ORGANIZATIONS_API",raising=False)
    import app.main as mod
    importlib.reload(mod)
    assert TestClient(mod.app).get("/v1/me/organizations").status_code==404

def test_rejects_unapproved_cors_origin(monkeypatch):
    monkeypatch.setenv("ELIOT_ENABLE_ORGANIZATIONS_API","true")
    monkeypatch.setenv("ELIOT_FRONTEND_ORIGIN","https://untrusted.example")
    import app.main as mod
    try:
        importlib.reload(mod)
        assert False,"Should refuse unexpected origin"
    except RuntimeError as exc:
        assert "approved development frontend" in str(exc)
    finally:
        monkeypatch.delenv("ELIOT_ENABLE_ORGANIZATIONS_API",raising=False)
        monkeypatch.delenv("ELIOT_FRONTEND_ORIGIN",raising=False)
        importlib.reload(mod)

def test_both_approved_frontends_pass_cors_and_others_do_not(monkeypatch):
    monkeypatch.setenv("ELIOT_ENABLE_ORGANIZATIONS_API","true")
    monkeypatch.setenv("ELIOT_FRONTEND_ORIGIN","https://app.tu-factoria.example")
    import app.main as mod
    try:
        importlib.reload(mod)
        client=TestClient(mod.app)
        def allowed(origin):
            r=client.options("/v1/me/organizations",headers={"Origin":origin,"Access-Control-Request-Method":"GET","Access-Control-Request-Headers":"Authorization"})
            return r.headers.get("access-control-allow-origin")
        assert allowed("https://app.tu-factoria.example")=="https://app.tu-factoria.example"
        assert allowed("https://app.tu-factoria.example")=="https://app.tu-factoria.example"
        assert allowed("https://untrusted.example") is None
    finally:
        monkeypatch.delenv("ELIOT_ENABLE_ORGANIZATIONS_API",raising=False)
        monkeypatch.delenv("ELIOT_FRONTEND_ORIGIN",raising=False)
        importlib.reload(mod)

def test_vps_frontend_origin_can_be_allowlisted(monkeypatch):
    monkeypatch.setenv("ELIOT_ENABLE_ORGANIZATIONS_API","true")
    monkeypatch.setenv("ELIOT_FRONTEND_ORIGINS","https://app.midominio.com")
    monkeypatch.setenv("ELIOT_FRONTEND_ORIGIN","https://app.midominio.com")
    import app.main as mod
    try:
        importlib.reload(mod)
        r=TestClient(mod.app).options("/v1/me/organizations",headers={"Origin":"https://app.midominio.com","Access-Control-Request-Method":"GET","Access-Control-Request-Headers":"Authorization"})
        assert r.headers.get("access-control-allow-origin")=="https://app.midominio.com"
    finally:
        monkeypatch.delenv("ELIOT_ENABLE_ORGANIZATIONS_API",raising=False)
        monkeypatch.delenv("ELIOT_FRONTEND_ORIGIN",raising=False)
        monkeypatch.delenv("ELIOT_FRONTEND_ORIGINS",raising=False)
        importlib.reload(mod)

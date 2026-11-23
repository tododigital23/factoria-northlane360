from uuid import uuid4
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["version"] == "0.2.5"

def test_debug_oidc_is_public(monkeypatch):
    monkeypatch.setenv("ELIOT_OIDC_ISSUER", "https://tenant.eu.auth0.com/")
    monkeypatch.setenv("ELIOT_OIDC_AUDIENCE", "https://api.eliot.internal")
    monkeypatch.setenv("ELIOT_OIDC_JWKS_URL", "https://tenant.eu.auth0.com/.well-known/jwks.json")
    monkeypatch.setenv("ELIOT_ENABLE_ORGANIZATIONS_API", "true")
    from importlib import reload
    import app.main as main
    reload(main)
    r = TestClient(main.app).get("/v1/debug/oidc")
    assert r.status_code == 200
    body = r.json()
    assert body["issuer_slash"] is True
    assert body["audience"] == "https://api.eliot.internal"
    assert body["jwks_host"] == "tenant.eu.auth0.com"
    assert body["orgs"] is True

def test_demo_is_closed_by_default(monkeypatch):
    monkeypatch.delenv("ELIOT_DEMO_KEY", raising=False)
    response = client.get("/demo/tasks", params={"organization_id": str(uuid4())})
    assert response.status_code == 403

def test_demo_task_creation_and_tenant_filter(monkeypatch):
    monkeypatch.setenv("ELIOT_DEMO_KEY", "test-only-key")
    org = str(uuid4())
    other = str(uuid4())
    headers = {"x-demo-key": "test-only-key"}
    r = client.post("/demo/tasks", json={"organization_id": org, "title": "Test task"}, headers=headers)
    assert r.status_code == 201
    a = client.get("/demo/tasks", params={"organization_id":org},headers=headers)
    b = client.get("/demo/tasks", params={"organization_id":other},headers=headers)
    assert len(a.json()) >= 1
    assert all(x["organization_id"] == org for x in a.json())
    assert b.json() == []

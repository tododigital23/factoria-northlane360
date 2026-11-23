from uuid import uuid4
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"

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

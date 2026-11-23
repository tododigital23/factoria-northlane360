from unittest.mock import MagicMock, patch
from uuid import UUID
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router

app=FastAPI()
app.include_router(router)
client=TestClient(app)
ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
URL=f"/v1/me/organizations/{ORG}/eliot/generative/status"

def connection(role="owner"):
    conn=MagicMock()
    cur=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchall.return_value=[(UUID(ORG),"Nova Demo",role)]
    return conn

def test_requires_valid_auth0_access_token():
    assert client.get(URL).status_code==401

def test_denies_org_not_in_memberships():
    conn=connection()
    with patch("app.organizations_api.verified_identity",return_value="issuer|member"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        r=client.get(f"/v1/me/organizations/{OTHER}/eliot/generative/status",headers={"Authorization":"Bearer fake"})
    assert r.status_code==404

def test_denies_non_owner():
    with patch("app.organizations_api.verified_identity",return_value="issuer|member"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=connection("member")):
        r=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert r.status_code==403

def test_unconfigured_service_returns_safe_status(monkeypatch):
    for name in ("OPENAI_API_KEY","ELIOT_OPENAI_ENABLED","ELIOT_OPENAI_ALLOWED_ORGANIZATIONS"):
        monkeypatch.delenv(name,raising=False)
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=connection()):
        r=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    data=r.json()
    assert data["ready"] is False
    assert data["api_key_configured"] is False
    assert data["company_opted_in"] is False
    assert data["mode_when_unavailable"]=="verified_data"
    assert data["no_model_request_made"] is True
    assert "OPENAI_API_KEY" not in r.text

def test_ready_requires_all_four_guards(monkeypatch):
    monkeypatch.setenv("ELIOT_OPENAI_MODEL","gpt-6-luna")
    monkeypatch.setenv("OPENAI_API_KEY","fake-test-secret")
    monkeypatch.setenv("ELIOT_OPENAI_ENABLED","true")
    monkeypatch.setenv("ELIOT_OPENAI_ALLOWED_ORGANIZATIONS",ORG)
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=connection()), \
         patch("app.eliot_llm_optional.urllib.request.urlopen") as remote:
        r=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    assert r.json()["ready"] is True
    assert "fake-test-secret" not in r.text
    remote.assert_not_called()

def test_other_company_cannot_opt_in_by_global_flag_alone(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY","fake-test-secret")
    monkeypatch.setenv("ELIOT_OPENAI_ENABLED","true")
    monkeypatch.setenv("ELIOT_OPENAI_ALLOWED_ORGANIZATIONS",OTHER)
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=connection()):
        r=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    assert r.json()["ready"] is False
    assert r.json()["company_opted_in"] is False

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
url=f"/v1/me/organizations/{ORG}/eliot/chat"

def db_response(role="owner"):
    conn=MagicMock()
    cursor=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    cursor.fetchall.side_effect=[
        [(UUID(ORG),"Nova Demo",role)],
        [(UUID("11111111-1111-4111-8111-111111111111"),"Desarrollo")],
        [],[],[],
    ]
    return conn

def test_fallback_remains_available_without_model_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY",raising=False)
    monkeypatch.delenv("ELIOT_OPENAI_ENABLED",raising=False)
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.psycopg.connect",return_value=db_response()), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.generate_eliot_natural_reply",return_value=None):
        r=client.post(url,json={"question":"¿Cómo va mi empresa?"},headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    assert r.json()["mode"]=="verified_data"
    assert r.json()["read_only"] is True

def test_natural_response_is_clearly_labelled():
    with patch.dict("os.environ",{"ELIOT_OPENAI_ALLOWED_ORGANIZATIONS":ORG}), \
         patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.psycopg.connect",return_value=db_response()), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.generate_eliot_natural_reply",return_value="La empresa tiene un departamento."):
        r=client.post(url,json={"question":"¿Cómo va mi empresa?"},headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    assert r.json()["mode"]=="grounded_ai"
    assert r.json()["organization_id"]==ORG
    assert r.json()["read_only"] is True

def test_other_company_is_rejected_without_calling_provider():
    connection=MagicMock()
    cursor=connection.__enter__.return_value.cursor.return_value.__enter__.return_value
    cursor.fetchall.return_value=[(UUID(ORG),"Nova Demo","owner")]
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.psycopg.connect",return_value=connection), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.generate_eliot_natural_reply") as provider:
        r=client.post(f"/v1/me/organizations/{OTHER}/eliot/chat",
           json={"question":"¿Cómo va la empresa?"},headers={"Authorization":"Bearer fake"})
    assert r.status_code==404
    provider.assert_not_called()

def test_member_cannot_send_tenant_data_to_model_even_if_allowlisted():
    with patch.dict("os.environ",{"ELIOT_OPENAI_ALLOWED_ORGANIZATIONS":ORG}), \
         patch("app.organizations_api.verified_identity",return_value="issuer|member"), \
         patch("app.organizations_api.psycopg.connect",return_value=db_response(role="member")), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.generate_eliot_natural_reply") as provider:
        r=client.post(url,json={"question":"Dame un resumen de mi empresa"},headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    assert r.json()["mode"]=="verified_data"
    provider.assert_not_called()

def test_owner_without_explicit_tenant_optin_never_calls_model():
    with patch.dict("os.environ",{"ELIOT_OPENAI_ALLOWED_ORGANIZATIONS":""}), \
         patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.psycopg.connect",return_value=db_response()), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.generate_eliot_natural_reply") as provider:
        r=client.post(url,json={"question":"Dame un resumen de mi empresa"},headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    assert r.json()["mode"]=="verified_data"
    provider.assert_not_called()

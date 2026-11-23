from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router

app=FastAPI()
app.include_router(router)
client=TestClient(app)
url="/v1/me/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks/55555555-5555-4555-8555-555555555555/status"
body={"action":"block","reason":"Needs review","request_key":"77777777-7777-4777-8777-777777777777"}

def test_requires_authentication():
    assert client.post(url,json=body).status_code==401

def test_rejects_unsupported_transitions():
    assert client.post(url,json={**body,"action":"running"}).status_code==422

def test_rejects_missing_idempotency_key():
    assert client.post(url,json={"action":"block"}).status_code==422

def test_verified_read_scope_cannot_modify_status():
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.jwks_client") as jwks, \
         patch("app.organizations_api.jwt.decode",return_value={"scope":"read:tasks"}), \
         patch.dict("os.environ",{"ELIOT_OIDC_AUDIENCE":"test-aud","ELIOT_OIDC_ISSUER":"https://issuer"}):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        r=client.post(url,json=body,headers={"Authorization":"Bearer opaque"})
    assert r.status_code==403

def test_db_failures_are_not_exposed():
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.jwks_client") as jwks, \
         patch("app.organizations_api.jwt.decode",return_value={"scope":"read:tasks create:tasks"}), \
         patch("app.organizations_api.db_params",side_effect=RuntimeError("secret database connection")), \
         patch.dict("os.environ",{"ELIOT_OIDC_AUDIENCE":"test-aud","ELIOT_OIDC_ISSUER":"https://issuer"}):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        r=client.post(url,json=body,headers={"Authorization":"Bearer opaque"})
    assert r.status_code==503
    assert "secret" not in r.text.lower()

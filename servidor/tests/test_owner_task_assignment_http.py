from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router

app=FastAPI()
app.include_router(router)
client=TestClient(app)
URL="/v1/me/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks/88888888-8888-4888-8888-888888888888/assign"
BODY={"worker_id":"55555555-5555-4555-8555-555555555555","request_key":"bbbbbbbb-1111-4111-8111-111111111111"}

def test_requires_access_token():
    assert client.post(URL,json=BODY).status_code==401

def test_body_requires_request_key():
    assert client.post(URL,json={"worker_id":BODY["worker_id"]}).status_code==422

def test_read_scope_cannot_assign():
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.jwks_client") as jwks, \
         patch("app.organizations_api.jwt.decode",return_value={"scope":"read:tasks"}), \
         patch.dict("os.environ",{"ELIOT_OIDC_AUDIENCE":"test-aud","ELIOT_OIDC_ISSUER":"https://issuer"}):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        response=client.post(URL,json=BODY,headers={"Authorization":"Bearer opaque"})
    assert response.status_code==403

def test_invalid_worker_id_rejected():
    assert client.post(URL,json={**BODY,"worker_id":"not-a-uuid"}).status_code==422

def test_database_secrets_never_exposed():
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.jwks_client") as jwks, \
         patch("app.organizations_api.jwt.decode",return_value={"scope":"read:tasks create:tasks"}), \
         patch("app.organizations_api.db_params",side_effect=RuntimeError("private database password")), \
         patch.dict("os.environ",{"ELIOT_OIDC_AUDIENCE":"test-aud","ELIOT_OIDC_ISSUER":"https://issuer"}):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        response=client.post(URL,json=BODY,headers={"Authorization":"Bearer opaque"})
    assert response.status_code==503
    assert "password" not in response.text.lower()

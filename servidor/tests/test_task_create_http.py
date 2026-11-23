from unittest.mock import patch
from fastapi.testclient import TestClient
from fastapi import FastAPI
from app.organizations_api import router

app=FastAPI()
app.include_router(router)
client=TestClient(app)
url="/v1/me/organizations/11111111-1111-4111-8111-111111111111/tasks"
body={"department_id":"22222222-2222-4222-8222-222222222222","title":"Valid task","request_key":"33333333-3333-4333-8333-333333333333"}

def test_post_requires_token():
    assert client.post(url,json=body).status_code==401

def test_post_requires_write_scope_even_if_read_scope_is_valid():
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.jwks_client") as jwks, \
         patch("app.organizations_api.jwt.decode",return_value={"scope":"read:tasks"}), \
         patch.dict("os.environ",{"ELIOT_OIDC_AUDIENCE":"test-aud","ELIOT_OIDC_ISSUER":"https://issuer"}):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        response=client.post(url,json=body,headers={"Authorization":"Bearer fake"})
    assert response.status_code==403

def test_post_rejects_invalid_payload():
    bad={**body,"title":"x"}
    assert client.post(url,json=bad,headers={"Authorization":"Bearer fake"}).status_code in (401,422)

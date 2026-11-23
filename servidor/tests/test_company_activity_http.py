from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router

app=FastAPI()
app.include_router(router)
client=TestClient(app)
url="/v1/me/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/activity"

def test_company_activity_requires_auth0():
    assert client.get(url).status_code == 401

def test_company_activity_rejects_invalid_limit():
    assert client.get(url+"?limit=101").status_code == 422
    assert client.get(url+"?limit=0").status_code == 422

def test_company_activity_rejects_invalid_organization_id():
    assert client.get("/v1/me/organizations/not-uuid/activity").status_code == 422

def test_company_activity_database_error_is_private():
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",side_effect=RuntimeError("private database secret")):
        response=client.get(url,headers={"Authorization":"Bearer fake"})
    assert response.status_code == 503
    assert "secret" not in response.text.lower()

from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router

application=FastAPI()
application.include_router(router)
client=TestClient(application)
endpoint="/v1/me/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/tasks/55555555-5555-4555-8555-555555555555/events"

def test_history_requires_auth0_token():
    assert client.get(endpoint).status_code==401

def test_history_rejects_invalid_uuid():
    assert client.get("/v1/me/organizations/nope/tasks/nope/events").status_code==422

def test_history_unavailable_database_does_not_leak_secrets():
    with patch("app.organizations_api.verified_identity",return_value="issuer|authorized"), \
         patch("app.organizations_api.db_params",side_effect=RuntimeError("database credential should stay secret")):
        response=client.get(endpoint,headers={"Authorization":"Bearer opaque"})
    assert response.status_code==503
    assert "credential" not in response.text.lower()

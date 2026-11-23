from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router

app = FastAPI()
app.include_router(router)
client = TestClient(app)
ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
WORKER = "55555555-5555-4555-8555-555555555555"
URL = f"/v1/me/organizations/{ORG}/workers/{WORKER}/availability"
BODY = {"state":"idle","request_key":"cccccccc-1111-4111-8111-111111111111"}
AUTH = {"Authorization":"Bearer opaque"}

def mocked_connection(value="idle", events=False):
    conn = MagicMock()
    cur = conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    if events:
        cur.fetchall.return_value = [(UUID("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
            "inactive", "idle", datetime(2026,10,28,tzinfo=timezone.utc))]
    else:
        cur.fetchone.return_value = (value,)
    return conn, cur

def token_context(scopes):
    return (
      patch("app.organizations_api.verified_identity", return_value="issuer|owner"),
      patch("app.organizations_api.jwks_client"),
      patch("app.organizations_api.jwt.decode",return_value={"scope":scopes}),
      patch.dict("os.environ", {"ELIOT_OIDC_AUDIENCE":"aud","ELIOT_OIDC_ISSUER":"https://issuer"})
    )

def test_anonymous_is_rejected():
    assert client.post(URL,json=BODY).status_code == 401
    assert client.get(URL+"/events").status_code == 401

def test_invalid_uuid_and_state_rejected():
    assert client.post(URL,json={"state":"idle"}).status_code == 422
    assert client.post(URL,json={**BODY,"state":"working"}).status_code == 422
    assert client.post(URL,json={**BODY,"request_key":"bad"}).status_code == 422

def test_read_scope_cannot_change_worker():
    a,b,c,d=token_context("read:tasks")
    with a,b as jwks,c,d:
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        result=client.post(URL,json=BODY,headers=AUTH)
    assert result.status_code == 403

def test_owner_can_mark_available_but_never_runs_worker():
    a,b,c,d=token_context("read:tasks create:tasks")
    conn,cur=mocked_connection()
    with a,b as jwks,c,d, \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        result=client.post(URL,json=BODY,headers=AUTH)
    assert result.status_code == 200
    assert result.json() == {
        "worker_id": WORKER,"state":"idle",
        "execution_started":False,"tools_granted":False
    }
    sql=[c.args[0].lower() for c in cur.execute.call_args_list]
    assert sql[0].startswith("select set_config")
    assert any("eliot.owner_set_worker_availability" in s for s in sql)
    assert all(s.startswith("select ") for s in sql)
    assert not any("start" in s or "execute task" in s for s in sql)

def test_owner_failure_does_not_expose_db_secrets():
    a,b,c,d=token_context("read:tasks create:tasks")
    with a,b as jwks,c,d, \
         patch("app.organizations_api.db_params",side_effect=RuntimeError("private password")):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        result=client.post(URL,json=BODY,headers=AUTH)
    assert result.status_code == 503
    assert "password" not in result.text.lower()

def test_history_is_read_only():
    conn,cur=mocked_connection(events=True)
    with patch("app.organizations_api.verified_identity",return_value="issuer|member"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        result=client.get(URL+"/events",headers=AUTH)
    assert result.status_code == 200
    assert result.json()[0]["previous_state"] == "inactive"
    assert result.json()[0]["state"] == "idle"
    assert all(x.args[0].lower().startswith("select ") for x in cur.execute.call_args_list)

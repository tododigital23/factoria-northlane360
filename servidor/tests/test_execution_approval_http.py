from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router

app=FastAPI()
app.include_router(router)
client=TestClient(app)
ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TASK="77777777-7777-4777-8777-777777777777"
WORKER="55555555-5555-4555-8555-555555555555"
APPROVAL="99999999-9999-4999-8999-999999999999"
BASE=f"/v1/me/organizations/{ORG}/tasks/{TASK}/execution/analysis-approvals"
AUTH={"Authorization":"Bearer opaque"}
BODY={"worker_id":WORKER,"request_key":"bbbbbbbb-1111-4111-8111-111111111111"}

def fake_db(*,result=None,history=False):
    connection=MagicMock()
    cursor=connection.__enter__.return_value.cursor.return_value.__enter__.return_value
    if history:
        cursor.fetchall.return_value=[
          (UUID(APPROVAL),UUID(WORKER),"approved",
           datetime(2026,10,28,tzinfo=timezone.utc),
           datetime(2026,10,28,tzinfo=timezone.utc)+timedelta(minutes=15))
        ]
    else:
        cursor.fetchone.return_value=(UUID(APPROVAL) if result is None else result,)
        cursor.fetchall.return_value=[(UUID(APPROVAL),)]
    return connection,cursor

def auth_context(scopes="read:tasks create:tasks"):
    return (patch("app.organizations_api.verified_identity",return_value="issuer|owner"),
            patch("app.organizations_api.jwks_client"),
            patch("app.organizations_api.jwt.decode",return_value={"scope":scopes}),
            patch.dict("os.environ",{"ELIOT_OIDC_AUDIENCE":"aud","ELIOT_OIDC_ISSUER":"https://issuer"}))

def test_requires_auth0():
    assert client.post(BASE,json=BODY).status_code==401
    assert client.get(BASE).status_code==401
    assert client.post(BASE+f"/{APPROVAL}/revoke",json={"request_key":BODY["request_key"]}).status_code==401

def test_validation_rejects_missing_fields_and_bad_uuids():
    assert client.post(BASE,json={}).status_code==422
    assert client.post(BASE,json={**BODY,"worker_id":"invalid"}).status_code==422
    assert client.post(BASE,json={**BODY,"request_key":"invalid"}).status_code==422

def test_read_only_scope_cannot_approve():
    a,b,c,d=auth_context("read:tasks")
    with a,b as jwks,c,d:
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        resp=client.post(BASE,json=BODY,headers=AUTH)
    assert resp.status_code==403

def test_owner_approval_records_only_without_execution():
    conn,cur=fake_db()
    a,b,c,d=auth_context()
    with a,b as jwks,c,d, \
        patch("app.organizations_api.db_params",return_value={"host":"test"}), \
        patch("app.organizations_api.psycopg.connect",return_value=conn):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        resp=client.post(BASE,json=BODY,headers=AUTH)
    assert resp.status_code==201
    data=resp.json()
    assert data["approval_id"]==APPROVAL and data["capability"]=="analysis_draft_v1"
    assert data["execution_started"] is False
    sql=[x.args[0].lower() for x in cur.execute.call_args_list]
    assert any("owner_approve_analysis_draft" in s for s in sql)
    assert all(s.startswith("select ") for s in sql)

def test_owner_can_list_history_without_actions():
    conn,cur=fake_db(history=True)
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        resp=client.get(BASE,headers=AUTH)
    assert resp.status_code==200
    assert resp.json()[0]["state"]=="approved"
    assert resp.json()[0]["capability"]=="analysis_draft_v1"
    assert all(c.args[0].lower().startswith("select ") for c in cur.execute.call_args_list)

def test_revocation_checks_exact_task_and_scope():
    conn,cur=fake_db(result="revoked")
    a,b,c,d=auth_context()
    with a,b as jwks,c,d, \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        resp=client.post(BASE+f"/{APPROVAL}/revoke",
           json={"request_key":BODY["request_key"]},headers=AUTH)
    assert resp.status_code==200
    assert resp.json()["state"]=="revoked"
    assert resp.json()["execution_started"] is False
    assert any("owner_revoke_analysis_draft" in c.args[0] for c in cur.execute.call_args_list)

def test_other_task_approval_cannot_be_revoked():
    conn,cur=fake_db(result="revoked")
    cur.fetchall.return_value=[]
    a,b,c,d=auth_context()
    with a,b as jwks,c,d, \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        resp=client.post(BASE+f"/{APPROVAL}/revoke",
           json={"request_key":BODY["request_key"]},headers=AUTH)
    assert resp.status_code==404
    assert not any("owner_revoke_analysis_draft" in c.args[0] for c in cur.execute.call_args_list)

def test_fail_closed_without_leaking_secrets():
    a,b,c,d=auth_context()
    with a,b as jwks,c,d, \
         patch("app.organizations_api.db_params",side_effect=RuntimeError("secret database password")):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        resp=client.post(BASE,json=BODY,headers=AUTH)
    assert resp.status_code==503
    assert "password" not in resp.text.lower()

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
TASK = "77777777-7777-4777-8777-777777777777"
APPROVAL = "99999999-9999-4999-8999-999999999999"
RUN = "88888888-8888-4888-8888-888888888888"
URL = f"/v1/me/organizations/{ORG}/tasks/{TASK}/execution/analysis-runs"
AUTH = {"Authorization":"Bearer opaque"}
BODY = {"approval_id": APPROVAL,"request_key":"aaaaaaaa-1111-4111-8111-111111111111"}

def db_connection(row=None, rows=None):
    conn=MagicMock()
    cur=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchone.return_value=row
    cur.fetchall.return_value=rows or []
    return conn,cur

def jwt_context(scope="read:tasks create:tasks"):
    return (
      patch("app.organizations_api.verified_identity",return_value="issuer|owner"),
      patch("app.organizations_api.jwks_client"),
      patch("app.organizations_api.jwt.decode",return_value={"scope":scope}),
      patch.dict("os.environ",{"ELIOT_OIDC_AUDIENCE":"aud","ELIOT_OIDC_ISSUER":"https://issuer"})
    )

def test_anonymous_rejected():
    assert client.post(URL,json=BODY).status_code==401
    assert client.get(URL).status_code==401

def test_bad_payload_and_uuid_rejected():
    assert client.post(URL,json={}).status_code==422
    assert client.post(URL,json={**BODY,"approval_id":"nope"}).status_code==422
    assert client.post(URL,json={**BODY,"request_key":"nope"}).status_code==422

def test_executor_disabled_fails_before_db_or_provider():
    a,b,c,d=jwt_context()
    with a,b as jwks,c,d, \
      patch("app.eliot_analysis_executor.is_enabled_for",return_value=False), \
      patch("app.organizations_api.psycopg.connect") as db, \
      patch("app.eliot_analysis_executor.generate_draft") as provider:
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(URL,json=BODY,headers=AUTH)
    assert res.status_code==503
    db.assert_not_called()
    provider.assert_not_called()

def test_read_only_scope_cannot_execute():
    a,b,c,d=jwt_context("read:tasks")
    with a,b as jwks,c,d, \
      patch("app.eliot_analysis_executor.is_enabled_for",return_value=True), \
      patch("app.organizations_api.psycopg.connect") as db:
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(URL,json=BODY,headers=AUTH)
    assert res.status_code==403
    db.assert_not_called()

def test_owner_claims_generates_once_and_finishes():
    claim,claim_cur=db_connection((UUID(RUN),True,"running","Review docs"))
    finish,finish_cur=db_connection(("completed",))
    a,b,c,d=jwt_context()
    report="Borrador basado únicamente en el título de la tarea."
    with a,b as jwks,c,d, \
       patch("app.eliot_analysis_executor.is_enabled_for",return_value=True), \
       patch("app.eliot_analysis_executor.generate_draft",return_value=(report,None)) as provider, \
       patch("app.organizations_api.db_params",return_value={"host":"test"}), \
       patch("app.organizations_api.psycopg.connect",side_effect=[claim,finish]) as db:
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(URL,json=BODY,headers=AUTH)
    assert res.status_code==200
    assert res.json()=={
      "run_id":RUN,"status":"completed","already_claimed":False,
      "generation_attempted":True,"draft_from_title_only":True,"report":report
    }
    assert db.call_count==2
    provider.assert_called_once_with(ORG,"Review docs")
    assert any("owner_claim_analysis_run" in x.args[0] for x in claim_cur.execute.call_args_list)
    assert any("owner_finish_analysis_run" in x.args[0] for x in finish_cur.execute.call_args_list)

def test_duplicate_key_does_not_call_provider():
    claim,cur=db_connection((UUID(RUN),False,"completed","Review docs"))
    a,b,c,d=jwt_context()
    with a,b as jwks,c,d, \
      patch("app.eliot_analysis_executor.is_enabled_for",return_value=True), \
      patch("app.eliot_analysis_executor.generate_draft") as provider, \
      patch("app.organizations_api.db_params",return_value={"host":"test"}), \
      patch("app.organizations_api.psycopg.connect",return_value=claim) as db:
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(URL,json=BODY,headers=AUTH)
    assert res.status_code==200
    assert res.json()["already_claimed"] is True
    assert res.json()["generation_attempted"] is False
    db.assert_called_once()
    provider.assert_not_called()

def test_model_failure_persisted_as_failed():
    claim,cur=db_connection((UUID(RUN),True,"running","Review docs"))
    finish,finish_cur=db_connection(("failed",))
    a,b,c,d=jwt_context()
    with a,b as jwks,c,d, \
      patch("app.eliot_analysis_executor.is_enabled_for",return_value=True), \
      patch("app.eliot_analysis_executor.generate_draft",return_value=(None,"rate_limited")), \
      patch("app.organizations_api.db_params",return_value={"host":"test"}), \
      patch("app.organizations_api.psycopg.connect",side_effect=[claim,finish]):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(URL,json=BODY,headers=AUTH)
    assert res.status_code==200 and res.json()["status"]=="failed"
    assert res.json()["report"] is None
    assert any("owner_finish_analysis_run" in x.args[0] for x in finish_cur.execute.call_args_list)

def test_claim_conflict_never_calls_model():
    import psycopg
    a,b,c,d=jwt_context()
    with a,b as jwks,c,d, \
      patch("app.eliot_analysis_executor.is_enabled_for",return_value=True), \
      patch("app.eliot_analysis_executor.generate_draft") as provider, \
      patch("app.organizations_api.db_params",return_value={"host":"test"}), \
      patch("app.organizations_api.psycopg.connect",
        side_effect=psycopg.errors.InvalidParameterValue("approval revoked")):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(URL,json=BODY,headers=AUTH)
    assert res.status_code==409
    provider.assert_not_called()
    assert "approval revoked" not in res.text.lower()

def test_result_history_is_scoped_read_only():
    now=datetime(2026,10,28,tzinfo=timezone.utc)
    conn,cur=db_connection(rows=[(UUID(RUN),"completed","Borrador",None,now,now)])
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
       patch("app.organizations_api.db_params",return_value={"host":"test"}), \
       patch("app.organizations_api.psycopg.connect",return_value=conn):
        res=client.get(URL,headers=AUTH)
    assert res.status_code==200
    assert res.json()[0]["report"]=="Borrador"
    assert res.json()[0]["draft_from_title_only"] is True
    assert all(x.args[0].lower().startswith("select ") for x in cur.execute.call_args_list)


def test_capability_status_owner_only_and_no_provider_call():
    connection,cur=db_connection(rows=[(UUID(ORG),"owner")])
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.eliot_analysis_executor.is_enabled_for",return_value=True), \
         patch("app.eliot_analysis_executor.generate_draft") as provider, \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=connection):
        res=client.get(f"/v1/me/organizations/{ORG}/execution/analysis-capability",headers=AUTH)
    assert res.status_code==200
    assert res.json()["enabled"] is True
    assert res.json()["external_tools_enabled"] is False
    assert res.json()["source_scope"]=="task_title_only"
    provider.assert_not_called()

def test_capability_does_not_leak_to_other_company_or_nonowner():
    connection,cur=db_connection(rows=[(UUID(ORG),"member")])
    with patch("app.organizations_api.verified_identity",return_value="issuer|member"), \
         patch("app.eliot_analysis_executor.is_enabled_for",return_value=True), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=connection):
        res=client.get(f"/v1/me/organizations/{ORG}/execution/analysis-capability",headers=AUTH)
    assert res.status_code==403

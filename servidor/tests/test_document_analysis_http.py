from datetime import datetime, timezone
from unittest.mock import MagicMock,patch
from uuid import UUID

import psycopg
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.organizations_api import router

ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TASK="77777777-7777-4777-8777-777777777777"
WORKER="55555555-5555-4555-8555-555555555555"
APPROVAL="99999999-9999-4999-8999-999999999999"
RUN="88888888-8888-4888-8888-888888888888"
REPO="tu-organizacion/factoria-northlane360"
PATH="docs/ARCHITECTURE.md"
SHA="a"*40
BASE=f"/v1/me/organizations/{ORG}/tasks/{TASK}/execution"
AUTH={"Authorization":"Bearer opaque"}
app=FastAPI()
app.include_router(router)
client=TestClient(app)

def db_conn(row=None,rows=None):
    c=MagicMock()
    cur=c.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchone.return_value=row
    cur.fetchall.return_value=rows or []
    return c,cur

def owner(scope="read:tasks create:tasks"):
    return (
      patch("app.organizations_api.verified_identity",return_value="issuer|owner"),
      patch("app.organizations_api._require_company_owner"),
      patch("app.organizations_api.jwks_client"),
      patch("app.organizations_api.jwt.decode",return_value={"scope":scope}),
      patch.dict("os.environ",{"ELIOT_OIDC_AUDIENCE":"aud","ELIOT_OIDC_ISSUER":"https://issuer"})
    )

def document(sha=SHA):
    return {"repository":REPO,"path":PATH,
            "ref":"feature/auth0-organizations-endpoint","sha":sha,
            "content":"# ELIOT\nAprobaciones por tarea.",
            "read_only":True,"sent_to_model":False}


def test_document_capability_off_by_default_despite_title_model():
    a,b,c,d,e=owner()
    with a,b,c,d,e,patch("app.eliot_document_analysis.documentary_enabled",return_value=False),\
      patch("app.organizations_api.psycopg.connect") as db:
        result=client.get(f"/v1/me/organizations/{ORG}/execution/documentary-capability",headers=AUTH)
    assert result.status_code==200 and result.json()["enabled"] is False
    assert result.json()["source_scope"]=="one_github_file_exact_sha"
    db.assert_not_called()


def test_anonymous_and_bad_uuid_rejected_without_db():
    with patch("app.organizations_api.psycopg.connect") as db:
        assert client.post(BASE+"/document-approvals",json={}).status_code==422
        assert client.post(BASE+"/document-runs",json={
         "approval_id":APPROVAL,"request_key":"invalid"
        }).status_code==422
        assert client.get(BASE+"/document-runs").status_code==401
    db.assert_not_called()


def test_approve_uses_exact_allowlisted_document_and_distinct_sql_capability():
    db,cur=db_conn(row=(UUID(APPROVAL),))
    a,b,c,d,e=owner()
    with a,b,c as jwks,d,e,\
      patch("app.eliot_document_analysis.documentary_enabled",return_value=True),\
      patch("app.eliot_github_reader.read_document",return_value=document()) as read,\
      patch("app.organizations_api.db_params",return_value={"host":"db"}),\
      patch("app.organizations_api.psycopg.connect",return_value=db):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(BASE+"/document-approvals",headers=AUTH,json={
         "worker_id":WORKER,"repository":REPO,"path":PATH,
         "expected_sha":SHA,"request_key":"11111111-1111-4111-8111-111111111111"
        })
    assert res.status_code==201,res.text
    assert res.json()["capability"]=="document_analysis_v1"
    assert res.json()["provider_called"] is False
    read.assert_called_once_with(ORG,REPO,PATH)
    assert any("owner_approve_document_analysis" in x.args[0] for x in cur.execute.call_args_list)


def test_sha_mismatch_aborts_without_db_access():
    a,b,c,d,e=owner()
    with a,b,c as jwks,d,e,\
      patch("app.eliot_document_analysis.documentary_enabled",return_value=True),\
      patch("app.eliot_github_reader.read_document",return_value=document("b"*40)),\
      patch("app.organizations_api.psycopg.connect") as db:
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(BASE+"/document-approvals",headers=AUTH,json={
         "worker_id":WORKER,"repository":REPO,"path":PATH,
         "expected_sha":SHA,"request_key":"11111111-1111-4111-8111-111111111111"
        })
    assert res.status_code==409
    db.assert_not_called()


def test_document_run_disabled_does_not_claim_or_call_openai():
    a,b,c,d,e=owner()
    with a,b,c as jwks,d,e,\
      patch("app.eliot_document_analysis.documentary_enabled",return_value=False),\
      patch("app.organizations_api.psycopg.connect") as db,\
      patch("app.eliot_document_analysis.generate_document_report") as provider:
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(BASE+"/document-runs",headers=AUTH,json={
         "approval_id":APPROVAL,"request_key":"22222222-2222-4222-8222-222222222222"
        })
    assert res.status_code==503
    db.assert_not_called()
    provider.assert_not_called()


def test_single_valid_document_run_fetches_rechecked_sha_before_provider():
    first,cur=db_conn(row=(UUID(RUN),True,"running","Review docs",REPO,PATH,
                           "feature/auth0-organizations-endpoint",SHA))
    last,cur_last=db_conn(row=("completed",))
    a,b,c,d,e=owner()
    with a,b,c as jwks,d,e,\
      patch("app.eliot_document_analysis.documentary_enabled",return_value=True),\
      patch("app.eliot_github_reader.read_document",return_value=document()) as reader,\
      patch("app.eliot_document_analysis.generate_document_report",
            return_value=("## Hallazgos\n[L1] Documento.",None)) as provider,\
      patch("app.organizations_api.db_params",return_value={"host":"db"}),\
      patch("app.organizations_api.psycopg.connect",side_effect=[first,last]):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(BASE+"/document-runs",headers=AUTH,json={
         "approval_id":APPROVAL,"request_key":"22222222-2222-4222-8222-222222222222"
        })
    assert res.status_code==200,res.text
    assert res.json()["status"]=="completed" and res.json()["sha"]==SHA
    reader.assert_called_once_with(ORG,REPO,PATH)
    provider.assert_called_once()
    assert any("owner_claim_document_run" in x.args[0] for x in cur.execute.call_args_list)
    assert any("owner_finish_document_run" in x.args[0] for x in cur_last.execute.call_args_list)


def test_retry_key_never_regenerates():
    first,cur=db_conn(row=(UUID(RUN),False,"completed","Review docs",REPO,PATH,
                           "feature/auth0-organizations-endpoint",SHA))
    a,b,c,d,e=owner()
    with a,b,c as jwks,d,e,\
      patch("app.eliot_document_analysis.documentary_enabled",return_value=True),\
      patch("app.eliot_github_reader.read_document") as reader,\
      patch("app.eliot_document_analysis.generate_document_report") as provider,\
      patch("app.organizations_api.db_params",return_value={"host":"db"}),\
      patch("app.organizations_api.psycopg.connect",return_value=first):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(BASE+"/document-runs",headers=AUTH,json={
         "approval_id":APPROVAL,"request_key":"22222222-2222-4222-8222-222222222222"
        })
    assert res.status_code==200 and res.json()["already_claimed"]
    reader.assert_not_called()
    provider.assert_not_called()


def test_changed_sha_is_recorded_as_failure_never_sent_to_model():
    first,_=db_conn(row=(UUID(RUN),True,"running","Review docs",REPO,PATH,
                          "feature/auth0-organizations-endpoint",SHA))
    last,cur_last=db_conn(row=("failed",))
    a,b,c,d,e=owner()
    with a,b,c as jwks,d,e,\
      patch("app.eliot_document_analysis.documentary_enabled",return_value=True),\
      patch("app.eliot_github_reader.read_document",return_value=document("b"*40)),\
      patch("app.eliot_document_analysis.generate_document_report") as provider,\
      patch("app.organizations_api.db_params",return_value={"host":"db"}),\
      patch("app.organizations_api.psycopg.connect",side_effect=[first,last]):
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        res=client.post(BASE+"/document-runs",headers=AUTH,json={
         "approval_id":APPROVAL,"request_key":"22222222-2222-4222-8222-222222222222"
        })
    assert res.status_code==200 and res.json()["error_code"]=="source_changed"
    provider.assert_not_called()
    args=[x.args for x in cur_last.execute.call_args_list if "owner_finish_document_run" in x.args[0]]
    assert args and args[0][1][-1]=="source_changed"


def test_existing_title_approval_not_interchangeable_for_document_run():
    a,b,c,d,e=owner()
    with a,b,c as jwks,d,e,\
       patch("app.eliot_document_analysis.documentary_enabled",return_value=True),\
       patch("app.organizations_api.db_params",return_value={"host":"db"}),\
       patch("app.organizations_api.psycopg.connect",
         side_effect=psycopg.errors.InvalidParameterValue("wrong approval capability")),\
       patch("app.eliot_document_analysis.generate_document_report") as provider:
        jwks.return_value.get_signing_key_from_jwt.return_value.key="key"
        response=client.post(BASE+"/document-runs",headers=AUTH,json={
         "approval_id":APPROVAL,"request_key":"22222222-2222-4222-8222-222222222222"
        })
    assert response.status_code==409
    provider.assert_not_called()

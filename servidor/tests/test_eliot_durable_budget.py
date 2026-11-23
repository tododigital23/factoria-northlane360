from unittest.mock import MagicMock, patch
from uuid import UUID
from datetime import date

import psycopg
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import eliot_durable_budget as budget
from app.organizations_api import router

ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
KEY="11111111-1111-4111-8111-111111111111"
AUTH={"Authorization":"Bearer stub"}
app=FastAPI()
app.include_router(router)
client=TestClient(app)


def db(row):
    conn=MagicMock()
    cur=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchone.return_value=row
    return conn,cur


def test_off_does_not_touch_db_or_require_subject():
    with patch.dict("os.environ",{"ELIOT_DURABLE_MODEL_BUDGET_ENABLED":"false"}),\
      patch("app.eliot_durable_budget.psycopg.connect") as dbconn:
        allowed,key=budget.reserve(ORG,None,KEY)
        assert allowed and key is None
        assert not budget.reconcile(ORG,None,None,{})
    dbconn.assert_not_called()


def test_enabled_fail_closed_on_missing_verified_identity():
    with patch.dict("os.environ",{"ELIOT_DURABLE_MODEL_BUDGET_ENABLED":"true"}),\
      patch("app.eliot_durable_budget.psycopg.connect") as dbconn:
        assert budget.reserve(ORG,None,KEY)==(False,None)
        assert budget.reserve(ORG,"issuer|owner","bad-uuid")==(False,None)
        assert budget.reserve(ORG,"issuer|owner",KEY,estimated_units=10001)==(False,None)
        assert budget.reserve("bad-org","issuer|owner",KEY)==(False,None)
    dbconn.assert_not_called()


def test_reservation_uses_verified_auth0_subject_and_owner_sql_only():
    conn,cur=db((True,))
    with patch.dict("os.environ",{"ELIOT_DURABLE_MODEL_BUDGET_ENABLED":"true"}),\
      patch("app.organizations_api.db_params",return_value={"host":"safe"}),\
      patch("app.eliot_durable_budget.psycopg.connect",return_value=conn):
        allowed,key=budget.reserve(ORG,"issuer|owner",KEY,estimated_units=2500)
    assert allowed and str(key)==KEY
    assert conn.__enter__.called
    calls=cur.execute.call_args_list
    assert calls[0].args[0].startswith("SELECT set_config")
    assert calls[0].args[1]==("issuer|owner",)
    assert "owner_reserve_model_budget" in calls[1].args[0]
    assert calls[1].args[1]==(UUID(ORG),UUID(KEY),2500)
    assert all(x.args[0].startswith("SELECT ") for x in calls)


def test_db_error_fails_without_provider_or_secret_leak():
    with patch.dict("os.environ",{"ELIOT_DURABLE_MODEL_BUDGET_ENABLED":"true"}),\
      patch("app.organizations_api.db_params",return_value={"host":"safe"}),\
      patch("app.eliot_durable_budget.psycopg.connect",
        side_effect=psycopg.OperationalError("secret not to expose")):
        assert budget.reserve(ORG,"issuer|owner",KEY)==(False,None)


def test_reconcile_reports_only_numeric_token_counts():
    conn,cur=db((True,))
    with patch.dict("os.environ",{"ELIOT_DURABLE_MODEL_BUDGET_ENABLED":"true"}),\
      patch("app.organizations_api.db_params",return_value={"host":"safe"}),\
      patch("app.eliot_durable_budget.psycopg.connect",return_value=conn):
        assert budget.reconcile(ORG,"issuer|owner",UUID(KEY),
            {"usage":{"input_tokens":100,"output_tokens":50}})
        assert not budget.reconcile(ORG,"issuer|owner",UUID(KEY),
            {"usage":{"input_tokens":"100","output_tokens":50}})
    assert any("owner_reconcile_model_budget" in c.args[0] for c in cur.execute.call_args_list)
    assert not any("UPDATE" in c.args[0] for c in cur.execute.call_args_list)


def test_document_provider_not_called_when_durable_quota_denies():
    from app.eliot_document_analysis import generate_document_report
    source={
      "repository":"Test/repo","path":"docs/README.md","ref":"main",
      "sha":"a"*40,"content":"# Safe\nA paragraph with plain text."
    }
    with patch.dict("os.environ",{"ELIOT_DURABLE_MODEL_BUDGET_ENABLED":"true"}),\
      patch("app.eliot_document_analysis.documentary_enabled",return_value=True),\
      patch("app.eliot_document_analysis.reserve_model_request",return_value=True),\
      patch("app.eliot_durable_budget.reserve",return_value=(False,None)),\
      patch("app.eliot_document_analysis.urllib.request.urlopen") as provider:
        output,reason=generate_document_report(
          ORG,"Review",source,verified_subject="issuer|owner",request_key=KEY)
    assert output is None and reason=="rate_limited"
    provider.assert_not_called()


def test_title_provider_not_called_when_durable_quota_denies():
    from app.eliot_analysis_executor import generate_draft
    with patch.dict("os.environ",{"ELIOT_DURABLE_MODEL_BUDGET_ENABLED":"true"}),\
      patch("app.eliot_analysis_executor.is_enabled_for",return_value=True),\
      patch("app.eliot_analysis_executor.reserve_model_request",return_value=True),\
      patch("app.eliot_durable_budget.reserve",return_value=(False,None)),\
      patch("app.eliot_analysis_executor.urllib.request.urlopen") as provider:
        output,reason=generate_draft(
          ORG,"Review",verified_subject="issuer|owner",request_key=KEY)
    assert output is None and reason=="rate_limited"
    provider.assert_not_called()


def test_status_off_never_queries_uninstalled_migration():
    route=f"/v1/me/organizations/{ORG}/execution/durable-model-budget"
    with patch("app.organizations_api._require_company_owner"),\
      patch.dict("os.environ",{"ELIOT_DURABLE_MODEL_BUDGET_ENABLED":"false"}),\
      patch("app.organizations_api.psycopg.connect") as dbconn:
        result=client.get(route,headers=AUTH)
    assert result.status_code==200
    assert result.json()["enabled"] is False
    dbconn.assert_not_called()


def test_status_on_is_owner_only_and_reports_distinct_estimate():
    route=f"/v1/me/organizations/{ORG}/execution/durable-model-budget"
    conn,cur=db((date(2026,10,29),5,12500,754,160,30,90000))
    with patch("app.organizations_api._require_company_owner"),\
      patch("app.organizations_api.verified_identity",return_value="issuer|owner"),\
      patch.dict("os.environ",{"ELIOT_DURABLE_MODEL_BUDGET_ENABLED":"true"}),\
      patch("app.organizations_api.db_params",return_value={"host":"safe"}),\
      patch("app.organizations_api.psycopg.connect",return_value=conn):
        result=client.get(route,headers=AUTH)
    assert result.status_code==200,result.text
    info=result.json()
    assert info["calls_reserved"]==5
    assert info["reservation_units_are_estimates"] is True
    assert info["provider_invoice"] is False
    assert info["scope"]=="single_company"
    assert "my_model_budget_status" in cur.execute.call_args_list[1].args[0]

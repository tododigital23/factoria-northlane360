from datetime import datetime,timezone
from unittest.mock import patch
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
import pytest

from app.eliot_run_recovery_triage import triage_company_runs
from app.organizations_api import router

ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
URL=f"/v1/me/organizations/{ORG}/execution/recovery-triage"
AUTH={"Authorization":"Bearer fake"}
app=FastAPI()
app.include_router(router)
client=TestClient(app)


def sample(state="running",attention=True,error=None):
    return {
      "organization_id":ORG,"read_only":True,"contains_report_text":False,
      "sample":{"not_full_company_census":True,"tasks_scanned":1,
                "task_limit":40,"run_limit_per_task_per_type":20,"truncated":False},
      "events":[{
       "id":"88888888-8888-4888-8888-888888888888",
       "task_id":"77777777-7777-4777-8777-777777777777",
       "task_title":"Check documentation",
       "kind":"document_analysis",
       "state":state,"error_code":error,"needs_attention":attention,
       "started_at":"2026-10-29T20:00:00+00:00",
       "repository":"Owner/private",
       "path":"docs/private.md","sha":"a"*40,
       "hidden_report_text":"NEVER INCLUDE",
      }],
    }


def test_ambiguous_running_never_authorizes_retry_or_calls_model():
    result=triage_company_runs(sample())
    assert result["incident_count_in_view"]==1
    assert result["has_executed_action"] is False
    assert result["untrusted_provider_outcome_for_stale_runs"] is True
    assert result["incidents"][0]["automated_retry_allowed"] is False
    assert result["incidents"][0]["another_model_call_started"] is False
    assert "no reenviar" in result["incidents"][0]["suggested_manual_check"].lower()
    assert "NEVER INCLUDE" not in str(result)


def test_failed_run_is_manual_review_and_completed_not_incident():
    failed=triage_company_runs(sample("failed",True,"rate_limited"))
    assert failed["incidents"][0]["priority"]=="review_failed"
    assert failed["incidents"][0]["reason_code"]=="rate_limited"
    completed=triage_company_runs(sample("completed",False))
    assert completed["incident_count_in_view"]==0
    running_ok=triage_company_runs(sample("running",False))
    assert running_ok["incident_count_in_view"]==0


def test_only_verified_sample_is_accepted():
    with pytest.raises(ValueError):
        triage_company_runs({**sample(),"read_only":False})
    with pytest.raises(ValueError):
        triage_company_runs({**sample(),"contains_report_text":True})
    with pytest.raises(ValueError):
        triage_company_runs({**sample(),"sample":{"not_full_company_census":False}})


def test_anonymous_is_rejected_without_model_access():
    with patch("app.organizations_api.company_work_overview",
               side_effect=HTTPException(status_code=401,detail="Bearer required")) as source,\
         patch("app.eliot_document_analysis.generate_document_report") as provider:
        response=client.get(URL)
    assert response.status_code==401
    provider.assert_not_called()


def test_owner_get_is_delegated_to_existing_tenant_scoped_reader():
    with patch("app.organizations_api.company_work_overview",return_value=sample()) as source,\
         patch("app.eliot_document_analysis.generate_document_report") as provider:
        response=client.get(URL,headers=AUTH)
    assert response.status_code==200
    assert response.json()["incidents"][0]["sha"]=="a"*40
    assert "NEVER INCLUDE" not in response.text
    source.assert_called_once()
    assert str(source.call_args.args[0])==ORG
    assert source.call_args.args[1]=="Bearer fake"
    provider.assert_not_called()


def test_other_company_forbidden_at_reader_boundary():
    with patch("app.organizations_api.company_work_overview",
        side_effect=HTTPException(status_code=403,detail="Owner only")):
        response=client.get(URL,headers=AUTH)
    assert response.status_code==403


def test_ambiguous_running_has_high_priority_but_no_replay():
    result=triage_company_runs(sample("running",True))
    incident=result["incidents"][0]
    assert incident["severity"]=="high"
    assert incident["next_action"]=="verify_provider_and_database"
    assert incident["automated_retry_allowed"] is False
    assert incident["status_changed"] is False


def test_rate_limit_failure_does_not_claim_provider_uncertainty():
    result=triage_company_runs(sample("failed",True,"rate_limited"))
    incident=result["incidents"][0]
    assert incident["severity"]=="normal"
    assert incident["next_action"]=="review_failure_and_approval"


def test_high_priority_incident_sorted_before_normal_failure():
    first=sample("failed",True,"rate_limited")["events"][0]
    second={**sample("running",True)["events"][0],
      "id":"99999999-9999-4999-8999-999999999999",
      "started_at":"2026-10-29T21:00:00+00:00"}
    overview={**sample(),"events":[first,second]}
    result=triage_company_runs(overview)
    assert result["incidents"][0]["run_id"]==second["id"]
    assert result["incidents"][1]["severity"]=="normal"

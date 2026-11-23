from unittest.mock import patch
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.eliot_runtime_budget_view import local_usage_status
from app.organizations_api import router

ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
URL=f"/v1/me/organizations/{ORG}/execution/local-model-usage"
app=FastAPI()
app.include_router(router)
client=TestClient(app)


def test_local_usage_consciously_not_provider_billing_or_total_quota():
    with patch("app.eliot_runtime_budget_view.local_usage_snapshot",
            return_value={"requests":2,"input_tokens":140,"output_tokens":38}), \
         patch.dict("os.environ",{
            "ELIOT_OPENAI_MAX_CALLS_PER_MINUTE":"4",
            "ELIOT_OPENAI_MAX_CALLS_PER_DAY":"20",
            "OPENAI_API_KEY":"fake-private-value"
         }):
        result=local_usage_status(ORG)
    assert result["organization_id"]==ORG
    assert result["read_only"] is True
    assert result["measurement"]=="current_api_process"
    assert result["provider_billing"] is False
    assert result["organization_wide_quota"] is False
    assert result["persistent_across_restart"] is False
    assert result["cross_replica_total"] is False
    assert result["limits"]=={
      "max_requests_per_minute_per_process":4,
      "max_requests_per_day_per_process":20
    }
    assert result["today_local"]=={
      "request_reservations":2,
      "reported_input_tokens":140,
      "reported_output_tokens":38
    }
    assert "fake-private-value" not in str(result)


def test_anonymous_cannot_read_local_usage():
    with patch("app.organizations_api.psycopg.connect") as db:
        result=client.get(URL)
    assert result.status_code==401
    db.assert_not_called()


def test_authenticated_owner_can_only_observe_their_verified_company():
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api._require_company_owner") as acl, \
         patch("app.eliot_runtime_budget_view.local_usage_snapshot",
               return_value={"requests":1,"input_tokens":4,"output_tokens":3}) as usage:
        result=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert result.status_code==200
    assert result.json()["organization_id"]==ORG
    acl.assert_called_once_with(UUID(ORG),"Bearer fake")
    usage.assert_called_once_with(ORG)


def test_rejected_owner_never_receives_any_metrics():
    from fastapi import HTTPException
    with patch("app.organizations_api.verified_identity",return_value="issuer|member"), \
         patch("app.organizations_api._require_company_owner",
              side_effect=HTTPException(status_code=403, detail="Owner only")), \
         patch("app.eliot_runtime_budget_view.local_usage_snapshot") as usage:
        result=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert result.status_code==403
    usage.assert_not_called()


def test_invalid_env_limits_clamped_like_actual_existing_guard():
    with patch("app.eliot_runtime_budget_view.local_usage_snapshot",
               return_value={"requests":0,"input_tokens":0,"output_tokens":0}), \
         patch.dict("os.environ",{
           "ELIOT_OPENAI_MAX_CALLS_PER_MINUTE":"999",
           "ELIOT_OPENAI_MAX_CALLS_PER_DAY":"-4",
         }):
        result=local_usage_status(OTHER)
    assert result["limits"]["max_requests_per_minute_per_process"]==30
    assert result["limits"]["max_requests_per_day_per_process"]==1

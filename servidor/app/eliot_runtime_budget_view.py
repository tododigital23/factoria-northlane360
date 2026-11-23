"""Read-only visibility of the current API process' pre-existing model guards.

This is NOT provider billing and NOT a durable or distributed quota.
Never returns API keys, request bodies, prompts or documents.
"""
import os
from app.eliot_model_limits import local_usage_snapshot, _limit


def local_usage_status(organization_id: str) -> dict:
    measured = local_usage_snapshot(organization_id)
    minute_limit = _limit("ELIOT_OPENAI_MAX_CALLS_PER_MINUTE", 15, 1, 30)
    daily_limit = _limit("ELIOT_OPENAI_MAX_CALLS_PER_DAY", 100, 1, 500)
    return {
        "organization_id": organization_id,
        "read_only": True,
        "measurement": "current_api_process",
        "provider_billing": False,
        "organization_wide_quota": False,
        "persistent_across_restart": False,
        "cross_replica_total": False,
        "note": "Muestra local y no persistente; consultar facturación oficial para costes.",
        "limits": {
            "max_requests_per_minute_per_process": minute_limit,
            "max_requests_per_day_per_process": daily_limit,
        },
        "today_local": {
            "request_reservations": measured["requests"],
            "reported_input_tokens": measured["input_tokens"],
            "reported_output_tokens": measured["output_tokens"],
        },
    }

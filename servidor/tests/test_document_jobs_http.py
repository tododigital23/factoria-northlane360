from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import eliot_document_jobs_api as api

ORG = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
TASK = UUID("77777777-7777-4777-8777-777777777777")
KEY = UUID("11111111-1111-4111-8111-111111111111")
BASE = f"/v1/me/organizations/{ORG}"
app = FastAPI()
app.include_router(api.router)
client = TestClient(app)
body = {"worker_id": str(KEY), "lease_id": str(KEY),
        "approval_id": str(KEY), "request_key": str(KEY)}

def cursor(cur):
    @contextmanager
    def context(_):
        yield cur
    return context

def test_opt_in_requires_both_flag_and_exact_org():
    with patch.dict("os.environ", {}, clear=True):
        assert not api.enabled_for(ORG)
    with patch.dict("os.environ", {"ELIOT_DURABLE_DOCUMENT_ENABLED": "true",
                                   "ELIOT_DURABLE_DOCUMENT_ALLOWED_ORGANIZATIONS": str(TASK)}):
        assert not api.enabled_for(ORG)

def test_anonymous_is_denied_without_storage():
    with patch.object(api, "_cursor") as db:
        assert client.get(BASE + f"/tasks/{TASK}/execution/document-jobs").status_code == 401
    db.assert_not_called()

def test_read_scope_cannot_enqueue():
    with patch.object(api, "_owner", side_effect=HTTPException(403, "scope")), \
            patch.object(api, "_cursor") as db:
        assert client.post(BASE + f"/tasks/{TASK}/execution/document-jobs", json=body).status_code == 403
    db.assert_not_called()

def test_disabled_capability_does_not_probe_missing_schema():
    with patch.object(api, "_owner", return_value="subject"), \
            patch.object(api, "enabled_for", return_value=False), patch.object(api, "_cursor") as db:
        result = client.get(BASE + "/execution/durable-document-capability")
    assert result.status_code == 200 and result.json()["enabled"] is False
    assert result.json()["worker_online_verified"] is False
    db.assert_not_called()

def test_disabled_queue_does_not_claim_approval():
    with patch.object(api, "_owner", return_value="subject"), \
            patch.object(api, "enabled_for", return_value=False), patch.object(api, "_cursor") as db:
        result = client.post(BASE + f"/tasks/{TASK}/execution/document-jobs", json=body)
    assert result.status_code == 503
    db.assert_not_called()

def test_enqueue_passes_only_owner_verified_scope_and_uuid_parameters():
    cur = MagicMock()
    cur.fetchone.return_value = (KEY,)
    with patch.object(api, "_owner", return_value="verified") as owner, \
            patch.object(api, "enabled_for", return_value=True), \
            patch.object(api, "_cursor", cursor(cur)):
        result = client.post(BASE + f"/tasks/{TASK}/execution/document-jobs", json=body)
    assert result.status_code == 202 and result.json()["provider_called"] is False
    assert result.json()["task_completed"] is False
    owner.assert_called_once_with(ORG, None, write=True)
    assert cur.execute.call_args.args[1] == (ORG, TASK, KEY, KEY, KEY, KEY)

def test_rejects_arbitrary_source_and_actor_fields():
    with patch.object(api, "_owner", return_value="verified"), patch.object(api, "_cursor") as db:
        result = client.post(BASE + f"/tasks/{TASK}/execution/document-jobs",
                             json={**body, "actor_subject": "spoofed", "repository": "other"})
    assert result.status_code == 422
    db.assert_not_called()

def test_job_history_does_not_return_claim_token_or_principal():
    cur = MagicMock()
    now = datetime.now(timezone.utc)
    cur.fetchall.return_value = [(KEY, KEY, KEY, "queued", now, now, False, False, None)]
    with patch.object(api, "_owner", return_value="verified"), patch.object(api, "_cursor", cursor(cur)):
        result = client.get(BASE + f"/tasks/{TASK}/execution/document-jobs")
    assert result.status_code == 200
    assert set(result.json()[0]) == {"job_id", "run_id", "lease_id", "state", "created_at",
                                    "valid_until", "cancel_requested", "attention_required", "error_code"}

def test_cancelling_in_flight_does_not_claim_that_request_was_undone():
    cur = MagicMock()
    cur.fetchone.return_value = ("cancellation_requested",)
    with patch.object(api, "_owner", return_value="verified"), patch.object(api, "_cursor", cursor(cur)):
        result = client.post(BASE + f"/execution/document-jobs/{KEY}/cancel")
    assert result.status_code == 200
    assert result.json()["in_flight_request_may_continue"] is True


"""Unit checks for irreversible worker boundaries. All external I/O is mocked."""
import hashlib
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest
import psycopg
from app import eliot_document_worker as worker

ORG = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
TEXT = "# Internal architecture\nPersist tasks and review results.\n"
SHA = hashlib.sha1(b"blob " + str(len(TEXT.encode())).encode() + b"\0" + TEXT.encode()).hexdigest()
JOB = dict(id=uuid4(), token=uuid4(), title="Review",
           repository="tu-organizacion/factoria-northlane360",
           path="docs/ARCHITECTURE.md", ref="feature/auth0-organizations-endpoint", sha=SHA)
DOC = {**{k: JOB[k] for k in ("repository", "path", "ref", "sha")},
       "content": TEXT, "read_only": True, "sent_to_model": False}


def store():
    value = MagicMock()
    value.take.return_value = JOB
    value.finish.return_value = "completed"
    return value


def test_disabled_worker_has_no_db_or_network():
    with patch.dict("os.environ", {}, clear=True), patch.object(worker, "Store") as db, \
            patch.object(worker, "read_document") as read:
        assert worker.process_one(ORG) == "disabled"
    db.assert_not_called()
    read.assert_not_called()


def test_worker_refuses_shared_identity_and_administrative_logins():
    settings = {"ELIOT_WORKER_DB_" + k: v for k, v in dict(
        HOST="db", PORT="5432", NAME="eliot_dev", USER="eliot_identity_app", PASSWORD="ci_only").items()}
    for name in ("eliot_identity_app", "postgres", "eliot_migrator", "eliot_worker_unsafe-name"):
        with patch.dict("os.environ", {**settings, "ELIOT_WORKER_DB_USER": name}, clear=True):
            with pytest.raises(RuntimeError):
                worker.db_params()


def test_committed_claim_required_before_any_network():
    db = store()
    db.take.side_effect = psycopg.OperationalError("commit unconfirmed")
    with patch.object(worker, "allowed_organizations", return_value=(ORG,)), \
            patch.object(worker, "read_document") as read:
        with pytest.raises(psycopg.OperationalError):
            worker.process_one(ORG, db)
    read.assert_not_called()


def test_source_hash_mismatch_never_calls_model():
    db = store()
    with patch.object(worker, "allowed_organizations", return_value=(ORG,)), \
            patch.object(worker, "read_document", return_value={**DOC, "content": "changed"}), \
            patch.object(worker, "generate_document_report") as generate:
        worker.process_one(ORG, db)
    generate.assert_not_called()
    db.verified.assert_not_called()
    db.finish.assert_called_once_with(ORG, JOB, None, "source_changed")


def test_source_commit_uncertainty_never_calls_model():
    db = store()
    db.verified.side_effect = psycopg.OperationalError("commit unconfirmed")
    with patch.object(worker, "allowed_organizations", return_value=(ORG,)), \
            patch.object(worker, "read_document", return_value=DOC), \
            patch.object(worker, "generate_document_report") as generate:
        with pytest.raises(psycopg.OperationalError):
            worker.process_one(ORG, db)
    generate.assert_not_called()


def test_claim_bound_budget_cannot_reserve_twice_or_for_different_job():
    db = store()
    db.call.return_value = (True,)
    budget = worker.JobBudget(db, ORG, JOB)
    assert budget.reserve(str(ORG), None, uuid4()) == (False, None)
    assert budget.reserve(str(ORG), None, JOB["id"]) == (True, JOB["id"])
    assert budget.reserve(str(ORG), None, JOB["id"]) == (False, None)
    db.call.assert_called_once()


def test_provider_gate_failure_prevents_http_even_when_model_enabled():
    from app.eliot_document_analysis import generate_document_report
    db = store()
    db.call.return_value = (False,)
    budget = worker.JobBudget(db, ORG, JOB)
    with patch("app.eliot_document_analysis.documentary_enabled", return_value=True), \
            patch("app.eliot_document_analysis.reserve_model_request", return_value=True), \
            patch("app.eliot_document_analysis.urllib.request.urlopen") as http:
        assert generate_document_report(str(ORG), JOB["title"], DOC,
            request_key=JOB["id"], budget_store=budget) == (None, "rate_limited")
    http.assert_not_called()


def test_provider_gate_commit_failure_prevents_http():
    from app.eliot_document_analysis import generate_document_report
    db = store()
    db.call.side_effect = psycopg.OperationalError("unconfirmed")
    budget = worker.JobBudget(db, ORG, JOB)
    with patch("app.eliot_document_analysis.documentary_enabled", return_value=True), \
            patch("app.eliot_document_analysis.reserve_model_request", return_value=True), \
            patch("app.eliot_document_analysis.urllib.request.urlopen") as http:
        with pytest.raises(psycopg.OperationalError):
            generate_document_report(str(ORG), JOB["title"], DOC,
                request_key=JOB["id"], budget_store=budget)
    http.assert_not_called()


def test_worker_passes_no_user_identity_and_does_not_retry_provider_failure():
    db = store()
    with patch.object(worker, "allowed_organizations", return_value=(ORG,)), \
            patch.object(worker, "read_document", return_value=DOC), \
            patch.object(worker, "generate_document_report", return_value=(None, "provider_error")) as generate:
        worker.process_one(ORG, db)
    generate.assert_called_once()
    assert "verified_subject" not in generate.call_args.kwargs
    assert isinstance(generate.call_args.kwargs["budget_store"], worker.JobBudget)
    db.finish.assert_called_once_with(ORG, JOB, None, "provider_error")


def test_store_does_not_return_before_commit_confirmed():
    connection = MagicMock()
    connection.__enter__.return_value.cursor.return_value.__enter__.return_value.fetchone.return_value = (True,)
    connection.__exit__.side_effect = psycopg.OperationalError("commit unconfirmed")
    with patch.object(worker, "db_params", return_value={}), \
            patch.object(worker.psycopg, "connect", return_value=connection):
        with pytest.raises(psycopg.OperationalError):
            worker.Store().call("SELECT 1", ())


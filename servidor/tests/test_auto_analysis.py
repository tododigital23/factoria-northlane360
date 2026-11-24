"""Auto-análisis tras assign del dueño: aprueba + genera borrador sin otra UI."""
from unittest.mock import MagicMock, patch
from uuid import uuid4

from app import eliot_auto_analysis as auto

ORG = str(uuid4())
TASK = str(uuid4())
WORKER = str(uuid4())
APPROVAL = uuid4()
RUN = uuid4()


def test_disabled_motor_does_not_touch_db():
    with patch.object(auto, "is_enabled_for", return_value=False), \
         patch("app.eliot_break.require_working"), \
         patch.object(auto.orgs.psycopg, "connect") as db:
        out = auto.start_for_owner_task(ORG, TASK, WORKER, "issuer|owner")
    assert out == {"execution_started": False, "run_status": None, "run_id": None, "reason": "executor_disabled"}
    db.assert_not_called()


def test_on_break_skips_without_provider():
    from fastapi import HTTPException
    with patch("app.eliot_break.require_working", side_effect=HTTPException(409, "break")), \
         patch.object(auto, "is_enabled_for") as enabled, \
         patch.object(auto, "generate_draft") as draft:
        out = auto.start_for_owner_task(ORG, TASK, WORKER, "issuer|owner")
    assert out["reason"] == "on_break" and out["execution_started"] is False
    enabled.assert_not_called()
    draft.assert_not_called()


def test_happy_path_approves_claims_and_finishes():
    approve_conn = MagicMock()
    approve_cur = approve_conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    approve_cur.fetchone.return_value = (APPROVAL,)
    claim_conn = MagicMock()
    claim_cur = claim_conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    claim_cur.fetchone.return_value = (RUN, True, "running", "Revisa precios")
    finish_conn = MagicMock()
    finish_cur = finish_conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    finish_cur.fetchone.return_value = ("completed",)
    report = "Borrador basado únicamente en el título."
    with patch("app.eliot_break.require_working"), \
         patch.object(auto, "is_enabled_for", return_value=True), \
         patch.object(auto.orgs, "_expire_stale_approvals_admin"), \
         patch.object(auto.orgs, "db_params", return_value={"host": "t"}), \
         patch.object(auto.orgs.psycopg, "connect", side_effect=[approve_conn, claim_conn, finish_conn]), \
         patch.object(auto, "generate_draft", return_value=(report, None)) as draft, \
         patch("app.eliot_durable_budget.enabled", return_value=False):
        out = auto.start_for_owner_task(ORG, TASK, WORKER, "issuer|owner")
    assert out["execution_started"] is True and out["run_status"] == "completed" and out["run_id"] == str(RUN)
    draft.assert_called_once_with(ORG, "Revisa precios")

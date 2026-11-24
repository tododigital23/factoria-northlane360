"""Al asignar un encargo, el dueño ya autorizó: aprueba y genera el borrador sin otra pantalla.

No abre GitHub ni el motor documental. Si el ejecutor está apagado o hay descanso,
la tarea queda pending y el monitoreo lo refleja; nunca rompe el assign.
"""
from __future__ import annotations

from uuid import UUID, uuid4

from app import organizations_api as orgs
from app.eliot_analysis_executor import generate_draft, is_enabled_for


def start_for_owner_task(organization_id, task_id, worker_id, subject: str) -> dict:
    """Devuelve {execution_started, run_status, run_id?, reason?} sin lanzar al caller del assign."""
    org, task, worker = str(organization_id), str(task_id), str(worker_id)
    out = {"execution_started": False, "run_status": None, "run_id": None, "reason": None}
    try:
        from app import eliot_break
        eliot_break.require_working(subject, UUID(org))
    except Exception as exc:
        code = getattr(exc, "status_code", None)
        out["reason"] = "on_break" if code == 409 else "break_check_failed"
        return out

    if not is_enabled_for(org):
        out["reason"] = "executor_disabled"
        return out

    try:
        orgs._expire_stale_approvals_admin(UUID(org), UUID(task))
    except Exception:
        pass

    approval_key = uuid4()
    run_key = uuid4()
    try:
        with orgs.psycopg.connect(**orgs.db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    cur.execute(
                        "SELECT eliot.owner_approve_analysis_draft(%s,%s,%s,%s)",
                        (org, task, worker, approval_key),
                    )
                    row = cur.fetchone()
                    if not row or not row[0]:
                        out["reason"] = "approval_failed"
                        return out
                    approval_id = row[0]
    except Exception:
        out["reason"] = "approval_failed"
        return out

    try:
        with orgs.psycopg.connect(**orgs.db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    cur.execute(
                        "SELECT run_id,should_execute,run_status,task_title "
                        "FROM eliot.owner_claim_analysis_run(%s,%s,%s,%s)",
                        (org, task, approval_id, run_key),
                    )
                    claim = cur.fetchone()
        if claim is None:
            out["reason"] = "claim_failed"
            return out
        run_id, should_execute, run_state, title = claim
        out["run_id"] = str(run_id)
        if not should_execute:
            out["execution_started"] = True
            out["run_status"] = run_state
            out["reason"] = "already_claimed"
            return out
    except Exception:
        out["reason"] = "claim_failed"
        return out

    from app.eliot_durable_budget import enabled as durable_enabled
    draft, reason = generate_draft(
        org,
        title,
        **({"verified_subject": subject, "request_key": run_key} if durable_enabled() else {}),
    )
    outcome = "completed" if draft is not None else "failed"
    failure = None if draft is not None else (reason or "internal_error")
    try:
        with orgs.psycopg.connect(**orgs.db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    cur.execute(
                        "SELECT eliot.owner_finish_analysis_run(%s,%s,%s,%s,%s)",
                        (org, run_id, outcome, draft, failure),
                    )
                    saved = cur.fetchone()
        if not saved or saved[0] != outcome:
            out["reason"] = "persist_failed"
            out["execution_started"] = True
            out["run_status"] = "running"
            return out
        out["execution_started"] = True
        out["run_status"] = outcome
        return out
    except Exception:
        out["reason"] = "persist_failed"
        out["execution_started"] = True
        out["run_status"] = "running"
        return out

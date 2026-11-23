"""Read-only review of persisted tool attempts. Never authorizes or retries work."""
from datetime import datetime, timezone


def review_tool_state(lease: dict | None, invocations: list[dict], *, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    pending = [row for row in invocations if row["status"] == "claimed"]
    state = "no_lease"
    review_required = False
    if pending:
        live = bool(lease and lease["state"] == "held"
                    and datetime.fromisoformat(lease["expires_at"]) > now)
        state = "in_progress_or_unconfirmed" if live else "outcome_unconfirmed"
        review_required = not live
    elif lease:
        if lease["state"] == "released":
            state, review_required = "released_requires_review", True
        elif lease["state"] != "held" or datetime.fromisoformat(lease["expires_at"]) <= now:
            state, review_required = "expired_requires_review", True
        elif invocations:
            state = "attempts_recorded"
        else:
            state = "lease_held"
    messages = {
        "no_lease": "No hay una reserva registrada para esta tarea.",
        "lease_held": "La reserva sigue vigente. Cada lectura requiere una autorización propia.",
        "attempts_recorded": "Hay resultados registrados. Una lectura no completa la tarea.",
        "in_progress_or_unconfirmed": "Hay una solicitud pendiente de confirmar. Puede seguir en curso; no la repitas.",
        "outcome_unconfirmed": "La reserva ya no está vigente y hay un resultado sin confirmar. Requiere revisión.",
        "released_requires_review": "La reserva fue liberada. Una nueva reserva requiere revisión; no se renovará automáticamente.",
        "expired_requires_review": "La reserva ha vencido. Requiere revisión antes de una nueva ejecución.",
    }
    return {"state": state, "message": messages[state], "review_required": review_required,
            "pending_invocation_ids": [row["invocation_id"] for row in pending],
            "suspend_new_actions": bool(pending) or review_required,
            "visible_attempts": len(invocations), "history_limit": 20,
            "advisory_only": True, "retry_execution": False,
            "automatic_recovery": False, "task_completed": False}

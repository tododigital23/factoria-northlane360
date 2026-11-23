"""Read-only assessment of interrupted or failed Eliot model runs.

Never starts, resumes, replays, revokes, changes task state or sends data
to provider. A request timing out does not prove the provider did not bill.
Owner-authenticated overview is sampled and its counts are not a census.
"""
from typing import Any


def triage_company_runs(overview: dict[str, Any]) -> dict[str, Any]:
    if not overview.get("read_only") or overview.get("contains_report_text") is not False:
        raise ValueError("Verified read-only overview required")
    if overview.get("sample", {}).get("not_full_company_census") is not True:
        raise ValueError("Bounded source required")
    items = []
    for entry in overview.get("events", [])[:30]:
        status = entry.get("state")
        if status == "failed":
            advice = (
                "Consultar el error y el historial de la tarea; comprobar "
                "si OpenAI procesó el intento antes de autorizar otro."
            )
            priority = "review_failed"
        elif status == "running" and entry.get("needs_attention") is True:
            advice = (
                "Estado incierto: comprobar registros del proveedor y la API. "
                "No reenviar la ejecución ni reutilizar su autorización."
            )
            priority = "investigate_ambiguous"
        else:
            continue
        # Priority is advisory, never a permission to replay or change status.
        if priority == "investigate_ambiguous":
            severity = "high"
            next_action = "verify_provider_and_database"
        elif entry.get("error_code") in ("provider_error", "internal_error"):
            severity = "high"
            next_action = "verify_provider_and_database"
        else:
            severity = "normal"
            next_action = "review_failure_and_approval"
        items.append({
            "run_id":entry["id"],
            "task_id":entry["task_id"],
            "task_title":entry["task_title"],
            "kind":entry["kind"],
            "state":status,
            "reason_code":entry.get("error_code"),
            "started_at":entry["started_at"],
            "priority":priority,
            "severity":severity,
            "next_action":next_action,
            "suggested_manual_check":advice,
            "repository":entry.get("repository"),
            "path":entry.get("path"),
            "sha":entry.get("sha"),
            "automated_retry_allowed":False,
            "another_model_call_started":False,
            "status_changed":False,
        })
    items.sort(key=lambda x: (x["severity"] != "high", x["started_at"], x["run_id"]))
    return {
        "organization_id": overview["organization_id"],
        "read_only":True,
        "has_executed_action":False,
        "untrusted_provider_outcome_for_stale_runs":True,
        "requires_owner_review":True,
        "sample": overview["sample"],
        "incident_count_in_view":len(items),
        "incidents":items[:20],
        "message":(
            "Diagnóstico consultivo de una muestra limitada de ejecuciones. "
            "Los intentos pendientes podrían haberse facturado incluso si la "
            "API perdió su respuesta. Nunca reintentar automáticamente."
        ),
    }

"""Pure, bounded, owner-only work overview formatter.

Never expose report bodies, model prompts, secrets or source content.
Counts always reflect at most 40 recent tasks and 20 runs of each
kind per task, NOT an unlimited company-wide census.
"""
from datetime import datetime, timezone
from typing import Any

MAX_TASKS = 40
MAX_EVENTS = 30


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _entry(
    task_id: str, title: str, kind: str, row: tuple[Any, ...],
    now: datetime,
) -> dict[str, Any]:
    if kind == "title_draft":
        run_id, state, _report, error, started, finished = row
        origin: dict[str, str | None] = {
            "repository": None, "path": None, "ref": None, "sha": None
        }
    else:
        run_id, state, _report, error, repo, path, ref, sha, started, finished = row
        origin = {"repository": repo, "path": path, "ref": ref, "sha": sha}
    age_seconds = max(0, (now - started).total_seconds())
    return {
        "id": str(run_id),
        "task_id": task_id,
        "task_title": title,
        "kind": kind,
        "state": state,
        "started_at": _iso(started),
        "finished_at": _iso(finished),
        "error_code": error,
        "needs_attention": state == "failed" or (
            state == "running" and age_seconds > 900
        ),
        **origin,
    }


def summarize(
    organization_id: str,
    tasks: list[tuple[Any, ...]],
    title_history: dict[str, list[tuple[Any, ...]]],
    document_history: dict[str, list[tuple[Any, ...]]],
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    counts = {
        "title_draft": {"completed": 0, "failed": 0, "running": 0},
        "document_analysis": {"completed": 0, "failed": 0, "running": 0},
    }
    entries: list[dict[str, Any]] = []
    for task in tasks[:MAX_TASKS]:
        task_id, _department_id, _worker_id, title, _status, _created = task
        key = str(task_id)
        for kind, histories in (
            ("title_draft", title_history),
            ("document_analysis", document_history),
        ):
            for row in histories.get(key, [])[:20]:
                event = _entry(key, title, kind, row, now)
                if event["state"] in counts[kind]:
                    counts[kind][event["state"]] += 1
                entries.append(event)
    entries.sort(key=lambda item: (item["started_at"], item["id"]), reverse=True)
    return {
        "organization_id": organization_id,
        "read_only": True,
        "contains_report_text": False,
        "sample": {
            "tasks_scanned": min(len(tasks), MAX_TASKS),
            "tasks_available_in_bounded_reader": len(tasks),
            "task_limit": MAX_TASKS,
            "run_limit_per_task_per_type": 20,
            "truncated": len(tasks) > MAX_TASKS,
            "not_full_company_census": True,
        },
        "counts": counts,
        "attention_count_in_sample": sum(e["needs_attention"] for e in entries),
        "events": entries[:MAX_EVENTS],
    }

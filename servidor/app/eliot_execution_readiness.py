"""Fail-closed execution-readiness assessment, no provider or tool calls.

This is an advisory stage: it never authorizes GitHub writes or model execution.
A real execution engine will need a separate durable lease and scoped approval.
"""
from typing import Any

def task_execution_readiness(
    organization_id: str,
    task: dict[str, Any],
    worker: dict[str, Any] | None,
    *,
    document_sha_verified: bool = False,
    approval_granted: bool = False,
    durable_budget_enabled: bool = False,
) -> dict[str, Any]:
    reasons: list[str] = []
    if str(task.get("organization_id")) != organization_id:
        reasons.append("tenant_mismatch")
    if task.get("status") != "pending":
        reasons.append("task_not_pending")
    if not worker:
        reasons.append("worker_missing")
    else:
        if str(worker.get("organization_id")) != organization_id:
            reasons.append("worker_tenant_mismatch")
        if str(task.get("assignee_worker_id")) != str(worker.get("id")):
            reasons.append("worker_not_assigned")
        if str(task.get("department_id")) != str(worker.get("department_id")):
            reasons.append("department_mismatch")
        if worker.get("operating_state") != "idle":
            reasons.append("worker_not_idle")
    if not document_sha_verified:
        reasons.append("document_sha_not_verified")
    if not approval_granted:
        reasons.append("explicit_approval_required")
    if not durable_budget_enabled:
        reasons.append("durable_budget_unavailable")
    return {
        "organization_id": organization_id,
        "task_id": str(task.get("id", "")),
        "worker_id": str(worker.get("id", "")) if worker else None,
        "ready_for_future_engine": not reasons,
        "advisory_only": True,
        "execution_started": False,
        "model_called": False,
        "github_write_allowed": False,
        "reasons": reasons,
        "next_stage": "design_durable_lease_and_scoped_tool_grants",
    }

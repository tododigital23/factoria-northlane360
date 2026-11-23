"""Owner-facing queue control. Disabled by default; never executes external I/O."""
import os
from uuid import UUID
from pydantic import Field
from fastapi import APIRouter, Header, HTTPException
from app import organizations_api as identity
from app.eliot_tool_control_api import StrictRequest, _cursor, _owner

router = APIRouter(prefix="/v1/me/organizations", tags=["durable-documents"])


def enabled_for(org):
    return (os.getenv("ELIOT_DURABLE_DOCUMENT_ENABLED") == "true"
            and str(org) in {s.strip() for s in os.getenv(
                "ELIOT_DURABLE_DOCUMENT_ALLOWED_ORGANIZATIONS", "").split(",")})


class EnqueueDocumentJob(StrictRequest):
    plan_id: UUID | None = None
    include_plan_objective: bool = Field(default=False,strict=True)
    worker_id: UUID
    lease_id: UUID
    approval_id: UUID
    request_key: UUID


def objective_capability(cur):
    signature='eliot.owner_enqueue_objective_document_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid)'
    cur.execute('SELECT to_regprocedure(%s)',(signature,));row=cur.fetchone()
    if not row or not row[0]:return False
    cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE')",(row[0],))
    if cur.fetchone()!=(True,):return False
    cur.execute("SELECT to_regprocedure('eliot.worker_take_document_job_with_objective(uuid)')")
    row=cur.fetchone()
    if not row or not row[0]:return False
    cur.execute("SELECT has_function_privilege('eliot_execution_worker',%s,'EXECUTE')",(row[0],))
    return cur.fetchone()==(True,)

@router.get("/{organization_id}/execution/durable-document-capability")
def capability(organization_id: UUID, authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=False)
    ready = False
    objective_ready = False
    if enabled_for(organization_id):
        with _cursor(subject) as cur:
            cur.execute("SELECT to_regprocedure('eliot.owner_enqueue_document_job(uuid,uuid,uuid,uuid,uuid,uuid)')")
            row = cur.fetchone()
            if row and row[0]:
                cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE')", (row[0],))
                ready = cur.fetchone() == (True,)
            objective_ready=objective_capability(cur)
    return {"organization_id": str(organization_id), "enabled": ready,
            "capability": "durable_document_analysis_v1", "requires_document_approval": True,
            "requires_live_lease": True, "provider_called": False,
            "worker_online_verified": False,"plan_objective_supported":objective_ready}


@router.post("/{organization_id}/tasks/{task_id}/execution/document-jobs", status_code=202)
def enqueue(organization_id: UUID, task_id: UUID, body: EnqueueDocumentJob,
            authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=True)
    if not enabled_for(organization_id):
        raise HTTPException(503, "Durable document queue disabled")
    from app import eliot_break
    eliot_break.require_working(subject, organization_id)
    if body.include_plan_objective and body.plan_id is None:raise HTTPException(422,'Objective requires a saved plan')
    with _cursor(subject) as cur:
        if body.include_plan_objective:
            if not objective_capability(cur):raise HTTPException(503,'Approved objective migration unavailable')
            cur.execute("SELECT eliot.owner_enqueue_objective_document_job(%s,%s,%s,%s,%s,%s,%s)",
                        (organization_id,task_id,body.worker_id,body.lease_id,body.approval_id,body.request_key,body.plan_id))
        elif body.plan_id is None:
            cur.execute("SELECT eliot.owner_enqueue_document_job(%s,%s,%s,%s,%s,%s)",
                        (organization_id, task_id, body.worker_id, body.lease_id,
                         body.approval_id, body.request_key))
        else:
            cur.execute("SELECT eliot.owner_enqueue_planned_document_job(%s,%s,%s,%s,%s,%s,%s)",
                        (organization_id, task_id, body.worker_id, body.lease_id,
                         body.approval_id, body.request_key, body.plan_id))
        row = cur.fetchone()
        if not row or not isinstance(row[0], UUID):
            raise HTTPException(503, "Document queue insertion unconfirmed")
    return {"job_id": str(row[0]), "provider_called": False,
            "task_completed": False, "consult_state": True}


@router.get("/{organization_id}/tasks/{task_id}/execution/document-jobs")
def jobs(organization_id: UUID, task_id: UUID,
         authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=False)
    with _cursor(subject) as cur:
        cur.execute("SELECT * FROM eliot.my_document_jobs(%s,%s)", (organization_id, task_id))
        rows = cur.fetchall()
    return [{"job_id": str(r[0]), "run_id": str(r[1]), "lease_id": str(r[2]),
             "state": r[3], "created_at": r[4].isoformat(), "valid_until": r[5].isoformat(),
             "cancel_requested": r[6], "attention_required": r[7], "error_code": r[8]}
            for r in rows]


@router.post("/{organization_id}/execution/document-jobs/{job_id}/cancel")
def cancel(organization_id: UUID, job_id: UUID,
           authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=True)
    with _cursor(subject) as cur:
        cur.execute("SELECT eliot.owner_cancel_document_job(%s,%s)", (organization_id, job_id))
        row = cur.fetchone()
        if not row or row[0] not in ("cancelled", "cancellation_requested",
                                    "completed", "failed", "needs_review"):
            raise HTTPException(503, "Cancellation unconfirmed")
    return {"job_id": str(job_id), "state": row[0], "provider_called": False,
            "in_flight_request_may_continue": row[0] == "cancellation_requested"}


"""Owner decisions on stored documentary work. No model/tool dispatch."""
from uuid import UUID
from typing import Literal
from fastapi import APIRouter, Header, HTTPException
from pydantic import Field
from app.eliot_tool_control_api import StrictRequest, _cursor, _owner

router = APIRouter(prefix="/v1/me/organizations", tags=["document-reviews"])
WRITE = "eliot.owner_review_document_work(uuid,uuid,uuid,text,text,uuid)"
READ = "eliot.my_document_work_review(uuid,uuid,uuid)"

class DocumentWorkReview(StrictRequest):
    decision: Literal["accepted", "changes_requested"]
    reason: str = Field(min_length=10, max_length=1000)
    request_key: UUID


def ready(cur):
    cur.execute("SELECT to_regprocedure(%s),to_regprocedure(%s)", (READ, WRITE))
    row = cur.fetchone()
    if not row or not all(row):
        return False
    cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE') "
                "AND has_function_privilege(current_user,%s,'EXECUTE')", row)
    return cur.fetchone() == (True,)


def read(cur, org, task, run):
    cur.execute("SELECT * FROM eliot.my_document_work_review(%s,%s,%s)", (org, task, run))
    r = cur.fetchone()
    if not r or r[0] != run:
        raise HTTPException(409, "Exact documentary result unavailable")
    return {"organization_id": str(org), "task_id": str(task), "run_id": str(run),
            "enabled": True, "task_status": r[1], "eligible": r[2] is None,
            "unavailable_reason": r[2], "review": None if r[3] is None else {
                "id": str(r[3]), "decision": r[4], "reason": r[5],
                "reviewed_at": r[6].isoformat(), "task_status_after": r[7],
                "request_key": str(r[8])}, "provider_called": False}


@router.get("/{organization_id}/tasks/{task_id}/execution/document-runs/{run_id}/review")
def context(organization_id: UUID, task_id: UUID, run_id: UUID,
            authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=False)
    with _cursor(subject) as cur:
        if not ready(cur):
            return {"organization_id": str(organization_id), "task_id": str(task_id),
                    "run_id": str(run_id), "enabled": False, "eligible": False,
                    "review": None, "provider_called": False}
        return read(cur, organization_id, task_id, run_id)


@router.post("/{organization_id}/tasks/{task_id}/execution/document-runs/{run_id}/review")
def review(organization_id: UUID, task_id: UUID, run_id: UUID, body: DocumentWorkReview,
           authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=True)
    if not 10 <= len(body.reason.strip()) <= 1000:
        raise HTTPException(422, "Review reason required")
    with _cursor(subject) as cur:
        if not ready(cur):
            raise HTTPException(503, "Document review migration unavailable")
        cur.execute("SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)",
                    (organization_id, task_id, run_id, body.decision, body.reason, body.request_key))
        row = cur.fetchone()
        if not row or not isinstance(row[0], UUID):
            raise HTTPException(503, "Review insertion unconfirmed")
        result = read(cur, organization_id, task_id, run_id)
        if not result["review"] or result["review"]["id"] != str(row[0]):
            raise HTTPException(503, "Review readback unconfirmed")
    # After the review has committed: a Freddy autopilot (033), if the owner approved one,
    # continues the mission. Separate transaction; it can never alter the review itself.
    if result["review"]["decision"] == "accepted":
        from app.eliot_mission_autopilot_api import advance_after_acceptance
        result["autopilot"] = advance_after_acceptance(subject, organization_id, task_id)
    return result

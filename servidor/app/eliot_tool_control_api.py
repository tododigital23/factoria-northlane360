"""Owner control plane and separately opt-in GitHub reader. Never calls a model."""
from contextlib import contextmanager
from datetime import datetime, timezone
from uuid import UUID

import psycopg
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app import organizations_api as identity
from app.eliot_github_reader import sources_for
from app.eliot_tool_grant_policy import evaluate_github_read_grant

router = APIRouter(prefix="/v1/me/organizations", tags=["tool-control"])


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LeaseRequest(StrictRequest):
    worker_id: UUID
    request_key: UUID


class LeaseRelease(StrictRequest):
    lease_id: UUID


class GitHubReadApproval(LeaseRequest):
    lease_id: UUID
    repository: str = Field(min_length=3, max_length=210)
    path: str = Field(min_length=6, max_length=400)
    expected_sha: str = Field(pattern=r"^[0-9a-f]{40}$")


def _owner(org: UUID, authorization: str | None, *, write: bool) -> str:
    subject = (identity._require_approval_scope(authorization) if write
               else identity.verified_identity(authorization))
    identity._require_company_owner(org, authorization)
    return subject


@contextmanager
def _cursor(subject: str):
    try:
        with identity.psycopg.connect(**identity.db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    yield cur
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(403, "Tool control not authorized") from None
    except (psycopg.errors.InvalidParameterValue, psycopg.errors.UniqueViolation,
            psycopg.errors.LockNotAvailable, psycopg.errors.ObjectNotInPrerequisiteState):
        raise HTTPException(409, "Task, worker, lease or authorization no longer eligible") from None
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(503, "Tool control storage unavailable") from None


def _lease(cur, org: UUID, task: UUID):
    cur.execute(
        "SELECT lease_id,worker_id,lease_state,acquired_at,expires_at "
        "FROM eliot.my_task_execution_lease(%s,%s)", (org, task),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return {"lease_id": str(row[0]), "worker_id": str(row[1]), "state": row[2],
            "acquired_at": row[3].isoformat(), "expires_at": row[4].isoformat(),
            "usable": row[2] == "held" and row[4] > datetime.now(timezone.utc)}


@router.get("/{organization_id}/tasks/{task_id}/execution/lease")
def get_lease(organization_id: UUID, task_id: UUID,
              authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=False)
    with _cursor(subject) as cur:
        lease = _lease(cur, organization_id, task_id)
    return {"organization_id": str(organization_id), "task_id": str(task_id),
            "lease": lease, "execution_started": False}


@router.post("/{organization_id}/tasks/{task_id}/execution/lease", status_code=201)
def acquire_lease(organization_id: UUID, task_id: UUID, body: LeaseRequest,
                  authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=True)
    with _cursor(subject) as cur:
        cur.execute("SELECT eliot.owner_claim_task_lease(%s,%s,%s,%s)",
                    (organization_id, task_id, body.worker_id, body.request_key))
        row = cur.fetchone()
        if not row or not row[0]:
            raise HTTPException(503, "Lease acquisition unconfirmed")
        lease = _lease(cur, organization_id, task_id)
        if not lease or lease["lease_id"] != str(row[0]):
            raise HTTPException(503, "Lease acquisition unconfirmed")
    return {"organization_id": str(organization_id), "task_id": str(task_id),
            "lease": lease, "execution_started": False}


@router.post("/{organization_id}/tasks/{task_id}/execution/lease/release")
def release_lease(organization_id: UUID, task_id: UUID, body: LeaseRelease,
                  authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=True)
    with _cursor(subject) as cur:
        cur.execute("SELECT eliot.owner_release_task_lease(%s,%s,%s)",
                    (organization_id, task_id, body.lease_id))
        row = cur.fetchone()
        if not row or type(row[0]) is not bool:
            raise HTTPException(503, "Lease release unconfirmed")
    return {"lease_id": str(body.lease_id), "state": "released", "changed": row[0],
            "execution_started": False}


def _validate_source(org: UUID, task: UUID, body: GitHubReadApproval):
    # Evaluate only operator-configured metadata. No GitHub request or secret read.
    if not any(f'{s["owner"]}/{s["repo"]}' == body.repository
               and body.path.startswith(s["prefix"]) for s in sources_for(str(org))):
        raise HTTPException(404, "GitHub source not available for this organization")
    grant = {"organization_id": str(org), "task_id": str(task),
             "worker_id": str(body.worker_id), "lease_id": str(body.lease_id),
             "capability": "github_document_read_v1", "state": "approved",
             "repository": body.repository, "path": body.path, "sha": body.expected_sha,
             "read_only": True, "single_use": True}
    decision = evaluate_github_read_grant(
        organization_id=str(org), task_id=str(task), worker_id=str(body.worker_id),
        lease_id=str(body.lease_id), grant=grant, repository=body.repository,
        path=body.path, sha=body.expected_sha,
    )
    if not decision["allowed_by_local_policy"]:
        raise HTTPException(422, "Document outside permitted tool scope")


@router.post("/{organization_id}/tasks/{task_id}/execution/github-read-grants", status_code=201)
def approve_github_read(organization_id: UUID, task_id: UUID, body: GitHubReadApproval,
                        authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=True)
    _validate_source(organization_id, task_id, body)
    with _cursor(subject) as cur:
        cur.execute("SELECT eliot.owner_approve_github_read(%s,%s,%s,%s,%s,%s,%s,%s)",
                    (organization_id, task_id, body.worker_id, body.lease_id,
                     body.repository, body.path, body.expected_sha, body.request_key))
        row = cur.fetchone()
        if not row or not row[0]:
            raise HTTPException(503, "GitHub read approval unconfirmed")
    # Do not invent a new expiry/state on an idempotent replay. GET returns DB state.
    return {"grant_id": str(row[0]), "organization_id": str(organization_id),
            "task_id": str(task_id), "capability": "github_document_read_v1",
            "single_use": True, "read_only": True, "source_verified": False,
            "execution_started": False, "provider_called": False}


@router.get("/{organization_id}/tasks/{task_id}/execution/github-read-grants")
def list_github_reads(organization_id: UUID, task_id: UUID,
                      authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=False)
    with _cursor(subject) as cur:
        cur.execute("SELECT grant_id,lease_id,source_repo,source_path,source_sha,"
                    "grant_state,expires_at FROM eliot.my_github_read_grants(%s,%s)",
                    (organization_id, task_id))
        rows = cur.fetchall()
    now = datetime.now(timezone.utc)
    return [{"grant_id": str(r[0]), "lease_id": str(r[1]), "repository": r[2],
             "path": r[3], "sha": r[4], "state": r[5], "expires_at": r[6].isoformat(),
             "unexpired_approval": r[5] == "approved" and r[6] > now,
             "requires_live_lease_check": True} for r in rows]


# 034: Opt-in, owner-requested dispatch. No autonomous scheduling or model calls.
class GitHubReadDispatch(GitHubReadApproval):
    grant_id: UUID


@router.post("/{organization_id}/tasks/{task_id}/execution/github-reads")
def dispatch_github_read(organization_id: UUID, task_id: UUID, body: GitHubReadDispatch,
                         authorization: str | None = Header(default=None)):
    from app.eliot_github_dispatch import enabled_for, verify_document, InvalidToolDocument
    from app.eliot_github_reader import read_document, GitHubSourceError

    subject = _owner(organization_id, authorization, write=True)
    if not enabled_for(organization_id):
        raise HTTPException(503, "GitHub tool dispatch disabled for this organization")
    _validate_source(organization_id, task_id, body)
    # Both grant consumption and invocation journal must commit before network I/O.
    # Connection/commit failure is ambiguous: never attempt the external read.
    with _cursor(subject) as cur:
        cur.execute(
            "SELECT invocation_id,should_execute,invocation_status "
            "FROM eliot.owner_start_github_invocation(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (organization_id, task_id, body.worker_id, body.grant_id, body.lease_id,
             body.repository, body.path, body.expected_sha, body.request_key),
        )
        row = cur.fetchone()
        if not row or not isinstance(row[0], UUID) or type(row[1]) is not bool:
            raise HTTPException(503, "Tool invocation unconfirmed")
        invocation_id, should_execute, status = row
    if not should_execute:
        return {"invocation_id": str(invocation_id), "status": status,
                "replayed": True, "document_returned": False,
                "external_read_attempted": False, "sent_to_model": False}

    doc = None
    size = None
    error = None
    try:
        doc = read_document(str(organization_id), body.repository, body.path)
        size = verify_document(doc, body.repository, body.path, body.expected_sha)
    except GitHubSourceError:
        error = "source_unavailable"
    except InvalidToolDocument as exc:
        error = exc.code
    except Exception:
        # Never return upstream exception details or partial document content.
        error = "internal_error"
    result_status = "failed" if error else "completed"
    try:
        with _cursor(subject) as cur:
            cur.execute("SELECT eliot.owner_finish_github_invocation(%s,%s,%s,%s,%s)",
                        (organization_id, invocation_id, result_status, size if not error else None, error))
            finished = cur.fetchone()
            if not finished or finished[0] != result_status:
                raise HTTPException(503, "Tool completion unconfirmed")
    except HTTPException:
        raise HTTPException(503, detail={"invocation_id": str(invocation_id),
                            "code": "completion_unconfirmed", "retry_execution": False}) from None
    if error:
        raise HTTPException(502, detail={"invocation_id": str(invocation_id),
                            "code": error, "retry_execution": False})
    return {"invocation_id": str(invocation_id), "status": "completed",
            "external_read_attempted": True, "replayed": False,
            "grant_consumed": True, "sent_to_model": False,
            "document": {"repository": body.repository, "path": body.path,
                         "sha": body.expected_sha, "ref": doc["ref"],
                         "content": doc["content"], "size_bytes": size,
                         "source_verified": True, "read_only": True}}


@router.get("/{organization_id}/tasks/{task_id}/execution/github-reads")
def list_github_invocations(organization_id: UUID, task_id: UUID,
                            authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=False)
    with _cursor(subject) as cur:
        cur.execute("SELECT invocation_id,grant_id,invocation_status,byte_count,error_code,"
                    "claimed_at,finished_at FROM eliot.my_github_invocations(%s,%s)",
                    (organization_id, task_id))
        rows = cur.fetchall()
    return [{"invocation_id": str(r[0]), "grant_id": str(r[1]), "status": r[2],
             "size_bytes": r[3], "error_code": r[4], "claimed_at": r[5].isoformat(),
             "finished_at": r[6].isoformat() if r[6] else None,
             "retry_execution": False} for r in rows]


@router.get("/{organization_id}/execution/github-tool-capability")
def github_tool_capability(organization_id: UUID,
                            authorization: str | None = Header(default=None)):
    from app.eliot_github_dispatch import enabled_for
    from app.eliot_github_reader import configured
    subject = _owner(organization_id, authorization, write=False)
    signatures = [
        "eliot.owner_start_github_invocation(uuid,uuid,uuid,uuid,uuid,text,text,text,uuid)",
        "eliot.owner_finish_github_invocation(uuid,uuid,text,integer,text)",
        "eliot.my_github_invocations(uuid,uuid)",
    ]
    with _cursor(subject) as cur:
        cur.execute(
            "SELECT COALESCE(bool_and(f.oid IS NOT NULL AND "
            "has_function_privilege(current_user,f.oid,'EXECUTE')),false) "
            "FROM (SELECT to_regprocedure(signature)::oid AS oid "
            "FROM unnest(%s::text[]) AS signature) AS f", (signatures,),
        )
        row = cur.fetchone()
        storage_ready = bool(row and row[0] is True)
        cur.execute(
            "SELECT COALESCE(bool_and(f.oid IS NOT NULL AND "
            "has_function_privilege(current_user,f.oid,'EXECUTE')),false) "
            "FROM (SELECT to_regprocedure(signature)::oid AS oid "
            "FROM unnest(%s::text[]) AS signature) AS f",
            (["eliot.owner_review_and_renew_lease(uuid,uuid,uuid,uuid,text,uuid)",
              "eliot.my_lease_reviews(uuid,uuid)"],),
        )
        review_row = cur.fetchone()
        lease_review_ready = bool(review_row and review_row[0] is True)
    source_configured = bool(configured() and sources_for(str(organization_id)))
    opted_in = enabled_for(organization_id)
    return {"organization_id": str(organization_id), "capability": "github_document_read_v1",
            "enabled": opted_in and storage_ready and source_configured,
            "operator_enabled": opted_in, "storage_ready": storage_ready,
            "lease_review_ready": lease_review_ready,
            "source_configured": source_configured, "connection_checked": False,
            "read_only": True, "single_use": True, "sent_to_model": False,
            "autonomous_execution": False}


@router.get("/{organization_id}/tasks/{task_id}/execution/github-read-review")
def github_read_review(organization_id: UUID, task_id: UUID,
                       authorization: str | None = Header(default=None)):
    from app.eliot_tool_recovery import review_tool_state
    subject = _owner(organization_id, authorization, write=False)
    # Same transaction snapshot for both readers, without table privileges.
    try:
        with identity.psycopg.connect(**identity.db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    lease = _lease(cur, organization_id, task_id)
                    cur.execute("SELECT invocation_id,invocation_status "
                                "FROM eliot.my_github_invocations(%s,%s)", (organization_id, task_id))
                    attempts = [{"invocation_id": str(r[0]), "status": r[1]} for r in cur.fetchall()]
    except psycopg.errors.InsufficientPrivilege:
        raise HTTPException(403, "Tool review not authorized") from None
    except (psycopg.Error, OSError, RuntimeError):
        raise HTTPException(503, "Tool review unavailable") from None
    return {"organization_id": str(organization_id), "task_id": str(task_id),
            **review_tool_state(lease, attempts)}


class LeaseReviewRequest(LeaseRequest):
    previous_lease_id: UUID
    reason: str = Field(min_length=10, max_length=1000)


@router.post("/{organization_id}/tasks/{task_id}/execution/lease/review", status_code=201)
def review_and_renew_lease(organization_id: UUID, task_id: UUID, body: LeaseReviewRequest,
                           authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=True)
    with _cursor(subject) as cur:
        cur.execute("SELECT eliot.owner_review_and_renew_lease(%s,%s,%s,%s,%s,%s)",
                    (organization_id, task_id, body.previous_lease_id, body.worker_id,
                     body.reason, body.request_key))
        row = cur.fetchone()
        if not row or not isinstance(row[0], UUID):
            raise HTTPException(503, "Lease review unconfirmed")
    # A replay may point to an older lease: do not invent current usability.
    return {"organization_id": str(organization_id), "task_id": str(task_id),
            "previous_lease_id": str(body.previous_lease_id), "lease_id": str(row[0]),
            "execution_started": False, "requires_fresh_tool_approval": True}


@router.get("/{organization_id}/tasks/{task_id}/execution/lease/reviews")
def lease_review_history(organization_id: UUID, task_id: UUID,
                          authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=False)
    with _cursor(subject) as cur:
        cur.execute("SELECT review_id,previous_lease_id,new_lease_id,reason,reviewed_at "
                    "FROM eliot.my_lease_reviews(%s,%s)", (organization_id, task_id))
        rows = cur.fetchall()
    return [{"review_id": str(r[0]), "previous_lease_id": str(r[1]),
             "new_lease_id": str(r[2]), "reason": r[3], "reviewed_at": r[4].isoformat()}
            for r in rows]

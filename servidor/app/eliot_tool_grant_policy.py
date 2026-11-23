"""Pure policy for the first scoped GitHub tool capability.

Advisory decision only: never makes HTTP calls, mints tokens, reads a secret,
or creates a GitHub write permission. Caller MUST still verify a current,
single-use owner grant from PostgreSQL, task lease and GitHub installation.
"""
import re
from typing import Any

_REPO=re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
_SHA=re.compile(r"^[0-9a-f]{40}$")
_DOC=re.compile(r"^docs/[A-Za-z0-9_./-]{1,395}\.(?:md|txt)$")
_FORBIDDEN=(".git/", "../", "/../", "//")
_CAPABILITY="github_document_read_v1"


def evaluate_github_read_grant(
    *,
    organization_id: str,
    task_id: str,
    worker_id: str,
    lease_id: str,
    grant: dict[str, Any],
    repository: str,
    path: str,
    sha: str,
) -> dict[str, Any]:
    reasons=[]
    for field,actual in (
        ("organization_id",organization_id),
        ("task_id",task_id),
        ("worker_id",worker_id),
        ("lease_id",lease_id),
    ):
        if not actual or grant.get(field)!=actual:
            reasons.append(field+"_mismatch")
    if grant.get("capability")!=_CAPABILITY:
        reasons.append("capability_not_allowed")
    if grant.get("state")!="approved":
        reasons.append("grant_not_approved")
    if grant.get("repository")!=repository or not _REPO.fullmatch(repository):
        reasons.append("repository_not_allowed")
    if grant.get("path")!=path or not _DOC.fullmatch(path) or any(x in path for x in _FORBIDDEN) or any(segment in ("", ".", "..") for segment in path.split("/")):
        reasons.append("path_not_allowed")
    if grant.get("sha")!=sha or not _SHA.fullmatch(sha):
        reasons.append("sha_not_allowed")
    if grant.get("read_only") is not True:
        reasons.append("write_permission_forbidden")
    if grant.get("single_use") is not True:
        reasons.append("single_use_required")
    return {
        "allowed_by_local_policy":not reasons,
        "capability":_CAPABILITY,
        "scope":"single_document_exact_sha",
        "reasons":reasons,
        "performs_request":False,
        "permits_github_write":False,
        "verified_durable_grant":False,
        "requires_db_grant_check":True,
    }

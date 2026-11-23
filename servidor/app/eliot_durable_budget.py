"""Optional fail-closed durable model budget (requires PG migration 019).

Enabled ONLY by ELIOT_DURABLE_MODEL_BUDGET_ENABLED=true AFTER migration.
Owner-only SECURITY DEFINER functions enforce tenant isolation under a
verified Auth0 subject. Reservation happens before any provider transfer.
It never stores prompts, secrets, document contents or provider tokens.
"""
import os
from uuid import UUID, uuid4

import psycopg

DEFAULT_RESERVATION_UNITS = 2500


def enabled() -> bool:
    return os.getenv("ELIOT_DURABLE_MODEL_BUDGET_ENABLED") == "true"


def _context(organization_id: str, subject: str | None):
    if not subject or not isinstance(subject, str) or len(subject) > 700:
        return None
    try:
        return UUID(organization_id)
    except (ValueError, TypeError, AttributeError):
        return None


def reserve(
    organization_id: str,
    subject: str | None,
    request_key: str | UUID | None = None,
    estimated_units: int = DEFAULT_RESERVATION_UNITS,
) -> tuple[bool, UUID | None]:
    """True only after a persisted atomic reservation; errors DENY.

    While disabled, return no durable reservation and do not access DB.
    Callers still use the existing process-local guard separately.
    """
    if not enabled():
        return True, None
    org = _context(organization_id, subject)
    if org is None or type(estimated_units) is not int or not 1 <= estimated_units <= 10000:
        return False, None
    try:
        key = UUID(str(request_key)) if request_key is not None else uuid4()
    except (ValueError, TypeError, AttributeError):
        return False, None
    from app.organizations_api import db_params
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    cur.execute(
                        "SELECT eliot.owner_reserve_model_budget(%s,%s,%s)",
                        (org,key,estimated_units),
                    )
                    row=cur.fetchone()
        return (bool(row and row[0] is True),key if row and row[0] is True else None)
    except (psycopg.Error,RuntimeError,OSError):
        return False,None


def reconcile(
    organization_id: str,
    subject: str | None,
    key: UUID | None,
    response: dict,
) -> bool:
    """Best-effort usage reconciliation; never refunds reserved capacity."""
    if not enabled() or key is None:
        return False
    org = _context(organization_id, subject)
    if org is None or not isinstance(response,dict):
        return False
    usage=response.get("usage")
    if not isinstance(usage,dict):
        return False
    inp=usage.get("input_tokens")
    out=usage.get("output_tokens")
    if any(type(x) is not int or not 0 <= x <= 1000000 for x in (inp,out)):
        return False
    from app.organizations_api import db_params
    try:
        with psycopg.connect(**db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
                    cur.execute(
                        "SELECT eliot.owner_reconcile_model_budget(%s,%s,%s,%s)",
                        (org,key,inp,out),
                    )
                    row=cur.fetchone()
        return bool(row and row[0] is True)
    except (psycopg.Error,RuntimeError,OSError):
        return False

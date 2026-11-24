"""Authorized company-database sources for Freddy objective planning.

Uses the same owner-visible connectors as Hosting (my_company_connectors),
with load_store_connector only as a fallback. Virtual ops documents; sha is
a fingerprint of org+path, not a Git blob.
"""
from __future__ import annotations

import hashlib
import re
from uuid import UUID

from app.eliot_connectors import DB_KINDS

REPO_PREFIX = "company-db/"
REF = "live"
# Must stay under docs/ — owner_create_document_plan and the table CHECK only allow docs/%.
PREFIX = "docs/ops/"
SLUG = re.compile(r"^[a-z0-9-]{2,40}$")
# Planning only needs the connector to exist; a failed probe must not block Freddy.
OK_STATUS = frozenset({"configured", "failed"})

STORE_DOCUMENTS: tuple[tuple[str, str], ...] = (
    ("docs/ops/pedidos.md", "Pedidos y verificación de pedidos"),
    ("docs/ops/problemas.md", "Problemas e incidencias de la tienda"),
    ("docs/ops/chats.md", "Chats y atención pendiente"),
    ("docs/ops/reporte-diario.md", "Reporte diario de la tienda"),
    ("docs/ops/mejora-continua.md", "Mejora continua del sistema"),
)


def _slug(label: str | None) -> str:
    raw = re.sub(r"[^a-z0-9-]", "-", (label or "tienda").lower())[:40].strip("-")
    return raw if SLUG.fullmatch(raw) else "tienda"


def document_sha(organization_id: str | UUID, path: str) -> str:
    return hashlib.sha1(f"{organization_id}|{path}|{REF}".encode()).hexdigest()


def _from_meta(meta: dict) -> dict:
    label_raw = meta.get("label") if isinstance(meta.get("label"), str) else None
    slug = _slug(label_raw)
    label = label_raw.strip()[:80] if label_raw and label_raw.strip() else slug
    return {
        "kind": "database",
        "repository": f"{REPO_PREFIX}{slug}",
        "ref": REF,
        "prefix": PREFIX,
        "label": label,
        "connector_kind": meta.get("kind"),
    }


def source_from_connector_rows(rows: list | None) -> dict | None:
    """Pick the best DB connector the owner can already see in Hosting."""
    if not rows:
        return None
    candidates: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        kind = row.get("kind")
        status = row.get("status")
        db_name = row.get("database_name")
        if kind not in DB_KINDS or status not in OK_STATUS:
            continue
        if not isinstance(db_name, str) or not db_name.strip():
            continue
        candidates.append(row)
    if not candidates:
        return None
    candidates.sort(key=lambda r: (0 if r.get("status") == "configured" else 1, str(r.get("label") or "")))
    return _from_meta(candidates[0])


def company_db_source(organization_id: UUID, connector_rows: list | None = None) -> dict | None:
    if connector_rows is not None:
        found = source_from_connector_rows(connector_rows)
        if found:
            return found
    try:
        from app.eliot_store_feed import load_store_connector
        meta = load_store_connector(organization_id)
    except Exception:
        meta = None
    return _from_meta(meta) if meta else None


def list_owner_connectors(cur, organization_id: UUID) -> list:
    cur.execute("SELECT to_regprocedure(%s)", ("eliot.my_company_connectors(uuid)",))
    row = cur.fetchone()
    if not row or not row[0]:
        return []
    try:
        cur.execute("SELECT * FROM eliot.my_company_connectors(%s)", (organization_id,))
        return [r[0] for r in cur.fetchall() if r and isinstance(r[0], dict)]
    except Exception:
        return []


def list_documents(organization_id: UUID, repository: str, connector_rows: list | None = None) -> list[dict[str, str]]:
    source = company_db_source(organization_id, connector_rows)
    if not source or source["repository"] != repository:
        return []
    org = str(organization_id)
    return [{"path": path, "sha": document_sha(org, path), "title": title}
            for path, title in STORE_DOCUMENTS]


def canonical_store_path(path: str) -> str:
    """Map legacy ops/*.md payloads to docs/ops/*.md required by SQL CHECKs."""
    if path.startswith("docs/ops/"):
        return path
    if path.startswith("ops/"):
        return "docs/" + path
    return path


def matches_step(organization_id: UUID, repository: str, ref: str, path: str, sha: str,
                 connector_rows: list | None = None) -> bool:
    source = company_db_source(organization_id, connector_rows)
    if not source or source["repository"] != repository or ref != REF:
        return False
    canonical = canonical_store_path(path)
    if not canonical.startswith(PREFIX) or not canonical.casefold().endswith((".md", ".txt", ".rst")):
        return False
    allowed = {p for p, _ in STORE_DOCUMENTS}
    if canonical not in allowed:
        return False
    org = str(organization_id)
    # Accept sha of either the canonical docs/ops path or the legacy ops/ path.
    return sha in {document_sha(org, canonical), document_sha(org, path), document_sha(org, canonical[len("docs/"):])}

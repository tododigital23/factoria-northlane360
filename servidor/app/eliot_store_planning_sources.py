"""Authorized company-database sources for Freddy objective planning.

Exposes the already-configured store connector as a planning source with
stable virtual ops documents. No DB rows are copied into the plan payload;
sha is a deterministic fingerprint of org+path, not a Git blob.
"""
from __future__ import annotations

import hashlib
import re
from uuid import UUID

from app.eliot_store_feed import load_store_connector

REPO_PREFIX = "company-db/"
REF = "live"
PREFIX = "ops/"
SLUG = re.compile(r"^[a-z0-9-]{2,40}$")

# Virtual ops documents for store-management objectives (not GitHub files).
STORE_DOCUMENTS: tuple[tuple[str, str], ...] = (
    ("ops/pedidos.md", "Pedidos y verificación de pedidos"),
    ("ops/problemas.md", "Problemas e incidencias de la tienda"),
    ("ops/chats.md", "Chats y atención pendiente"),
    ("ops/reporte-diario.md", "Reporte diario de la tienda"),
    ("ops/mejora-continua.md", "Mejora continua del sistema"),
)


def _slug(label: str | None) -> str:
    raw = re.sub(r"[^a-z0-9-]", "-", (label or "tienda").lower())[:40].strip("-")
    return raw if SLUG.fullmatch(raw) else "tienda"


def document_sha(organization_id: str | UUID, path: str) -> str:
    return hashlib.sha1(f"{organization_id}|{path}|{REF}".encode()).hexdigest()


def company_db_source(organization_id: UUID) -> dict | None:
    meta = load_store_connector(organization_id)
    if not meta:
        return None
    slug = _slug(meta.get("label") if isinstance(meta.get("label"), str) else None)
    label = meta.get("label") if isinstance(meta.get("label"), str) and meta["label"].strip() else slug
    return {
        "kind": "database",
        "repository": f"{REPO_PREFIX}{slug}",
        "ref": REF,
        "prefix": PREFIX,
        "label": label.strip()[:80],
        "connector_kind": meta.get("kind"),
    }


def list_documents(organization_id: UUID, repository: str) -> list[dict[str, str]]:
    source = company_db_source(organization_id)
    if not source or source["repository"] != repository:
        return []
    org = str(organization_id)
    return [{"path": path, "sha": document_sha(org, path), "title": title}
            for path, title in STORE_DOCUMENTS]


def matches_step(organization_id: UUID, repository: str, ref: str, path: str, sha: str) -> bool:
    source = company_db_source(organization_id)
    if not source or source["repository"] != repository or ref != REF:
        return False
    if not path.startswith(PREFIX) or not path.casefold().endswith(".md"):
        return False
    allowed = {p for p, _ in STORE_DOCUMENTS}
    if path not in allowed:
        return False
    return sha == document_sha(str(organization_id), path)

"""Conectores FTP/FTPS y bases remotas por empresa + gestores autónomos.

Las contraseñas se cifran en la API (nl360:v1:) antes de guardarlas. Nunca salen en las respuestas.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import Field

from app import eliot_readonly
from app import organizations_api as identity
from app.eliot_connectors import (
    DEFAULT_PORTS,
    LOCAL_DB_HOSTS,
    discover_wp_database_bounded,
    remote_db_host,
    test_connector,
)
from app.eliot_storage_crypto import StorageCryptoError, configured as crypto_ready, seal, unseal
from app.eliot_tool_control_api import StrictRequest, _cursor

router = APIRouter(prefix="/v1/me/organizations", tags=["company-connectors"])
FUNCTIONS = (
    "eliot.my_company_connectors(uuid)",
    "eliot.owner_save_company_connector(uuid,text,text,text,integer,text,text,text,text)",
    "eliot.owner_connector_secret(uuid,uuid)",
    "eliot.owner_set_connector_test(uuid,uuid,boolean,text)",
    "eliot.owner_remove_company_connector(uuid,uuid)",
    "eliot.owner_create_manager_invite(uuid,text,text,integer)",
    "eliot.redeem_manager_invite(text)",
    "eliot.owner_company_managers(uuid)",
    "eliot.owner_revoke_manager(uuid,uuid)",
    "eliot.my_managed_organizations()",
)
Kind = Literal["ftp", "ftps", "mysql", "mariadb", "postgresql", "mssql", "mongodb"]
HOURS = 72
HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$")


def _ready(cur):
    for signature in FUNCTIONS:
        cur.execute("SELECT to_regprocedure(%s)", (signature,))
        row = cur.fetchone()
        if not row or not row[0]:
            raise HTTPException(503, "Company connectors unavailable")


def _owner_write():
    if eliot_readonly.is_viewer():
        raise HTTPException(403, "Acceso de solo consulta")


def _fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _seal_password(organization_id: str, password: str) -> str:
    if not crypto_ready():
        raise HTTPException(503, "Falta ELIOT_STORAGE_MASTER_KEY para guardar secretos de conectores")
    try:
        return seal(json.dumps({"password": password}, separators=(",", ":")).encode(), "company-connector", organization_id)
    except StorageCryptoError:
        raise HTTPException(503, "No se pudo cifrar el secreto del conector") from None


def _open_password(organization_id: str, cipher: str) -> str:
    try:
        raw = unseal(cipher, "company-connector", organization_id)
        data = json.loads(raw.decode())
        password = data.get("password")
        if not isinstance(password, str) or not password:
            raise StorageCryptoError("empty password")
        return password
    except (StorageCryptoError, json.JSONDecodeError, UnicodeDecodeError, TypeError, AttributeError):
        raise HTTPException(503, "No se pudo abrir el secreto del conector") from None


def _public_connector(row: dict) -> dict:
    return {
        "id": str(row["id"]),
        "organization_id": str(row["organization_id"]),
        "kind": row["kind"],
        "label": row["label"],
        "host": row["host"],
        "port": int(row["port"]),
        "username": row["username"],
        "remote_path": row.get("remote_path"),
        "database_name": row.get("database_name"),
        "status": row["status"],
        "last_tested_at": row.get("last_tested_at"),
        "last_error": row.get("last_error"),
        "updated_at": row.get("updated_at"),
        "has_secret": True,
    }


class ConnectorBody(StrictRequest):
    kind: Kind
    label: str = Field(min_length=2, max_length=80, pattern=r"^[^\x00-\x1f\x7f]+$")
    host: str = Field(min_length=1, max_length=253)
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=400)
    remote_path: str | None = Field(default=None, max_length=400)
    database_name: str | None = Field(default=None, max_length=120)


class ManagerInvite(StrictRequest):
    label: str = Field(min_length=1, max_length=80, pattern=r"^[^\x00-\x1f\x7f]+$")


class ManagerRedeem(StrictRequest):
    token: str = Field(min_length=30, max_length=80)


@router.get("/{organization_id}/connectors")
def list_connectors(organization_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT * FROM eliot.my_company_connectors(%s)", (organization_id,))
        rows = [r[0] for r in cur.fetchall()]
    out = []
    for row in rows:
        if isinstance(row, dict) and str(row.get("organization_id")) == str(organization_id):
            out.append(_public_connector(row))
    return {"organization_id": str(organization_id), "connectors": out, "crypto_ready": crypto_ready()}


def _ftp_host_from_rows(rows: list) -> str | None:
    for row in rows:
        if isinstance(row, dict) and row.get("kind") in ("ftp", "ftps"):
            host = row.get("host")
            if isinstance(host, str) and host.strip() and HOST_RE.fullmatch(host.strip()):
                return host.strip()
    return None


def _is_local_host(host: str) -> bool:
    raw = host.strip()
    return raw.lower() in LOCAL_DB_HOSTS or raw.split(":")[0].strip().lower() in {"localhost", "127.0.0.1", "::1"}


@router.post("/{organization_id}/connectors", status_code=201)
def save_connector(organization_id: UUID, body: ConnectorBody, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    _owner_write()
    host = body.host.strip()
    if not HOST_RE.fullmatch(host):
        raise HTTPException(422, "Host inválido")
    label = body.label.strip()
    username = body.username.strip()
    port = body.port or DEFAULT_PORTS[body.kind]
    remote_path = body.remote_path.strip() if body.remote_path else None
    database_name = body.database_name.strip() if body.database_name else None
    host_adjusted = False
    if body.kind in ("ftp", "ftps"):
        database_name = None
    else:
        remote_path = None
        if not database_name:
            raise HTTPException(422, "Indica el nombre de la base de datos")
    cipher = _seal_password(str(organization_id), body.password)
    with _cursor(subject) as cur:
        _ready(cur)
        if body.kind not in ("ftp", "ftps") and _is_local_host(host):
            cur.execute("SELECT * FROM eliot.my_company_connectors(%s)", (organization_id,))
            ftp_host = _ftp_host_from_rows([r[0] for r in cur.fetchall()])
            if ftp_host:
                host, host_adjusted = remote_db_host(host, ftp_host)
        cur.execute(
            "SELECT eliot.owner_save_company_connector(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (organization_id, body.kind, label, host, port, username, remote_path, database_name, cipher),
        )
        row = cur.fetchone()
        r = row[0] if row else None
    if not isinstance(r, dict) or r.get("saved") is not True or str(r.get("organization_id")) != str(organization_id):
        raise HTTPException(503, "Connector save unconfirmed")
    return {
        "id": str(r["id"]),
        "organization_id": str(organization_id),
        "kind": r["kind"],
        "label": r["label"],
        "status": r["status"],
        "host": host,
        "host_adjusted_from_localhost": host_adjusted,
        "saved": True,
        "password_stored": True,
    }


@router.post("/{organization_id}/connectors/{connector_id}/use-ftp-host")
def use_ftp_host_for_database(organization_id: UUID, connector_id: UUID, authorization: str | None = Header(default=None)):
    """Sustituye localhost/127.0.0.1 del conector MySQL por el host del FTP de la misma empresa."""
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    _owner_write()
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT * FROM eliot.my_company_connectors(%s)", (organization_id,))
        items = [r[0] for r in cur.fetchall() if isinstance(r[0], dict)]
        meta = next((c for c in items if str(c.get("id")) == str(connector_id)), None)
        if not meta:
            raise HTTPException(404, "Connector not found")
        if meta.get("kind") not in ("mysql", "mariadb", "postgresql", "mssql", "mongodb"):
            raise HTTPException(422, "Solo aplica a conectores de base de datos")
        ftp_host = _ftp_host_from_rows(items)
        if not ftp_host:
            raise HTTPException(409, "No hay FTP guardado para tomar el host remoto")
        if not _is_local_host(str(meta.get("host") or "")):
            return {
                "organization_id": str(organization_id),
                "connector_id": str(connector_id),
                "host": meta["host"],
                "changed": False,
                "message": "El host ya no es localhost",
            }
        cur.execute("SELECT eliot.owner_connector_secret(%s,%s)", (organization_id, connector_id))
        secret_row = cur.fetchone()
        cipher = secret_row[0] if secret_row else None
    if not isinstance(cipher, str):
        raise HTTPException(503, "Connector secret unavailable")
    password = _open_password(str(organization_id), cipher)
    new_host, _ = remote_db_host(str(meta["host"]), ftp_host)
    db_cipher = _seal_password(str(organization_id), password)
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute(
            "SELECT eliot.owner_save_company_connector(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (organization_id, meta["kind"], meta["label"], new_host, int(meta["port"]),
             meta["username"], None, meta.get("database_name"), db_cipher),
        )
        row = cur.fetchone()
        r = row[0] if row else None
    if not isinstance(r, dict) or r.get("saved") is not True:
        raise HTTPException(503, "Host update unconfirmed")
    return {
        "organization_id": str(organization_id),
        "connector_id": str(r.get("id") or connector_id),
        "host": new_host,
        "changed": True,
        "message": f"Host actualizado de localhost a {new_host}",
    }


@router.post("/{organization_id}/connectors/{connector_id}/discover-database", status_code=201)
def discover_database_from_ftp(organization_id: UUID, connector_id: UUID, authorization: str | None = Header(default=None)):
    """Lee wp-config.php por FTP y guarda el conector MySQL (WooCommerce/WordPress)."""
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    _owner_write()
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT * FROM eliot.my_company_connectors(%s)", (organization_id,))
        items = [r[0] for r in cur.fetchall() if isinstance(r[0], dict)]
        meta = next((c for c in items if str(c.get("id")) == str(connector_id)), None)
        if not meta:
            raise HTTPException(404, "Connector not found")
        if meta.get("kind") not in ("ftp", "ftps"):
            raise HTTPException(422, "Solo FTP/FTPS puede detectar la base")
        cur.execute("SELECT eliot.owner_connector_secret(%s,%s)", (organization_id, connector_id))
        secret_row = cur.fetchone()
        cipher = secret_row[0] if secret_row else None
    if not isinstance(cipher, str):
        raise HTTPException(503, "Connector secret unavailable")
    password = _open_password(str(organization_id), cipher)
    discovered = discover_wp_database_bounded(
        meta["kind"], meta["host"], int(meta["port"]), meta["username"], password,
        meta.get("remote_path"),
    )
    if isinstance(discovered, str):
        raise HTTPException(502, discovered)
    label_base = (meta.get("label") or "tienda").strip()[:60]
    label = f"WooCommerce {label_base}"[:80]
    db_cipher = _seal_password(str(organization_id), discovered["password"])
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute(
            "SELECT eliot.owner_save_company_connector(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (organization_id, "mysql", label, discovered["host"], discovered["port"],
             discovered["username"], None, discovered["database_name"], db_cipher),
        )
        row = cur.fetchone()
        r = row[0] if row else None
    if not isinstance(r, dict) or r.get("saved") is not True:
        raise HTTPException(503, "Database connector save unconfirmed")
    return {
        "organization_id": str(organization_id),
        "ftp_connector_id": str(connector_id),
        "id": str(r["id"]),
        "kind": "mysql",
        "label": label,
        "host": discovered["host"],
        "port": discovered["port"],
        "username": discovered["username"],
        "database_name": discovered["database_name"],
        "host_adjusted_from_localhost": discovered["host_adjusted_from_localhost"],
        "source": discovered["source"],
        "saved": True,
        "password_stored": True,
    }


@router.post("/{organization_id}/connectors/{connector_id}/test")
def test_saved_connector(organization_id: UUID, connector_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    _owner_write()
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT * FROM eliot.my_company_connectors(%s)", (organization_id,))
        items = [r[0] for r in cur.fetchall() if isinstance(r[0], dict)]
        meta = next((c for c in items if str(c.get("id")) == str(connector_id)), None)
        if not meta:
            raise HTTPException(404, "Connector not found")
        cur.execute("SELECT eliot.owner_connector_secret(%s,%s)", (organization_id, connector_id))
        secret_row = cur.fetchone()
        cipher = secret_row[0] if secret_row else None
    if not isinstance(cipher, str):
        raise HTTPException(503, "Connector secret unavailable")
    password = _open_password(str(organization_id), cipher)
    error = test_connector(
        meta["kind"], meta["host"], int(meta["port"]), meta["username"], password,
        meta.get("remote_path"), meta.get("database_name"),
    )
    ok = error is None
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT eliot.owner_set_connector_test(%s,%s,%s,%s)", (organization_id, connector_id, ok, error))
        ack = cur.fetchone()
        result = ack[0] if ack else None
    if not isinstance(result, dict) or result.get("tested") is not True:
        raise HTTPException(503, "Connector test unconfirmed")
    return {"organization_id": str(organization_id), "connector_id": str(connector_id), "ok": ok, "error": error}


@router.post("/{organization_id}/connectors/{connector_id}/remove")
def remove_connector(organization_id: UUID, connector_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    _owner_write()
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT eliot.owner_remove_company_connector(%s,%s)", (organization_id, connector_id))
        row = cur.fetchone()
        r = row[0] if row else None
    if not isinstance(r, dict) or r.get("removed") is not True:
        raise HTTPException(503, "Connector removal unconfirmed")
    return {"organization_id": str(organization_id), "connector_id": str(connector_id), "removed": True}


@router.get("/{organization_id}/managers")
def list_managers(organization_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    _owner_write()
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT eliot.owner_company_managers(%s)", (organization_id,))
        row = cur.fetchone()
        data = row[0] if row else None
    if not isinstance(data, dict) or str(data.get("organization_id")) != str(organization_id):
        raise HTTPException(503, "Manager list unconfirmed")
    return {
        "organization_id": str(organization_id),
        "invite_hours": HOURS,
        "managers": data.get("managers") or [],
        "invites": data.get("invites") or [],
    }


@router.post("/{organization_id}/managers/invites", status_code=201)
def create_manager_invite(organization_id: UUID, body: ManagerInvite, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    _owner_write()
    token = secrets.token_urlsafe(32)
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute(
            "SELECT eliot.owner_create_manager_invite(%s,%s,%s,%s)",
            (organization_id, body.label.strip(), _fingerprint(token), HOURS),
        )
        row = cur.fetchone()
        r = row[0] if row else None
    if not isinstance(r, dict) or r.get("created") is not True:
        raise HTTPException(503, "Manager invite unconfirmed")
    return {
        "organization_id": str(organization_id),
        "invite_id": str(r["invite_id"]),
        "label": r["label"],
        "expires_at": r["expires_at"],
        "token": token,
    }


@router.post("/{organization_id}/managers/{item_id}/revoke")
def revoke_manager(organization_id: UUID, item_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    _owner_write()
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT eliot.owner_revoke_manager(%s,%s)", (organization_id, item_id))
        row = cur.fetchone()
        r = row[0] if row else None
    if not isinstance(r, dict) or r.get("revoked") is not True:
        raise HTTPException(503, "Manager revocation unconfirmed")
    return {"organization_id": str(organization_id), "id": str(item_id), "kind": r.get("kind"), "revoked": True}


managers_router = APIRouter(prefix="/v1/me", tags=["company-managers"])


@managers_router.post("/managers/redeem")
def redeem_manager(body: ManagerRedeem, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT eliot.redeem_manager_invite(%s)", (_fingerprint(body.token),))
        row = cur.fetchone()
        r = row[0] if row else None
    if not isinstance(r, dict) or r.get("joined") is not True:
        raise HTTPException(503, "Manager redeem unconfirmed")
    return {"organization_id": str(r["organization_id"]), "company": r.get("company"), "joined": True}


@managers_router.get("/managed-organizations")
def managed_organizations(authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization, require_tasks_scope=False)
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute("SELECT * FROM eliot.my_managed_organizations()")
        rows = [r[0] for r in cur.fetchall() if isinstance(r[0], dict)]
    return {"organizations": rows}

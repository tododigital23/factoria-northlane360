"""Contrato HTTP de conectores FTP/BD y gestores. Sin red real."""
from contextlib import contextmanager
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import eliot_connectors_api as api

ORG = uuid4()
CID = uuid4()
app = FastAPI()
app.include_router(api.router)
app.include_router(api.managers_router)
client = TestClient(app)
cur = MagicMock()


@contextmanager
def cursor(_):
    yield cur


def ready():
    return [("fn",)] * len(api.FUNCTIONS)


def test_list_requires_auth():
    assert client.get(f"/v1/me/organizations/{ORG}/connectors").status_code == 401


def test_save_rejects_bad_host_before_storage():
    with patch.object(api.identity, "verified_identity", return_value="iss|sub"), \
         patch.object(api, "_cursor") as db:
        r = client.post(
            f"/v1/me/organizations/{ORG}/connectors",
            json={"kind": "ftp", "label": "Hosting", "host": "bad/host", "username": "u", "password": "p"},
        )
    assert r.status_code == 422
    db.assert_not_called()


def test_save_seals_password_and_never_returns_it():
    cur.reset_mock()
    cur.fetchone.side_effect = ready() + [({"id": str(CID), "organization_id": str(ORG), "kind": "ftp",
                                            "label": "Hosting", "status": "configured", "saved": True},)]
    with patch.object(api.identity, "verified_identity", return_value="iss|sub"), \
         patch.object(api, "crypto_ready", return_value=True), \
         patch.object(api, "seal", return_value="nl360:v1:" + "a" * 40) as seal, \
         patch.object(api, "_cursor", cursor):
        r = client.post(
            f"/v1/me/organizations/{ORG}/connectors",
            json={"kind": "ftp", "label": "Hosting", "host": "ftp.example.com", "port": 21,
                  "username": "user", "password": "secret-password", "remote_path": "/public_html"},
        )
    assert r.status_code == 201, r.text
    assert "secret-password" not in r.text
    assert r.json()["password_stored"] is True
    seal.assert_called_once()
    args = cur.execute.call_args.args[1]
    assert args[0] == ORG and args[1] == "ftp" and args[8].startswith("nl360:v1:")


def test_test_connector_records_result():
    meta = {"id": str(CID), "organization_id": str(ORG), "kind": "mysql", "label": "Tienda",
            "host": "db.example.com", "port": 3306, "username": "shop", "remote_path": None,
            "database_name": "shop", "status": "configured"}
    cur.reset_mock()
    cur.fetchall.return_value = [(meta,)]
    cur.fetchone.side_effect = ready() + [("nl360:v1:cipher",)] + ready() + [
        ({"organization_id": str(ORG), "connector_id": str(CID), "ok": True, "tested": True},)
    ]
    with patch.object(api.identity, "verified_identity", return_value="iss|sub"), \
         patch.object(api, "_open_password", return_value="pwd"), \
         patch.object(api, "test_connector", return_value=None), \
         patch.object(api, "_cursor", cursor):
        r = client.post(f"/v1/me/organizations/{ORG}/connectors/{CID}/test")
    assert r.status_code == 200 and r.json()["ok"] is True and r.json()["error"] is None


def test_manager_invite_returns_token_once():
    cur.reset_mock()
    cur.fetchone.side_effect = ready() + [({"invite_id": str(uuid4()), "organization_id": str(ORG),
                                            "label": "Ana", "expires_at": "2026-12-01T00:00:00Z", "created": True},)]
    with patch.object(api.identity, "verified_identity", return_value="iss|owner"), \
         patch.object(api, "_cursor", cursor):
        r = client.post(f"/v1/me/organizations/{ORG}/managers/invites", json={"label": "Ana"})
    assert r.status_code == 201 and isinstance(r.json().get("token"), str) and len(r.json()["token"]) >= 30


def test_viewer_cannot_save_connector():
    with patch.object(api.identity, "verified_identity", return_value="iss|viewer"), \
         patch.object(api.eliot_readonly, "is_viewer", return_value=True), \
         patch.object(api, "_cursor") as db:
        r = client.post(
            f"/v1/me/organizations/{ORG}/connectors",
            json={"kind": "ftp", "label": "Hosting", "host": "ftp.example.com", "username": "u", "password": "p"},
        )
    assert r.status_code == 403
    db.assert_not_called()

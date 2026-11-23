"""No-OpenAI, read-only preflight for an exact GitHub document attached to one task."""
from unittest.mock import MagicMock,patch
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.organizations_api import router

ORG = "11111111-2222-4333-8444-555555555555"
OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TASK = "c0457b76-1858-4058-9ee8-3b467cc3f9d7"
WORKER = "de97dcad-6b37-4a2c-bbcd-a83672598cf8"
REPO = "tu-organizacion/factoria-northlane360"
SHA = "a"*40
PATH = "docs/ELIOT_GITHUB_APP_READONLY.md"
URL = f"/v1/me/organizations/{ORG}/tasks/{TASK}/document-evidence/preflight"
AUTH = {"Authorization":"Bearer stub"}
BODY = {"repository":REPO, "path":PATH, "expected_sha":SHA, "worker_id":WORKER}

app=FastAPI()
app.include_router(router)
client=TestClient(app)


def connection(*,role="owner",pending=True,assigned=True,idle=True,task_exists=True):
    conn=MagicMock()
    cur=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    rows=[
       [(UUID(ORG),role)],
       [(UUID(TASK),UUID(WORKER) if assigned else None,"pending" if pending else "blocked")] if task_exists else [],
       [(UUID(WORKER),"idle" if idle else "inactive")]
    ]
    cur.fetchall.side_effect=rows
    return conn


def source(sha=SHA):
    return {
      "repository":REPO,"path":PATH,"ref":"feature/auth0-organizations-endpoint",
      "sha":sha,"content":"# ELIOT\nAutorizaciones\n","source_type":"github",
      "read_only":True,"sent_to_model":False
    }


def mocks(conn):
    return (
      patch("app.organizations_api.verified_identity",return_value="issuer|owner"),
      patch("app.organizations_api.db_params",return_value={"host":"db"}),
      patch("app.organizations_api.psycopg.connect",return_value=conn),
    )


def test_valid_owner_preflight_rechecks_task_worker_and_revision_without_ai():
    conn=connection()
    from app.eliot_github_reader import read_document
    with mocks(conn)[0],mocks(conn)[1],mocks(conn)[2], \
         patch("app.eliot_github_reader.read_document",return_value=source()) as read:
        response=client.post(URL,json=BODY,headers=AUTH)
    assert response.status_code==200, response.text
    result=response.json()
    assert result["sha"]==SHA and result["source_verified"] is True
    assert result["sent_to_model"] is False and result["model_calls"]==0
    assert result["approval_created"] is False and result["saved_as_evidence"] is False
    assert "content" not in result
    assert result["size_bytes"]==len(source()["content"].encode())
    read.assert_called_once_with(ORG,REPO,PATH)
    assert len([x for x in conn.__enter__.return_value.cursor.return_value.__enter__.return_value.execute.call_args_list if "INSERT" in str(x)])==0


def test_sha_change_prevents_preflight_and_does_not_return_new_document():
    conn=connection()
    with mocks(conn)[0],mocks(conn)[1],mocks(conn)[2], \
         patch("app.eliot_github_reader.read_document",return_value=source("b"*40)):
        resp=client.post(URL,json=BODY,headers=AUTH)
    assert resp.status_code==409
    assert "content" not in resp.text


def test_owner_or_task_worker_mismatch_never_contacts_github():
    for config,expected in [
       ({"role":"member"},403),
       ({"task_exists":False},404),
       ({"pending":False},409),
       ({"assigned":False},409),
       ({"idle":False},409),
    ]:
        conn=connection(**config)
        with mocks(conn)[0],mocks(conn)[1],mocks(conn)[2], \
             patch("app.eliot_github_reader.read_document") as read:
            result=client.post(URL,json=BODY,headers=AUTH)
        assert result.status_code==expected,(config,result.text)
        read.assert_not_called()


def test_invalid_sha_rejected_before_any_authorization_or_network():
    conn=connection()
    data={**BODY,"expected_sha":"wrong-sha"}
    with patch("app.organizations_api.psycopg.connect") as db, \
         patch("app.eliot_github_reader.read_document") as read:
        response=client.post(URL,json=data,headers=AUTH)
    assert response.status_code==422
    db.assert_not_called()
    read.assert_not_called()


def test_unverified_owner_denied_before_database_or_github():
    with patch("app.organizations_api.psycopg.connect") as db, \
         patch("app.eliot_github_reader.read_document") as read:
        response=client.post(URL,json=BODY)
    assert response.status_code==401
    db.assert_not_called()
    read.assert_not_called()


def test_cross_company_task_does_not_become_accessible():
    conn=connection(task_exists=False)
    with mocks(conn)[0],mocks(conn)[1],mocks(conn)[2], \
         patch("app.eliot_github_reader.read_document") as read:
        result=client.post(URL,json=BODY,headers=AUTH)
    assert result.status_code==404
    read.assert_not_called()

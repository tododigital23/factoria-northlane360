from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from uuid import uuid4

import psycopg
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import eliot_tool_control_api as api

ORG,TASK,WORKER,LEASE,GRANT,KEY = [uuid4() for _ in range(6)]
BASE=f"/v1/me/organizations/{ORG}/tasks/{TASK}/execution"
REPO="tu-organizacion/factoria-northlane360"
SOURCE={"owner":"tu-organizacion","repo":"factoria-northlane360","prefix":"docs/"}
BODY={"worker_id":str(WORKER),"lease_id":str(LEASE),"request_key":str(KEY),
      "repository":REPO,"path":"docs/ARCHITECTURE.md","expected_sha":"a"*40}
app=FastAPI(); app.include_router(api.router); client=TestClient(app)

@contextmanager
def environment():
    with ExitStack() as stack:
        scope=stack.enter_context(patch.object(api.identity,"_require_approval_scope",return_value="issuer|owner"))
        stack.enter_context(patch.object(api.identity,"verified_identity",return_value="issuer|owner"))
        owner=stack.enter_context(patch.object(api.identity,"_require_company_owner"))
        stack.enter_context(patch.object(api.identity,"db_params",return_value={}))
        connect=stack.enter_context(patch.object(api.identity.psycopg,"connect"))
        conn=connect.return_value.__enter__.return_value
        cur=conn.cursor.return_value.__enter__.return_value
        stack.enter_context(patch.object(api,"sources_for",return_value=[SOURCE]))
        network=stack.enter_context(patch("app.eliot_github_reader._request_json"))
        yield cur,connect,conn,owner,scope
        network.assert_not_called()

@pytest.mark.parametrize("method,suffix,body",[
    ("get","/lease",None),("get","/github-read-grants",None),
    ("post","/lease",{"worker_id":str(WORKER),"request_key":str(KEY)}),
    ("post","/lease/release",{"lease_id":str(LEASE)}),("post","/github-read-grants",BODY)])
def test_anonymous_cannot_touch_storage(method,suffix,body):
    with patch.object(api.identity.psycopg,"connect") as connect:
        res=client.request(method,BASE+suffix,**({"json":body} if body else {}))
    assert res.status_code==401
    connect.assert_not_called()

@pytest.mark.parametrize("denied",["owner","scope"])
def test_auth_precedes_storage_and_source_lookup(denied):
    with environment() as (_,connect,_,owner,scope):
        (owner if denied=="owner" else scope).side_effect=HTTPException(403,"denied")
        with patch.object(api,"sources_for") as source:
            res=client.post(BASE+"/github-read-grants",json=BODY)
        source.assert_not_called(); connect.assert_not_called()
    assert res.status_code==403

def test_acquire_binds_verified_subject_and_all_ids():
    now=datetime.now(timezone.utc)
    with environment() as (cur,_,conn,_,_):
        cur.fetchone.side_effect=[(LEASE,),(LEASE,WORKER,"held",now,now+timedelta(minutes=10))]
        res=client.post(BASE+"/lease",json={"worker_id":str(WORKER),"request_key":str(KEY)})
        assert cur.execute.call_args_list[0].args[1]==("issuer|owner",)
        assert cur.execute.call_args_list[1].args[1]==(ORG,TASK,WORKER,KEY)
        conn.transaction.return_value.__exit__.assert_called_once()
    assert res.status_code==201
    assert res.json()["lease"]["usable"] and res.json()["execution_started"] is False

def test_approval_exact_binding_and_honest_replay_response():
    with environment() as (cur,_,_,_,_):
        cur.fetchone.return_value=(GRANT,)
        res=client.post(BASE+"/github-read-grants",json=BODY)
        assert cur.execute.call_args.args[1]==(ORG,TASK,WORKER,LEASE,REPO,BODY["path"],"a"*40,KEY)
    assert res.status_code==201
    assert res.json()["source_verified"] is False and res.json()["provider_called"] is False
    assert "state" not in res.json() and "expires_in_minutes" not in res.json()

@pytest.mark.parametrize("changes,status",[
    ({"repository":"Other/repo"},404),({"path":"docs/../secret.md"},422),
    ({"path":"docs/.git/config.md"},422),({"path":"docs//file.md"},422),
    ({"path":"docs/./file.md"},422),({"path":"docs/code.py"},422),
    ({"expected_sha":"B"*40},422),({"expected_sha":"invalid"},422),
    ({"organization_id":str(uuid4())},422),({"worker_id":"invalid"},422)])
def test_invalid_scope_never_reaches_storage(changes,status):
    with environment() as (_,connect,_,_,_):
        res=client.post(BASE+"/github-read-grants",json={**BODY,**changes})
        connect.assert_not_called()
    assert res.status_code==status

def test_missing_tenant_config_fails_closed():
    with environment() as (_,connect,_,_,_):
        with patch.object(api,"sources_for",return_value=[]):
            res=client.post(BASE+"/github-read-grants",json=BODY)
        connect.assert_not_called()
    assert res.status_code==404

@pytest.mark.parametrize("error,status",[
    (psycopg.errors.InvalidParameterValue("internal detail"),409),
    (psycopg.errors.LockNotAvailable("internal detail"),409),
    (psycopg.errors.ObjectNotInPrerequisiteState("internal detail"),409),
    (psycopg.errors.InsufficientPrivilege("internal detail"),403),
    (psycopg.OperationalError("secret password"),503)])
def test_errors_rollback_and_do_not_expose_details(error,status):
    with environment() as (cur,_,conn,_,_):
        cur.execute.side_effect=[None,error]
        res=client.post(BASE+"/github-read-grants",json=BODY)
        assert conn.transaction.return_value.__exit__.call_args.args[0] is type(error)
    assert res.status_code==status
    assert "internal detail" not in res.text and "secret" not in res.text

def test_listing_expiry_does_not_assert_live_lease():
    with environment() as (cur,_,_,_,_):
        cur.fetchall.return_value=[(GRANT,LEASE,REPO,BODY["path"],"a"*40,"approved",
                                   datetime.now(timezone.utc)-timedelta(seconds=1))]
        res=client.get(BASE+"/github-read-grants")
    assert res.status_code==200
    assert res.json()[0]["unexpired_approval"] is False
    assert res.json()[0]["requires_live_lease_check"] is True

def test_release_idempotent_and_unconfirmed_approval_fails_closed():
    with environment() as (cur,_,_,_,_):
        cur.fetchone.return_value=(False,)
        res=client.post(BASE+"/lease/release",json={"lease_id":str(LEASE)})
    assert res.status_code==200 and res.json()["changed"] is False
    with environment() as (cur,_,_,_,_):
        cur.fetchone.return_value=None
        res=client.post(BASE+"/github-read-grants",json=BODY)
    assert res.status_code==503

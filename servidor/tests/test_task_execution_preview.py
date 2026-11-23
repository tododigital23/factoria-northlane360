from unittest.mock import MagicMock, patch
from uuid import UUID
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router

app=FastAPI()
app.include_router(router)
client=TestClient(app)
ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TASK="55555555-5555-4555-8555-555555555555"
DEPT="33333333-3333-4333-8333-333333333333"
WORKER="44444444-4444-4444-8444-444444444444"
URL=f"/v1/me/organizations/{ORG}/tasks/{TASK}/execution/preview"

def data_connection(*,member="owner",state="inactive",taskstatus="pending",assigned=True):
    conn=MagicMock()
    cursor=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    cursor.fetchall.side_effect=[
      [(UUID(ORG),"Nova Demo",member)],
      [(UUID(TASK),UUID(DEPT),UUID(WORKER) if assigned else None,"Review docs",taskstatus,None)],
      [(UUID(WORKER),UUID(DEPT),"Programador IA","Software",state)],
      [(UUID(DEPT),"Desarrollo")],
    ]
    return conn,cursor

def test_requires_auth0():
    assert client.get(URL).status_code==401

def test_invalid_ids_are_422():
    assert client.get("/v1/me/organizations/not-uuid/tasks/not-uuid/execution/preview").status_code==422

def test_unauthorized_company_returns_404_without_tenant_queries():
    connection,cursor=data_connection()
    with patch("app.organizations_api.verified_identity",return_value="issuer|member"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=connection):
        r=client.get(f"/v1/me/organizations/{OTHER}/tasks/{TASK}/execution/preview",headers={"Authorization":"Bearer fake"})
    assert r.status_code==404
    assert cursor.execute.call_count==2

def test_inactive_worker_cannot_execute_and_no_write_queries():
    conn,cursor=data_connection()
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        r=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    result=r.json()
    assert result["worker_name"]=="Programador IA"
    assert result["department_name"]=="Desarrollo"
    assert result["checks"]["worker_belongs_to_task_department"]
    assert not result["checks"]["worker_activated"]
    assert result["eligible_for_execution"] is False
    assert result["execution_available"] is False
    assert result["read_only"] is True
    assert any("motor auditado" in reason.lower() for reason in result["reasons"])
    assert cursor.execute.call_count==5
    assert all(call.args[0].lower().startswith("select ") for call in cursor.execute.call_args_list)

def test_unassigned_worker_is_not_reported_as_working():
    conn,cursor=data_connection(assigned=False)
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        r=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    assert r.json()["worker_name"] is None
    assert not r.json()["checks"]["worker_assigned"]

def test_non_pending_task_fails_readiness():
    conn,cursor=data_connection(taskstatus="blocked")
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        r=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    assert not r.json()["checks"]["task_pending"]

def test_readiness_does_not_enable_runner_even_if_worker_active():
    conn,cursor=data_connection(state="working")
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        r=client.get(URL,headers={"Authorization":"Bearer fake"})
    assert r.status_code==200
    assert r.json()["checks"]["worker_activated"]
    assert not r.json()["execution_available"]

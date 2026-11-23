from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.eliot_work_overview import MAX_TASKS, summarize
from app.organizations_api import router

ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TASK="77777777-7777-4777-8777-777777777777"
TITLE_RUN="88888888-8888-4888-8888-888888888888"
DOC_RUN="99999999-9999-4999-8999-999999999999"
NOW=datetime(2026,10,29,20,0,tzinfo=timezone.utc)
URL=f"/v1/me/organizations/{ORG}/execution/work-overview"
AUTH={"Authorization":"Bearer fake"}
app=FastAPI()
app.include_router(router)
client=TestClient(app)


def task(task_id=TASK):
    return (UUID(task_id),UUID("33333333-3333-4333-8333-333333333333"),
            None,"Revisar documentación","pending",NOW-timedelta(days=1))


def title_run():
    return (UUID(TITLE_RUN),"completed","TOP SECRET DOCUMENT BODY",None,
            NOW-timedelta(minutes=10),NOW-timedelta(minutes=9))


def doc_run(state="failed",started=None):
    return (UUID(DOC_RUN),state,"SECRET DOCUMENT CONTENT" if state=="completed" else None,
            "source_changed" if state=="failed" else None,
            "tu-organizacion/factoria-northlane360",
            "docs/ORGANIZATIONS_ENDPOINT.md","feature/auth0-organizations-endpoint",
            "a"*40,started or NOW-timedelta(minutes=20),
            NOW-timedelta(minutes=19) if state!="running" else None)


def setup_db(organization=ORG,role="owner",tasks=None,history=None):
    t=tasks if tasks is not None else [task()]
    h=history if history is not None else [[title_run()],[doc_run()]]
    conn=MagicMock()
    cur=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchall.side_effect=[[(UUID(organization),role)],t,*h]
    return conn,cur


def test_summary_counts_and_provenance_without_report_contents():
    result=summarize(ORG,[task()],{TASK:[title_run()]},{TASK:[doc_run()]},now=NOW)
    assert result["read_only"] is True
    assert result["contains_report_text"] is False
    assert result["counts"]["title_draft"]["completed"]==1
    assert result["counts"]["document_analysis"]["failed"]==1
    assert result["attention_count_in_sample"]==1
    assert any(e["kind"]=="document_analysis" for e in result["events"])
    assert next(e for e in result["events"] if e["kind"]=="document_analysis")["sha"]=="a"*40
    assert "TOP SECRET" not in repr(result)
    assert "SECRET DOCUMENT" not in repr(result)
    assert result["sample"]["not_full_company_census"] is True


def test_stale_running_marked_for_attention_but_recent_running_not():
    old=doc_run("running",NOW-timedelta(minutes=19))
    recent=doc_run("running",NOW-timedelta(minutes=1))
    result=summarize(ORG,[task()],{}, {TASK:[old,recent]},now=NOW)
    assert result["attention_count_in_sample"]==1
    assert sum(x["needs_attention"] for x in result["events"])==1
    assert result["counts"]["document_analysis"]["running"]==2


def test_bounded_task_sampling_does_not_claim_global_census():
    many=[task("77777777-7777-4777-8777-"+str(i).zfill(12)) for i in range(45)]
    result=summarize(ORG,many,{}, {},now=NOW)
    assert result["sample"]["truncated"] is True
    assert result["sample"]["tasks_scanned"]==MAX_TASKS
    assert result["sample"]["tasks_available_in_bounded_reader"]==45
    assert result["events"]==[]


def test_anonymous_request_stops_before_database():
    with patch("app.organizations_api.psycopg.connect") as db:
        assert client.get(URL).status_code==401
    db.assert_not_called()


def test_owner_sees_bounded_sources_without_secrets():
    db,cur=setup_db()
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"db"}), \
         patch("app.organizations_api.psycopg.connect",return_value=db):
        response=client.get(URL,headers=AUTH)
    assert response.status_code==200,response.text
    body=response.json()
    assert body["organization_id"]==ORG
    assert body["counts"]["document_analysis"]["failed"]==1
    assert next(e for e in body["events"] if e["kind"]=="document_analysis")["path"]=="docs/ORGANIZATIONS_ENDPOINT.md"
    assert "TOP SECRET DOCUMENT BODY" not in response.text
    assert "SECRET DOCUMENT CONTENT" not in response.text
    assert all(c.args[0].lstrip().startswith("SELECT ") for c in cur.execute.call_args_list)
    assert any("eliot.my_analysis_runs" in c.args[0] for c in cur.execute.call_args_list)
    assert any("eliot.my_document_runs" in c.args[0] for c in cur.execute.call_args_list)
    assert not any("INSERT " in c.args[0] for c in cur.execute.call_args_list)


def test_nonowner_forbidden_before_task_or_run_lookup():
    db,cur=setup_db(role="member",history=[])
    with patch("app.organizations_api.verified_identity",return_value="issuer|member"), \
         patch("app.organizations_api.db_params",return_value={"host":"db"}), \
         patch("app.organizations_api.psycopg.connect",return_value=db):
        res=client.get(URL,headers=AUTH)
    assert res.status_code==403
    assert not any("my_tasks" in x.args[0] or "my_document_runs" in x.args[0]
                   for x in cur.execute.call_args_list)


def test_unknown_company_404_no_task_or_run_leakage():
    db,cur=setup_db(organization=OTHER,history=[])
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"db"}), \
         patch("app.organizations_api.psycopg.connect",return_value=db):
        res=client.get(URL,headers=AUTH)
    assert res.status_code==404
    assert not any("my_tasks" in x.args[0] for x in cur.execute.call_args_list)


def test_owner_with_no_tasks_returns_empty_report():
    db,cur=setup_db(tasks=[],history=[])
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"db"}), \
         patch("app.organizations_api.psycopg.connect",return_value=db):
        res=client.get(URL,headers=AUTH)
    assert res.status_code==200
    assert res.json()["events"]==[]
    assert res.json()["sample"]["tasks_scanned"]==0

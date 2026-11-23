from unittest.mock import MagicMock, patch
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.organizations_api import router
from app.eliot_text_core import choose_intents, answer

app=FastAPI()
app.include_router(router)
client=TestClient(app)

ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
URL = f"/v1/me/organizations/{ORG}/eliot/chat"

DEPTS = [{"id":"11111111-1111-4111-8111-111111111111","name":"Desarrollo"}]
WORKERS = [{"id":"22222222-2222-4222-8222-222222222222",
            "department_id":DEPTS[0]["id"],"name":"Programador IA","state":"inactive"}]
TASKS = [{"id":"33333333-3333-4333-8333-333333333333",
          "department_id":DEPTS[0]["id"],"title":"Revisar estructura",
          "status":"blocked"}]
EVENTS = [{"event_type":"blocked","task_title":"Revisar estructura"}]

def test_two_questions_have_two_answers():
    r=answer("Eliot, ¿cómo va mi empresa? ¿Qué tareas tenemos bloqueadas?",
             "Nova Demo",DEPTS,WORKERS,TASKS,EVENTS)
    assert r["intents"] == ["summary","blocked"]
    assert "Resumen verificado" in r["answer"]
    assert "Hay 1 tarea(s) bloqueada(s)" in r["answer"]
    assert r["answer"].count("Nota:")==1

def test_followup_uses_only_topic_hint_from_same_company():
    result=answer("¿Y cuántas?", "Nova Demo",DEPTS,WORKERS,TASKS,EVENTS,
                  context_intent="blocked")
    assert result["intents"]==["blocked"]
    assert "Hay 1 tarea(s) bloqueada(s)" in result["answer"]

def test_explicit_new_intent_overrides_hint():
    result=answer("¿Y los trabajadores?", "Nova Demo",DEPTS,WORKERS,TASKS,EVENTS,
                  context_intent="blocked")
    assert result["intents"]==["workers"]

def test_unsafe_action_does_not_mix_with_data_answers():
    result=answer("Crea una empresa y dime qué tareas hay",
                  "Nova Demo",DEPTS,WORKERS,TASKS,EVENTS)
    assert result["intents"]==["action"]
    assert result["read_only"] is True
    assert "no ejecuta órdenes" in result["answer"]

def test_request_rejects_invalid_context_and_anonymous():
    assert client.post(URL,json={"question":"¿Y cuántas?","context_intent":"owner"}).status_code==422
    assert client.post(URL,json={"question":"¿Y cuántas?","context_intent":"blocked"}).status_code==401

def mock_conn():
    connection=MagicMock()
    cur=connection.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchall.side_effect=[
        [(UUID(ORG),"Nova Demo","owner")],
        [(UUID(DEPTS[0]["id"]),"Desarrollo")],
        [(UUID(WORKERS[0]["id"]),UUID(DEPTS[0]["id"]),"Programador IA","Software","inactive")],
        [(UUID(TASKS[0]["id"]),UUID(DEPTS[0]["id"]),None,"Revisar estructura","blocked",None)],
        [(UUID("44444444-4444-4444-8444-444444444444"),UUID(TASKS[0]["id"]),
          "Revisar estructura",UUID(DEPTS[0]["id"]),"Desarrollo","blocked","Block","2026")]
    ]
    return connection

def test_http_multi_intent_remains_authorized_and_read_only():
    conn=mock_conn()
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        response=client.post(URL,json={
            "question":"¿Cómo va mi empresa? ¿Qué tareas tenemos bloqueadas?",
            "context_intent":"workers"
        },headers={"Authorization":"Bearer opaque"})
    assert response.status_code==200
    payload=response.json()
    assert payload["intents"]==["summary","blocked"]
    assert payload["organization_id"]==ORG
    assert payload["read_only"] is True
    cur=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    assert cur.execute.call_count==6
    for call in cur.execute.call_args_list:
        assert call.args[0].lower().startswith("select ")

def test_wrong_tenant_cannot_be_reached_with_context_hint():
    conn=MagicMock()
    cur=conn.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchall.return_value=[(UUID(ORG),"Nova Demo","owner")]
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=conn):
        response=client.post(f"/v1/me/organizations/{OTHER}/eliot/chat",
          json={"question":"¿Y cuántas?","context_intent":"blocked"},
          headers={"Authorization":"Bearer opaque"})
    assert response.status_code==404
    assert cur.execute.call_count==2

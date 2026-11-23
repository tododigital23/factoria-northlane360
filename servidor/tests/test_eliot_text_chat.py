from unittest.mock import MagicMock, patch
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.organizations_api import router
from app.eliot_text_core import choose_intent, answer

app=FastAPI()
app.include_router(router)
client=TestClient(app)
org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
other="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
base=f"/v1/me/organizations/{org}/eliot/chat"
sample={
 "organization":(UUID(org),"Nova Demo","owner"),
 "departments":[(UUID("11111111-1111-4111-8111-111111111111"),"Desarrollo")],
 "workers":[(UUID("22222222-2222-4222-8222-222222222222"),
             UUID("11111111-1111-4111-8111-111111111111"),"Programador IA","Software","inactive")],
 "tasks":[(UUID("33333333-3333-4333-8333-333333333333"),
           UUID("11111111-1111-4111-8111-111111111111"),None,"Revisar estructura","blocked",None)],
 "events":[(UUID("44444444-4444-4444-8444-444444444444"),
            UUID("33333333-3333-4333-8333-333333333333"),"Revisar estructura",
            UUID("11111111-1111-4111-8111-111111111111"),"Desarrollo","blocked","Block","2026-10-27")]
}

def test_chat_requires_valid_token():
    assert client.post(base,json={"question":"Dame un resumen"}).status_code==401

def test_chat_validates_question():
    assert client.post(base,headers={"Authorization":"Bearer opaque"},json={"question":"x"}).status_code==422

def mock_connection():
    connection=MagicMock()
    conn=connection.__enter__.return_value
    cursor=conn.cursor.return_value.__enter__.return_value
    cursor.fetchall.side_effect=[
     [sample["organization"]],
     sample["departments"],sample["workers"],sample["tasks"],sample["events"]
    ]
    return connection,cursor

def test_chat_returns_verified_records_only():
    connection,cursor=mock_connection()
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=connection):
        r=client.post(base,json={"question":"¿Qué tareas están bloqueadas?"},headers={"Authorization":"Bearer mocked"})
    assert r.status_code==200
    payload=r.json()
    assert payload["mode"]=="verified_data"
    assert payload["read_only"] is True
    assert "Revisar estructura" in payload["answer"]
    queries=[c.args[0].lower() for c in cursor.execute.call_args_list]
    assert len(queries)==6
    assert all(q.startswith("select ") for q in queries)
    assert all("eliot.my_" in q or "set_config" in q for q in queries)

def test_chat_denies_unauthorized_company_before_fetching_tenant_data():
    connection=MagicMock()
    cur=connection.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchall.return_value=[sample["organization"]]
    with patch("app.organizations_api.verified_identity",return_value="issuer|owner"), \
         patch("app.organizations_api.db_params",return_value={"host":"test"}), \
         patch("app.organizations_api.psycopg.connect",return_value=connection):
        r=client.post(f"/v1/me/organizations/{other}/eliot/chat",
         json={"question":"¿Cómo va la empresa?"},headers={"Authorization":"Bearer mocked"})
    assert r.status_code==404
    assert cur.execute.call_count==2
    assert "Nova" not in r.text

def test_action_queries_never_invoke_actions():
    result=answer("Crea una empresa nueva","Nova Demo",[],[],[],[])
    assert result["intent"]=="action" and result["read_only"] is True
    assert "no ejecuta órdenes" in result["answer"]

def test_intents_in_spanish_and_accented_questions():
    assert choose_intent("¿Qué tareas están BLOQUEADAS?")=="blocked"
    assert choose_intent("¿Cuáles son los departamentos?")=="departments"
    assert choose_intent("¿Cómo va mi empresa?")=="summary"
    assert choose_intent("¿Quién está trabajando?")=="workers"

def test_empty_data_stays_truthful():
    r=answer("Dame el resumen", "Pruebas",[],[],[],[])
    assert "0 departamentos" in r["answer"]
    assert "0 trabajadores" in r["answer"]

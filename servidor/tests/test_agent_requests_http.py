"""Contrato HTTP de 035 («Pedir una tarea» y memoria compartida). BD simulada."""
from contextlib import contextmanager
from unittest.mock import MagicMock,patch
from uuid import uuid4
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app import eliot_holding_api as api
ORG=uuid4();W=uuid4();T=uuid4();D=uuid4();KEY=uuid4()
app=FastAPI();app.include_router(api.router);client=TestClient(app)
url=f'/v1/me/organizations/{ORG}/workers/{W}/requests'
body={'request':'Revisa la página de precios y propone mejoras','deliverable':'Lista de mejoras','request_key':str(KEY)}
cur=MagicMock()
@contextmanager
def cursor(_):yield cur
READY=[('fn',),(True,)]*2
def ok(**o):return {'organization_id':str(ORG),'worker_id':str(W),'task_id':str(T),'department_id':str(D),'title':'Revisa la página de precios',
 'status':'pending','replayed':False,'execution_started':False,**o}

def test_auth_before_storage():
 with patch.object(api,'_cursor') as db:assert client.post(url,json=body).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403)),patch.object(api,'_cursor') as db:
  assert client.post(url,json=body).status_code==403
  assert client.post(f'/v1/me/organizations/{ORG}/memory/pricing',json={'content':'x'}).status_code==403
 db.assert_not_called()

@pytest.mark.parametrize('change',[{'request':'corto'},{'request':'x'*2001},{'request':'          '+'a'},{'deliverable':'x'*301},{'extra':1},{'request_key':'no'}])
def test_invalid_request_never_writes(change):
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:
  assert client.post(url,json={**body,**change}).status_code==422
 db.assert_not_called()

def test_request_exact_args_and_strict_result():
 cur.reset_mock();cur.fetchone.side_effect=READY+[(ok(secret='x'),)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):r=client.post(url,json=body)
 assert r.status_code==201,r.text
 auth.assert_called_once_with(ORG,None,write=True)
 assert cur.execute.call_args.args[1]==(ORG,W,body['request'],'Lista de mejoras',KEY)
 assert r.json()['task_id']==str(T) and r.json()['execution_started'] is False and 'secret' not in r.text

def test_blank_deliverable_becomes_null():
 cur.reset_mock();cur.fetchone.side_effect=READY+[(ok(),)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  client.post(url,json={**body,'deliverable':'   '})
 assert cur.execute.call_args.args[1][3] is None

@pytest.mark.parametrize('bad',[ok(status='running'),ok(execution_started=True),ok(worker_id=str(uuid4())),ok(task_id='x'),ok(title='ab'),ok(replayed='no'),None])
def test_inconsistent_result_is_unconfirmed(bad):
 cur.reset_mock();cur.fetchone.side_effect=READY+[(bad,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(url,json=body).status_code==503

def test_missing_migration_fails_closed():
 cur.reset_mock();cur.fetchone.side_effect=[(None,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(url,json=body).status_code==503
 cur.reset_mock();cur.fetchone.side_effect=[(None,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  r=client.get(f'/v1/me/organizations/{ORG}/memory')
 assert r.json()['enabled'] is False and r.json()['keys']==list(api.MEMORY_KEYS)

def test_memory_read_and_write():
 cur.reset_mock();cur.fetchone.side_effect=READY;cur.fetchall.return_value=[({'key':'pricing','content':'29 €'},)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):
  r=client.get(f'/v1/me/organizations/{ORG}/memory')
 assert r.json()['items']==[{'key':'pricing','content':'29 €'}];auth.assert_called_once_with(ORG,None,write=False)
 cur.reset_mock();cur.fetchone.side_effect=READY+[({'key':'pricing','updated':True},)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  r=client.post(f'/v1/me/organizations/{ORG}/memory/pricing',json={'content':'Plan básico 35 €'})
 assert r.json()=={'organization_id':str(ORG),'key':'pricing','updated':True}
 assert cur.execute.call_args.args[1]==(ORG,'pricing','Plan básico 35 €')
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:
  assert client.post(f'/v1/me/organizations/{ORG}/memory/secret',json={'content':'x'}).status_code==422
  assert client.post(f'/v1/me/organizations/{ORG}/memory/faq',json={'content':'x'*2001}).status_code==422
 db.assert_not_called()

def test_task_requests_listing():
 cur.reset_mock();cur.fetchone.side_effect=READY;cur.fetchall.return_value=[({'task_id':str(T),'request':'hola mundo largo'},)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  r=client.get(f'/v1/me/organizations/{ORG}/task-requests')
 assert r.json()['enabled'] is True and r.json()['requests'][0]['task_id']==str(T)

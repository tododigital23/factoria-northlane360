"""HTTP contract for 032 plan reopening. DB is mocked; SQL behaviour is covered in tests/pg."""
from contextlib import contextmanager
from unittest.mock import MagicMock,patch
from uuid import uuid4
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app import eliot_document_plans_api as api
ORG=uuid4();TASK=uuid4();PLAN=uuid4();JOB=uuid4();KEY=uuid4()
app=FastAPI();app.include_router(api.router);client=TestClient(app)
base=f'/v1/me/organizations/{ORG}/tasks/{TASK}/execution/document-plans/{PLAN}'
body={'failed_job_id':str(JOB),'reason':'Citation validator corrected; retry once','request_key':str(KEY)}
READY=[('fn',),(True,),('fn',),(True,)]
cur=MagicMock()
@contextmanager
def cursor(_):yield cur
def ok(**over):return {'plan_id':str(PLAN),'attempt':1,'failed_job_id':str(JOB),'replayed':False,'dispatched':False,**over}

def test_auth_before_any_storage():
 with patch.object(api,'_cursor') as db:assert client.post(base+'/reopen',json=body).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403)),patch.object(api,'_cursor') as db:
  assert client.post(base+'/reopen',json=body).status_code==403
 db.assert_not_called()

@pytest.mark.parametrize('change',[{'reason':'short'},{'reason':'          '},{'failed_job_id':'nope'},{'request_key':None},{'dispatch':True}])
def test_invalid_request_never_touches_storage(change):
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:
  assert client.post(base+'/reopen',json={**body,**change}).status_code==422
 db.assert_not_called()

@pytest.mark.parametrize('rows',[[(None,)],[('fn',),(False,)],[('fn',),(True,),(None,)]])
def test_missing_migration_or_grant_fails_closed(rows):
 cur.reset_mock();cur.fetchone.side_effect=rows
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(base+'/reopen',json=body).status_code==503
 assert all('owner_reopen_failed_document_plan(' not in c.args[0] for c in cur.execute.call_args_list)

def test_reopen_passes_exact_scope_and_never_claims_dispatch():
 cur.reset_mock();cur.fetchone.side_effect=READY+[(ok(private='omit'),)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):
  r=client.post(base+'/reopen',json=body)
 assert r.status_code==200,r.text
 auth.assert_called_once_with(ORG,None,write=True)
 assert cur.execute.call_args.args[1]==(ORG,TASK,PLAN,JOB,body['reason'],KEY)
 data=r.json();assert data['attempt']==1 and 'private' not in data
 assert not data['provider_called'] and not data['execution_started'] and not data['approval_created']
 assert data['next_steps']==['review_previous_lease','approve_document_analysis','dispatch_plan']

@pytest.mark.parametrize('result',[ok(dispatched=True),ok(plan_id=str(uuid4())),ok(failed_job_id=str(uuid4())),
 ok(attempt=3),ok(attempt=True),ok(replayed='no'),None,'text'])
def test_inconsistent_storage_result_is_unconfirmed(result):
 cur.reset_mock();cur.fetchone.side_effect=READY+[(result,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(base+'/reopen',json=body).status_code==503

def test_attempt_history_is_read_only_and_disabled_without_migration():
 cur.reset_mock();cur.fetchone.side_effect=[(None,)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):
  r=client.get(base+'/attempts')
 assert r.status_code==200 and r.json()['enabled'] is False and r.json()['attempts']==[]
 auth.assert_called_once_with(ORG,None,write=False)
 cur.reset_mock();cur.fetchone.side_effect=READY;cur.fetchall.return_value=[({'attempt':1,'failed_error_code':'invalid_response'},)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  r=client.get(base+'/attempts')
 assert r.json()['attempts']==[{'attempt':1,'failed_error_code':'invalid_response'}]
 assert cur.execute.call_args.args[1]==(ORG,PLAN)

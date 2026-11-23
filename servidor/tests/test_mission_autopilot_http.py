"""HTTP contract for 033 mission autopilot. DB mocked; SQL behaviour in tests/pg/mission_autopilot.py."""
from contextlib import contextmanager
from unittest.mock import MagicMock,patch
from uuid import uuid4
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app import eliot_mission_autopilot_api as api
from app import eliot_document_reviews_api as reviews
ORG=uuid4();MISSION=uuid4();KEY=uuid4();JOB=uuid4();PLAN=uuid4();TASK=uuid4();RUN=uuid4()
app=FastAPI();app.include_router(api.router);app.include_router(reviews.router);client=TestClient(app)
base=f'/v1/me/organizations/{ORG}/execution/document-missions/{MISSION}/autopilot'
body={'max_jobs':4,'objective_consent':False,'auto_retry':True,'hours':24,'cost_consent':True,'request_key':str(KEY)}
READY=[('fn',),(True,)]*4
cur=MagicMock()
@contextmanager
def cursor(_):yield cur
def adv(**over):
 return {'mission_id':str(MISSION),'stopped':'job_in_progress','stopped_at_position':1,'jobs_dispatched':1,'max_jobs':4,
  'dispatched':[{'position':1,'plan_id':str(PLAN),'job_id':str(JOB),'kind':'dispatch'}],**over}

def test_auth_before_storage_on_every_write():
 for path,payload in ((base,body),(base+'/advance',None),(base+'/revoke',{'reason':'Owner revokes autopilot'})):
  with patch.object(api,'_cursor') as db:assert client.post(path,json=payload).status_code==401
  db.assert_not_called()
  with patch.object(api,'_owner',side_effect=HTTPException(403)),patch.object(api,'_cursor') as db:
   assert client.post(path,json=payload).status_code==403
  db.assert_not_called()

@pytest.mark.parametrize('change',[{'cost_consent':False},{'max_jobs':0},{'max_jobs':11},{'max_jobs':True},{'hours':0},
 {'hours':169},{'objective_consent':'yes'},{'unknown':1},{'request_key':'x'}])
def test_invalid_terms_never_touch_storage(change):
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:
  assert client.post(base,json={**body,**change}).status_code==422
 db.assert_not_called()

@pytest.mark.parametrize('rows',[[(None,)],[('fn',),(False,)]])
def test_missing_migration_fails_closed(rows):
 cur.reset_mock();cur.fetchone.side_effect=rows
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(base,json=body).status_code==503
  cur.fetchone.side_effect=rows;assert client.post(base+'/advance').status_code==503
 assert all('owner_grant' not in c.args[0] and 'owner_advance' not in c.args[0] for c in cur.execute.call_args_list)

def test_grant_passes_exact_terms_and_reports_budget_and_first_dispatch():
 cur.reset_mock();cur.fetchone.side_effect=READY+[({'autopilot_id':str(KEY),'replayed':False,'advance':adv(secret='x')},)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):r=client.post(base,json=body)
 assert r.status_code==200,r.text
 auth.assert_called_once_with(ORG,None,write=True)
 assert cur.execute.call_args.args[1]==(ORG,MISSION,4,False,True,24,KEY)
 d=r.json();assert d['estimated_token_units']==10000 and d['advance']['dispatched'][0]['job_id']==str(JOB)
 assert 'secret' not in str(d) and d['provider_called'] is False

@pytest.mark.parametrize('bad',[adv(stopped='surprise'),adv(mission_id=str(uuid4())),adv(dispatched=[{'position':9,'plan_id':str(PLAN),'job_id':str(JOB),'kind':'dispatch'}]),
 adv(dispatched=[{'position':1,'plan_id':str(PLAN),'job_id':'nope','kind':'dispatch'}]),adv(dispatched=[{'position':1,'plan_id':str(PLAN),'job_id':str(JOB),'kind':'other'}]),
 adv(jobs_dispatched='1'),adv(dispatched=None),None])
def test_inconsistent_advance_is_unconfirmed(bad):
 cur.reset_mock();cur.fetchone.side_effect=READY+[(bad,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(base+'/advance').status_code==503

def test_revoke_never_claims_to_abort_queued_jobs():
 cur.reset_mock();cur.fetchone.side_effect=READY+[({'mission_id':str(MISSION),'revoked':True},)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  r=client.post(base+'/revoke',json={'reason':'Owner revokes autopilot'})
 assert r.status_code==200 and r.json()['revoked'] is True and r.json()['queued_jobs_aborted'] is False

def test_status_disabled_without_migration():
 cur.reset_mock();cur.fetchone.side_effect=[(None,)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):r=client.get(base)
 assert r.json()['enabled'] is False and r.json()['autopilots']==[];auth.assert_called_once_with(ORG,None,write=False)

# --- Hook: accepted reviews continue the mission in a SEPARATE transaction.
REVIEW_URL=f'/v1/me/organizations/{ORG}/tasks/{TASK}/execution/document-runs/{RUN}/review'
def review_result(decision):
 return {'organization_id':str(ORG),'task_id':str(TASK),'run_id':str(RUN),'enabled':True,'review':{'id':str(KEY),'decision':decision}}

def test_accepted_review_triggers_autopilot_after_commit():
 calls=[]
 def hook(subject,org,task):calls.append((subject,org,task));return {'attempted':True,'missions':[]}
 with patch.object(reviews,'_owner',return_value='verified'),patch.object(reviews,'_cursor',cursor),\
   patch.object(reviews,'ready',return_value=True),patch.object(reviews,'read',return_value=review_result('accepted')),\
   patch.object(api,'advance_after_acceptance',hook):
  cur.reset_mock();cur.fetchone.side_effect=[(KEY,)]
  r=client.post(REVIEW_URL,json={'decision':'accepted','reason':'Report accepted by owner','request_key':str(KEY)})
 assert r.status_code==200 and r.json()['autopilot']=={'attempted':True,'missions':[]} and calls==[('verified',ORG,TASK)]

def test_changes_requested_never_triggers_autopilot():
 with patch.object(reviews,'_owner',return_value='verified'),patch.object(reviews,'_cursor',cursor),\
   patch.object(reviews,'ready',return_value=True),patch.object(reviews,'read',return_value=review_result('changes_requested')),\
   patch.object(api,'advance_after_acceptance') as hook:
  cur.reset_mock();cur.fetchone.side_effect=[(KEY,)]
  r=client.post(REVIEW_URL,json={'decision':'changes_requested','reason':'Corrections are required','request_key':str(KEY)})
 assert r.status_code==200 and 'autopilot' not in r.json();hook.assert_not_called()

def test_hook_failure_never_breaks_the_committed_review():
 def broken(_):raise HTTPException(503)
 with patch.object(api,'_cursor',broken):
  assert api.advance_after_acceptance('verified',ORG,TASK)=={'attempted':True,'error':'autopilot_unconfirmed'}
 cur.reset_mock();cur.fetchone.side_effect=READY+[(adv(),)]
 cur.fetchall.return_value=[({'mission_id':str(MISSION)},),({'mission_id':None},)]
 with patch.object(api,'_cursor',cursor):out=api.advance_after_acceptance('verified',ORG,TASK)
 assert out['attempted'] and out['missions'][0]['mission_id']==str(MISSION) and out['missions'][0]['stopped']=='job_in_progress'

from contextlib import contextmanager
from datetime import datetime,timezone
from unittest.mock import MagicMock,patch
from uuid import UUID,uuid4
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app.eliot_plan_tracking import summarize,progression,MAX_TASKS,MAX_VISIBLE_PLANS
from app import eliot_plan_tracking_api as api
ORG=UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');TASK=UUID('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');WORKER=UUID('cccccccc-cccc-4ccc-8ccc-cccccccccccc');DEPT=UUID('dddddddd-dddd-4ddd-8ddd-dddddddddddd')
T=(TASK,DEPT,WORKER,'Review documentation','pending',datetime.now(timezone.utc))
def plan(state=None,decision=None):
 verified=state in {'source_verified','provider_started','completed'}
 return {'id':str(uuid4()),'task_id':str(TASK),'worker_id':str(WORKER),'objective':'Review exact documentary evidence','repository':'Nova/project','path':'docs/CI.md','ref':'live','sha':'a'*40,'version':'document_plan_v1','max_jobs':1,'estimated_token_units':2500,'steps':[{'id':'verify_source','responsible':'worker','depends_on':[]},{'id':'analyze_document','responsible':'worker','depends_on':['verify_source']},{'id':'review_result','responsible':'owner','depends_on':['analyze_document']}],'created_at':'2026-11-07T17:00:00+00:00','scope_current':True,'job_id':str(uuid4()) if state else None,'run_id':str(uuid4()) if state else None,'job_state':state,'source_verified_at':'2026-11-07T17:01:00Z' if verified else None,'review_decision':decision,'task_status':'pending','claim_token':'must-not-escape','result_text':'must-not-escape'}
def overview(p):return summarize(ORG,[T],{str(TASK):[p]},{str(WORKER):'Programador IA'},{str(DEPT):'Desarrollo'})
@pytest.mark.parametrize('job,decision,state,steps',[
 (None,None,'prepared',['pending','waiting','waiting']),
 ('queued',None,'queued',['queued','waiting','waiting']),
 ('claimed',None,'claimed',['in_progress','waiting','waiting']),
 ('source_verified',None,'source_verified',['completed','ready','waiting']),
 ('provider_started',None,'provider_started',['completed','in_progress','waiting']),
 ('completed',None,'awaiting_review',['completed','completed','awaiting_review']),
 ('completed','accepted','accepted',['completed','completed','accepted']),
 ('completed','changes_requested','changes_requested',['completed','completed','changes_requested']),
 ('needs_review',None,'needs_review',['uncertain','blocked','blocked']),
 ('failed',None,'failed',['failed','blocked','blocked']),
 ('cancelled',None,'cancelled',['cancelled','blocked','blocked']),
])
def test_progress_follows_observed_records_not_plan_existence(job,decision,state,steps):
 raw=overview(plan(job,decision));entry=raw['plans'][0]
 assert entry['state']==state and [s['state'] for s in entry['steps']]==steps
 assert raw['counts_in_visible_sample'][state]==1 and raw['read_only'] and not raw['provider_called']
 assert entry['worker_name']=='Programador IA' and entry['department_name']=='Desarrollo'
 assert 'claim_token' not in entry and 'result_text' not in entry

def test_stale_draft_does_not_look_started_and_verified_failure_preserves_evidence():
 p=plan();p['scope_current']=False;assert overview(p)['plans'][0]['state']=='outdated'
 p=plan('failed');p['source_verified_at']='2026-11-07T17:01:00Z'
 assert [s['state'] for s in overview(p)['plans'][0]['steps']]==['completed','failed','blocked']
 p=plan('needs_review');p['source_verified_at']='2026-11-07T17:01:00Z'
 assert [s['state'] for s in overview(p)['plans'][0]['steps']]==['completed','uncertain','blocked']

@pytest.mark.parametrize('change',[
 {'task_id':str(ORG)},{'worker_id':'bad'},{'max_jobs':2},{'estimated_token_units':9999},{'version':'future'},
 {'steps':[]},{'created_at':'2026-11-07'},{'job_state':'completed'},{'review_decision':'accepted'},
 {'sha':'b'},{'scope_current':None},
])
def test_invalid_or_inconsistent_storage_is_not_turned_into_progress(change):
 with pytest.raises((ValueError,TypeError)):overview({**plan(),**change})

def test_source_verification_record_is_required_for_advanced_states():
 p=plan('provider_started');p['source_verified_at']=None
 with pytest.raises(ValueError):overview(p)

def test_bounded_sample_and_counts_describe_only_visible_plans():
 tasks=[];histories={}
 for i in range(MAX_TASKS+2):
  tid=uuid4();tasks.append((tid,*T[1:]));histories[str(tid)]=[{**plan(),'task_id':str(tid)} for _ in range(4)]
 raw=summarize(ORG,tasks,histories)
 assert raw['sample']['tasks_scanned']==MAX_TASKS and raw['sample']['tasks_truncated']
 assert raw['sample']['plans_in_task_sample']==MAX_TASKS*4 and raw['sample']['plans_truncated']
 assert len(raw['plans'])==MAX_VISIBLE_PLANS and sum(raw['counts_in_visible_sample'].values())==MAX_VISIBLE_PLANS
 assert raw['sample']['not_full_company_census']

app=FastAPI();app.include_router(api.router);client=TestClient(app);URL=f'/v1/me/organizations/{ORG}/execution/document-plans-overview'
CUR=MagicMock()
@contextmanager
def cursor(_):yield CUR

def test_anonymous_and_non_owner_cannot_read_company_monitor():
 with patch.object(api,'_cursor') as db:assert client.get(URL).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403,'Owner only')),patch.object(api,'_cursor') as db:assert client.get(URL).status_code==403
 db.assert_not_called()

def test_unavailable_storage_has_no_fabricated_counts_and_no_task_queries():
 CUR.reset_mock()
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=False):
  raw=client.get(URL).json()
 assert raw['enabled'] is False and raw['plans']==[] and 'counts_in_visible_sample' not in raw
 CUR.execute.assert_not_called()

def test_monitor_reuses_only_scoped_readers_and_omits_execution_secrets():
 CUR.reset_mock();CUR.fetchall.side_effect=[[T],[(WORKER,'Programador IA')],[(DEPT,'Desarrollo')]]
 with patch.object(api,'_owner',return_value='verified') as owner,patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True),patch.object(api,'controls_ready',return_value=True),patch.object(api,'objective_capability',return_value=False),patch.object(api,'read',return_value=[plan('completed')]) as history:
  response=client.get(URL)
 assert response.status_code==200 and response.json()['plans'][0]['state']=='awaiting_review' and response.json()['plan_controls_available'] is True
 owner.assert_called_once_with(ORG,None,write=False);history.assert_called_once_with(CUR,ORG,TASK)
 assert all(call.args[1]==(ORG,) and call.args[0].startswith('SELECT') for call in CUR.execute.call_args_list)
 assert 'must-not-escape' not in response.text

def test_mismatched_plan_scope_fails_without_partial_results():
 CUR.fetchall.side_effect=[[T],[],[]]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True),patch.object(api,'controls_ready',return_value=True),patch.object(api,'objective_capability',return_value=False),patch.object(api,'read',return_value=[{**plan(),'task_id':str(ORG)}]):
  assert client.get(URL).status_code==503

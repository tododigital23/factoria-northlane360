from copy import deepcopy
from contextlib import contextmanager
from unittest.mock import MagicMock,patch
from uuid import UUID,uuid4
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app import eliot_document_missions_api as api
ORG=uuid4();MID=uuid4();PID=uuid4();KEY=uuid4()
app=FastAPI();app.include_router(api.router);client=TestClient(app);URL=f'/v1/me/organizations/{ORG}/execution/document-missions'
cur=MagicMock()
@contextmanager
def cursor(_):yield cur

def item():
 def step(pos,dependency):return {'position':pos,'plan_id':str(uuid4()),'task_id':str(uuid4()),'task_title':'Review task','worker_id':str(uuid4()),'objective':'Evaluate exact documentary evidence','repository':'Nova/project','path':'docs/CI.md','ref':'live','sha':'a'*40,'job_id':None,'run_id':None,'job_state':None,'review_decision':None,'control_state':'active','scope_current':True,'dependency_satisfied':dependency}
 return {'id':str(MID),'objective':'Coordinate the documentary review','created_at':'2026-11-08T10:00:00Z','owner_is_creator':True,'max_jobs':2,'estimated_token_units':5000,'steps':[step(1,True),step(2,False)],'private':'omit'}

def test_saved_mission_never_looks_started():
 p=api.present(item());assert p['state']=='prepared' and p['accepted_steps']==0
 assert [s['state'] for s in p['steps']]==['ready','waiting'] and p['steps'][0]['can_prepare'] and not p['steps'][1]['can_prepare']
 assert 'private' not in p

def test_only_exact_accepted_previous_report_opens_next_step():
 p=item();s=p['steps'][0];s.update(job_id=str(uuid4()),run_id=str(uuid4()),job_state='completed')
 assert api.present(p)['state']=='awaiting_review'
 s['review_decision']='accepted';p['steps'][1]['dependency_satisfied']=True
 assert api.present(p)['steps'][1]['state']=='ready'
 s['review_decision']='changes_requested';p['steps'][1]['dependency_satisfied']=False
 assert api.present(p)['state']=='needs_attention'

@pytest.mark.parametrize('change',['wrong_order','duplicate_task','invented_dependency','premature_job','missing_review','bad_sha','bad_limits','duplicate_plan'])
def test_inconsistent_storage_cannot_fabricate_progress(change):
 p=item()
 if change=='wrong_order':p['steps'][1]['position']=3
 if change=='duplicate_task':p['steps'][1]['task_id']=p['steps'][0]['task_id']
 if change=='invented_dependency':p['steps'][1]['dependency_satisfied']=True
 if change=='premature_job':p['steps'][1].update(job_id=str(uuid4()),run_id=str(uuid4()),job_state='queued')
 if change=='missing_review':p['steps'][0]['review_decision']='accepted'
 if change=='bad_sha':p['steps'][0]['sha']='x'
 if change=='bad_limits':p['max_jobs']=True
 if change=='duplicate_plan':p['steps'][1]['plan_id']=p['steps'][0]['plan_id']
 with pytest.raises((ValueError,TypeError)):api.present(p)

def test_owner_boundary_before_storage():
 with patch.object(api,'_cursor') as db:assert client.get(URL).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403)),patch.object(api,'_cursor') as db:assert client.get(URL).status_code==403
 db.assert_not_called()

def test_absent_migration_has_no_fake_totals_or_writes():
 cur.reset_mock()
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=False):r=client.get(URL)
 assert r.json()['enabled'] is False and r.json()['missions']==[] and not r.json()['execution_started']
 cur.execute.assert_not_called()

body={'objective':'Coordinate documentary tasks','plan_ids':[str(uuid4()),str(uuid4())],'request_key':str(KEY)}
@pytest.mark.parametrize('change',[{'plan_ids':[str(PID)]},{'plan_ids':[str(PID),str(PID)]},{'objective':' '*10},{'created_by':str(KEY)}])
def test_invalid_mission_never_writes(change):
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:assert client.post(URL,json={**body,**change}).status_code==422
 db.assert_not_called()

def test_creation_has_exact_ordered_scope_and_no_execution():
 cur.reset_mock();cur.fetchone.return_value=(MID,)
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True):r=client.post(URL,json=body)
 assert r.status_code==201 and not r.json()['provider_called'] and not r.json()['execution_started'] and not r.json()['task_completed']
 auth.assert_called_once_with(ORG,None,write=True)
 assert cur.execute.call_args.args[1]==(ORG,body['objective'],[UUID(x) for x in body['plan_ids']],KEY)

def controlled(state='paused',revision=1):
 p=item();p.update(mission_control_available=True,mission_control_state=state,mission_control_revision=revision,last_control={'action':{'paused':'pause','active':'resume','cancelled':'cancel'}[state],'reason':'Recorded control reason','created_at':'2026-11-08T12:00:00Z'});return p

@pytest.mark.parametrize('state',['paused','cancelled'])
def test_global_control_blocks_unsent_steps_without_rewriting_completed_or_queued_jobs(state):
 p=controlled(state);p['steps'][0].update(job_id=str(uuid4()),run_id=str(uuid4()),job_state='queued')
 r=api.present(p);assert r['state']==state and r['steps'][0]['state']=='queued' and r['steps'][1]['state']==state
 assert not any(s['can_prepare'] for s in r['steps']) and r['can_control']==(state=='paused')
 assert r['last_control']['reason']=='Recorded control reason'

@pytest.mark.parametrize('changes',[{'mission_control_state':'x'},{'mission_control_revision':True},{'last_control':None},{'mission_control_available':False},{'mission_control_revision':0},{'last_control':{'action':'resume','reason':'Valid reason long enough','created_at':'2026-11-08T10:00:00Z'}}])
def test_corrupt_global_controls_are_not_actionable(changes):
 p=controlled();p.update(changes)
 with pytest.raises((ValueError,TypeError,KeyError)):api.present(p)

def test_resume_does_not_override_individual_pause_or_missing_predecessor_acceptance():
 p=controlled('active',2);p['steps'][0]['control_state']='paused';r=api.present(p)
 assert r['steps'][0]['state']=='paused' and r['steps'][1]['state']=='waiting'
 assert not any(s['can_prepare'] for s in r['steps'])

control_body={'action':'pause','reason':'Pause future mission steps','expected_revision':0,'request_key':str(KEY)}
CONTROL_URL=URL+f'/{MID}/control'
def test_global_control_requires_owner_before_storage_and_available_migration():
 with patch.object(api,'_cursor') as db:assert client.post(CONTROL_URL,json=control_body).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'controls_ready',return_value=False):assert client.post(CONTROL_URL,json=control_body).status_code==503

@pytest.mark.parametrize('changes',[{'action':'stop'},{'reason':' '*10},{'expected_revision':True},{'expected_revision':2147483647},{'worker_id':str(PID)}])
def test_invalid_global_control_never_writes(changes):
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:assert client.post(CONTROL_URL,json={**control_body,**changes}).status_code==422
 db.assert_not_called()

def test_global_control_ack_does_not_claim_existing_jobs_stopped():
 cur.reset_mock();cur.fetchone.return_value=({'mission_id':str(MID),'action_id':str(KEY),'recorded_state':'paused','recorded_revision':1},)
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor),patch.object(api,'controls_ready',return_value=True):r=client.post(CONTROL_URL,json=control_body)
 assert r.status_code==200 and not r.json()['existing_jobs_stopped'] and not r.json()['execution_started']
 auth.assert_called_once_with(ORG,None,write=True)
 assert cur.execute.call_args.args[1]==(ORG,MID,'pause',control_body['reason'],0,KEY)

@pytest.mark.parametrize('bad',[{}, {'mission_id':str(MID),'action_id':str(KEY),'recorded_state':'paused','recorded_revision':True}])
def test_invalid_control_ack_is_unconfirmed(bad):
 cur.fetchone.return_value=(bad,)
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'controls_ready',return_value=True):assert client.post(CONTROL_URL,json=control_body).status_code==503

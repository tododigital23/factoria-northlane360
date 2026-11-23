from contextlib import contextmanager
from datetime import datetime,timedelta,timezone
from unittest.mock import MagicMock,patch
from uuid import uuid4
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app.eliot_office_overview import summarize,MAX_TASKS
from app import eliot_office_api as api
ORG,D,W,T,J,R,L=(uuid4() for _ in range(7));NOW=datetime.now(timezone.utc)
DEPTS=[(D,'Desarrollo')];WORKERS=[(W,D,'Programador IA','Documentación','idle')]
TASKS=[(T,D,W,'Revisar documentación','pending',NOW-timedelta(minutes=10))]
LEASE=(L,W,'held',NOW-timedelta(minutes=1),NOW+timedelta(minutes=5))
def job(state='provider_started',attention=False,cancel=False):return (J,R,L,state,NOW-timedelta(seconds=20),NOW+timedelta(minutes=3),cancel,attention,None)
def view(rows=None,lease=LEASE,review=None,workers=WORKERS):
 return summarize(ORG,DEPTS,workers,TASKS,{str(T):rows or []},{str(T):lease},{str(T):review},NOW)
@pytest.mark.parametrize('state,phase',[('queued','queued'),('claimed','preparing'),('source_verified','reading'),('provider_started','analyzing'),('needs_review','attention')])
def test_only_recorded_bound_valid_execution_can_animate(state,phase):
 r=view([job(state)]);w=r['workers'][0];assert w['phase']==phase
 assert (w['animation_until'] is not None)==(state in {'claimed','source_verified','provider_started'})
 assert r['worker_online_verified'] is False and r['provider_called'] is False and r['source_fetched'] is False
 assert 'lease_id' not in str(r) and 'claim_token' not in str(r)

def test_idle_or_administratively_working_never_invents_live_execution():
 assert view()['workers'][0]['phase']=='available'
 r=view(workers=[(W,D,'Programador','Docs','working')]);assert r['workers'][0]['phase']=='unconfirmed' and r['workers'][0]['animation_until'] is None

@pytest.mark.parametrize('why',['expired_lease','expired_job','attention','cancel','inactive','changed_worker','missing_lease','changed_task'])
def test_stale_uncertain_or_mismatched_records_do_not_animate(why):
 j=job();l=LEASE;workers=WORKERS;tasks=TASKS
 if why=='expired_lease':l=(*LEASE[:4],NOW-timedelta(seconds=1))
 if why=='expired_job':j=(*j[:5],NOW-timedelta(seconds=1),*j[6:])
 if why=='attention':j=job(attention=True)
 if why=='cancel':j=job(cancel=True)
 if why=='inactive':workers=[(W,D,'Programador','Docs','inactive')]
 if why=='changed_worker':l=(L,uuid4(),*LEASE[2:])
 if why=='missing_lease':l=None
 if why=='changed_task':tasks=[(*TASKS[0][:4],'completed',TASKS[0][5])]
 r=summarize(ORG,DEPTS,workers,tasks,{str(T):[j]},{str(T):l},{},NOW)
 assert all(w['animation_until'] is None for w in r['workers'])
 if why in {'changed_worker','missing_lease'}:assert r['sample']['unattributed_job_records']==1

def test_completed_report_needs_human_review_and_never_looks_like_current_execution():
 r=view([job('completed')]);assert r['workers'][0]['phase']=='awaiting_review' and r['workers'][0]['animation_until'] is None
 assert r['recent_jobs'][0]['review_state']=='pending'
 r=view([job('completed')],review='accepted');assert r['workers'][0]['phase']=='available'

def test_conflicting_parallel_records_stop_animation_instead_of_choosing_a_worker_story():
 t2=uuid4();j2=uuid4();tasks=TASKS+[(t2,D,W,'Otro análisis','pending',NOW-timedelta(minutes=1))]
 r=summarize(ORG,DEPTS,WORKERS,tasks,{str(T):[job()],str(t2):[(j2,*job()[1:])]},{str(T):LEASE,str(t2):LEASE},{},NOW)
 assert r['workers'][0]['phase']=='attention' and r['workers'][0]['animation_until'] is None

def test_sample_limits_and_bad_records_are_explicit():
 tasks=[(uuid4(),D,W,'Task','pending',NOW) for _ in range(MAX_TASKS+1)]
 r=summarize(ORG,DEPTS,WORKERS,tasks,{}, {},{},NOW);assert r['sample']['tasks_truncated'] and r['sample']['tasks_scanned']==MAX_TASKS
 assert r['sample']['not_full_company_census'] and r['workers'][0]['assigned_tasks_in_sample']==MAX_TASKS
 with pytest.raises(ValueError):view([job('invented')])

app=FastAPI();app.include_router(api.router);client=TestClient(app);URL=f'/v1/me/organizations/{ORG}/execution/office-overview';cur=MagicMock()
@contextmanager
def cursor(_):yield cur

def test_owner_auth_precedes_database():
 with patch.object(api,'_cursor') as db:assert client.get(URL).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403)),patch.object(api,'_cursor') as db:assert client.get(URL).status_code==403
 db.assert_not_called()

def test_endpoint_uses_only_scoped_existing_readers_and_no_external_io():
 cur.reset_mock();cur.fetchall.side_effect=[DEPTS,WORKERS,TASKS,[job('completed')]];cur.fetchone.side_effect=[LEASE,(None,)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):r=client.get(URL)
 assert r.status_code==200 and r.json()['workers'][0]['phase']=='awaiting_review'
 auth.assert_called_once_with(ORG,None,write=False)
 assert all(c.args[0].startswith('SELECT') and c.args[1][0]==ORG for c in cur.execute.call_args_list)
 assert len(cur.execute.call_args_list)==6

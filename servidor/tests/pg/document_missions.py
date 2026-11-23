"""Disposable PG18 only: mission scoping, whole-chain review gates and rollback."""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
CREATE_M='SELECT eliot.owner_create_document_mission(%s,%s,%s,%s)'
READ_M='SELECT * FROM eliot.my_document_missions(%s)'
OBJECTIVE='Coordinate the documentary evidence across the selected tasks'
def new_plans(count=2):
 tasks=[new_task() for _ in range(count)];plans=[plan(t)[0] for t in tasks];return tasks,plans
def mission(plans,key=None):
 args=(ORG,OBJECTIVE,plans,key or uuid4());return owner(CREATE_M,args)[0][0],args
def enqueue(t,p):
 l,a=approval(t);args=(ORG,t,WORKER,l,a,uuid4(),p);return owner(ENQUEUE,args)[0][0],args
def finish_fixture(j):
 # Direct fixture writes in a disposable database. No actual external request or task decision.
 rid=query('SELECT run_id FROM eliot.ai_document_jobs WHERE id=%s',(j,))[0][0]
 query("UPDATE eliot.ai_document_jobs SET state='completed',finished_at=clock_timestamp() WHERE id=%s",(j,))
 query("UPDATE eliot.ai_document_runs SET status='completed',finished_at=clock_timestamp(),result_text='Disposable CI documentary report' WHERE id=%s",(rid,))
 return rid

tasks,plans=new_plans(3);m,args=mission(plans);assert owner(CREATE_M,args)[0][0]==m
saved=next(r[0] for r in owner(READ_M,(ORG,)) if r[0]['id']==str(m))
assert len(saved['steps'])==3 and [s['dependency_satisfied'] for s in saved['steps']]==[True,False,False]
assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=ANY(%s)',(tasks,))[0][0]==0
assert saved['estimated_token_units']==7500
# Later steps cannot consume their fresh approvals before every predecessor is accepted.
l,a=approval(tasks[1]);second=(ORG,tasks[1],WORKER,l,a,uuid4(),plans[1])
denied(lambda:owner(ENQUEUE,second),psycopg.errors.ObjectNotInPrerequisiteState)
assert query('SELECT state FROM eliot.ai_document_approvals WHERE id=%s',(a,))[0][0]=='approved'
assert query('SELECT count(*) FROM eliot.ai_document_runs WHERE task_id=%s',(tasks[1],))[0][0]==0
j,_=enqueue(tasks[0],plans[0]);rid=finish_fixture(j)
# Completed report alone, or acceptance of a different task, cannot advance this mission.
denied(lambda:owner(ENQUEUE,second),psycopg.errors.ObjectNotInPrerequisiteState)
owner('SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)',(ORG,tasks[0],rid,'accepted','Accepted disposable CI evidence only',uuid4()))
j2=owner(ENQUEUE,second)[0][0];assert owner(ENQUEUE,second)[0][0]==j2
l3,a3=approval(tasks[2]);third=(ORG,tasks[2],WORKER,l3,a3,uuid4(),plans[2])
denied(lambda:owner(ENQUEUE,third),psycopg.errors.ObjectNotInPrerequisiteState)
rid2=finish_fixture(j2)
owner('SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)',(ORG,tasks[1],rid2,'changes_requested','Corrections required on disposable evidence',uuid4()))
denied(lambda:owner(ENQUEUE,third),psycopg.errors.ObjectNotInPrerequisiteState)
# Creation cannot attach historical jobs or share a plan between two missions.
_,others=new_plans()
denied(lambda:mission([plans[0],others[0]]),psycopg.errors.ObjectNotInPrerequisiteState)
denied(lambda:mission([plans[2],others[0]]),psycopg.errors.ObjectNotInPrerequisiteState)
denied(lambda:mission([others[0],others[0]]),psycopg.errors.InvalidParameterValue)
denied(lambda:mission([others[0]]),psycopg.errors.InvalidParameterValue)
for role in ('eliot_identity','eliot_execution_worker'):
 for table in ('ai_document_missions','ai_document_mission_steps'):
  denied(lambda:query('SELECT * FROM eliot.'+table,role=role),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(CREATE_M,args,role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:owner(READ_M,(OTHER,)),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(CREATE_M,args,role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
# Concurrent creation retries return one mission, same ordered immutable plan list.
tx,px=new_plans();key=uuid4();barrier=Barrier(2)
def repeat(_):
 barrier.wait();return mission(px,key)[0]
with ThreadPoolExecutor(2) as pool:results=list(pool.map(repeat,range(2)))
assert results[0]==results[1]
# Creation/enqueue race: either creation wins and step 2 is blocked, or creation
# rejects an already sent plan. Never commit a mission with a premature step 2 job.
for _ in range(3):
 ts,ps=new_plans();lease,appr=approval(ts[1]);queue=(ORG,ts[1],WORKER,lease,appr,uuid4(),ps[1]);barrier=Barrier(2)
 def race(which):
  barrier.wait()
  try:return ('mission',mission(ps)[0]) if which=='mission' else ('job',owner(ENQUEUE,queue)[0][0])
  except psycopg.errors.ObjectNotInPrerequisiteState:return (which,None)
 with ThreadPoolExecutor(2) as pool:out=dict(pool.map(race,['mission','job']))
 assert (out['mission'] is None)!=(out['job'] is None)
print('PG18 missions: ordered scope, no implicit dispatch, exact predecessor review, rollback, tenant permissions and creation/enqueue races passed')

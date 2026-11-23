"""Disposable PG18 only: plan persistence, exact scope and one durable job."""
import os
from uuid import UUID,uuid4
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import psycopg
assert os.getenv('ELIOT_TEST_DISPOSABLE_DB')=='1'
ORG=UUID('c0430000-0000-4000-8000-000000000001');OTHER=UUID('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
WORKER=UUID('c0430000-0000-4000-8000-000000000003');DEPT=UUID('c0430000-0000-4000-8000-000000000002')
REPO='Nova/project';PATH='docs/CI.md';SHA='a'*40
CREATE='SELECT eliot.owner_create_document_plan(%s,%s,%s,%s,%s,%s,%s,%s,%s)'
ENQUEUE='SELECT eliot.owner_enqueue_planned_document_job(%s,%s,%s,%s,%s,%s,%s)'
def query(sql,args=(),role=None,subject='test|ownerA'):
 with psycopg.connect('') as c,c.cursor() as cur:
  cur.execute("SET statement_timeout='12s'")
  if role:cur.execute('SET LOCAL ROLE '+role)
  cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,));cur.execute(sql,args)
  return cur.fetchall() if cur.description else []
def owner(sql,args=()):return query(sql,args,role='eliot_identity')
def denied(fn,exc):
 try:fn()
 except exc:return
 raise AssertionError('Expected denial '+str(exc))
def new_task():
 t=uuid4();query("INSERT INTO eliot.ai_tasks(id,organization_id,department_id,assignee_worker_id,title) VALUES(%s,%s,%s,%s,'Persistent plan CI')",(t,ORG,DEPT,WORKER));return t
def plan(t,key=None,objective='Inspect the documentary evidence for this task'):
 args=(ORG,t,WORKER,objective,REPO,PATH,'ci',SHA,key or uuid4());return owner(CREATE,args)[0][0],args
def approval(t):
 l=owner('SELECT eliot.owner_claim_task_lease(%s,%s,%s,%s)',(ORG,t,WORKER,uuid4()))[0][0]
 a=owner('SELECT eliot.owner_approve_document_analysis(%s,%s,%s,%s,%s,%s,%s,%s)',(ORG,t,WORKER,REPO,PATH,'ci',SHA,uuid4()))[0][0]
 return l,a
def read(t):return [r[0] for r in owner('SELECT * FROM eliot.my_document_plans(%s,%s)',(ORG,t))]

t=new_task();p,args=plan(t);assert owner(CREATE,args)[0][0]==p
item=read(t)[0];assert item['id']==str(p) and item['scope_current'] and item['owner_is_creator']
assert item['max_jobs']==1 and item['estimated_token_units']==2500 and item['job_id'] is None
assert item['steps'][1]['depends_on']==['verify_source'] and item['steps'][2]['responsible']=='owner'
assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(t,))[0][0]==0
assert query('SELECT count(*) FROM eliot.ai_task_events WHERE task_id=%s',(t,))[0][0]==1
bad=list(args);bad[3]='A changed objective with the same request key'
denied(lambda:owner(CREATE,tuple(bad)),psycopg.errors.InvalidParameterValue)
for role in ('eliot_identity','eliot_execution_worker'):
 denied(lambda:query('SELECT * FROM eliot.ai_document_plans',role=role),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(CREATE,args,role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(CREATE,args,role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:owner('SELECT * FROM eliot.my_document_plans(%s,%s)',(OTHER,t)),psycopg.errors.InsufficientPrivilege)
# Source cannot be rebound to an approval for a different SHA or task.
l,a=approval(t);queue=(ORG,t,WORKER,l,a,uuid4(),p)
query('UPDATE eliot.ai_document_approvals SET source_sha=%s WHERE id=%s',('b'*40,a))
denied(lambda:owner(ENQUEUE,queue),psycopg.errors.InvalidParameterValue)
query('UPDATE eliot.ai_document_approvals SET source_sha=%s WHERE id=%s',(SHA,a))
j=owner(ENQUEUE,queue)[0][0];assert owner(ENQUEUE,queue)[0][0]==j
assert read(t)[0]['job_id']==str(j) and read(t)[0]['job_state']=='queued'
assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(t,))[0][0]==1
assert query('SELECT count(*) FROM eliot.ai_document_runs WHERE task_id=%s',(t,))[0][0]==1
changed=(*queue[:5],uuid4(),p)
denied(lambda:owner(ENQUEUE,changed),psycopg.errors.ObjectNotInPrerequisiteState)
# Task snapshot changes invalidate unused plans; owner save retries remain idempotent.
t2=new_task();p2,args2=plan(t2);l2,a2=approval(t2)
query('UPDATE eliot.ai_tasks SET updated_at=clock_timestamp() WHERE id=%s',(t2,))
assert not read(t2)[0]['scope_current'];assert owner(CREATE,args2)[0][0]==p2
denied(lambda:owner(ENQUEUE,(ORG,t2,WORKER,l2,a2,uuid4(),p2)),psycopg.errors.ObjectNotInPrerequisiteState)
# Queuing against one of two prepared plans cannot associate the job with both.
t3=new_task();p3,_=plan(t3);p4,_=plan(t3);l3,a3=approval(t3);barrier=Barrier(2)
def race(pid):
 barrier.wait()
 try:return owner(ENQUEUE,(ORG,t3,WORKER,l3,a3,uuid4(),pid))[0][0]
 except (psycopg.errors.ObjectNotInPrerequisiteState,psycopg.errors.InvalidParameterValue):return None
with ThreadPoolExecutor(2) as pool:results=list(pool.map(race,[p3,p4]))
assert sum(r is not None for r in results)==1
assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(t3,))[0][0]==1
assert sum(p['job_id'] is not None for p in read(t3))==1
# Do not retroactively attach a legacy job using a reused key.
t4=new_task();p5,_=plan(t4);l4,a4=approval(t4);key=uuid4()
j4=owner('SELECT eliot.owner_enqueue_document_job(%s,%s,%s,%s,%s,%s)',(ORG,t4,WORKER,l4,a4,key))[0][0]
denied(lambda:owner(ENQUEUE,(ORG,t4,WORKER,l4,a4,key,p5)),psycopg.errors.ObjectNotInPrerequisiteState)
# FK enforces organization AND task for a linked job even for privileged fixture writes.
denied(lambda:query('UPDATE eliot.ai_document_plans SET job_id=%s WHERE id=%s',(j4,p2)),psycopg.errors.ForeignKeyViolation)
# No implicit rights or state changes from saving/reading; state derives from real job/review.
assert query('SELECT status FROM eliot.ai_tasks WHERE id=%s',(t,))[0][0]=='pending'
assert not any(k in read(t)[0] for k in ('claim_token','claimed_by','result_text'))
print('Persistent documentary plans: scope, persistence, one-job binding, concurrency, retries and permissions passed')

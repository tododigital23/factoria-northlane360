"""Disposable PG only (032): reopen a mission step whose job failed, without duplicating work.

Reproduces the 9/11 situation: step 1 of a 2-step mission ends 'failed' (invalid_response)
after the provider call; step 2 stays blocked. Verifies the explicit owner reopening,
the unchanged ordinary dispatch path, exactly one new job, and the step 2 gate.
"""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
CREATE_M='SELECT eliot.owner_create_document_mission(%s,%s,%s,%s)'
REOPEN='SELECT eliot.owner_reopen_failed_document_plan(%s,%s,%s,%s,%s,%s)'
ATTEMPTS='SELECT * FROM eliot.my_document_plan_attempts(%s,%s)'
REVIEW='SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)'
CONTROL_M='SELECT eliot.owner_control_document_mission(%s,%s,%s,%s,%s,%s)'
REASON='Citation validation failed; corrected validator deployed'
WORKER_ROLE='ci_doc_worker'  # created and enabled for ORG by tests/pg/durable_document_jobs.py


def as_worker(sql,args):
 with psycopg.connect('') as c,c.cursor() as cur:
  cur.execute("SET statement_timeout='12s'");cur.execute('SET SESSION AUTHORIZATION '+WORKER_ROLE)
  cur.execute(sql,args);return cur.fetchall() if cur.description else []
def count(sql,args=()):return query(sql,args)[0][0]
def new_mission(n=2):
 tasks=[new_task() for _ in range(n)];plans=[plan(t)[0] for t in tasks]
 m=owner(CREATE_M,(ORG,'Analyse planning and coordination documents in sequence',plans,uuid4()))[0][0]
 return m,tasks,plans
def approval_after(t,previous):
 # A finished execution leaves a lease that only an owner review can renew (024).
 release(t,previous)
 l=owner('SELECT eliot.owner_review_and_renew_lease(%s,%s,%s,%s,%s,%s)',(ORG,t,previous,WORKER,'Reviewed failed attempt before retry',uuid4()))[0][0]
 a=owner('SELECT eliot.owner_approve_document_analysis(%s,%s,%s,%s,%s,%s,%s,%s)',(ORG,t,WORKER,REPO,PATH,'ci',SHA,uuid4()))[0][0]
 return l,a
def dispatch(t,p,previous=None):
 l,a=approval(t) if previous is None else approval_after(t,previous)
 return owner(ENQUEUE,(ORG,t,WORKER,l,a,uuid4(),p))[0][0],l,a
def run_worker(job,report=None,error='invalid_response',provider=True):
 """Drive the real worker functions; unrelated queued fixture jobs are failed safely first."""
 while True:
  claim=as_worker('SELECT * FROM eliot.worker_take_document_job_with_objective(%s)',(ORG,))
  assert claim,'job never claimed'
  if claim[0][0]==job:break
  as_worker('SELECT eliot.worker_finish_document_job(%s,%s,%s,%s,%s)',(ORG,claim[0][0],claim[0][1],None,'rate_limited'))
 token=claim[0][1]
 assert as_worker('SELECT eliot.worker_verify_document_source(%s,%s,%s,%s,%s)',(ORG,job,token,SHA,43))==[(True,)]
 if provider:
  assert as_worker('SELECT eliot.worker_begin_document_provider(%s,%s,%s)',(ORG,job,token))==[(True,)]
 return as_worker('SELECT eliot.worker_finish_document_job(%s,%s,%s,%s,%s)',(ORG,job,token,report,error))[0][0]
def release(t,l):owner('SELECT eliot.owner_release_task_lease(%s,%s,%s)',(ORG,t,l))
def state(j):return count('SELECT state FROM eliot.ai_document_jobs WHERE id=%s',(j,))
def mission_steps(m):
 return next(r[0] for r in owner('SELECT * FROM eliot.my_document_missions(%s)',(ORG,)) if r[0]['id']==str(m))['steps']

# Disposable fixture: an earlier suite deliberately exhausts today's ledger; start this suite fresh.
query('UPDATE eliot.ai_model_budget_daily SET calls_reserved=0,token_units_reserved=0 WHERE organization_id=%s',(ORG,))

# --- 1. The 9/11 situation: step 1 failed with a known invalid_response after dispatch.
m,tasks,plans=new_mission()
j1,l1,a1=dispatch(tasks[0],plans[0])
assert run_worker(j1)=='failed' and state(j1)=='failed'
tasks_before=count('SELECT count(*) FROM eliot.ai_tasks WHERE organization_id=%s',(ORG,))
# Before reopening: the plan cannot take another job and step 2 stays blocked.
l1b,a1b=approval_after(tasks[0],l1)
denied(lambda:owner(ENQUEUE,(ORG,tasks[0],WORKER,l1b,a1b,uuid4(),plans[0])),psycopg.errors.ObjectNotInPrerequisiteState)
l2,a2=approval(tasks[1]);step2=(ORG,tasks[1],WORKER,l2,a2,uuid4(),plans[1])
denied(lambda:owner(ENQUEUE,step2),psycopg.errors.ObjectNotInPrerequisiteState)
assert [s['dependency_satisfied'] for s in mission_steps(m)]==[True,False]

# --- 2. Authorization, tenant scope and input checks: no state change on any denial.
key=uuid4();args=(ORG,tasks[0],plans[0],j1,REASON,key)
denied(lambda:query(REOPEN,args,role='eliot_identity',subject='test|not-a-member'),psycopg.errors.InsufficientPrivilege)
# ownerB is an active co-owner from earlier fixtures, but not the plan's creator.
denied(lambda:query(REOPEN,args,role='eliot_identity',subject='test|ownerB'),psycopg.errors.InvalidParameterValue)
denied(lambda:query(REOPEN,args,role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
denied(lambda:owner(REOPEN,(OTHER,tasks[0],plans[0],j1,REASON,key)),psycopg.errors.InsufficientPrivilege)
denied(lambda:owner(REOPEN,(ORG,tasks[0],plans[0],j1,'short',key)),psycopg.errors.InvalidParameterValue)
denied(lambda:owner(REOPEN,(ORG,tasks[0],plans[0],uuid4(),REASON,key)),psycopg.errors.ObjectNotInPrerequisiteState)
denied(lambda:owner(REOPEN,(ORG,tasks[1],plans[1],j1,REASON,key)),psycopg.errors.ObjectNotInPrerequisiteState)
denied(lambda:owner(REOPEN,(ORG,tasks[1],plans[0],j1,REASON,key)),psycopg.errors.InvalidParameterValue)  # plan of another task
for role in ('eliot_identity','eliot_execution_worker'):
 denied(lambda:query('SELECT * FROM eliot.ai_document_plan_attempts',role=role),psycopg.errors.InsufficientPrivilege)
assert count('SELECT job_id FROM eliot.ai_document_plans WHERE id=%s',(plans[0],))==j1
# Even privileged direct writes cannot unlink or swap the job without an audited attempt.
denied(lambda:query('UPDATE eliot.ai_document_plans SET job_id=NULL WHERE id=%s',(plans[0],)),psycopg.errors.ObjectNotInPrerequisiteState)

# --- 3. Reopen once; replays are idempotent; a reused key with other content conflicts.
events=count('SELECT count(*) FROM eliot.ai_task_events WHERE task_id=%s',(tasks[0],))
first=owner(REOPEN,args)[0][0]
assert first=={'plan_id':str(plans[0]),'attempt':1,'failed_job_id':str(j1),'replayed':False,'dispatched':False}
assert owner(REOPEN,args)[0][0]['replayed'] is True
denied(lambda:owner(REOPEN,(ORG,tasks[0],plans[0],j1,REASON+' (edited)',key)),psycopg.errors.InvalidParameterValue)
assert count('SELECT count(*) FROM eliot.ai_task_events WHERE task_id=%s',(tasks[0],))==events+1
assert count('SELECT job_id FROM eliot.ai_document_plans WHERE id=%s',(plans[0],)) is None
# History preserved: failed job/run/approval untouched, no job/approval/lease created by reopening.
assert state(j1)=='failed' and count('SELECT state FROM eliot.ai_document_approvals WHERE id=%s',(a1,))=='failed'
assert count("SELECT status FROM eliot.ai_document_runs r JOIN eliot.ai_document_jobs j ON j.run_id=r.id WHERE j.id=%s",(j1,))=='failed'
assert count('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(tasks[0],))==1
hist=[r[0] for r in owner(ATTEMPTS,(ORG,plans[0]))]
assert len(hist)==1 and hist[0]['failed_error_code']=='invalid_response' and hist[0]['reopened_by_me']
denied(lambda:query('UPDATE eliot.ai_document_plan_attempts SET reason=%s',(REASON+'!',)),psycopg.errors.ObjectNotInPrerequisiteState)
denied(lambda:query('DELETE FROM eliot.ai_document_plan_attempts'),psycopg.errors.ObjectNotInPrerequisiteState)
denied(lambda:owner(ATTEMPTS,(OTHER,plans[0])),psycopg.errors.InsufficientPrivilege)

# --- 4. Ordinary dispatch path: consumed approval is not reusable; a fresh one dispatches ONE job.
denied(lambda:owner(ENQUEUE,(ORG,tasks[0],WORKER,l1b,a1,uuid4(),plans[0])),
       (psycopg.errors.ObjectNotInPrerequisiteState,psycopg.errors.InvalidParameterValue))
retry=(ORG,tasks[0],WORKER,l1b,a1b,uuid4(),plans[0])
j1b=owner(ENQUEUE,retry)[0][0];assert owner(ENQUEUE,retry)[0][0]==j1b and j1b!=j1
assert count('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(tasks[0],))==2
denied(lambda:owner(REOPEN,(ORG,tasks[0],plans[0],j1b,REASON,uuid4())),psycopg.errors.ObjectNotInPrerequisiteState)  # queued, not failed
denied(lambda:owner(ENQUEUE,step2),psycopg.errors.ObjectNotInPrerequisiteState)  # still gated
report='Disposable CI documentary report [L1-L2]'
assert run_worker(j1b,report=report,error=None)=='completed'
rid=count('SELECT run_id FROM eliot.ai_document_jobs WHERE id=%s',(j1b,))
denied(lambda:owner(ENQUEUE,step2),psycopg.errors.ObjectNotInPrerequisiteState)  # completed is not accepted
owner(REVIEW,(ORG,tasks[0],rid,'accepted','Accepted disposable CI evidence only',uuid4()))
j2=owner(ENQUEUE,step2)[0][0];assert owner(ENQUEUE,step2)[0][0]==j2
assert [s['dependency_satisfied'] for s in mission_steps(m)]==[True,True]
assert mission_steps(m)[0]['job_id']==str(j1b) and mission_steps(m)[0]['review_decision']=='accepted'
assert count('SELECT count(*) FROM eliot.ai_tasks WHERE organization_id=%s',(ORG,))==tasks_before  # no duplicated tasks
assert count('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(tasks[1],))==1

# --- 5. Not recoverable: uncertain provider outcome, source change, cancelled mission, limit.
m2,t2,p2=new_mission()
j,_,_=dispatch(t2[0],p2[0]);assert run_worker(j,error='provider_error')=='needs_review'
denied(lambda:owner(REOPEN,(ORG,t2[0],p2[0],j,REASON,uuid4())),psycopg.errors.ObjectNotInPrerequisiteState)
m3,t3,p3=new_mission()
j,_,_=dispatch(t3[0],p3[0]);assert run_worker(j,error='source_changed',provider=False)=='failed'
denied(lambda:owner(REOPEN,(ORG,t3[0],p3[0],j,REASON,uuid4())),psycopg.errors.ObjectNotInPrerequisiteState)
m4,t4,p4=new_mission()
j,l,_=dispatch(t4[0],p4[0]);assert run_worker(j)=='failed'
rev=next(r[0] for r in owner('SELECT * FROM eliot.my_document_missions(%s)',(ORG,)) if r[0]['id']==str(m4))['mission_control_revision']
owner(CONTROL_M,(ORG,m4,'cancel','Cancelled disposable mission for CI',rev,uuid4()))
denied(lambda:owner(REOPEN,(ORG,t4[0],p4[0],j,REASON,uuid4())),psycopg.errors.ObjectNotInPrerequisiteState)
m5,t5,p5=new_mission()
l=None
for attempt in (1,2,3):
 j,l,_=dispatch(t5[0],p5[0],l);assert run_worker(j)=='failed'
 if attempt<3:assert owner(REOPEN,(ORG,t5[0],p5[0],j,REASON,uuid4()))[0][0]['attempt']==attempt
 else:denied(lambda:owner(REOPEN,(ORG,t5[0],p5[0],j,REASON,uuid4())),psycopg.errors.ObjectNotInPrerequisiteState)

# --- 6. Concurrent reopenings with different keys: exactly one is recorded.
m6,t6,p6=new_mission()
j,l,_=dispatch(t6[0],p6[0]);assert run_worker(j)=='failed';barrier=Barrier(2)
def race(_):
 barrier.wait()
 try:return owner(REOPEN,(ORG,t6[0],p6[0],j,REASON,uuid4()))[0][0]['attempt']
 except psycopg.errors.ObjectNotInPrerequisiteState:return None
with ThreadPoolExecutor(2) as pool:out=list(pool.map(race,range(2)))
assert sorted(out,key=lambda x:x is None)==[1,None]
assert count('SELECT count(*) FROM eliot.ai_document_plan_attempts WHERE plan_id=%s',(p6[0],))==1
print('PG missions 032: failed step reopened once with audit, ordinary dispatch path, one new job, '
      'step 2 gated until acceptance, no duplicated tasks, uncertain/source-changed/cancelled/limit/race rejected')

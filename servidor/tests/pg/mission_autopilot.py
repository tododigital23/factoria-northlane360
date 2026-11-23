"""Disposable PG only (033): Freddy advances an owner-approved mission inside a fixed budget.

Uses the real owner functions and the real worker functions. Verifies that one approval of
the mission replaces per-step lease/approval/dispatch clicks, while human acceptance of each
report, mission controls, the job budget and uncertain-outcome rules still hold.
"""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
CREATE_M='SELECT eliot.owner_create_document_mission(%s,%s,%s,%s)'
GRANT='SELECT eliot.owner_grant_mission_autopilot(%s,%s,%s,%s,%s,%s,%s)'
ADVANCE='SELECT eliot.owner_advance_mission_autopilot(%s,%s)'
REVOKE_='SELECT eliot.owner_revoke_mission_autopilot(%s,%s,%s)'
READ_A='SELECT * FROM eliot.my_mission_autopilot(%s,%s)'
REVIEW='SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)'
CONTROL_M='SELECT eliot.owner_control_document_mission(%s,%s,%s,%s,%s,%s)'
WORKER_ROLE='ci_doc_worker'


def as_worker(sql,args):
 with psycopg.connect('') as c,c.cursor() as cur:
  cur.execute("SET statement_timeout='12s'");cur.execute('SET SESSION AUTHORIZATION '+WORKER_ROLE)
  cur.execute(sql,args);return cur.fetchall() if cur.description else []
def count(sql,args=()):return query(sql,args)[0][0]
def new_mission(n=2):
 tasks=[new_task() for _ in range(n)];plans=[plan(t)[0] for t in tasks]
 m=owner(CREATE_M,(ORG,'Analyse planning and coordination documents in sequence',plans,uuid4()))[0][0]
 return m,tasks,plans
def grant(m,max_jobs=4,objective=False,retry=True,hours=24,key=None):
 return owner(GRANT,(ORG,m,max_jobs,objective,retry,hours,key or uuid4()))[0][0]
def advance(m):return owner(ADVANCE,(ORG,m))[0][0]
def job_of(p):return count('SELECT job_id FROM eliot.ai_document_plans WHERE id=%s',(p,))
def jobs(t):return count('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(t,))
def run_worker(job,report=None,error='invalid_response',provider=True):
 while True:
  claim=as_worker('SELECT * FROM eliot.worker_take_document_job_with_objective(%s)',(ORG,))
  assert claim,'job never claimed'
  if claim[0][0]==job:break
  as_worker('SELECT eliot.worker_finish_document_job(%s,%s,%s,%s,%s)',(ORG,claim[0][0],claim[0][1],None,'rate_limited'))
 token=claim[0][1]
 assert as_worker('SELECT eliot.worker_verify_document_source(%s,%s,%s,%s,%s)',(ORG,job,token,SHA,43))==[(True,)]
 if provider:assert as_worker('SELECT eliot.worker_begin_document_provider(%s,%s,%s)',(ORG,job,token))==[(True,)]
 return as_worker('SELECT eliot.worker_finish_document_job(%s,%s,%s,%s,%s)',(ORG,job,token,report,error))[0][0]
def complete(job):return run_worker(job,report='Disposable CI documentary report [L1-L2]',error=None)
def accept(t,job):
 rid=count('SELECT run_id FROM eliot.ai_document_jobs WHERE id=%s',(job,))
 owner(REVIEW,(ORG,t,rid,'accepted','Accepted disposable CI evidence only',uuid4()))
def reset_budget():
 query('UPDATE eliot.ai_model_budget_daily SET calls_reserved=0,token_units_reserved=0 WHERE organization_id=%s',(ORG,))

reset_budget()
tasks_before=count('SELECT count(*) FROM eliot.ai_tasks WHERE organization_id=%s',(ORG,))

# --- 1. Full cycle: one approval, Freddy dispatches, retries a known failure, waits for acceptance.
m,t,p=new_mission();tasks_before+=2
key=uuid4();g=grant(m,key=key)
assert g['replayed'] is False and g['advance']['stopped']=='job_in_progress'
assert [d['position'] for d in g['advance']['dispatched']]==[1] and job_of(p[1]) is None
j1=job_of(p[0]);assert str(j1)==g['advance']['dispatched'][0]['job_id']
assert count('SELECT document_mode FROM eliot.ai_document_jobs WHERE id=%s',(j1,))=='standard_v1'  # no objective consent
replay=owner(GRANT,(ORG,m,4,False,True,24,key))[0][0]
assert replay['replayed'] is True and replay['advance']['dispatched']==[] and jobs(t[0])==1
assert advance(m)['stopped']=='job_in_progress' and jobs(t[0])==1          # no duplicate while running
assert run_worker(j1)=='failed'                                             # the 9/11 situation
r=advance(m);assert r['dispatched'][0]['kind']=='retry' and r['jobs_dispatched']==2
j1b=job_of(p[0]);assert j1b!=j1 and jobs(t[0])==2
assert count('SELECT count(*) FROM eliot.ai_document_plan_attempts WHERE plan_id=%s',(p[0],))==1
assert complete(j1b)=='completed'
assert advance(m)['stopped']=='awaiting_owner_review' and job_of(p[1]) is None   # human acceptance stays
accept(t[0],j1b)
r=advance(m);assert r['dispatched'][0]['position']==2 and r['jobs_dispatched']==3
j2=job_of(p[1]);assert complete(j2)=='completed'
assert advance(m)['stopped']=='awaiting_owner_review'
accept(t[1],j2)
assert advance(m)['stopped']=='mission_complete' and advance(m)['dispatched']==[]
info=owner(READ_A,(ORG,m))[0][0]
assert info['jobs_dispatched']==3 and [d['kind'] for d in info['dispatches']]==['dispatch','retry','dispatch']
assert count('SELECT count(*) FROM eliot.ai_tasks WHERE organization_id=%s',(ORG,))==tasks_before  # no duplicated tasks

# --- 2. Budget, retry policy and uncertain outcomes.
reset_budget()
m,t,p=new_mission();tasks_before+=2
grant(m,max_jobs=2)
assert run_worker(job_of(p[0]))=='failed';assert advance(m)['dispatched'][0]['kind']=='retry'
assert run_worker(job_of(p[0]))=='failed';r=advance(m)
assert r['stopped']=='budget_exhausted' and r['dispatched']==[] and jobs(t[0])==2
m,t,p=new_mission();tasks_before+=2
grant(m,retry=False);assert run_worker(job_of(p[0]))=='failed'
assert advance(m)['stopped']=='step_failed_not_retryable' and jobs(t[0])==1
m,t,p=new_mission();tasks_before+=2
grant(m);assert run_worker(job_of(p[0]),error='provider_error')=='needs_review'
assert advance(m)['stopped']=='needs_human_investigation' and jobs(t[0])==1
m,t,p=new_mission();tasks_before+=2
grant(m);assert run_worker(job_of(p[0]),error='source_changed',provider=False)=='failed'
assert advance(m)['stopped']=='step_failed_not_retryable'
m,t,p=new_mission();tasks_before+=2
grant(m,max_jobs=6)
for _ in range(2):
 assert run_worker(job_of(p[0]))=='failed';assert advance(m)['dispatched'][0]['kind']=='retry'
assert run_worker(job_of(p[0]))=='failed';assert advance(m)['stopped']=='retry_limit_reached'
m,t,p=new_mission();tasks_before+=2
grant(m);jc=job_of(p[0]);assert complete(jc)=='completed'
rid=count('SELECT run_id FROM eliot.ai_document_jobs WHERE id=%s',(jc,))
owner(REVIEW,(ORG,t[0],rid,'changes_requested','Corrections required on disposable evidence',uuid4()))
assert advance(m)['stopped']=='changes_requested' and job_of(p[1]) is None

# --- 3. Objective consent, controls, revocation, expiry.
reset_budget()
m,t,p=new_mission();tasks_before+=2
grant(m,objective=True)
assert count('SELECT document_mode FROM eliot.ai_document_jobs WHERE id=%s',(job_of(p[0]),))=='objective_v1'
denied(lambda:grant(m),psycopg.errors.ObjectNotInPrerequisiteState)        # one active grant per mission
r=owner(REVOKE_,(ORG,m,'Owner stops autopilot for review'))[0][0];assert r['revoked'] is True
assert count('SELECT state FROM eliot.ai_document_jobs WHERE id=%s',(job_of(p[0]),))=='queued'  # not aborted
assert advance(m)['stopped']=='no_active_autopilot'
assert owner(READ_A,(ORG,m))[0][0]['state']=='revoked'
m,t,p=new_mission();tasks_before+=2
rev=next(x[0] for x in owner('SELECT * FROM eliot.my_document_missions(%s)',(ORG,)) if x[0]['id']==str(m))['mission_control_revision']
owner(CONTROL_M,(ORG,m,'pause','Paused disposable mission for CI',rev,uuid4()))
denied(lambda:grant(m),psycopg.errors.ObjectNotInPrerequisiteState)
owner(CONTROL_M,(ORG,m,'resume','Resumed disposable mission for CI',rev+1,uuid4()))
grant(m);assert run_worker(job_of(p[0]))=='failed'
owner(CONTROL_M,(ORG,m,'pause','Paused disposable mission for CI',rev+2,uuid4()))
assert advance(m)['stopped']=='mission_paused' and jobs(t[0])==1
m,t,p=new_mission();tasks_before+=2
g=grant(m,hours=1);assert run_worker(job_of(p[0]))=='failed'
query('ALTER TABLE eliot.ai_document_mission_autopilots DISABLE TRIGGER guard_autopilot_terms')
query("UPDATE eliot.ai_document_mission_autopilots SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=%s",(g['autopilot_id'],))
query('ALTER TABLE eliot.ai_document_mission_autopilots ENABLE TRIGGER guard_autopilot_terms')
assert advance(m)['stopped']=='autopilot_expired' and jobs(t[0])==1
assert owner(READ_A,(ORG,m))[0][0]['state']=='expired'

# --- 4. A refusal of an existing control rolls back the whole step (no orphan lease/approval).
m,t,p=new_mission();tasks_before+=2
g=grant(m);assert run_worker(job_of(p[0]))=='failed'
query("UPDATE eliot.ai_workers SET operating_state='blocked' WHERE id=%s",(WORKER,))
appr=count('SELECT count(*) FROM eliot.ai_document_approvals WHERE task_id=%s',(t[0],))
leases=count('SELECT count(*) FROM eliot.ai_task_execution_leases WHERE task_id=%s',(t[0],))
r=advance(m);assert r['stopped']=='step_not_eligible' and r['dispatched']==[]
assert count('SELECT count(*) FROM eliot.ai_document_approvals WHERE task_id=%s',(t[0],))==appr
assert count('SELECT count(*) FROM eliot.ai_task_execution_leases WHERE task_id=%s',(t[0],))==leases
assert count('SELECT count(*) FROM eliot.ai_document_plan_attempts WHERE plan_id=%s',(p[0],))==0
query("UPDATE eliot.ai_workers SET operating_state='idle' WHERE id=%s",(WORKER,))
assert advance(m)['dispatched'][0]['kind']=='retry'

# --- 5. Authorization, terms and tenant scope.
m,t,p=new_mission();tasks_before+=2
for terms in ((1,False,True,24),(7,False,True,24),(4,False,True,0),(4,False,True,169)):
 denied(lambda:owner(GRANT,(ORG,m,*terms,uuid4())),psycopg.errors.InvalidParameterValue)
denied(lambda:query(GRANT,(ORG,m,4,False,True,24,uuid4()),role='eliot_identity',subject='test|not-a-member'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(GRANT,(ORG,m,4,False,True,24,uuid4()),role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
denied(lambda:owner(GRANT,(OTHER,m,4,False,True,24,uuid4())),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(GRANT,(ORG,m,4,False,True,24,uuid4()),role='eliot_identity',subject='test|ownerB'),psycopg.errors.InvalidParameterValue)
grant(m)
denied(lambda:query(ADVANCE,(ORG,m),role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(ADVANCE,(ORG,m),role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
for table in ('ai_document_mission_autopilots','ai_document_mission_autopilot_dispatches'):
 denied(lambda:query('SELECT * FROM eliot.'+table,role='eliot_identity'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query('DELETE FROM eliot.ai_document_mission_autopilot_dispatches'),psycopg.errors.ObjectNotInPrerequisiteState)
denied(lambda:query('UPDATE eliot.ai_document_mission_autopilots SET max_jobs=10'),psycopg.errors.ObjectNotInPrerequisiteState)

# --- 6. Concurrent advances after a failure produce exactly one retry job.
m,t,p=new_mission();tasks_before+=2
grant(m);assert run_worker(job_of(p[0]))=='failed';barrier=Barrier(3)
def race(_):
 barrier.wait();return len(advance(m)['dispatched'])
with ThreadPoolExecutor(3) as pool:out=list(pool.map(race,range(3)))
assert sorted(out)==[0,0,1] and jobs(t[0])==2
assert count('SELECT count(*) FROM eliot.ai_tasks WHERE organization_id=%s',(ORG,))==tasks_before
print('PG autopilot 033: one owner approval drives lease/approval/dispatch, safe retries, human acceptance gate, '
      'budget/expiry/revocation/pause, rollback of refused steps, tenant scope and concurrency passed')

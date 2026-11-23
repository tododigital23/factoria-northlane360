"""Real PG18 transactions/roles; disposable CI only, no provider I/O."""
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4
import psycopg
assert os.getenv('ELIOT_TEST_DISPOSABLE_DB') == '1'
ORG=UUID('c0430000-0000-4000-8000-000000000001')
WORKER=UUID('c0430000-0000-4000-8000-000000000003')
DEPT=UUID('c0430000-0000-4000-8000-000000000002')
OWNER=UUID('11111111-1111-4111-8111-111111111111')
OTHER=UUID('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

def query(sql,args=(),subject='test|ownerA',role=None):
 with psycopg.connect('') as c,c.cursor() as cur:
  cur.execute("SET statement_timeout='12s'")
  if role: cur.execute('SET LOCAL ROLE '+role) # fixed test role names only
  cur.execute("SELECT set_config('app.verified_subject',%s,true)",(subject,))
  cur.execute(sql,args)
  return cur.fetchall() if cur.description else []

def denied(fn,exc):
 try: fn()
 except exc: return
 raise AssertionError('Expected '+str(exc))

def run(task=None,status='completed'):
 if task is None:
  task=uuid4()
  query("INSERT INTO eliot.ai_tasks(id,organization_id,department_id,assignee_worker_id,title) VALUES(%s,%s,%s,%s,'Document review CI')",(task,ORG,DEPT,WORKER))
 approval,rid=uuid4(),uuid4()
 query("INSERT INTO eliot.ai_document_approvals(id,organization_id,task_id,worker_id,approved_by,action_key,source_repo,source_path,source_ref,source_sha,state) VALUES(%s,%s,%s,%s,%s,%s,'Nova/project','docs/CI.md','ci',%s,'finished')",(approval,ORG,task,WORKER,OWNER,uuid4(),'a'*40))
 query("INSERT INTO eliot.ai_document_runs(id,organization_id,task_id,worker_id,approval_id,requested_by,request_key,source_repo,source_path,source_ref,source_sha,status,result_text,error_code,finished_at) VALUES(%s,%s,%s,%s,%s,%s,%s,'Nova/project','docs/CI.md','ci',%s,%s,%s,%s,CASE WHEN %s='running' THEN NULL ELSE clock_timestamp() END)",(rid,ORG,task,WORKER,approval,OWNER,uuid4(),'a'*40,status,'Stored documentary evidence' if status=='completed' else None,'provider_error' if status=='failed' else None,status))
 return task,rid

def review(task,rid,decision='accepted',key=None,reason='Reviewed conclusions and source evidence'):
 return query('SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)',(ORG,task,rid,decision,reason,key or uuid4()),role='eliot_identity')[0][0]

def context(task,rid):
 return query('SELECT * FROM eliot.my_document_work_review(%s,%s,%s)',(ORG,task,rid),role='eliot_identity')[0]

t,r=run(); assert context(t,r)[2] is None
key=uuid4(); saved=review(t,r,key=key); assert review(t,r,key=key)==saved
assert context(t,r)[1:5]==('completed','already_reviewed',saved,'accepted')
denied(lambda:query('SELECT eliot.owner_claim_task_lease(%s,%s,%s,%s)',(ORG,t,WORKER,uuid4()),role='eliot_identity'),psycopg.errors.InvalidParameterValue)
assert query("SELECT count(*) FROM eliot.ai_task_events WHERE task_id=%s AND event_type='completed'",(t,))[0][0]==1
denied(lambda:review(t,r,key=key,reason='A different reason for same request'),psycopg.errors.InvalidParameterValue)
denied(lambda:review(t,r),psycopg.errors.ObjectNotInPrerequisiteState)
t,r=run(); review(t,r,'changes_requested'); assert context(t,r)[1]=='blocked'
# Corrective decision never dispatches another job and cannot be overwritten.
assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(t,))[0][0]==0
denied(lambda:review(t,r),psycopg.errors.ObjectNotInPrerequisiteState)
t,r=run(); key=uuid4()
for actor in ('','test|nonmember'):
 denied(lambda:query('SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)',(ORG,t,r,'accepted','Review reason with context',key),subject=actor,role='eliot_identity'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query('SELECT * FROM eliot.my_document_work_review(%s,%s,%s)',(OTHER,t,r),role='eliot_identity'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query('SELECT * FROM eliot.ai_document_work_reviews',role='eliot_identity'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query('SELECT eliot.document_review_unavailable(%s,%s,%s)',(ORG,t,r),role='eliot_identity'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query('SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)',(ORG,t,r,'accepted','Review reason with context',key),role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
# Stale task, changed assignment, blocked/cancelled work and wrong task/run.
t2,r2=run()
denied(lambda:review(t,r2),psycopg.errors.ObjectNotInPrerequisiteState)
query('UPDATE eliot.ai_tasks SET updated_at=clock_timestamp() WHERE id=%s',(t,))
assert context(t,r)[2]=='task_changed'
denied(lambda:review(t,r),psycopg.errors.ObjectNotInPrerequisiteState)
for status in ('blocked','cancelled','completed'):
 t,r=run();query('UPDATE eliot.ai_tasks SET status=%s WHERE id=%s',(status,t))
 denied(lambda:review(t,r),psycopg.errors.ObjectNotInPrerequisiteState)
t,r=run();query('UPDATE eliot.ai_tasks SET assignee_worker_id=NULL WHERE id=%s',(t,))
assert context(t,r)[2]=='task_changed'
# Newer failures invalidate an older successful report too.
t,r=run();run(t,'failed');assert context(t,r)[2]=='newer_attempt'
denied(lambda:review(t,r),psycopg.errors.ObjectNotInPrerequisiteState)
# Uncertainty outside the 20-attempt UI window must still prevent closure.
t,old=run(status='running')
for _ in range(21):run(t,'failed')
_,r=run(t);assert context(t,r)[2]=='unconfirmed_execution'
denied(lambda:review(t,r),psycopg.errors.ObjectNotInPrerequisiteState)
# Failed and title-only/unknown reports are not acceptable documentary evidence.
t,r=run(status='failed');denied(lambda:review(t,r),psycopg.errors.ObjectNotInPrerequisiteState)
t,r=run();denied(lambda:review(t,uuid4()),psycopg.errors.ObjectNotInPrerequisiteState)
# Concurrent opposite decisions serialize on the task; exactly one event/decision.
t,r=run();barrier=Barrier(2)
def race(decision):
 barrier.wait()
 try:return review(t,r,decision)
 except psycopg.errors.ObjectNotInPrerequisiteState:return None
with ThreadPoolExecutor(2) as pool:results=list(pool.map(race,['accepted','changes_requested']))
assert sum(x is not None for x in results)==1
assert query('SELECT count(*) FROM eliot.ai_document_work_reviews WHERE task_id=%s',(t,))[0][0]==1
# A task mutation committed while the reviewer waits must be seen after the lock.
t,r=run()
with psycopg.connect('') as blocker,blocker.cursor() as cur:
 cur.execute('UPDATE eliot.ai_tasks SET updated_at=clock_timestamp() WHERE id=%s',(t,))
 with ThreadPoolExecutor(1) as pool:
  future=pool.submit(review,t,r)
  # Observe the server lock wait rather than sleep-based scheduling.
  for _ in range(200):
   if query("SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT eliot.owner_review_document_work%%'")[0][0]:break
  else:raise AssertionError('Reviewer did not wait for task lock')
  blocker.commit()
  denied(future.result,psycopg.errors.ObjectNotInPrerequisiteState)
assert context(t,r)[2]=='task_changed'
print('Document work reviews: authorization, exact scope, history, retries, audit and concurrent closure passed')

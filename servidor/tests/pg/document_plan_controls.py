"""Disposable PG18: persistent control, idempotency and enqueue races."""
# Reuse fixture functions without rerunning the earlier script's test body.
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
from app.eliot_plan_tracking import summarize
CONTROL='SELECT eliot.owner_control_document_plan(%s,%s,%s,%s,%s,%s,%s)'
def control(t,p,action,revision,key=None,reason='Owner control for documentary plan'):
 args=(ORG,t,p,action,reason,revision,key or uuid4());return owner(CONTROL,args)[0][0],args

t=new_task();p,_=plan(t);l,a=approval(t);key=uuid4();queue=(ORG,t,WORKER,l,a,key,p)
first,request=control(t,p,'pause',0);assert first['recorded_state']=='paused' and first['recorded_revision']==1
assert owner(CONTROL,request)[0][0]==first
item=read(t)[0];assert item['control_available'] and item['control_state']=='paused' and item['control_revision']==1
raw=summarize(ORG,[(t,DEPT,WORKER,'Controlled CI','pending',None)],{str(t):[item]})
assert raw['plans'][0]['state']=='paused' and raw['plans'][0]['can_control']
denied(lambda:owner(ENQUEUE,queue),psycopg.errors.ObjectNotInPrerequisiteState)
assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(t,))[0][0]==0
assert query('SELECT count(*) FROM eliot.ai_document_runs WHERE task_id=%s',(t,))[0][0]==0
assert query('SELECT state FROM eliot.ai_document_approvals WHERE id=%s',(a,))[0][0]=='approved'
# Resume does not enqueue or renew the task snapshot. Old retries cannot pause it again.
resumed,_=control(t,p,'resume',1);assert resumed['recorded_state']=='active'
assert owner(CONTROL,request)[0][0]==first and read(t)[0]['control_state']=='active'
denied(lambda:control(t,p,'pause',0),psycopg.errors.ObjectNotInPrerequisiteState)
changed=list(request);changed[4]='Changed reason with a reused request key'
denied(lambda:owner(CONTROL,tuple(changed)),psycopg.errors.InvalidParameterValue)
# Cancellation is final for this plan and leaves task/worker/approval unchanged.
control(t,p,'cancel',2);assert read(t)[0]['control_state']=='cancelled'
denied(lambda:control(t,p,'resume',3),psycopg.errors.ObjectNotInPrerequisiteState)
denied(lambda:owner(ENQUEUE,queue),psycopg.errors.ObjectNotInPrerequisiteState)
assert query('SELECT status FROM eliot.ai_tasks WHERE id=%s',(t,))[0][0]=='pending'
assert query('SELECT count(*) FROM eliot.ai_document_plan_controls WHERE plan_id=%s',(p,))[0][0]==3
# SQL CHECK also prevents privileged accidental linking of an inactive plan.
denied(lambda:query('UPDATE eliot.ai_document_plans SET job_id=(SELECT id FROM eliot.ai_document_jobs LIMIT 1) WHERE id=%s',(p,)),psycopg.errors.CheckViolation)
# Stale plans may be cancelled, but resume cannot refresh their snapshot.
t2=new_task();p2,_=plan(t2);control(t2,p2,'pause',0)
query('UPDATE eliot.ai_tasks SET updated_at=clock_timestamp() WHERE id=%s',(t2,))
denied(lambda:control(t2,p2,'resume',1),psycopg.errors.ObjectNotInPrerequisiteState)
control(t2,p2,'cancel',1)
# Owner/tenant isolation, no direct runtime access and no worker control grant.
for role in ('eliot_identity','eliot_execution_worker'):
 denied(lambda:query('SELECT * FROM eliot.ai_document_plan_controls',role=role),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(CONTROL,request,role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(CONTROL,request,role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:owner(CONTROL,(OTHER,*request[1:])),psycopg.errors.InsufficientPrivilege)
# Every concurrent pause/enqueue has exactly one winner, and never partial jobs.
for _ in range(3):
 tx=new_task();px,_=plan(tx);lx,ax=approval(tx);barrier=Barrier(2)
 def racer(which):
  barrier.wait()
  try:
   if which=='pause':control(tx,px,'pause',0)
   else:owner(ENQUEUE,(ORG,tx,WORKER,lx,ax,uuid4(),px))
   return which
  except psycopg.errors.ObjectNotInPrerequisiteState:return None
 with ThreadPoolExecutor(2) as pool:results=list(pool.map(racer,['pause','enqueue']))
 assert sum(v is not None for v in results)==1
 saved=read(tx)[0]
 assert (saved['job_id'] is None)==(saved['control_state']=='paused')
 assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(tx,))[0][0]==(0 if saved['job_id'] is None else 1)
 if saved['job_id'] is not None:denied(lambda:control(tx,px,'cancel',0),psycopg.errors.ObjectNotInPrerequisiteState)
print('Plan controls PG18: transitions, audit, idempotency, isolation, stale scope and enqueue races passed')

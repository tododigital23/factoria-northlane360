"""Disposable PG18: global future-dispatch control, races and rollback."""
from pathlib import Path
exec(Path('tests/pg/document_missions.py').read_text().split('\ntasks,plans=new_plans(3)')[0])
CONTROL='SELECT eliot.owner_control_document_mission(%s,%s,%s,%s,%s,%s)'
REASON='Control of disposable CI mission only'
def change(m,action='pause',revision=0,key=None):
 args=(ORG,m,action,REASON,revision,key or uuid4());return owner(CONTROL,args)[0][0],args
def current(m):return next(r[0] for r in owner(READ_M,(ORG,)) if r[0]['id']==str(m))
def jobs(ts):return query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=ANY(%s)',(ts,))[0][0]

ts,ps=new_plans();m,_=mission(ps);l,a=approval(ts[0]);queue=(ORG,ts[0],WORKER,l,a,uuid4(),ps[0])
r,again=change(m);assert r['recorded_state']=='paused' and r['recorded_revision']==1
assert owner(CONTROL,again)[0][0]==r
assert current(m)['mission_control_state']=='paused' and current(m)['last_control']['reason']==REASON
assert not read(ts[0])[0]['mission_dependency_satisfied']
# A paused global mission cannot be bypassed by resuming the individual plan.
individual='SELECT eliot.owner_control_document_plan(%s,%s,%s,%s,%s,%s,%s)'
owner(individual,(ORG,ts[0],ps[0],'pause',REASON,0,uuid4()));owner(individual,(ORG,ts[0],ps[0],'resume',REASON,1,uuid4()))
denied(lambda:owner(ENQUEUE,queue),psycopg.errors.ObjectNotInPrerequisiteState)
assert jobs(ts)==0 and query('SELECT count(*) FROM eliot.ai_document_runs WHERE task_id=%s',(ts[0],))[0][0]==0
assert query('SELECT state FROM eliot.ai_document_approvals WHERE id=%s',(a,))[0][0]=='approved'
# A new revision is required; old retries report old result without replaying state.
denied(lambda:change(m,'resume',0),psycopg.errors.ObjectNotInPrerequisiteState)
change(m,'resume',1);assert owner(CONTROL,again)[0][0]==r and current(m)['mission_control_state']=='active'
assert read(ts[0])[0]['mission_dependency_satisfied'];j=owner(ENQUEUE,queue)[0][0]
# Global cancel preserves queued work and immutable individual plan statuses.
change(m,'cancel',2);assert current(m)['mission_control_state']=='cancelled'
assert query('SELECT state FROM eliot.ai_document_jobs WHERE id=%s',(j,))[0][0]=='queued'
assert query('SELECT control_state FROM eliot.ai_document_plans WHERE id=ANY(%s)',(ps,))==[('active',),('active',)]
assert not read(ts[1])[0]['mission_dependency_satisfied']
denied(lambda:change(m,'resume',3),psycopg.errors.ObjectNotInPrerequisiteState)
assert len(query('SELECT * FROM eliot.ai_document_mission_controls WHERE mission_id=%s',(m,)))==3
# Even after exact predecessor acceptance, cancellation remains the dispatch barrier.
rid=finish_fixture(j);owner('SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)',(ORG,ts[0],rid,'accepted','Accepted CI fixture only',uuid4()))
l2,a2=approval(ts[1]);denied(lambda:owner(ENQUEUE,(ORG,ts[1],WORKER,l2,a2,uuid4(),ps[1])),psycopg.errors.ObjectNotInPrerequisiteState)
assert jobs(ts)==1
# Invalid inputs, conflicting idempotency, tenant/creator/RLS/worker boundaries.
bad=list(again);bad[3]='Different request reason';denied(lambda:owner(CONTROL,bad),psycopg.errors.InvalidParameterValue)
for action,reason,revision in [('stop',REASON,0),('pause','short',0),('pause',REASON,-1),('pause',REASON,2147483647)]:
 denied(lambda:owner(CONTROL,(ORG,m,action,reason,revision,uuid4())),psycopg.errors.InvalidParameterValue)
denied(lambda:owner(CONTROL,(OTHER,m,'pause',REASON,0,uuid4())),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(CONTROL,again,role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
for role in ('eliot_identity','eliot_execution_worker'):
 denied(lambda:query('SELECT * FROM eliot.ai_document_mission_controls',role=role),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(CONTROL,again,role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
# Parallel identical retries create exactly one immutable audit action.
ts,ps=new_plans();m,_=mission(ps);key=uuid4();barrier=Barrier(2)
def retry(_):barrier.wait();return change(m,key=key)[0]
with ThreadPoolExecutor(2) as pool:results=list(pool.map(retry,range(2)))
assert results[0]==results[1]
assert query('SELECT count(*) FROM eliot.ai_document_mission_controls WHERE mission_id=%s',(m,))[0][0]==1
# Concurrent pause/enqueue: if enqueue wins, its job remains; if pause wins,
# the entire attempted job/run/consumed approval transaction rolls back.
for _ in range(6):
 ts,ps=new_plans();m,_=mission(ps);l,a=approval(ts[0]);q=(ORG,ts[0],WORKER,l,a,uuid4(),ps[0]);barrier=Barrier(2)
 def race(which):
  barrier.wait()
  try:return (which,change(m)[0] if which=='pause' else owner(ENQUEUE,q)[0][0])
  except psycopg.errors.ObjectNotInPrerequisiteState:return (which,None)
 with ThreadPoolExecutor(2) as pool:out=dict(pool.map(race,['pause','enqueue']))
 assert out['pause'] is not None and current(m)['mission_control_state']=='paused'
 assert jobs(ts)==(1 if out['enqueue'] else 0)
 if not out['enqueue']:assert query('SELECT state FROM eliot.ai_document_approvals WHERE id=%s',(a,))[0][0]=='approved'
 assert not read(ts[0])[0]['mission_dependency_satisfied']
 denied(lambda:owner(ENQUEUE,(ORG,ts[0],WORKER,l,a,uuid4(),ps[0])),psycopg.errors.ObjectNotInPrerequisiteState)
# Two conflicting controls of the same revision cannot both commit.
ts,ps=new_plans();m,_=mission(ps);barrier=Barrier(2)
def conflict(action):
 barrier.wait()
 try:return change(m,action)[0]
 except psycopg.errors.ObjectNotInPrerequisiteState:return None
with ThreadPoolExecutor(2) as pool:out=list(pool.map(conflict,['pause','cancel']))
assert sum(x is not None for x in out)==1
print('PG18 mission controls: scope, revisions, immutable audit, idempotency, rollback, exact dependencies, no existing-job mutation and concurrent controls/dispatch passed')
# Another active owner of the SAME tenant can inspect, but cannot control creator's mission.
query("INSERT INTO eliot.organization_memberships(organization_id,user_id,role,status) SELECT %s,id,'owner','active' FROM eliot.users WHERE external_subject='test|ownerB' ON CONFLICT DO NOTHING",(ORG,))
denied(lambda:query(CONTROL,(ORG,m,'cancel',REASON,1,uuid4()),role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
# Exhausted missions have no future dispatch to control.
ts,ps=new_plans();done_m,_=mission(ps)
for t,p in zip(ts,ps):
 j,_=enqueue(t,p);rid=finish_fixture(j)
 owner('SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)',(ORG,t,rid,'accepted','Accepted disposable CI evidence only',uuid4()))
denied(lambda:change(done_m),psycopg.errors.ObjectNotInPrerequisiteState)
assert all(s['review_decision']=='accepted' for s in current(done_m)['steps'])

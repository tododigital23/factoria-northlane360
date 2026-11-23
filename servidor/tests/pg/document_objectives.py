"""PG18 disposable only: objective consent snapshots and restricted versioned claims."""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
OBJECTIVE='Evaluate documented traceability within this exact document'
FN='SELECT eliot.owner_enqueue_objective_document_job(%s,%s,%s,%s,%s,%s,%s)'
def worker(sql,args=(),principal='ci_doc_worker'):
 with psycopg.connect('') as c,c.cursor() as cur:
  cur.execute('SET SESSION AUTHORIZATION '+principal)
  cur.execute(sql,args);return cur.fetchall() if cur.description else []
# Expire earlier disposable queued fixtures, then consume only their failed eligibility checks.
query("UPDATE eliot.ai_document_jobs SET valid_until=clock_timestamp()-interval '1 second' WHERE organization_id=%s AND state='queued'",(ORG,))
for _ in range(200):
 if query("SELECT count(*) FROM eliot.ai_document_jobs WHERE organization_id=%s AND state='queued'",(ORG,))[0][0]==0:break
 worker('SELECT * FROM eliot.worker_take_document_job_with_objective(%s)',(ORG,))
assert query("SELECT count(*) FROM eliot.ai_document_jobs WHERE organization_id=%s AND state='queued'",(ORG,))[0][0]==0
t=new_task();p,_=plan(t,objective=OBJECTIVE);l,a=approval(t);args=(ORG,t,WORKER,l,a,uuid4(),p)
j=owner(FN,args)[0][0];assert owner(FN,args)[0][0]==j
saved=query('SELECT document_mode,plan_id_snapshot,plan_objective_snapshot FROM eliot.ai_document_jobs WHERE id=%s',(j,))[0]
assert saved==('objective_v1',p,OBJECTIVE)
# Live plan edits by administrative fixture do not change the committed job's objective.
query('UPDATE eliot.ai_document_plans SET objective=%s WHERE id=%s',('Changed administrative fixture objective',p))
denied(lambda:query('UPDATE eliot.ai_document_jobs SET plan_objective_snapshot=%s WHERE id=%s',('Changed objective',j)),psycopg.errors.ObjectNotInPrerequisiteState)
claim=worker('SELECT * FROM eliot.worker_take_document_job_with_objective(%s)',(ORG,))[0]
assert claim[0]==j and len(claim)==8 and claim[7]=={'mode':'objective_v1','organization_id':str(ORG),'job_id':str(j),'plan_id':str(p),'objective':OBJECTIVE}
assert worker('SELECT * FROM eliot.worker_take_document_job_with_objective(%s)',(ORG,))==[]
for principal in ('ci_doc_other',):
 denied(lambda:worker('SELECT * FROM eliot.worker_take_document_job_with_objective(%s)',(ORG,),principal),psycopg.errors.InsufficientPrivilege)
denied(lambda:worker('SELECT * FROM eliot.worker_take_document_job(%s)',(ORG,)),psycopg.errors.InsufficientPrivilege)
denied(lambda:query('SELECT * FROM eliot.worker_take_document_job_with_objective(%s)',(ORG,),role='eliot_identity'),psycopg.errors.InsufficientPrivilege)
denied(lambda:worker(FN,args),psycopg.errors.InsufficientPrivilege)
# Earlier/standard consent cannot be retrofitted, nor linked to another task/plan.
t2=new_task();p2,_=plan(t2);l2,a2=approval(t2);args2=(ORG,t2,WORKER,l2,a2,uuid4(),p2)
j2=owner(ENQUEUE,args2)[0][0]
denied(lambda:owner(FN,args2),psycopg.errors.ObjectNotInPrerequisiteState)
claim2=worker('SELECT * FROM eliot.worker_take_document_job_with_objective(%s)',(ORG,))[0]
assert claim2[0]==j2 and claim2[7]=={'mode':'standard_v1'}
# Paused plans cannot enqueue an objective job or consume a fresh approval.
t3=new_task();p3,_=plan(t3);l3,a3=approval(t3)
owner('SELECT eliot.owner_control_document_plan(%s,%s,%s,%s,%s,%s,%s)',(ORG,t3,p3,'pause','Review objective before proceeding',0,uuid4()))
denied(lambda:owner(FN,(ORG,t3,WORKER,l3,a3,uuid4(),p3)),psycopg.errors.ObjectNotInPrerequisiteState)
assert query('SELECT state FROM eliot.ai_document_approvals WHERE id=%s',(a3,))[0][0]=='approved'
assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(t3,))[0][0]==0
# Concurrent identical retries retain exactly one immutable objective job.
t4=new_task();p4,_=plan(t4);l4,a4=approval(t4);args4=(ORG,t4,WORKER,l4,a4,uuid4(),p4);barrier=Barrier(2)
def repeat(_):
 barrier.wait();return owner(FN,args4)[0][0]
with ThreadPoolExecutor(2) as pool:ids=list(pool.map(repeat,range(2)))
assert ids[0]==ids[1]
assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(t4,))[0][0]==1
denied(lambda:query(FN,args4,role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
print('PG18 objective consent: immutable snapshot, one versioned claim, principal isolation, legacy consent and pause rollback passed')

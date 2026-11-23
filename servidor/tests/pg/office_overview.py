"""Disposable PG18: existing readers feed the office without mutating jobs."""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
from app.eliot_office_overview import summarize,MAX_TASKS
before=query('SELECT count(*) FROM eliot.ai_document_jobs')[0][0]
departments=owner('SELECT department_id,department_name FROM eliot.my_departments(%s)',(ORG,))
workers=owner('SELECT worker_id,department_id,worker_name,specialty,worker_state FROM eliot.my_workers(%s)',(ORG,))
tasks=owner('SELECT task_id,department_id,assignee_worker_id,task_title,task_status,created_at FROM eliot.my_tasks(%s)',(ORG,))
histories={};leases={};reviews={}
for t in tasks[:MAX_TASKS]:
 key=str(t[0]);rows=owner('SELECT * FROM eliot.my_document_jobs(%s,%s)',(ORG,t[0]));histories[key]=rows
 if not rows:continue
 l=owner('SELECT * FROM eliot.my_task_execution_lease(%s,%s)',(ORG,t[0]));leases[key]=l[0] if l else None
 latest=max(rows,key=lambda r:(r[4],str(r[0])))
 if latest[3]=='completed':
  r=owner('SELECT decision FROM eliot.my_document_work_review(%s,%s,%s)',(ORG,t[0],latest[1]));reviews[key]=r[0][0] if r else 'unavailable'
r=summarize(ORG,departments,workers,tasks,histories,leases,reviews)
assert r['organization_id']==str(ORG) and r['read_only'] and not r['provider_called'] and not r['source_fetched'] and not r['worker_online_verified']
assert r['sample']['not_full_company_census'] and r['sample']['tasks_scanned']<=MAX_TASKS
assert query('SELECT count(*) FROM eliot.ai_document_jobs')[0][0]==before
assert 'claim_token' not in str(r) and 'result_text' not in str(r) and 'plan_objective_snapshot' not in str(r)
print('PG18 office: scoped existing reader shapes, metadata-only projection, bounded sample and no writes passed')

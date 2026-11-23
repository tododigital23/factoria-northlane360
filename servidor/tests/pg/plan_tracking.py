"""Read real plan/job records left by disposable PG18 concurrency fixtures."""
import os
from uuid import UUID
import psycopg
from app.eliot_plan_tracking import MAX_TASKS,summarize
assert os.getenv('ELIOT_TEST_DISPOSABLE_DB')=='1'
org=UUID('c0430000-0000-4000-8000-000000000001')
with psycopg.connect('') as conn,conn.cursor() as cur:
 cur.execute('SET LOCAL ROLE eliot_identity')
 cur.execute("SELECT set_config('app.verified_subject','test|ownerA',true)")
 cur.execute('SELECT task_id,department_id,assignee_worker_id,task_title,task_status,created_at FROM eliot.my_tasks(%s)',(org,));tasks=cur.fetchall()
 cur.execute('SELECT worker_id,worker_name FROM eliot.my_workers(%s)',(org,));workers={str(r[0]):r[1] for r in cur.fetchall()}
 cur.execute('SELECT department_id,department_name FROM eliot.my_departments(%s)',(org,));departments={str(r[0]):r[1] for r in cur.fetchall()}
 histories={}
 for t in tasks[:MAX_TASKS]:
  cur.execute('SELECT * FROM eliot.my_document_plans(%s,%s)',(org,t[0]));histories[str(t[0])]=[r[0] for r in cur.fetchall()]
 raw=summarize(org,tasks,histories,workers,departments)
 assert raw['enabled'] and raw['plans'] and raw['read_only'] and not raw['provider_called']
 assert raw['counts_in_visible_sample']['queued']>=1 and raw['counts_in_visible_sample']['outdated']>=1
 assert all(p['worker_name']=='Durable CI worker' for p in raw['plans'])
 assert all(p['state']!='accepted' for p in raw['plans'])
 assert all(p['steps'][1]['state']!='completed' for p in raw['plans'])
 cur.execute('SELECT count(*) FROM eliot.my_document_plans(%s,%s)',(org,tasks[0][0]));cur.fetchone()
print('Plan monitor: real scoped PG18 plan/job metadata and no fabricated completion passed')

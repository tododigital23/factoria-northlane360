"""Disposable PG18 only: same review is idempotent; competitors cannot fork generations."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID,uuid4
import psycopg

ORG=UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
TASK=UUID('77777777-7777-4777-8777-777777777777')
WORKER=UUID('55555555-5555-4555-8555-555555555555')
REASON='Confirmed historical result; explicit new reservation'

def identify(cur):
    cur.execute('SET LOCAL ROLE eliot_identity')
    cur.execute("SELECT set_config('app.verified_subject','test|ownerA',true)")

def current():
    with psycopg.connect('') as conn,conn.cursor() as cur:
        identify(cur)
        cur.execute('SELECT lease_id FROM eliot.my_task_execution_lease(%s,%s)',(ORG,TASK))
        return cur.fetchone()[0]

def parallel(previous,keys):
    barrier=Barrier(2)
    def renew(key):
        try:
            with psycopg.connect('') as conn,conn.cursor() as cur:
                identify(cur);cur.execute("SET LOCAL statement_timeout='10s'")
                barrier.wait(timeout=10)
                cur.execute('SELECT eliot.owner_review_and_renew_lease(%s,%s,%s,%s,%s,%s)',
                            (ORG,TASK,previous,WORKER,REASON,key))
                return ('ok',cur.fetchone()[0])
        except psycopg.errors.InvalidParameterValue:
            return ('conflict',None)
    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(renew,keys))

old=current();key=uuid4()
rows=parallel(old,[key,key])
assert all(row[0]=='ok' for row in rows) and rows[0][1]==rows[1][1],rows
fresh=rows[0][1]
assert fresh!=old and current()==fresh
with psycopg.connect('') as conn,conn.cursor() as cur:
    identify(cur)
    cur.execute('SELECT eliot.owner_release_task_lease(%s,%s,%s)',(ORG,TASK,fresh))
rows=parallel(fresh,[uuid4(),uuid4()])
assert sorted(row[0] for row in rows)==['conflict','ok'],rows
with psycopg.connect('') as conn,conn.cursor() as cur:
    cur.execute("SELECT count(*) FROM eliot.ai_task_execution_leases WHERE organization_id=%s AND task_id=%s AND state='held'",(ORG,TASK))
    assert cur.fetchone()[0]==1
    cur.execute('SELECT count(*) FROM eliot.ai_lease_reviews WHERE organization_id=%s AND task_id=%s',(ORG,TASK))
    assert cur.fetchone()[0]==2
    cur.execute('SELECT count(*) FROM eliot.ai_github_tool_invocations i JOIN eliot.ai_task_execution_leases l ON l.organization_id=i.organization_id AND l.lease_id=i.lease_id WHERE i.organization_id=%s AND i.task_id=%s AND l.lease_id=%s',(ORG,TASK,old))
    assert cur.fetchone()[0]==1
print('PG18 lease review concurrency: one successor per previous lease; historical links preserved')

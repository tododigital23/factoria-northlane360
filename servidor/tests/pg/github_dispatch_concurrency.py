"""Run only against disposable PG18 CI fixtures. No external calls."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4
import psycopg

ORG=UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
TASK=UUID('77777777-7777-4777-8777-777777777777')
WORKER=UUID('55555555-5555-4555-8555-555555555555')
REPO='tu-organizacion/factoria-northlane360'
PATH='docs/ARCHITECTURE.md'
KEY=uuid4()

def identify(cur):
    cur.execute('SET LOCAL ROLE eliot_identity')
    cur.execute("SELECT set_config('app.verified_subject','test|ownerA',true)")

with psycopg.connect('') as conn, conn.cursor() as cur:
    identify(cur)
    cur.execute('SELECT eliot.owner_claim_task_lease(%s,%s,%s,%s)',(ORG,TASK,WORKER,uuid4()))
    lease=cur.fetchone()[0]
    cur.execute('SELECT eliot.owner_approve_github_read(%s,%s,%s,%s,%s,%s,%s,%s)',
                (ORG,TASK,WORKER,lease,REPO,PATH,'a'*40,uuid4()))
    grant=cur.fetchone()[0]
barrier=Barrier(2)

def claim():
    with psycopg.connect('') as conn, conn.cursor() as cur:
        identify(cur)
        cur.execute("SET LOCAL statement_timeout='10s'")
        barrier.wait(timeout=10)
        cur.execute('SELECT * FROM eliot.owner_start_github_invocation(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (ORG,TASK,WORKER,grant,lease,REPO,PATH,'a'*40,KEY))
        return cur.fetchone()

with ThreadPoolExecutor(max_workers=2) as pool:
    rows=list(pool.map(lambda _:claim(),range(2)))
assert rows[0][0]==rows[1][0], rows
assert sorted(row[1] for row in rows)==[False,True], rows
with psycopg.connect('') as conn, conn.cursor() as cur:
    identify(cur)
    cur.execute('SELECT * FROM eliot.my_github_invocations(%s,%s)',(ORG,TASK))
    assert len(cur.fetchall())==1
print('PG18 concurrent claims: exactly one dispatch authorized; replay did not execute')

# Exercise the review endpoint's exact transaction mode against real PG18.
# This also proves that local identity settings work in a read-only snapshot.
with psycopg.connect('') as conn, conn.cursor() as cur:
    cur.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    identify(cur)
    cur.execute('SELECT lease_id,worker_id,lease_state,acquired_at,expires_at FROM eliot.my_task_execution_lease(%s,%s)', (ORG,TASK))
    current=cur.fetchone()
    assert current[0]==lease and current[1]==WORKER and current[2]=='held'
    cur.execute('SELECT invocation_id,invocation_status FROM eliot.my_github_invocations(%s,%s)',(ORG,TASK))
    attempts=cur.fetchall()
    assert len(attempts)==1 and attempts[0][1]=='claimed'
print('PG18 review: tenant-scoped identity and readers work in a read-only repeatable snapshot')

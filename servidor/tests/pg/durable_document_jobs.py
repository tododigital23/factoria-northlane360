"""Disposable CI PG18 only. Real sessions, locks, roles and durable state."""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID, uuid4
import psycopg

assert os.getenv("ELIOT_TEST_DISPOSABLE_DB") == "1", "Disposable CI database required"
ORG = UUID("c0430000-0000-4000-8000-000000000001")
OTHER = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
WORKER = UUID("c0430000-0000-4000-8000-000000000003")
DEPT = UUID("c0430000-0000-4000-8000-000000000002")
OWNER = UUID("11111111-1111-4111-8111-111111111111")
SHA = "a" * 40
REPO = "tu-organizacion/factoria-northlane360"


def query(sql, args=(), *, principal=None, owner=False):
    with psycopg.connect("") as conn, conn.cursor() as cur:
        cur.execute("SET statement_timeout='12s'")
        if principal:
            cur.execute("SET SESSION AUTHORIZATION " + principal)  # fixed CI names only
        if owner:
            cur.execute("SET LOCAL ROLE eliot_identity")
            cur.execute("SELECT set_config('app.verified_subject','test|ownerA',true)")
        cur.execute(sql, args)
        return cur.fetchall() if cur.description else []


def denied(fn, exc):
    try:
        fn()
    except exc:
        return
    raise AssertionError("Expected denial: " + str(exc))


def queued():
    task, key = uuid4(), uuid4()
    query("INSERT INTO eliot.ai_tasks(id,organization_id,department_id,assignee_worker_id,title)"
          " VALUES(%s,%s,%s,%s,'Durable CI review')", (task, ORG, DEPT, WORKER))
    lease = query("SELECT eliot.owner_claim_task_lease(%s,%s,%s,%s)",
                  (ORG, task, WORKER, uuid4()), owner=True)[0][0]
    approval = query("SELECT eliot.owner_approve_document_analysis(%s,%s,%s,%s,%s,%s,%s,%s)",
        (ORG, task, WORKER, REPO, "docs/CI.md", "ci", SHA, uuid4()), owner=True)[0][0]
    args = (ORG, task, WORKER, lease, approval, key)
    job = query("SELECT eliot.owner_enqueue_document_job(%s,%s,%s,%s,%s,%s)", args, owner=True)[0][0]
    again = query("SELECT eliot.owner_enqueue_document_job(%s,%s,%s,%s,%s,%s)", args, owner=True)[0][0]
    assert job == again
    assert query("SELECT count(*) FROM eliot.ai_document_jobs WHERE id=%s", (job,))[0][0] == 1
    return dict(task=task, id=job, lease=lease, approval=approval, key=key)


def take():
    return query("SELECT * FROM eliot.worker_take_document_job(%s)", (ORG,), principal="ci_doc_worker")


def verify(job, claim):
    assert query("SELECT eliot.worker_verify_document_source(%s,%s,%s,%s,%s)",
                 (ORG, job["id"], claim[1], SHA, 12), principal="ci_doc_worker") == [(True,)]


def begin(job, claim):
    return query("SELECT eliot.worker_begin_document_provider(%s,%s,%s)",
                 (ORG, job["id"], claim[1]), principal="ci_doc_worker")


def finish(job, claim, report=None, error="rate_limited"):
    return query("SELECT eliot.worker_finish_document_job(%s,%s,%s,%s,%s)",
        (ORG, job["id"], claim[1], report, error), principal="ci_doc_worker")


def status(job):
    return query("SELECT state FROM eliot.ai_document_jobs WHERE id=%s", (job["id"],))[0][0]


# Explicit test-only principals. Migration provisions NO application credential.
query("INSERT INTO eliot.organizations(id,name) VALUES(%s,'Durable job CI')", (ORG,))
query("INSERT INTO eliot.organization_memberships(organization_id,user_id,role,status)"
      " VALUES(%s,%s,'owner','active')", (ORG, OWNER))
query("INSERT INTO eliot.departments(id,organization_id,name) VALUES(%s,%s,'Development')", (DEPT, ORG))
query("INSERT INTO eliot.ai_workers(id,organization_id,department_id,display_name,specialty,operating_state)"
      " VALUES(%s,%s,%s,'Durable CI worker','Software','idle')", (WORKER, ORG, DEPT))
query("CREATE ROLE ci_doc_worker LOGIN")
query("CREATE ROLE ci_doc_other LOGIN")
query("CREATE ROLE ci_doc_same_org LOGIN")
query("GRANT eliot_execution_worker TO ci_doc_worker,ci_doc_other,ci_doc_same_org")
for name, org in (("ci_doc_worker", ORG), ("ci_doc_other", OTHER), ("ci_doc_same_org", ORG)):
    query("INSERT INTO eliot.ai_execution_principals(principal,organization_id,enabled)"
          " VALUES(%s,%s,true)", (name, org))
denied(lambda: query("SELECT * FROM eliot.ai_document_jobs", principal="ci_doc_worker"),
       psycopg.errors.InsufficientPrivilege)
denied(lambda: query("SELECT * FROM eliot.worker_take_document_job(%s)", (ORG,), owner=True),
       psycopg.errors.InsufficientPrivilege)
denied(lambda: query("SELECT * FROM eliot.worker_take_document_job(%s)", (ORG,), principal="ci_doc_other"),
       psycopg.errors.InsufficientPrivilege)
for name in ("document_job_eligible(uuid)", "finish_document_job_internal(uuid,text,text,text)"):
    assert query("SELECT has_function_privilege('ci_doc_worker',%s,'EXECUTE')",
                 ("eliot." + name,)) == [(False,)]

# Two actual worker sessions race for the same queued task.
job = queued()
barrier = Barrier(2)
def contender(_):
    barrier.wait(timeout=10)
    return take()
with ThreadPoolExecutor(max_workers=2) as pool:
    rows = list(pool.map(contender, (1, 2)))
assert sorted(len(row) for row in rows) == [0, 1], rows
claim = next(row[0] for row in rows if row)
assert claim[0] == job["id"]
assert take() == []
denied(lambda: query("SELECT eliot.worker_verify_document_source(%s,%s,%s,%s,%s)",
       (ORG, job["id"], uuid4(), SHA, 12), principal="ci_doc_worker"), psycopg.errors.InsufficientPrivilege)
denied(lambda: query("SELECT eliot.worker_verify_document_source(%s,%s,%s,%s,%s)",
       (ORG, job["id"], claim[1], SHA, 12), principal="ci_doc_same_org"), psycopg.errors.InsufficientPrivilege)
verify(job, claim)
assert begin(job, claim) == [(True,)]
assert begin(job, claim) == [(False,)]
assert query("SELECT count(*) FROM eliot.ai_model_budget_reservations WHERE request_key=%s",
             (job["id"],)) == [(1,)]
assert query("SELECT eliot.worker_reconcile_document_budget(%s,%s,%s,100,50)",
             (ORG, job["id"], claim[1]), principal="ci_doc_worker") == [(True,)]
assert query("SELECT eliot.worker_reconcile_document_budget(%s,%s,%s,100,50)",
             (ORG, job["id"], claim[1]), principal="ci_doc_worker") == [(True,)]
denied(lambda: query("SELECT eliot.worker_reconcile_document_budget(%s,%s,%s,999,50)",
       (ORG, job["id"], claim[1]), principal="ci_doc_worker"), psycopg.errors.InvalidParameterValue)
assert finish(job, claim, "Review of exact source [L1]", None) == [("completed",)]
assert query("SELECT status FROM eliot.ai_tasks WHERE id=%s", (job["task"],)) == [("pending",)]
assert query("SELECT run_status FROM eliot.my_document_runs(%s,%s)",
             (ORG, job["task"]), owner=True) == [("completed",)]

# Safe cancellation before claim: no provider, no requeue.
job = queued()
assert query("SELECT eliot.owner_cancel_document_job(%s,%s)", (ORG, job["id"]), owner=True) == [("cancelled",)]
assert take() == []
assert status(job) == "cancelled"

# Revoked owner is checked again by the service before source access.
job = queued()
query("UPDATE eliot.organization_memberships SET status='suspended'"
      " WHERE organization_id=%s AND user_id=%s", (ORG, OWNER))
assert take() == []
assert status(job) == "failed"
query("UPDATE eliot.organization_memberships SET status='active'"
      " WHERE organization_id=%s AND user_id=%s", (ORG, OWNER))

# Source and model gates are distinct; a disabled binding denies the second.
job = queued()
claim = take()[0]
verify(job, claim)
query("UPDATE eliot.ai_execution_principals SET enabled=false WHERE principal='ci_doc_worker'")
denied(lambda: begin(job, claim), psycopg.errors.InsufficientPrivilege)
query("UPDATE eliot.ai_execution_principals SET enabled=true WHERE principal='ci_doc_worker'")
query("UPDATE eliot.ai_task_execution_leases SET acquired_at=clock_timestamp()-interval '20 minutes',"
      " expires_at=clock_timestamp()-interval '1 second'"
      " WHERE organization_id=%s AND lease_id=%s", (ORG, job["lease"]))
assert begin(job, claim) == [(False,)]
assert finish(job, claim) == [("failed",)]

# Legacy execution cannot finish a queued job or create another execution.
job = queued()
run = query("SELECT run_id FROM eliot.ai_document_jobs WHERE id=%s", (job["id"],))[0][0]
denied(lambda: query("SELECT eliot.owner_finish_document_run(%s,%s,'failed',NULL,'internal_error')",
       (ORG, run), owner=True), psycopg.errors.ObjectNotInPrerequisiteState)
extra = query("SELECT eliot.owner_approve_analysis_draft(%s,%s,%s,%s)",
              (ORG, job["task"], WORKER, uuid4()), owner=True)[0][0]
denied(lambda: query("SELECT * FROM eliot.owner_claim_analysis_run(%s,%s,%s,%s)",
       (ORG, job["task"], extra, uuid4()), owner=True), psycopg.errors.ObjectNotInPrerequisiteState)
claim = take()[0]
verify(job, claim)
assert begin(job, claim) == [(True,)]
assert finish(job, claim, None, "provider_error") == [("needs_review",)]
assert status(job) == "needs_review"
assert take() == []  # No reclaim, even for a different process.
assert query("SELECT status FROM eliot.ai_document_runs WHERE id=%s", (run,)) == [("running",)]

# Cancelling a claimed job stops the model, but never invents an undo.
job = queued()
claim = take()[0]
verify(job, claim)
assert query("SELECT eliot.owner_cancel_document_job(%s,%s)", (ORG, job["id"]), owner=True) == [("cancellation_requested",)]
assert begin(job, claim) == [(False,)]
assert finish(job, claim) == [("failed",)]

# Cancelling after the durable dispatch gate preserves a real returned report.
job = queued()
claim = take()[0]
verify(job, claim)
assert begin(job, claim) == [(True,)]
assert query("SELECT eliot.owner_cancel_document_job(%s,%s)", (ORG, job["id"]), owner=True) == [("cancellation_requested",)]
assert finish(job, claim, "Real returned result [L1]", None) == [("completed",)]
assert query("SELECT cancel_requested FROM eliot.ai_document_jobs WHERE id=%s",
             (job["id"],)) == [(True,)]

# Service restart cannot claim a previous process's unresolved execution.
job = queued()
claim = take()[0]
query("UPDATE eliot.ai_document_jobs SET claimed_at=clock_timestamp()-interval '3 minutes'"
      " WHERE id=%s", (job["id"],))
assert take() == []
assert query("SELECT attention_required FROM eliot.my_document_jobs(%s,%s)",
             (ORG, job["task"]), owner=True) == [(True,)]
verify(job, claim)
assert finish(job, claim) == [("failed",)]

# Durable quota is shared with the old synchronous path.
job = queued()
claim = take()[0]
verify(job, claim)
query("UPDATE eliot.ai_task_execution_leases SET expires_at=clock_timestamp()+interval '150 milliseconds'"
      " WHERE organization_id=%s AND lease_id=%s", (ORG, job["lease"]))
with psycopg.connect("") as blocker, blocker.cursor() as cur:
    cur.execute("SELECT 1 FROM eliot.ai_model_budget_daily WHERE organization_id=%s FOR UPDATE", (ORG,))
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(begin, job, claim)
        time.sleep(0.3)
        blocker.commit()
        assert pending.result(timeout=10) == [(False,)]
assert finish(job, claim) == [("failed",)]

# Durable quota is shared with the old synchronous path.
job = queued()
claim = take()[0]
verify(job, claim)
query("UPDATE eliot.ai_model_budget_daily SET calls_reserved=30"
      " WHERE organization_id=%s AND day_utc=(now() AT TIME ZONE 'UTC')::date", (ORG,))
assert begin(job, claim) == [(False,)]
assert finish(job, claim) == [("failed",)]
assert query("SELECT count(*) FROM eliot.ai_model_budget_reservations WHERE request_key=%s",
             (job["id"],)) == [(0,)]
print("PG18 durable jobs: session isolation, idempotency, concurrent claim, one dispatch, "
      "legacy guards, cancellation, revoked owner, expiry, budget and no ambiguous replay passed")


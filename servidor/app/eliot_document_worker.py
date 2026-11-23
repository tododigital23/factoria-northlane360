"""Independent, opt-in durable document worker. No user JWTs, retries or recovery.

Run: python -m app.eliot_document_worker --once
Production polling: python -m app.eliot_document_worker
A crash leaves a persisted claim for human review, never a fresh provider call.
"""
import argparse
import logging
import os
import time
from uuid import UUID

import psycopg

from app.eliot_document_analysis import documentary_enabled, generate_document_report
from app.eliot_github_dispatch import verify_document, InvalidToolDocument
from app.eliot_github_reader import read_document, GitHubSourceError

log = logging.getLogger("eliot.document_worker")


def allowed_organizations():
    if os.getenv("ELIOT_DOCUMENT_WORKER_ENABLED") != "true":
        return ()
    try:
        values = tuple(UUID(s.strip()) for s in os.getenv(
            "ELIOT_DURABLE_DOCUMENT_ALLOWED_ORGANIZATIONS", "").split(",") if s.strip())
    except ValueError:
        raise RuntimeError("Invalid worker organization configuration") from None
    return tuple(org for org in values if documentary_enabled(str(org)))


def db_params():
    from app import eliot_db
    return {k: v for k, v in eliot_db.worker_params().items() if k != "engine"}


class Store:
    def call(self, sql, args):
        # A return value is usable only after the connection/transaction commit.
        with psycopg.connect(**db_params()) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, args)
                row = cur.fetchone()
        return row

    def take(self, org):
        v2=self.call("SELECT to_regprocedure('eliot.worker_take_document_job_with_objective(uuid)')",())
        use_objective=bool(v2 and v2[0])
        sql="SELECT * FROM eliot.worker_take_document_job_with_objective(%s)" if use_objective else "SELECT * FROM eliot.worker_take_document_job(%s)"
        row = self.call(sql, (org,))
        if row is None:
            return None
        if len(row) != (8 if use_objective else 7) or not all(isinstance(row[i], UUID) for i in (0, 1)):
            raise RuntimeError("Worker claim unconfirmed")
        job=dict(zip(("id", "token", "title", "repository", "path", "ref", "sha"), row[:7]))
        if use_objective:
            context=row[7]
            if not isinstance(context,dict) or context.get('mode') not in {'standard_v1','objective_v1'}:raise RuntimeError('Invalid objective context')
            if context['mode']=='objective_v1':
                if context.get('organization_id')!=str(org) or context.get('job_id')!=str(job['id']):raise RuntimeError('Wrong objective scope')
                try:UUID(context['plan_id'])
                except (KeyError,ValueError,TypeError,AttributeError):raise RuntimeError('Invalid objective plan') from None
                if not isinstance(context.get('objective'),str) or not 10<=len(context['objective'].strip())<=1000:raise RuntimeError('Invalid objective')
                job.update(approved_plan_id=context['plan_id'],approved_objective=context['objective'])
            elif set(context)!={'mode'}:raise RuntimeError('Unexpected standard objective')
        return job

    def verified(self, org, job, count):
        row = self.call("SELECT eliot.worker_verify_document_source(%s,%s,%s,%s,%s)",
                        (org, job["id"], job["token"], job["sha"], count))
        if row != (True,):
            raise RuntimeError("Source step unconfirmed")

    def finish(self, org, job, report, reason):
        row = self.call("SELECT eliot.worker_finish_document_job(%s,%s,%s,%s,%s)",
                        (org, job["id"], job["token"], report, reason))
        if not row or row[0] not in ("completed", "failed", "needs_review"):
            raise RuntimeError("Job result unconfirmed")
        return row[0]


def company_on_break(org, store):
    """040: ¿está la empresa en descanso? Sin la migración, o si no se puede saber, no lo está."""
    try:
        row = store.call("SELECT to_regprocedure('eliot.company_on_break(uuid)')", ())
        if not row or not row[0]:
            return False
        row = store.call("SELECT eliot.company_on_break(%s)", (org,))
        return bool(row and row[0] is True)
    except Exception:
        return False


def run_due_routines(org, store):
    """034: materialize due recurring tasks for THIS company only. Never executes them.

    Returns the number of pending tasks created, or None when 034 is not installed.
    """
    row = store.call("SELECT to_regprocedure('eliot.worker_run_due_routines(uuid)')", ())
    if not row or not row[0]:
        return None
    if company_on_break(org, store):
        return 0              # en descanso tampoco se crean tareas recurrentes; se crearán al volver
    row = store.call("SELECT eliot.worker_run_due_routines(%s)", (org,))
    if not row or type(row[0]) is not int or row[0] < 0:
        raise RuntimeError("Routine materialization unconfirmed")
    return row[0]


ROUTINE_INTERVAL_SECONDS = 600


class JobBudget:
    """The model's reservation is the durable one-time provider dispatch gate."""
    def __init__(self, store, org, job):
        self.store, self.org, self.job = store, org, job
        self.reserved = False

    def reserve(self, organization_id, subject, request_key):
        if str(self.org) != organization_id or request_key != self.job["id"] or self.reserved:
            return False, None
        row = self.store.call(
            "SELECT eliot.worker_begin_document_provider(%s,%s,%s)",
            (self.org, self.job["id"], self.job["token"]))
        self.reserved = row == (True,)
        return self.reserved, self.job["id"] if self.reserved else None

    def reconcile(self, organization_id, subject, key, response):
        if not self.reserved or key != self.job["id"] or organization_id != str(self.org):
            return False
        usage = response.get("usage")
        if not isinstance(usage, dict):
            return False
        inp, out = usage.get("input_tokens"), usage.get("output_tokens")
        if any(type(x) is not int or not 0 <= x <= 1000000 for x in (inp, out)):
            return False
        row = self.store.call(
            "SELECT eliot.worker_reconcile_document_budget(%s,%s,%s,%s,%s)",
            (self.org, key, self.job["token"], inp, out))
        return row == (True,)


def process_one(org, store=None):
    """At most one read and one model attempt. Never retry any failed claim/gate."""
    if org not in allowed_organizations():
        return "disabled"
    store = store if store is not None else Store()
    if company_on_break(org, store):
        return "on_break"     # 040: el propietario ha mandado a esta empresa a descansar; no se toma trabajo
    job = store.take(org)  # Commit uncertainty propagates; no external I/O.
    if job is None:
        return "idle"
    try:
        document = read_document(str(org), job["repository"], job["path"])
        count = verify_document(document, job["repository"], job["path"], job["sha"])
        if document["ref"] != job["ref"]:
            raise InvalidToolDocument("revision_mismatch")
    except (GitHubSourceError, InvalidToolDocument) as exc:
        reason = "source_changed" if isinstance(exc, InvalidToolDocument) else "source_unavailable"
        return store.finish(org, job, None, reason)
    store.verified(org, job, count)  # Must commit before reserving provider dispatch.
    budget = JobBudget(store, org, job)
    try:
        report, reason = generate_document_report(
            str(org), job["title"], document, request_key=job["id"], budget_store=budget,
            **({k:job[k] for k in ('approved_objective','approved_plan_id')} if 'approved_objective' in job else {}))
    except Exception:
        # Never log exception text: it could contain provider/source material.
        report, reason = None, "internal_error"
    return store.finish(org, job, report, reason if report is None else None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    organizations = allowed_organizations()
    if not organizations:
        log.error("document_worker_disabled_or_unconfigured")
        return 1
    last_routines = 0.0
    while True:
        if time.monotonic() - last_routines >= ROUTINE_INTERVAL_SECONDS:
            last_routines = time.monotonic()
            for org in organizations:
                try:
                    log.info("routine_tasks_created=%s", run_due_routines(org, Store()))
                except Exception:
                    # Task creation only; a failure never blocks document jobs.
                    log.error("routine_materialization_unconfirmed")
        for org in organizations:
            try:
                result = process_one(org)
                log.info("document_worker_result=%s", result)
            except Exception:
                log.error("document_worker_storage_or_result_unconfirmed")
                return 2  # Operator review; supervisor restart cannot reclaim old jobs.
        if args.once:
            return 0
        time.sleep(3)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    raise SystemExit(main())


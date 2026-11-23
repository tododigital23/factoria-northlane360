"""Real composition, atomic rollback and retries in disposable PG18 only."""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
from app.eliot_objective_planning_api import ObjectiveBreakdown, save_in_transaction, ready


def body(key=None):
    return ObjectiveBreakdown(objective='Improve the documentary evidence of this project',
        request_key=key or uuid4(), confirm_save=True, steps=[dict(
            title=title, department_id=DEPT, worker_id=WORKER,
            deliverable='Documented findings linked to source evidence',
            acceptance='Every finding cites the exact approved document',
            repository=REPO, path=PATH, ref='ci', sha=SHA)
            for title in ['Evidence diagnosis', 'Documentary recommendations']])


def save(value, org=ORG, subject='test|ownerA'):
    with psycopg.connect('') as c, c.cursor() as cur:
        cur.execute("SET LOCAL statement_timeout='15s'")
        cur.execute('SET LOCAL ROLE eliot_identity')
        cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
        assert ready(cur)
        return save_in_transaction(cur, org, value)


value=body(); result=save(value); assert save(value)==result
tasks=[UUID(s['task_id']) for s in result['steps']]
assert len(set(tasks))==2
assert query('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=ANY(%s)',(tasks,))[0][0]==0
assert query('SELECT count(*) FROM eliot.ai_document_approvals WHERE task_id=ANY(%s)',(tasks,))[0][0]==0
assert query('SELECT count(*) FROM eliot.ai_task_execution_leases WHERE task_id=ANY(%s)',(tasks,))[0][0]==0
mission=next(r[0] for r in owner('SELECT * FROM eliot.my_document_missions(%s)',(ORG,)) if r[0]['id']==result['mission_id'])
assert [s['dependency_satisfied'] for s in mission['steps']]==[True,False]
assert 'Criterio de revisión:' in read(tasks[0])[0]['objective']
# A failure on step 2 must remove step 1 tasks, plans and events too.
bad=body(); bad.steps[1].worker_id=uuid4()
before=query('SELECT count(*) FROM eliot.ai_tasks')[0][0]
denied(lambda:save(bad),(psycopg.errors.ForeignKeyViolation,psycopg.errors.ObjectNotInPrerequisiteState))
assert query('SELECT count(*) FROM eliot.ai_tasks')[0][0]==before
changed=value.model_copy(deep=True);changed.steps[1].acceptance='A different acceptance criterion is now requested'
denied(lambda:save(changed),psycopg.errors.InvalidParameterValue)
assert query('SELECT count(*) FROM eliot.ai_tasks')[0][0]==before
expanded=value.model_copy(deep=True)
third=expanded.steps[0].model_copy(deep=True);third.title='An additional step with the same save key'
expanded.steps.append(third)
denied(lambda:save(expanded),psycopg.errors.InvalidParameterValue)
assert query('SELECT count(*) FROM eliot.ai_tasks')[0][0]==before
denied(lambda:save(body(),org=OTHER),psycopg.errors.InsufficientPrivilege)
denied(lambda:save(body(),subject='test|unrelated-objective-owner'),psycopg.errors.InsufficientPrivilege)
# Concurrent requests for the same reviewed payload create one complete bundle.
retry=body(); barrier=Barrier(2)
def race(_):
    barrier.wait();return save(retry)
with ThreadPoolExecutor(2) as pool: results=list(pool.map(race,range(2)))
assert results[0]==results[1]
assert query('SELECT count(*) FROM eliot.ai_tasks')[0][0]==before+2
print('Objective planning PG18: atomic tasks/plans/mission, no dispatch, exact retry, conflicts, tenant denial and concurrent retries passed')

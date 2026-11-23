"""Save an owner-reviewed documentary breakdown atomically; never dispatch work.

This composes existing scoped functions, not a general autonomous planner.
No external reads, model calls, permissions, leases or budget reservations.
"""
from uuid import UUID, uuid5

from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import Field, field_validator, model_validator

from app.eliot_tool_control_api import StrictRequest, _cursor, _owner
from app.eliot_document_plans_api import ready as plans_ready
from app.eliot_document_missions_api import ready as missions_ready
from app.eliot_github_reader import sources_for, _segments, EXTENSIONS, GitHubSourceError

router = APIRouter(prefix='/v1/me/organizations', tags=['objective-planning'])
TASK_FUNCTION = 'eliot.create_task_for_owner(uuid,uuid,uuid,text,uuid)'


class ObjectiveStep(StrictRequest):
    title: str = Field(min_length=3, max_length=200)
    department_id: UUID
    worker_id: UUID
    deliverable: str = Field(min_length=10, max_length=250)
    acceptance: str = Field(min_length=10, max_length=250)
    repository: str = Field(min_length=3, max_length=210)
    path: str = Field(min_length=6, max_length=400)
    ref: str = Field(min_length=1, max_length=160)
    sha: str = Field(pattern=r'^[0-9a-f]{40}$')

    @field_validator('title', 'deliverable', 'acceptance')
    @classmethod
    def meaningful(cls, value):
        # Field lengths apply before trimming; reject whitespace-only payloads.
        if len(value.strip()) < 3:
            raise ValueError('Meaningful text required')
        return value.strip()


class ObjectiveBreakdown(StrictRequest):
    objective: str = Field(min_length=10, max_length=400)
    steps: list[ObjectiveStep] = Field(min_length=2, max_length=5)
    request_key: UUID
    confirm_save: bool = Field(strict=True)

    @model_validator(mode='after')
    def reviewed_scope(self):
        self.objective = self.objective.strip()
        if not self.confirm_save or len(self.objective) < 10:
            raise ValueError('Explicit review and objective required')
        if any(len(s.deliverable) < 10 or len(s.acceptance) < 10 for s in self.steps):
            raise ValueError('Deliverable and review criterion required')
        if len({s.title.casefold() for s in self.steps}) != len(self.steps):
            raise ValueError('Distinct step titles required')
        return self


def ready(cur):
    for signature in (TASK_FUNCTION, 'eliot.owner_create_document_plan(uuid,uuid,uuid,text,text,text,text,text,uuid)'):
        cur.execute('SELECT to_regprocedure(%s)', (signature,))
        row = cur.fetchone()
        if not row or not row[0]:
            return False
        cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE') AND "
                    "(SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=%s::regprocedure)='eliot_migrator'",
                    (row[0], row[0]))
        if cur.fetchone() != (True,):
            return False
    return plans_ready(cur) and missions_ready(cur)


def validate_sources(org, body):
    sources = sources_for(str(org))
    for step in body.steps:
        try:
            _segments(step.path)
        except GitHubSourceError:
            raise HTTPException(422, 'Invalid document path') from None
        if not step.path.casefold().endswith(EXTENSIONS) or not any(
            f"{s['owner']}/{s['repo']}" == step.repository and s['ref'] == step.ref
            and step.path.startswith(s['prefix']) for s in sources
        ):
            raise HTTPException(409, 'Step source not configured for organization')


def _id(cur):
    row = cur.fetchone()
    if not row or not isinstance(row[0], UUID):
        raise HTTPException(503, 'Objective save unconfirmed')
    return row[0]


def save_in_transaction(cur, org, body):
    """Caller owns one transaction. Any failure must escape and roll it all back.

    Stable per-request keys preserve retries and reject changed payloads in SQL.
    Never derive new keys from a changed payload after an uncertain save.
    """
    steps = []
    for position, step in enumerate(body.steps, 1):
        task_key = uuid5(body.request_key, f'objective-task:{position}')
        plan_key = uuid5(body.request_key, f'objective-plan:{position}')
        cur.execute('SELECT eliot.create_task_for_owner(%s,%s,%s,%s,%s)',
                    (org, step.department_id, step.worker_id, step.title, task_key))
        task_id = _id(cur)
        objective = (f'Objetivo: {body.objective}\nEntregable: {step.deliverable}'
                     f'\nCriterio de revisión: {step.acceptance}')
        cur.execute('SELECT eliot.owner_create_document_plan(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                    (org, task_id, step.worker_id, objective, step.repository,
                     step.path, step.ref, step.sha, plan_key))
        plan_id = _id(cur)
        steps.append({'position': position, 'task_id': str(task_id),
                      'plan_id': str(plan_id), 'worker_id': str(step.worker_id)})
    cur.execute('SELECT eliot.owner_create_document_mission(%s,%s,%s,%s)',
                (org, body.objective, [UUID(s['plan_id']) for s in steps],
                 uuid5(body.request_key, 'objective-mission')))
    mission_id = _id(cur)
    return {'organization_id': str(org), 'request_key': str(body.request_key),
            'mission_id': str(mission_id), 'steps': steps, 'atomic_save': True,
            'provider_called': False, 'source_fetched': False, 'execution_started': False,
            'permissions_granted': False, 'budget_reserved': False}


@router.get('/{organization_id}/execution/objective-planning')
def capability(organization_id: UUID, authorization: str | None = Header(default=None)):
    from app.eliot_objective_proposal import enabled as proposal_enabled
    subject = _owner(organization_id, authorization, write=False)
    with _cursor(subject) as cur:
        enabled = ready(cur)
    return {'organization_id': str(organization_id), 'enabled': enabled,
            'generative_proposal_available': enabled and proposal_enabled(organization_id),
            'min_steps': 2, 'max_steps': 5, 'proposal_mode': 'guided_documentary',
            'provider_called': False, 'execution_started': False,
            'sources': [{'repository': f"{s['owner']}/{s['repo']}", 'ref': s['ref'],
                         'prefix': s['prefix']} for s in sources_for(str(organization_id))]}


@router.post('/{organization_id}/execution/objective-planning', status_code=201)
def create(organization_id: UUID, body: ObjectiveBreakdown,
           authorization: str | None = Header(default=None)):
    subject = _owner(organization_id, authorization, write=True)
    validate_sources(organization_id, body)
    with _cursor(subject) as cur:
        if not ready(cur):
            raise HTTPException(503, 'Objective planning storage unavailable')
        result = save_in_transaction(cur, organization_id, body)
    # Return only after the entire transaction has committed.
    return result


from app.eliot_objective_proposal import ProposalRequest


@router.post('/{organization_id}/execution/objective-planning/propose')
def propose(organization_id: UUID, body: ProposalRequest, response: Response,
            authorization: str | None = Header(default=None)):
    from app.eliot_objective_proposal import generate
    subject = _owner(organization_id, authorization, write=True)
    from app import eliot_break
    eliot_break.require_working(subject, organization_id)
    with _cursor(subject) as cur:
        if not ready(cur):
            raise HTTPException(503, 'Objective planning storage unavailable')
    response.headers['Cache-Control'] = 'no-store'
    return generate(organization_id, subject, body)

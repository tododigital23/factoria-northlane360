"""Persistent fixed-scope documentary plans. Saving a plan never dispatches work."""
from uuid import UUID
from typing import Literal
from fastapi import APIRouter,Header,HTTPException
from pydantic import Field
from app.eliot_tool_control_api import StrictRequest,_cursor,_owner
from app.eliot_github_reader import sources_for,EXTENSIONS
router=APIRouter(prefix='/v1/me/organizations',tags=['document-plans'])
FUNCTIONS=('eliot.my_document_plans(uuid,uuid)',
 'eliot.owner_create_document_plan(uuid,uuid,uuid,text,text,text,text,text,uuid)',
 'eliot.owner_enqueue_planned_document_job(uuid,uuid,uuid,uuid,uuid,uuid,uuid)')
class CreatePlan(StrictRequest):
 worker_id:UUID
 objective:str=Field(min_length=10,max_length=1000)
 repository:str=Field(min_length=3,max_length=210)
 path:str=Field(min_length=6,max_length=400)
 ref:str=Field(min_length=1,max_length=160)
 sha:str=Field(pattern=r'^[0-9a-f]{40}$')
 request_key:UUID

def ready(cur):
 for signature in FUNCTIONS:
  cur.execute('SELECT to_regprocedure(%s)',(signature,));row=cur.fetchone()
  if not row or not row[0]:return False
  cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE')",(row[0],))
  if cur.fetchone()!=(True,):return False
 return True

def controls_ready(cur):
 signature='eliot.owner_control_document_plan(uuid,uuid,uuid,text,text,integer,uuid)'
 cur.execute('SELECT to_regprocedure(%s)',(signature,));row=cur.fetchone()
 if not row or not row[0]:return False
 cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE')",(row[0],))
 return cur.fetchone()==(True,)

def read(cur,org,task):
 cur.execute('SELECT * FROM eliot.my_document_plans(%s,%s)',(org,task))
 return [r[0] for r in cur.fetchall()]

@router.get('/{organization_id}/tasks/{task_id}/execution/document-plans')
def plans(organization_id:UUID,task_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 with _cursor(subject) as cur:
  enabled=ready(cur);items=read(cur,organization_id,task_id) if enabled else []
 return {'organization_id':str(organization_id),'task_id':str(task_id),'enabled':enabled,
         'plans':items,'provider_called':False,'execution_started':False}

@router.post('/{organization_id}/tasks/{task_id}/execution/document-plans',status_code=201)
def create(organization_id:UUID,task_id:UUID,body:CreatePlan,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 if len(body.objective.strip())<10:raise HTTPException(422,'Objective required')
 source=next((s for s in sources_for(str(organization_id))
   if f"{s['owner']}/{s['repo']}"==body.repository and s['ref']==body.ref
   and body.path.startswith(s['prefix'])),None)
 if source is None or '..' in body.path.split('/') or '' in body.path.split('/') or not body.path.casefold().endswith(EXTENSIONS):
  raise HTTPException(409,'Plan source not configured for organization')
 with _cursor(subject) as cur:
  if not ready(cur):raise HTTPException(503,'Document plan migration unavailable')
  cur.execute('SELECT eliot.owner_create_document_plan(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
   (organization_id,task_id,body.worker_id,body.objective,body.repository,body.path,body.ref,body.sha,body.request_key))
  row=cur.fetchone()
  if not row or not isinstance(row[0],UUID):raise HTTPException(503,'Plan save unconfirmed')
  plan_id=row[0]
 return {'organization_id':str(organization_id),'task_id':str(task_id),'plan_id':str(plan_id),
         'provider_called':False,'execution_started':False,'source_verified':False}

class ControlPlan(StrictRequest):
 action:Literal['pause','resume','cancel']
 reason:str=Field(min_length=10,max_length=500)
 expected_revision:int=Field(ge=0,le=2147483646,strict=True)
 request_key:UUID

@router.post('/{organization_id}/tasks/{task_id}/execution/document-plans/{plan_id}/control')
def control(organization_id:UUID,task_id:UUID,plan_id:UUID,body:ControlPlan,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 if len(body.reason.strip())<10:raise HTTPException(422,'Control reason required')
 signature='eliot.owner_control_document_plan(uuid,uuid,uuid,text,text,integer,uuid)'
 with _cursor(subject) as cur:
  cur.execute('SELECT to_regprocedure(%s)',(signature,));row=cur.fetchone()
  if not row or not row[0]:raise HTTPException(503,'Plan control migration unavailable')
  cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE')",(row[0],))
  if cur.fetchone()!=(True,):raise HTTPException(503,'Plan control permission unavailable')
  cur.execute('SELECT eliot.owner_control_document_plan(%s,%s,%s,%s,%s,%s,%s)',
    (organization_id,task_id,plan_id,body.action,body.reason.strip(),body.expected_revision,body.request_key))
  row=cur.fetchone();result=row[0] if row else None
  if (not isinstance(result,dict) or result.get('plan_id')!=str(plan_id)
   or result.get('recorded_state')!={'pause':'paused','resume':'active','cancel':'cancelled'}[body.action]
   or type(result.get('recorded_revision')) is not int or result['recorded_revision']!=body.expected_revision+1):
   raise HTTPException(503,'Plan control unconfirmed')
  try:UUID(result['action_id'])
  except (KeyError,ValueError,TypeError,AttributeError):raise HTTPException(503,'Plan control unconfirmed') from None
 return {'organization_id':str(organization_id),'task_id':str(task_id),'plan_id':str(plan_id),
  'action_id':result['action_id'],'recorded_state':result['recorded_state'],'recorded_revision':result['recorded_revision'],
  'provider_called':False,'execution_started':False,'task_completed':False}

# 032: explicit, audited reopening of a plan whose job ended as a KNOWN failure.
# Reopening never dispatches: the next job needs the ordinary lease review, single-use
# approval, budget and mission gates. Fails closed (503) until migration 032 is applied.
REOPEN_SIGNATURE='eliot.owner_reopen_failed_document_plan(uuid,uuid,uuid,uuid,text,uuid)'
ATTEMPTS_SIGNATURE='eliot.my_document_plan_attempts(uuid,uuid)'

def _function_ready(cur,signature):
 cur.execute('SELECT to_regprocedure(%s)',(signature,));row=cur.fetchone()
 if not row or not row[0]:return False
 cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE')",(row[0],))
 return cur.fetchone()==(True,)

def recovery_ready(cur):
 return _function_ready(cur,REOPEN_SIGNATURE) and _function_ready(cur,ATTEMPTS_SIGNATURE)

class ReopenPlan(StrictRequest):
 failed_job_id:UUID
 reason:str=Field(min_length=10,max_length=500)
 request_key:UUID

@router.post('/{organization_id}/tasks/{task_id}/execution/document-plans/{plan_id}/reopen')
def reopen(organization_id:UUID,task_id:UUID,plan_id:UUID,body:ReopenPlan,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 if len(body.reason.strip())<10:raise HTTPException(422,'Reopen reason required')
 with _cursor(subject) as cur:
  if not recovery_ready(cur):raise HTTPException(503,'Plan recovery migration unavailable')
  cur.execute('SELECT eliot.owner_reopen_failed_document_plan(%s,%s,%s,%s,%s,%s)',
   (organization_id,task_id,plan_id,body.failed_job_id,body.reason.strip(),body.request_key))
  row=cur.fetchone();result=row[0] if row else None
  if (not isinstance(result,dict) or result.get('plan_id')!=str(plan_id)
   or result.get('failed_job_id')!=str(body.failed_job_id) or result.get('dispatched') is not False
   or type(result.get('attempt')) is not int or result['attempt'] not in (1,2)
   or type(result.get('replayed')) is not bool):
   raise HTTPException(503,'Plan reopening unconfirmed')
 return {'organization_id':str(organization_id),'task_id':str(task_id),'plan_id':str(plan_id),
  'failed_job_id':result['failed_job_id'],'attempt':result['attempt'],'replayed':result['replayed'],
  'provider_called':False,'execution_started':False,'approval_created':False,'task_completed':False,
  'next_steps':['review_previous_lease','approve_document_analysis','dispatch_plan']}

@router.get('/{organization_id}/tasks/{task_id}/execution/document-plans/{plan_id}/attempts')
def attempts(organization_id:UUID,task_id:UUID,plan_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 with _cursor(subject) as cur:
  enabled=recovery_ready(cur);items=[]
  if enabled:
   cur.execute('SELECT * FROM eliot.my_document_plan_attempts(%s,%s)',(organization_id,plan_id))
   items=[r[0] for r in cur.fetchall()]
 return {'organization_id':str(organization_id),'task_id':str(task_id),'plan_id':str(plan_id),
  'enabled':enabled,'attempts':items,'provider_called':False}

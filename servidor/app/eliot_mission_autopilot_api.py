"""033: Freddy mission autopilot inside a budget approved once by the owner.

Every advance runs in an authenticated request of the owner who granted it; internally it
reuses the existing lease, approval, enqueue, mission-guard and 032 reopen functions.
Endpoints fail closed (503) until migration 033 is installed. Acceptance of each report
remains a human decision: autopilot only continues after it.
"""
from uuid import UUID
from fastapi import APIRouter,Header,HTTPException
from pydantic import Field
from app.eliot_tool_control_api import StrictRequest,_cursor,_owner

router=APIRouter(prefix='/v1/me/organizations',tags=['mission-autopilot'])
FUNCTIONS=('eliot.owner_grant_mission_autopilot(uuid,uuid,integer,boolean,boolean,integer,uuid)',
 'eliot.owner_advance_mission_autopilot(uuid,uuid)','eliot.owner_revoke_mission_autopilot(uuid,uuid,text)',
 'eliot.my_mission_autopilot(uuid,uuid)')
STOPS={'job_in_progress','awaiting_owner_review','changes_requested','needs_human_investigation','step_failed_not_retryable',
 'retry_limit_reached','budget_exhausted','step_not_eligible','mission_complete','mission_paused','mission_cancelled',
 'autopilot_expired','no_active_autopilot'}
TOKEN_UNITS_PER_JOB=2500

def ready(cur):
 for signature in FUNCTIONS:
  cur.execute('SELECT to_regprocedure(%s)',(signature,));row=cur.fetchone()
  if not row or not row[0]:return False
  cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE')",(row[0],))
  if cur.fetchone()!=(True,):return False
 return True

def checked_advance(result,mission_id):
 """Strict shape check: anything unexpected is reported as unconfirmed, never as progress."""
 if (not isinstance(result,dict) or result.get('mission_id')!=str(mission_id) or result.get('stopped') not in STOPS
  or not isinstance(result.get('dispatched'),list)):
  raise ValueError('unconfirmed')
 dispatched=[]
 for d in result['dispatched']:
  if (not isinstance(d,dict) or d.get('kind') not in ('dispatch','retry') or type(d.get('position')) is not int
   or not 1<=d['position']<=5):raise ValueError('unconfirmed')
  UUID(d['job_id']);UUID(d['plan_id'])
  dispatched.append({'position':d['position'],'plan_id':d['plan_id'],'job_id':d['job_id'],'kind':d['kind']})
 out={'stopped':result['stopped'],'stopped_at_position':result.get('stopped_at_position'),'dispatched':dispatched}
 for k in ('jobs_dispatched','max_jobs'):
  if k in result:
   if type(result[k]) is not int:raise ValueError('unconfirmed')
   out[k]=result[k]
 return out

def _advance(cur,org,mission):
 cur.execute('SELECT eliot.owner_advance_mission_autopilot(%s,%s)',(org,mission));row=cur.fetchone()
 try:return checked_advance(row[0] if row else None,mission)
 except (ValueError,KeyError,TypeError,AttributeError):raise HTTPException(503,'Autopilot advance unconfirmed') from None

class GrantAutopilot(StrictRequest):
 max_jobs:int=Field(ge=1,le=10,strict=True)
 objective_consent:bool=Field(strict=True)
 auto_retry:bool=Field(strict=True)
 hours:int=Field(ge=1,le=168,strict=True)
 cost_consent:bool=Field(strict=True)
 request_key:UUID

class RevokeAutopilot(StrictRequest):
 reason:str=Field(min_length=10,max_length=500)

base='/{organization_id}/execution/document-missions/{mission_id}/autopilot'

@router.get(base)
def status(organization_id:UUID,mission_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 with _cursor(subject) as cur:
  enabled=ready(cur);items=[]
  if enabled:
   cur.execute('SELECT * FROM eliot.my_mission_autopilot(%s,%s)',(organization_id,mission_id));items=[r[0] for r in cur.fetchall()]
 return {'organization_id':str(organization_id),'mission_id':str(mission_id),'enabled':enabled,'autopilots':items,
  'provider_called':False,'token_units_per_job':TOKEN_UNITS_PER_JOB}

@router.post(base)
def grant(organization_id:UUID,mission_id:UUID,body:GrantAutopilot,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 if body.cost_consent is not True:raise HTTPException(422,'Explicit cost consent required')
 from app import eliot_break;eliot_break.require_working(subject,organization_id)
 with _cursor(subject) as cur:
  if not ready(cur):raise HTTPException(503,'Autopilot migration unavailable')
  cur.execute('SELECT eliot.owner_grant_mission_autopilot(%s,%s,%s,%s,%s,%s,%s)',(organization_id,mission_id,body.max_jobs,
   body.objective_consent,body.auto_retry,body.hours,body.request_key));row=cur.fetchone();result=row[0] if row else None
  try:
   autopilot_id=str(UUID(result['autopilot_id']));replayed=result['replayed']
   if type(replayed) is not bool:raise TypeError
   advance=checked_advance(result['advance'],mission_id)
  except (ValueError,KeyError,TypeError,AttributeError):raise HTTPException(503,'Autopilot grant unconfirmed') from None
 return {'organization_id':str(organization_id),'mission_id':str(mission_id),'autopilot_id':autopilot_id,'replayed':replayed,
  'max_jobs':body.max_jobs,'estimated_token_units':body.max_jobs*TOKEN_UNITS_PER_JOB,'advance':advance,
  'provider_called':False,'task_completed':False}

@router.post(base+'/advance')
def advance(organization_id:UUID,mission_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 from app import eliot_break;eliot_break.require_working(subject,organization_id)
 with _cursor(subject) as cur:
  if not ready(cur):raise HTTPException(503,'Autopilot migration unavailable')
  result=_advance(cur,organization_id,mission_id)
 return {'organization_id':str(organization_id),'mission_id':str(mission_id),'advance':result,'provider_called':False,'task_completed':False}

@router.post(base+'/revoke')
def revoke(organization_id:UUID,mission_id:UUID,body:RevokeAutopilot,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 if len(body.reason.strip())<10:raise HTTPException(422,'Revoke reason required')
 with _cursor(subject) as cur:
  if not ready(cur):raise HTTPException(503,'Autopilot migration unavailable')
  cur.execute('SELECT eliot.owner_revoke_mission_autopilot(%s,%s,%s)',(organization_id,mission_id,body.reason.strip()));row=cur.fetchone()
  result=row[0] if row else None
  if not isinstance(result,dict) or result.get('mission_id')!=str(mission_id) or type(result.get('revoked')) is not bool:
   raise HTTPException(503,'Autopilot revocation unconfirmed')
 return {'organization_id':str(organization_id),'mission_id':str(mission_id),'revoked':result['revoked'],
  'queued_jobs_aborted':False,'provider_called':False}

def advance_after_acceptance(subject,org,task):
 """Called AFTER an accepted review has committed. Never changes the review outcome."""
 try:
  from app import eliot_break
  if eliot_break.on_break(subject,org):return {'attempted':False,'reason':'company_on_break'}   # en descanso no se encadena más trabajo
  with _cursor(subject) as cur:
   if not ready(cur):return {'attempted':False,'reason':'autopilot_unavailable'}
   cur.execute('SELECT * FROM eliot.my_document_plans(%s,%s)',(org,task))
   missions=sorted({r[0].get('mission_id') for r in cur.fetchall() if isinstance(r[0],dict) and r[0].get('mission_id')})
   if not missions:return {'attempted':False,'reason':'no_mission'}
   results=[]
   for mission in missions[:5]:
    results.append({'mission_id':mission,**_advance(cur,org,UUID(mission))})
   return {'attempted':True,'missions':results}
 except HTTPException:
  return {'attempted':True,'error':'autopilot_unconfirmed'}

"""Explicit sequential documentary missions; no dispatch or provider calls."""
from typing import Literal
from uuid import UUID
from app.eliot_mission_state import present
from fastapi import APIRouter,Header,HTTPException
from pydantic import Field,field_validator
from app.eliot_tool_control_api import StrictRequest,_cursor,_owner
router=APIRouter(prefix='/v1/me/organizations',tags=['document-missions'])
FUNCTIONS=('eliot.owner_create_document_mission(uuid,text,uuid[],uuid)','eliot.my_document_missions(uuid)')
class CreateMission(StrictRequest):
 objective:str=Field(min_length=10,max_length=1000)
 plan_ids:list[UUID]=Field(min_length=2,max_length=5)
 request_key:UUID
 @field_validator('plan_ids')
 @classmethod
 def unique(cls,v):
  if len(set(v))!=len(v):raise ValueError('Distinct plans required')
  return v

def ready(cur):
 for signature in FUNCTIONS:
  cur.execute('SELECT to_regprocedure(%s)',(signature,));row=cur.fetchone()
  if not row or not row[0]:return False
  cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE') AND (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=%s::regprocedure)='eliot_migrator'",(row[0],row[0]))
  if cur.fetchone()!=(True,):return False
 cur.execute("SELECT EXISTS(SELECT 1 FROM pg_trigger g JOIN pg_proc p ON p.oid=g.tgfoid WHERE g.tgrelid='eliot.ai_document_plans'::regclass AND g.tgname='guard_document_mission_dispatch' AND g.tgenabled IN ('O','A') AND pg_get_userbyid(p.proowner)='eliot_migrator') AND (SELECT count(*) FROM pg_class WHERE oid IN (to_regclass('eliot.ai_document_missions'),to_regclass('eliot.ai_document_mission_steps')) AND relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner)='eliot_migrator')=2")
 return cur.fetchone()==(True,)

CONTROL='eliot.owner_control_document_mission(uuid,uuid,text,text,integer,uuid)'
def controls_ready(cur):
 cur.execute('SELECT to_regprocedure(%s)',(CONTROL,));row=cur.fetchone()
 if not row or not row[0]:return False
 cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE') AND (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=%s::regprocedure)='eliot_migrator'",(row[0],row[0]))
 if cur.fetchone()!=(True,):return False
 cur.execute("SELECT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('eliot.ai_document_mission_controls') AND relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner)='eliot_migrator') AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='eliot.ai_document_missions'::regclass AND attname='control_revision' AND NOT attisdropped) AND EXISTS(SELECT 1 FROM pg_trigger g JOIN pg_proc p ON p.oid=g.tgfoid WHERE g.tgrelid='eliot.ai_document_plans'::regclass AND g.tgname='guard_document_mission_dispatch' AND g.tgenabled IN ('O','A') AND pg_get_userbyid(p.proowner)='eliot_migrator')")
 return cur.fetchone()==(True,)

@router.get('/{organization_id}/execution/document-missions')
def missions(organization_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 with _cursor(subject) as cur:
  enabled=ready(cur);control_enabled=controls_ready(cur) if enabled else False
  if enabled:
   cur.execute('SELECT * FROM eliot.my_document_missions(%s)',(organization_id,));rows=cur.fetchall()
  else:rows=[]
 try:
  if len(rows)>20:raise ValueError('Unbounded missions')
  items=[present(r[0]) for r in rows]
  if any(m['mission_control_available']!=control_enabled for m in items):raise ValueError('Control metadata unavailable')
  if len({m['id'] for m in items})!=len(items):raise ValueError('Duplicate missions')
 except (ValueError,TypeError,KeyError,IndexError,AttributeError):raise HTTPException(503,'Mission data could not be verified') from None
 return {'organization_id':str(organization_id),'enabled':enabled,'mission_controls_available':control_enabled,'read_only':True,'provider_called':False,'execution_started':False,'limit':20,'not_full_company_census':True,'missions':items}

@router.post('/{organization_id}/execution/document-missions',status_code=201)
def create(organization_id:UUID,body:CreateMission,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 if len(body.objective.strip())<10:raise HTTPException(422,'Objective required')
 with _cursor(subject) as cur:
  if not ready(cur):raise HTTPException(503,'Mission migration unavailable')
  cur.execute('SELECT eliot.owner_create_document_mission(%s,%s,%s,%s)',(organization_id,body.objective.strip(),body.plan_ids,body.request_key));row=cur.fetchone()
  if not row or not isinstance(row[0],UUID):raise HTTPException(503,'Mission save unconfirmed')
 return {'organization_id':str(organization_id),'mission_id':str(row[0]),'provider_called':False,'execution_started':False,'task_completed':False}

class ControlMission(StrictRequest):
 action:Literal['pause','resume','cancel']
 reason:str=Field(min_length=10,max_length=500)
 expected_revision:int=Field(ge=0,le=2147483646,strict=True)
 request_key:UUID

@router.post('/{organization_id}/execution/document-missions/{mission_id}/control')
def control(organization_id:UUID,mission_id:UUID,body:ControlMission,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 if len(body.reason.strip())<10:raise HTTPException(422,'Control reason required')
 with _cursor(subject) as cur:
  if not controls_ready(cur):raise HTTPException(503,'Mission controls unavailable')
  cur.execute('SELECT eliot.owner_control_document_mission(%s,%s,%s,%s,%s,%s)',(organization_id,mission_id,body.action,body.reason.strip(),body.expected_revision,body.request_key));row=cur.fetchone();result=row[0] if row else None
  if not isinstance(result,dict) or result.get('mission_id')!=str(mission_id) or result.get('recorded_state')!={'pause':'paused','resume':'active','cancel':'cancelled'}[body.action] or type(result.get('recorded_revision')) is not int or result['recorded_revision']!=body.expected_revision+1:raise HTTPException(503,'Mission control unconfirmed')
  try:UUID(result['action_id'])
  except (KeyError,ValueError,TypeError,AttributeError):raise HTTPException(503,'Mission control unconfirmed') from None
 return {'organization_id':str(organization_id),'mission_id':str(mission_id),'action_id':result['action_id'],'recorded_state':result['recorded_state'],'recorded_revision':result['recorded_revision'],'provider_called':False,'execution_started':False,'existing_jobs_stopped':False,'task_completed':False}

@router.get('/{organization_id}/execution/document-missions/{mission_id}/delivery')
def delivery(organization_id:UUID,mission_id:UUID,authorization:str|None=Header(default=None)):
 from app.eliot_mission_delivery import compile_delivery
 subject=_owner(organization_id,authorization,write=False)
 with _cursor(subject) as cur:
  if not ready(cur):raise HTTPException(503,'Mission storage unavailable')
  cur.execute('SELECT * FROM eliot.my_document_missions(%s)',(organization_id,));rows=cur.fetchall()
  try:
   if len(rows)>20:raise ValueError('Unbounded mission history')
   matches=[r[0] for r in rows if isinstance(r[0],dict) and r[0].get('id')==str(mission_id)]
   if len(matches)!=1:raise ValueError('Exact mission outside latest 20')
   mission=present(matches[0])
   if mission['state']!='accepted':raise ValueError('All steps require acceptance')
   reports={};reviews={}
   for s in mission['steps']:
    task=UUID(s['task_id']);run=UUID(s['run_id'])
    cur.execute('SELECT run_id,run_status,run_result,source_repo,source_path,source_ref,source_sha,started_at,finished_at FROM eliot.my_document_runs(%s,%s)',(organization_id,task));reports[s['run_id']]=cur.fetchall()
    cur.execute('SELECT run_id,review_id,decision,reason,reviewed_at FROM eliot.my_document_work_review(%s,%s,%s)',(organization_id,task,run));reviews[s['run_id']]=cur.fetchone()
   result=compile_delivery(organization_id,mission,reports,reviews)
  except (ValueError,TypeError,KeyError,IndexError,AttributeError):raise HTTPException(409,'Exact accepted mission reports unavailable within history limits') from None
 return result

"""034: holding de Freddy. Altas de empresa, perfil, capacidades, mensajes intra-empresa y rutinas.

El holding solo ve recuentos agregados. Cada empresa conserva su aislamiento (RLS, FKs
compuestas, propietario verificado en el servidor). Todas las rutas fallan cerradas (503 o
enabled:false) hasta instalar la migración 034. Nada aquí llama a proveedores ni ejecuta trabajos.
"""
from typing import Literal
from uuid import UUID
from fastapi import APIRouter,Header,HTTPException
from pydantic import Field
from app import organizations_api as identity
from app.eliot_tool_control_api import StrictRequest,_cursor,_owner

router=APIRouter(prefix='/v1/me',tags=['holding'])
CAPABILITIES=('repository','website','seo','marketing','email','orders','monitoring','automation')
Capability=Literal['repository','website','seo','marketing','email','orders','monitoring','automation']
FUNCTIONS={
 'holding':('eliot.my_holding()','eliot.owner_provision_company(uuid,text,text,text,text,text,text[],uuid)'),
 'profile':('eliot.owner_update_company_profile(uuid,text,text,text,text)','eliot.owner_set_company_capability(uuid,text,text)'),
 'rename':('eliot.owner_rename_company(uuid,text)',),
 'retire':('eliot.owner_retire_company(uuid,text)','eliot.my_retired_companies()'),
 'messages':('eliot.my_agent_messages(uuid)',),
 'routines':('eliot.my_routines(uuid)','eliot.owner_create_routine(uuid,uuid,uuid,text,text,text,text,uuid)',
  'eliot.owner_control_routine(uuid,uuid,text)','eliot.owner_run_due_routines(uuid)'),
}
REPO=r'^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'
SITE=r'^https://[A-Za-z0-9.-]{3,200}(:[0-9]{2,5})?(/\S*)?$'

def ready(cur,group):
 for signature in FUNCTIONS[group]:
  cur.execute('SELECT to_regprocedure(%s)',(signature,));row=cur.fetchone()
  if not row or not row[0]:return False
  cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE')",(row[0],))
  if cur.fetchone()!=(True,):return False
 return True

def _require(cur,group):
 if not ready(cur,group):raise HTTPException(503,'Holding migration unavailable')

class CompanyLinks(StrictRequest):
 repository:str|None=Field(default=None,max_length=201,pattern=REPO)
 website_url:str|None=Field(default=None,max_length=500,pattern=SITE)

class NewCompany(CompanyLinks):
 name:str=Field(min_length=2,max_length=120)
 project_name:str=Field(min_length=2,max_length=120)
 project_summary:str=Field(min_length=10,max_length=600)
 capabilities:list[Capability]=Field(default_factory=list,max_length=8)
 confirm:Literal[True]
 request_key:UUID

class Profile(CompanyLinks):
 project_name:str=Field(min_length=2,max_length=120)
 project_summary:str=Field(min_length=10,max_length=600)

class CompanyName(StrictRequest):
 name:str=Field(min_length=2,max_length=120,pattern=r'^[^\x00-\x1f\x7f]+$')

class CapabilityChange(StrictRequest):
 state:Literal['planned','disabled']

class NewRoutine(StrictRequest):
 department_id:UUID
 worker_id:UUID
 title:str=Field(min_length=3,max_length=160)
 instructions:str=Field(min_length=10,max_length=2000)
 cadence:Literal['daily','weekly','monthly']
 capability:Capability|None=None
 request_key:UUID

class RoutineControl(StrictRequest):
 state:Literal['active','paused']

def _trimmed(*values):
 for value,minimum in values:
  if len(value.strip())<minimum:raise HTTPException(422,'Text too short after trimming')

@router.get('/holding')
def holding(authorization:str|None=Header(default=None)):
 subject=identity.verified_identity(authorization, require_tasks_scope=False)
 identity.ensure_first_owner(subject)
 try:
  with _cursor(subject) as cur:
   enabled=ready(cur,'holding');items=[]
   if enabled:
    cur.execute('SELECT * FROM eliot.my_holding()');items=[r[0] for r in cur.fetchall()]
  return {'enabled':enabled,'holdings':items,'provider_called':False}
 except HTTPException as exc:
  if exc.status_code not in (403,503):
   raise
  fallback=identity.holding_admin_read(subject)
  if fallback is not None:
   return fallback
  raise

@router.post('/holding/{holding_id}/companies',status_code=201)
def create_company(holding_id:UUID,body:NewCompany,authorization:str|None=Header(default=None)):
 subject=identity._require_approval_scope(authorization)
 _trimmed((body.name,2),(body.project_name,2),(body.project_summary,10))
 if len(set(body.capabilities))!=len(body.capabilities):raise HTTPException(422,'Duplicate capabilities')
 with _cursor(subject) as cur:
  _require(cur,'holding')
  cur.execute('SELECT eliot.owner_provision_company(%s,%s,%s,%s,%s,%s,%s,%s)',(holding_id,body.name.strip(),body.project_name.strip(),
   body.project_summary.strip(),body.repository,body.website_url,list(body.capabilities),body.request_key))
  row=cur.fetchone();r=row[0] if row else None
  try:
   org=str(UUID(r['organization_id']));slot=r['slot'];replayed=r['replayed'];departments=r['departments'];workers=r['workers_created']
   if (r.get('holding_id')!=str(holding_id) or type(slot) is not int or not 1<=slot<=20 or type(replayed) is not bool
     or type(workers) is not int or r.get('provider_called') is not False or not isinstance(departments,list) or not departments):raise ValueError
   departments=[{'id':str(UUID(d['id'])),'name':str(d['name'])} for d in departments]
  except (ValueError,KeyError,TypeError,AttributeError):raise HTTPException(503,'Company provisioning unconfirmed') from None
 return {'holding_id':str(holding_id),'organization_id':org,'slot':slot,'replayed':replayed,'departments':departments,
  'workers_created':workers,'provider_called':False}

@router.post('/organizations/{organization_id}/profile')
def update_profile(organization_id:UUID,body:Profile,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 _trimmed((body.project_name,2),(body.project_summary,10))
 with _cursor(subject) as cur:
  _require(cur,'profile')
  cur.execute('SELECT eliot.owner_update_company_profile(%s,%s,%s,%s,%s)',(organization_id,body.project_name.strip(),
   body.project_summary.strip(),body.repository,body.website_url))
  row=cur.fetchone()
  if not row or not isinstance(row[0],dict) or row[0].get('updated') is not True:raise HTTPException(503,'Profile update unconfirmed')
 return {'organization_id':str(organization_id),'updated':True}

class CompanyRetire(StrictRequest):
 confirm_name:str=Field(min_length=2,max_length=120,pattern=r'^[^\x00-\x1f\x7f]+$')

@router.post('/organizations/{organization_id}/retire')
def retire_company(organization_id:UUID,body:CompanyRetire,authorization:str|None=Header(default=None)):
 """038: retira la empresa de La Factoría y deja libre su parcela. No borra datos; pausa sus tareas recurrentes.
 Exige escribir el nombre exacto. 409 si el nombre no coincide o hay pilotos automáticos en marcha."""
 subject=_owner(organization_id,authorization,write=True)
 _trimmed((body.confirm_name,2))
 try:
  with _cursor(subject) as cur:
   _require(cur,'retire')
   cur.execute('SELECT eliot.owner_retire_company(%s,%s)',(organization_id,body.confirm_name.strip()))
   row=cur.fetchone();r=row[0] if row else None
   if (not isinstance(r,dict) or r.get('organization_id')!=str(organization_id) or r.get('retired') is not True
     or type(r.get('slot')) is not int or type(r.get('routines_paused')) is not int or not isinstance(r.get('name'),str)):
    raise HTTPException(503,'Company retirement unconfirmed')
 except HTTPException as error:
  if error.status_code==409:raise HTTPException(409,'Company name does not match or the company has active autopilots') from None
  raise
 return {'organization_id':str(organization_id),'name':r['name'],'slot':r['slot'],'retired':True,'routines_paused':r['routines_paused']}

@router.post('/organizations/{organization_id}/name')
def rename_company(organization_id:UUID,body:CompanyName,authorization:str|None=Header(default=None)):
 """036: cambia solo el nombre de la empresa. No mueve datos, agentes ni permisos. 409 si el nombre ya existe en el holding."""
 subject=_owner(organization_id,authorization,write=True)
 _trimmed((body.name,2))
 with _cursor(subject) as cur:
  _require(cur,'rename')
  cur.execute('SELECT eliot.owner_rename_company(%s,%s)',(organization_id,body.name.strip()))
  row=cur.fetchone();r=row[0] if row else None
  if (not isinstance(r,dict) or r.get('organization_id')!=str(organization_id) or r.get('name')!=body.name.strip()
    or type(r.get('renamed')) is not bool):raise HTTPException(503,'Company rename unconfirmed')
 return {'organization_id':str(organization_id),'name':r['name'],'renamed':r['renamed']}

@router.post('/organizations/{organization_id}/capabilities/{capability}')
def set_capability(organization_id:UUID,capability:Capability,body:CapabilityChange,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 with _cursor(subject) as cur:
  _require(cur,'profile')
  cur.execute('SELECT eliot.owner_set_company_capability(%s,%s,%s)',(organization_id,capability,body.state))
  row=cur.fetchone();r=row[0] if row else None
  if (not isinstance(r,dict) or r.get('capability')!=capability or r.get('state')!=body.state
    or type(r.get('departments_created')) is not int):raise HTTPException(503,'Capability change unconfirmed')
 return {'organization_id':str(organization_id),'capability':capability,'state':body.state,
  'departments_created':r['departments_created'],'connector_enabled':False}

@router.get('/organizations/{organization_id}/agent-messages')
def agent_messages(organization_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 with _cursor(subject) as cur:
  enabled=ready(cur,'messages');items=[]
  if enabled:
   cur.execute('SELECT * FROM eliot.my_agent_messages(%s)',(organization_id,));items=[r[0] for r in cur.fetchall()]
 return {'organization_id':str(organization_id),'enabled':enabled,'messages':items,'same_company_only':True}

@router.get('/organizations/{organization_id}/routines')
def routines(organization_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 with _cursor(subject) as cur:
  enabled=ready(cur,'routines');items=[]
  if enabled:
   cur.execute('SELECT * FROM eliot.my_routines(%s)',(organization_id,));items=[r[0] for r in cur.fetchall()]
 return {'organization_id':str(organization_id),'enabled':enabled,'routines':items}

@router.post('/organizations/{organization_id}/routines',status_code=201)
def create_routine(organization_id:UUID,body:NewRoutine,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 _trimmed((body.title,3),(body.instructions,10))
 with _cursor(subject) as cur:
  _require(cur,'routines')
  cur.execute('SELECT eliot.owner_create_routine(%s,%s,%s,%s,%s,%s,%s,%s)',(organization_id,body.department_id,body.worker_id,
   body.title.strip(),body.instructions.strip(),body.cadence,body.capability,body.request_key))
  row=cur.fetchone()
  if not row or not isinstance(row[0],UUID):raise HTTPException(503,'Routine creation unconfirmed')
 return {'organization_id':str(organization_id),'routine_id':str(row[0]),'execution_started':False}

@router.post('/organizations/{organization_id}/routines/{routine_id}/control')
def control_routine(organization_id:UUID,routine_id:UUID,body:RoutineControl,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 with _cursor(subject) as cur:
  _require(cur,'routines')
  cur.execute('SELECT eliot.owner_control_routine(%s,%s,%s)',(organization_id,routine_id,body.state))
  row=cur.fetchone()
  if not row or not isinstance(row[0],dict) or row[0].get('routine_id')!=str(routine_id) or row[0].get('state')!=body.state:
   raise HTTPException(503,'Routine control unconfirmed')
 return {'organization_id':str(organization_id),'routine_id':str(routine_id),'state':body.state}

@router.post('/organizations/{organization_id}/routines/run-due')
def run_due(organization_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 with _cursor(subject) as cur:
  _require(cur,'routines')
  cur.execute('SELECT eliot.owner_run_due_routines(%s)',(organization_id,));row=cur.fetchone()
  if not row or type(row[0]) is not int or row[0]<0:raise HTTPException(503,'Routine run unconfirmed')
 return {'organization_id':str(organization_id),'tasks_created':row[0],'execution_started':False}

# 035: «Pedir una tarea» a un agente y memoria compartida de la empresa.
FUNCTIONS.update({
 'requests':('eliot.owner_request_agent_task(uuid,uuid,text,text,uuid)','eliot.my_task_requests(uuid)'),
 'memory':('eliot.my_company_memory(uuid)','eliot.owner_set_company_memory(uuid,text,text)'),
})
MEMORY_KEYS=('audience','pricing','value_proposition','brand_tone','products','faq')
MemoryKey=Literal['audience','pricing','value_proposition','brand_tone','products','faq']

class AgentRequest(StrictRequest):
 request:str=Field(min_length=10,max_length=2000)
 deliverable:str|None=Field(default=None,max_length=300)
 request_key:UUID

class MemoryItem(StrictRequest):
 content:str=Field(max_length=2000)

@router.post('/organizations/{organization_id}/workers/{worker_id}/requests',status_code=201)
def request_agent_task(organization_id:UUID,worker_id:UUID,body:AgentRequest,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 _trimmed((body.request,10))
 deliverable=body.deliverable.strip() if body.deliverable and body.deliverable.strip() else None
 with _cursor(subject) as cur:
  _require(cur,'requests')
  cur.execute('SELECT eliot.owner_request_agent_task(%s,%s,%s,%s,%s)',(organization_id,worker_id,body.request.strip(),deliverable,body.request_key))
  row=cur.fetchone();r=row[0] if row else None
  try:
   task=str(UUID(r['task_id']));dept=str(UUID(r['department_id']));title=r['title'];replayed=r['replayed']
   if (r.get('worker_id')!=str(worker_id) or r.get('status')!='pending' or r.get('execution_started') is not False
     or not isinstance(title,str) or not 3<=len(title)<=200 or type(replayed) is not bool):raise ValueError
  except (ValueError,KeyError,TypeError,AttributeError):raise HTTPException(503,'Request unconfirmed') from None
 return {'organization_id':str(organization_id),'worker_id':str(worker_id),'task_id':task,'department_id':dept,
  'title':title,'status':'pending','replayed':replayed,'execution_started':False}

@router.get('/organizations/{organization_id}/task-requests')
def task_requests(organization_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 with _cursor(subject) as cur:
  enabled=ready(cur,'requests');items=[]
  if enabled:
   cur.execute('SELECT * FROM eliot.my_task_requests(%s)',(organization_id,));items=[r[0] for r in cur.fetchall()]
 return {'organization_id':str(organization_id),'enabled':enabled,'requests':items}

@router.get('/organizations/{organization_id}/memory')
def memory(organization_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 with _cursor(subject) as cur:
  enabled=ready(cur,'memory');items=[]
  if enabled:
   cur.execute('SELECT * FROM eliot.my_company_memory(%s)',(organization_id,));items=[r[0] for r in cur.fetchall()]
 return {'organization_id':str(organization_id),'enabled':enabled,'items':items,'keys':list(MEMORY_KEYS)}

@router.post('/organizations/{organization_id}/memory/{key}')
def set_memory(organization_id:UUID,key:MemoryKey,body:MemoryItem,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=True)
 with _cursor(subject) as cur:
  _require(cur,'memory')
  cur.execute('SELECT eliot.owner_set_company_memory(%s,%s,%s)',(organization_id,key,body.content))
  row=cur.fetchone()
  if not row or not isinstance(row[0],dict) or row[0].get('key')!=key or row[0].get('updated') is not True:
   raise HTTPException(503,'Memory update unconfirmed')
 return {'organization_id':str(organization_id),'key':key,'updated':True}

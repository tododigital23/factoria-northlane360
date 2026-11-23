"""Company plan monitor, owner-only; reuses scoped SQL readers without writes."""
from uuid import UUID
from app.eliot_document_jobs_api import objective_capability
from fastapi import APIRouter,Header,HTTPException
from app.eliot_tool_control_api import _cursor,_owner
from app.eliot_document_plans_api import ready,read,controls_ready
from app.eliot_plan_tracking import MAX_TASKS,summarize
router=APIRouter(prefix='/v1/me/organizations',tags=['plan-tracking'])

@router.get('/{organization_id}/execution/document-plans-overview')
def overview(organization_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 try:
  with _cursor(subject) as cur:
   if not ready(cur):return {'organization_id':str(organization_id),'enabled':False,'read_only':True,'provider_called':False,'source_fetched':False,'task_completed':False,'plans':[]}
   cur.execute('SELECT task_id,department_id,assignee_worker_id,task_title,task_status,created_at FROM eliot.my_tasks(%s)',(organization_id,));tasks=cur.fetchall()
   cur.execute('SELECT worker_id,worker_name FROM eliot.my_workers(%s)',(organization_id,));workers={str(r[0]):r[1] for r in cur.fetchall()}
   cur.execute('SELECT department_id,department_name FROM eliot.my_departments(%s)',(organization_id,));departments={str(r[0]):r[1] for r in cur.fetchall()}
   controls=controls_ready(cur)
   objectives=objective_capability(cur)
   histories={str(t[0]):read(cur,organization_id,t[0]) for t in tasks[:MAX_TASKS]}
  result=summarize(organization_id,tasks,histories,workers,departments)
  result['plan_controls_available']=controls
  result['plan_objective_supported']=objectives
  return result
 except (ValueError,TypeError,KeyError,IndexError):
  raise HTTPException(503,'Plan monitoring data could not be verified') from None

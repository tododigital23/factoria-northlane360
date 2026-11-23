"""Office metadata projection using only existing tenant-scoped readers."""
from uuid import UUID
from fastapi import APIRouter,Header,HTTPException
from app.eliot_tool_control_api import _cursor,_owner
from app.eliot_office_overview import summarize,MAX_TASKS,MAX_WORKERS,MAX_DEPARTMENTS
router=APIRouter(prefix='/v1/me/organizations',tags=['office'])
@router.get('/{organization_id}/execution/office-overview')
def office(organization_id:UUID,authorization:str|None=Header(default=None)):
 subject=_owner(organization_id,authorization,write=False)
 try:
  with _cursor(subject) as cur:
   cur.execute('SELECT department_id,department_name FROM eliot.my_departments(%s) LIMIT %s',(organization_id,MAX_DEPARTMENTS+1));departments=cur.fetchall()
   cur.execute('SELECT worker_id,department_id,worker_name,specialty,worker_state FROM eliot.my_workers(%s) LIMIT %s',(organization_id,MAX_WORKERS+1));workers=cur.fetchall()
   cur.execute('SELECT task_id,department_id,assignee_worker_id,task_title,task_status,created_at FROM eliot.my_tasks(%s)',(organization_id,));tasks=cur.fetchall()
   histories={};leases={};reviews={}
   for t in tasks[:MAX_TASKS]:
    key=str(t[0]);cur.execute('SELECT * FROM eliot.my_document_jobs(%s,%s)',(organization_id,t[0]));rows=cur.fetchall();histories[key]=rows
    if not rows:continue
    cur.execute('SELECT * FROM eliot.my_task_execution_lease(%s,%s)',(organization_id,t[0]));leases[key]=cur.fetchone()
    # Only the most recent completed record can affect the office review signal.
    latest=max(rows,key=lambda r:(r[4],str(r[0])))
    if latest[3]=='completed':
     cur.execute('SELECT decision FROM eliot.my_document_work_review(%s,%s,%s)',(organization_id,t[0],latest[1]));r=cur.fetchone();reviews[key]=r[0] if r else 'unavailable'
  return summarize(organization_id,departments,workers,tasks,histories,leases,reviews)
 except (ValueError,TypeError,KeyError,IndexError,AttributeError):raise HTTPException(503,'Office records could not be verified') from None

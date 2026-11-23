"""Read-only quality inspection of an exact stored report. No provider/source I/O."""
from uuid import UUID
from fastapi import APIRouter, Header, HTTPException
from app.eliot_tool_control_api import _cursor, _owner
from app.eliot_document_analysis import PREFIX
from app.eliot_document_quality import assess_report
router = APIRouter(prefix="/v1/me/organizations", tags=["document-quality"])

@router.get("/{organization_id}/tasks/{task_id}/execution/document-runs/{run_id}/quality")
def quality(organization_id:UUID, task_id:UUID, run_id:UUID, authorization:str|None=Header(default=None)):
 subject = _owner(organization_id, authorization, write=False)
 with _cursor(subject) as cur:
  cur.execute("SELECT run_id,run_status,run_result,source_repo,source_path,source_ref,source_sha "
              "FROM eliot.my_document_runs(%s,%s)",(organization_id,task_id))
  rows = [r for r in cur.fetchall() if r[0] == run_id]
 if len(rows)!=1 or rows[0][1]!="completed" or not isinstance(rows[0][2],str):
  raise HTTPException(409,"Exact completed report unavailable in history")
 r=rows[0]
 return {"organization_id":str(organization_id),"task_id":str(task_id),"run_id":str(run_id),
         "repository":r[3],"path":r[4],"ref":r[5],"sha":r[6],
         "quality":assess_report(r[2],prefix=PREFIX),"read_only":True,"provider_called":False,
         "source_fetched":False,"task_completed":False}

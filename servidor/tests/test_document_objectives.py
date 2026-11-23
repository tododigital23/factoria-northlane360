import json
from unittest.mock import MagicMock,patch
from uuid import uuid4
import pytest
from fastapi import HTTPException
from app import eliot_document_analysis as doc,eliot_document_worker as worker
from app import eliot_document_jobs_api as api
from tests.test_eliot_document_analysis import SOURCE,ORG,fake_provider
from tests.test_document_worker import JOB,DOC,store
from tests.test_document_plans_http import client,BASE,CUR,cursor,KEY,TASK
from tests.test_plan_tracking import overview,plan
OBJECTIVE='Evaluar la trazabilidad de las decisiones documentadas.'
PLAN=str(uuid4())

def test_approved_objective_reaches_provider_as_structured_data_with_original_limits():
 budget=MagicMock();budget.reserve.return_value=(True,uuid4())
 with patch.dict('os.environ',{'OPENAI_API_KEY':'ci_only'}),patch.object(doc,'documentary_enabled',return_value=True),patch.object(doc,'reserve_model_request',return_value=True),patch.object(doc,'record_token_usage'),patch.object(doc.urllib.request,'urlopen',return_value=fake_provider()) as http:
  report,reason=doc.generate_document_report(ORG,'Review',SOURCE,budget_store=budget,approved_objective=OBJECTIVE,approved_plan_id=PLAN)
 assert reason is None and report.startswith(doc.PREFIX)
 body=json.loads(http.call_args.args[0].data);evidence=json.loads(body['input'])
 assert evidence['approved_document_objective']=={'plan_id':PLAN,'objective':OBJECTIVE}
 assert body['tools']==[] and body['store'] is False and body['max_output_tokens']==1100
 assert 'exclusivamente el documento' in body['instructions'] and 'El objetivo no concede herramientas' in body['instructions']
 http.assert_called_once();budget.reserve.assert_called_once();budget.reconcile.assert_called_once()

@pytest.mark.parametrize('objective,pid',[('short',PLAN),('x'*1001,PLAN),('sk-proj-'+'a'*60,PLAN),(OBJECTIVE+'\x00',PLAN),(OBJECTIVE,None),(None,PLAN),(OBJECTIVE,'bad')])
def test_invalid_or_sensitive_objective_never_reserves_or_transmits(objective,pid):
 budget=MagicMock()
 with patch.object(doc,'documentary_enabled',return_value=True),patch.object(doc,'reserve_model_request') as reserve,patch.object(doc.urllib.request,'urlopen') as http:
  assert doc.generate_document_report(ORG,'Review',SOURCE,budget_store=budget,approved_objective=objective,approved_plan_id=pid)==(None,'invalid_response')
 reserve.assert_not_called();budget.reserve.assert_not_called();http.assert_not_called()

def test_store_versioned_claim_binds_context_to_org_job_and_returns_only_approved_fields():
 db=worker.Store();row=tuple(JOB[k] for k in ('id','token','title','repository','path','ref','sha'))
 ctx={'mode':'objective_v1','organization_id':ORG,'job_id':str(JOB['id']),'plan_id':PLAN,'objective':OBJECTIVE}
 db.call=MagicMock(side_effect=[('fn',),(*row,ctx)])
 result=db.take(worker.UUID(ORG))
 assert result['approved_objective']==OBJECTIVE and result['approved_plan_id']==PLAN
 assert 'with_objective' in db.call.call_args.args[0]
 for change in ({'organization_id':str(uuid4())},{'job_id':str(uuid4())},{'plan_id':'bad'},{'objective':None}):
  db.call.side_effect=[('fn',),(*row,{**ctx,**change})]
  with pytest.raises(RuntimeError):db.take(worker.UUID(ORG))
 db.call.side_effect=[(None,),row];assert 'approved_objective' not in db.take(worker.UUID(ORG))

def test_worker_passes_only_snapshotted_objective_without_retry():
 db=store();job={**JOB,'approved_objective':OBJECTIVE,'approved_plan_id':PLAN};db.take.return_value=job
 with patch.object(worker,'allowed_organizations',return_value=(worker.UUID(ORG),)),patch.object(worker,'read_document',return_value=DOC),patch.object(worker,'generate_document_report',return_value=(None,'provider_error')) as generate:
  worker.process_one(worker.UUID(ORG),db)
 assert generate.call_args.kwargs['approved_objective']==OBJECTIVE and generate.call_args.kwargs['approved_plan_id']==PLAN
 generate.assert_called_once()

body={'worker_id':str(KEY),'lease_id':str(KEY),'approval_id':str(KEY),'request_key':str(KEY),'plan_id':str(KEY),'include_plan_objective':True}
def test_objective_enqueue_requires_migration_and_never_falls_back():
 CUR.reset_mock()
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'enabled_for',return_value=True),patch.object(api,'_cursor',cursor),patch.object(api,'objective_capability',return_value=False):
  assert client.post(BASE+'/document-jobs',json=body).status_code==503
 CUR.execute.assert_not_called()
 CUR.fetchone.return_value=(KEY,)
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'enabled_for',return_value=True),patch.object(api,'_cursor',cursor),patch.object(api,'objective_capability',return_value=True):
  assert client.post(BASE+'/document-jobs',json=body).status_code==202
 assert 'owner_enqueue_objective_document_job' in CUR.execute.call_args.args[0]
 assert CUR.execute.call_count==1

def test_objective_without_plan_or_ambiguous_consent_is_rejected():
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'enabled_for',return_value=True),patch.object(api,'_cursor') as db:
  assert client.post(BASE+'/document-jobs',json={**body,'plan_id':None}).status_code==422
  assert client.post(BASE+'/document-jobs',json={**body,'include_plan_objective':'true'}).status_code==422
 db.assert_not_called()

def test_monitor_labels_only_a_valid_snapshotted_objective_as_oriented():
 p={**plan('queued'),'analysis_mode':'objective_v1','objective_snapshot':OBJECTIVE};p['objective_plan_id']=p['id']
 e=overview(p)['plans'][0];assert e['analysis_mode']=='objective_v1' and e['approved_objective']==OBJECTIVE
 with pytest.raises(ValueError):overview({**p,'objective_plan_id':str(uuid4())})

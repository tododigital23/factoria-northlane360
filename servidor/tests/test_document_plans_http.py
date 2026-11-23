from contextlib import contextmanager
from unittest.mock import MagicMock,patch
from uuid import UUID
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app import eliot_document_plans_api as api
from app import eliot_document_jobs_api as jobs
ORG=UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');TASK=UUID('77777777-7777-4777-8777-777777777777');KEY=UUID('11111111-1111-4111-8111-111111111111')
app=FastAPI();app.include_router(api.router);app.include_router(jobs.router);client=TestClient(app)
BASE=f'/v1/me/organizations/{ORG}/tasks/{TASK}/execution'
body={'worker_id':str(KEY),'objective':'Inspect the documentary evidence','repository':'Nova/project','path':'docs/CI.md','ref':'ci','sha':'a'*40,'request_key':str(KEY)}
CUR=MagicMock()
@contextmanager
def cursor(_):yield CUR

def test_anonymous_and_non_owner_fail_before_storage():
 with patch.object(api,'_cursor') as db:assert client.get(BASE+'/document-plans').status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403,'Owner only')),patch.object(api,'_cursor') as db:assert client.post(BASE+'/document-plans',json=body).status_code==403
 db.assert_not_called()

def test_uninstalled_plan_schema_disables_reads():
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=False):
  result=client.get(BASE+'/document-plans')
 assert result.json()['enabled'] is False and result.json()['plans']==[] and not result.json()['execution_started']

def test_creation_is_scoped_parameterized_and_never_executes():
 CUR.reset_mock();CUR.fetchone.return_value=(KEY,)
 with patch.object(api,'_owner',return_value='verified') as owner,patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True),patch.object(api,'sources_for',return_value=[{'owner':'Nova','repo':'project','ref':'ci','prefix':'docs/'}]):
  result=client.post(BASE+'/document-plans',json=body)
 assert result.status_code==201 and not result.json()['provider_called'] and not result.json()['source_verified']
 assert not result.json()['execution_started'];owner.assert_called_once_with(ORG,None,write=True)
 assert CUR.execute.call_args.args[1]==(ORG,TASK,KEY,body['objective'],body['repository'],body['path'],body['ref'],body['sha'],KEY)

def test_unconfigured_source_or_injected_actor_does_not_write():
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'sources_for',return_value=[]),patch.object(api,'_cursor') as db:
  assert client.post(BASE+'/document-plans',json=body).status_code==409
  assert client.post(BASE+'/document-plans',json={**body,'created_by':str(KEY)}).status_code==422
 db.assert_not_called()

def test_plan_id_selects_atomic_queue_binding_without_legacy_fallback():
 CUR.reset_mock();CUR.fetchone.return_value=(KEY,)
 with patch.object(jobs,'_owner',return_value='verified'),patch.object(jobs,'enabled_for',return_value=True),patch.object(jobs,'_cursor',cursor):
  result=client.post(BASE+'/document-jobs',json={'worker_id':str(KEY),'lease_id':str(KEY),'approval_id':str(KEY),'request_key':str(KEY),'plan_id':str(KEY)})
 assert result.status_code==202
 assert 'owner_enqueue_planned_document_job' in CUR.execute.call_args.args[0]
 assert CUR.execute.call_args.args[1]==(ORG,TASK,KEY,KEY,KEY,KEY,KEY)
 assert CUR.execute.call_count==1 and not result.json()['provider_called']

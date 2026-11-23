from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import UUID
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import eliot_document_reviews_api as api
ORG=UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); TASK=UUID('77777777-7777-4777-8777-777777777777'); KEY=UUID('11111111-1111-4111-8111-111111111111')
app=FastAPI();app.include_router(api.router);client=TestClient(app)
URL=f'/v1/me/organizations/{ORG}/tasks/{TASK}/execution/document-runs/{KEY}/review'
body={'decision':'accepted','reason':'Reviewed exact documentary evidence','request_key':str(KEY)}
@contextmanager
def cursor(_):yield CUR
CUR=MagicMock()
def row(reviewed=True):return (KEY,'completed' if reviewed else 'pending','already_reviewed' if reviewed else None,KEY if reviewed else None,'accepted' if reviewed else None,body['reason'] if reviewed else None,datetime.now(timezone.utc) if reviewed else None,'completed' if reviewed else None,KEY if reviewed else None)

def test_anonymous_and_scope_rejection_precede_storage():
 with patch.object(api,'_cursor') as db:
  assert client.get(URL).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403,'Owner required')),patch.object(api,'_cursor') as db:
  assert client.post(URL,json=body).status_code==403
 db.assert_not_called()

def test_missing_migration_is_read_only_disabled():
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=False):
  result=client.get(URL)
  assert result.json()['enabled'] is False and result.json()['eligible'] is False
  assert client.post(URL,json=body).status_code==503

@pytest.mark.parametrize('extra',[{'actor':'spoofed'},{'sha':'a'*40},{'decision':'completed'},{'reason':'          '}])
def test_rejects_spoofed_context_and_invalid_decision(extra):
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:
  assert client.post(URL,json={**body,**extra}).status_code==422
 db.assert_not_called()

def test_review_is_parameterized_owner_write_and_read_back_before_commit():
 CUR.reset_mock();CUR.fetchone.side_effect=[(KEY,),row()]
 with patch.object(api,'_owner',return_value='verified') as owner,patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True):
  result=client.post(URL,json=body)
 assert result.status_code==200 and result.json()['review']['decision']=='accepted'
 assert result.json()['task_status']=='completed' and result.json()['provider_called'] is False
 owner.assert_called_once_with(ORG,None,write=True)
 assert CUR.execute.call_args_list[0].args[1]==(ORG,TASK,KEY,'accepted',body['reason'],KEY)

def test_get_does_not_mutate_and_preserves_exact_scope():
 CUR.reset_mock();CUR.fetchone.side_effect=[row(False)]
 with patch.object(api,'_owner',return_value='verified') as owner,patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True):
  result=client.get(URL)
 assert result.json()['eligible'] is True and result.json()['run_id']==str(KEY)
 owner.assert_called_once_with(ORG,None,write=False)
 assert CUR.execute.call_count==1 and 'my_document_work_review' in CUR.execute.call_args.args[0]

def test_missing_or_wrong_result_is_not_substituted():
 for r in (None,(TASK,*row()[1:])):
  CUR.fetchone.side_effect=[r]
  with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True):
   assert client.get(URL).status_code==409

def test_null_insert_result_is_unconfirmed():
 CUR.fetchone.side_effect=[None]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True):
  assert client.post(URL,json=body).status_code==503

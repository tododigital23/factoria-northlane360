from contextlib import contextmanager
from unittest.mock import MagicMock,patch
from uuid import UUID,uuid4
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app import eliot_document_plans_api as api
from tests.test_plan_tracking import plan,overview
ORG=uuid4();TASK=uuid4();PLAN=uuid4();KEY=uuid4()
app=FastAPI();app.include_router(api.router);client=TestClient(app)
url=f'/v1/me/organizations/{ORG}/tasks/{TASK}/execution/document-plans/{PLAN}/control'
body={'action':'pause','reason':'Owner requests a pause','expected_revision':0,'request_key':str(KEY)}
cur=MagicMock()
@contextmanager
def cursor(_):yield cur

def test_auth_before_control_storage():
 with patch.object(api,'_cursor') as db:assert client.post(url,json=body).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403)),patch.object(api,'_cursor') as db:assert client.post(url,json=body).status_code==403
 db.assert_not_called()
@pytest.mark.parametrize('change',[{'action':'execute'},{'reason':'   '},{'expected_revision':True},{'expected_revision':-1},{'created_by':str(ORG)}])
def test_invalid_control_never_writes(change):
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:assert client.post(url,json={**body,**change}).status_code==422
 db.assert_not_called()
@pytest.mark.parametrize('rows', [[(None,)], [('fn',),(False,)]])
def test_uninstalled_or_ungranted_control_fails_closed(rows):
 cur.reset_mock();cur.fetchone.side_effect=rows
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):assert client.post(url,json=body).status_code==503
 assert all('owner_control_document_plan(' not in c.args[0] for c in cur.execute.call_args_list)
def test_control_uses_verified_subject_exact_scope_and_returns_only_acknowledgement():
 cur.reset_mock();cur.fetchone.side_effect=[('fn',),(True,),({'plan_id':str(PLAN),'action_id':str(KEY),'recorded_state':'paused','recorded_revision':1,'private':'omit'},)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):response=client.post(url,json=body)
 assert response.status_code==200 and response.json()['recorded_state']=='paused' and 'private' not in response.json()
 assert not response.json()['provider_called'] and not response.json()['execution_started']
 auth.assert_called_once_with(ORG,None,write=True)
 assert cur.execute.call_args.args[1]==(ORG,TASK,PLAN,'pause',body['reason'],0,KEY)
@pytest.mark.parametrize('state',['paused','cancelled'])
def test_monitor_keeps_controlled_plan_distinct_from_job_state(state):
 p={**plan(),'control_available':True,'control_state':state,'control_revision':1,'owner_is_creator':True}
 e=overview(p)['plans'][0];assert e['state']==state and e['can_control']==(state=='paused') and e['job_id'] is None
@pytest.mark.parametrize('change',[{'control_state':'paused','control_available':False},{'control_state':'surprise'},{'control_revision':True},{'job_state':'queued','control_state':'paused'}])
def test_monitor_rejects_inconsistent_control_metadata(change):
 with pytest.raises(ValueError):overview({**plan(),'control_available':True,**change})
@pytest.mark.parametrize('rows,result',[([(None,)],False),([('fn',),(False,)],False),([('fn',),(True,)],True)])
def test_control_capability_requires_installed_function_and_runtime_execute(rows,result):
 cur.reset_mock();cur.fetchone.side_effect=rows
 assert api.controls_ready(cur) is result
 assert all(c.args[0].startswith('SELECT') for c in cur.execute.call_args_list)

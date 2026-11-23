import json
from contextlib import contextmanager
from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import eliot_objective_proposal as g
from app import eliot_objective_planning_api as api

ORG=UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');KEY=UUID('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
BODY={'objective':'Mejorar la documentación del proyecto', 'step_count':2, 'consent_openai':True}
STEPS=[{'title':t,'deliverable':'Entregable documental revisable','acceptance':'Criterio concreto y verificable'} for t in ['Analizar el alcance','Evaluar recomendaciones']]
app=FastAPI();app.include_router(api.router);client=TestClient(app)
URL=f'/v1/me/organizations/{ORG}/execution/objective-planning/propose'


def payload(steps=None):
    return {'status':'completed','output':[{'type':'message','role':'assistant','content':[{'type':'output_text','text':json.dumps({'steps':STEPS if steps is None else steps})}]}], 'usage':{'input_tokens':400,'output_tokens':200}}


class Response:
    status=200
    def __init__(self,data=None): self.data=json.dumps(payload() if data is None else data).encode()
    def __enter__(self): return self
    def __exit__(self,*args): return None
    def read(self,n): return self.data[:n]


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv('ELIOT_OPENAI_ENABLED','true');monkeypatch.setenv('OPENAI_API_KEY','fixture-secret')
    monkeypatch.setenv('ELIOT_OPENAI_MODEL','gpt-6-luna');monkeypatch.setenv('ELIOT_OPENAI_ALLOWED_ORGANIZATIONS',str(ORG))
    monkeypatch.setenv('ELIOT_DURABLE_MODEL_BUDGET_ENABLED','true')


@pytest.mark.parametrize('body',[{**BODY,'consent_openai':False},{**BODY,'consent_openai':1},{**BODY,'step_count':True},{**BODY,'step_count':6},{**BODY,'objective':' '*15},{**BODY,'worker_id':str(KEY)}])
def test_invalid_input_never_reaches_model(body):
    with patch.object(g,'generate') as call:
        assert client.post(URL,json=body).status_code==422
        call.assert_not_called()


def test_auth_and_storage_gate_all_external_calls():
    with patch.object(g,'generate') as call:
        assert client.post(URL,json=BODY).status_code==401;call.assert_not_called()
    with patch.object(api,'_owner',side_effect=HTTPException(403,'Owner only')),patch.object(g,'generate') as call:
        assert client.post(URL,json=BODY).status_code==403;call.assert_not_called()
    @contextmanager
    def cursor(_):yield MagicMock()
    with patch.object(api,'_owner',return_value='verified') as owner,patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=False),patch.object(g,'generate') as call:
        assert client.post(URL,json=BODY).status_code==503;call.assert_not_called()
        owner.assert_called_once_with(ORG,None,write=True)


@pytest.mark.parametrize('gate',['provider','tenant','model','durable'])
def test_disabled_gates_deny_before_reservation_or_network(configured,monkeypatch,gate):
    if gate=='provider':monkeypatch.setenv('ELIOT_OPENAI_ENABLED','false')
    if gate=='tenant':monkeypatch.setenv('ELIOT_OPENAI_ALLOWED_ORGANIZATIONS','')
    if gate=='model':monkeypatch.setenv('ELIOT_OPENAI_MODEL','unverified-model')
    if gate=='durable':monkeypatch.setenv('ELIOT_DURABLE_MODEL_BUDGET_ENABLED','false')
    with patch.object(g.budget,'reserve') as reserve,patch.object(g.urllib.request,'build_opener') as network:
        with pytest.raises(HTTPException) as error:g.generate(ORG,'verified',g.ProposalRequest(**BODY))
    assert error.value.status_code==503;reserve.assert_not_called();network.assert_not_called()


@pytest.mark.parametrize('local,durable,key',[(False,True,KEY),(True,False,None),(True,True,None)])
def test_all_quota_gates_deny_before_network(configured,local,durable,key):
    with patch.object(g,'reserve_model_request',return_value=local),patch.object(g.budget,'reserve',return_value=(durable,key)),patch.object(g.urllib.request,'build_opener') as call:
        with pytest.raises(HTTPException) as error:g.generate(ORG,'verified',g.ProposalRequest(**BODY))
    assert error.value.status_code==429;call.assert_not_called()


def test_exact_objective_only_transfer_reserves_before_network(configured):
    events=[];opener=MagicMock();opener.open.side_effect=lambda *a,**k:(events.append('network') or Response())
    def reserve(*a,**k):events.append('budget');assert k=={'estimated_units':10000};return True,KEY
    with patch.object(g,'reserve_model_request',return_value=True),patch.object(g.budget,'reserve',side_effect=reserve),patch.object(g.budget,'reconcile') as reconcile,patch.object(g,'record_token_usage'),patch.object(g.urllib.request,'build_opener',return_value=opener):
        result=g.generate(ORG,'verified',g.ProposalRequest(**BODY))
    assert events==['budget','network']
    request=opener.open.call_args.args[0];body=json.loads(request.data)
    assert json.loads(body['input'])=={'objective_untrusted':BODY['objective'],'step_count':2}
    assert body['tools']==[] and body['store'] is False and body['max_output_tokens']==2000
    assert body['text']['format']['strict'] is True and body['text']['format']['schema']['additionalProperties'] is False
    assert 'fixture-secret' not in json.dumps(body) and 'verified' not in body['input']
    assert result['steps']==STEPS and result['tasks_created'] is result['execution_started'] is result['source_fetched'] is False
    assert result['requires_owner_review'] is True;reconcile.assert_called_once()
    # The generated fields fit the existing reviewed-save contract; IDs and sources
    # are explicitly supplied afterwards, never invented by the model.
    steps=[dict(s,department_id=KEY,worker_id=KEY,repository='Owner/repo',path='docs/CI.md',ref='main',sha='a'*40) for s in result['steps']]
    assert len(api.ObjectiveBreakdown(objective=BODY['objective'],steps=steps,request_key=KEY,confirm_save=True).steps)==2


@pytest.mark.parametrize('kind',['incomplete','refusal','tool','extra','duplicate','count','oversized','bad_json','duplicate_json'])
def test_invalid_model_outputs_never_become_a_plan(kind):
    data=payload()
    if kind=='incomplete':data['status']='incomplete'
    if kind=='refusal':data['output'][0]['content']=[{'type':'refusal','refusal':'no'}]
    if kind=='tool':data['output'].append({'type':'function_call'})
    if kind=='extra':data=payload([{**s,'worker_id':str(KEY)} for s in STEPS])
    if kind=='duplicate':data=payload([STEPS[0],STEPS[0]])
    if kind=='count':data=payload(STEPS[:1])
    if kind=='oversized':data=payload([{**s,'deliverable':'x'*251} for s in STEPS])
    if kind=='bad_json':data['output'][0]['content'][0]['text']='```json\n{}\n```'
    if kind=='duplicate_json':data['output'][0]['content'][0]['text']='{"steps":[],"steps":'+json.dumps(STEPS)+'}'
    with pytest.raises(ValueError):g.parse_proposal(data,2)


def test_timeout_is_not_retried_and_does_not_expose_errors(configured):
    opener=MagicMock();opener.open.side_effect=TimeoutError('fixture-secret private upstream')
    with patch.object(g,'reserve_model_request',return_value=True),patch.object(g.budget,'reserve',return_value=(True,KEY)),patch.object(g.urllib.request,'build_opener',return_value=opener):
        with pytest.raises(HTTPException) as error:g.generate(ORG,'verified',g.ProposalRequest(**BODY))
    assert opener.open.call_count==1 and error.value.status_code==502
    assert 'fixture-secret' not in error.value.detail


def test_redirect_handler_never_forwards_authorization():
    assert g.NoRedirect().redirect_request(None,None,302,'redirect',{},'https://other.invalid') is None


def test_proposal_route_never_saves_and_disables_response_caching():
    @contextmanager
    def cursor(_):yield MagicMock()
    with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True),patch.object(api,'save_in_transaction') as save,patch.object(g,'generate',return_value={'tasks_created':False}) as generate:
        result=client.post(URL,json=BODY)
    assert result.status_code==200 and result.headers['Cache-Control']=='no-store'
    save.assert_not_called();generate.assert_called_once()

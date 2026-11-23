from unittest.mock import patch,MagicMock
import pytest
from fastapi import HTTPException
from app import eliot_server_voice as voice
ORG='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
@pytest.fixture(autouse=True)
def config(monkeypatch):
 for k,v in {'ELIOT_SERVER_VOICE_ENABLED':'true','ELIOT_OPENAI_ENABLED':'true','OPENAI_API_KEY':'test-secret-long-enough-for-hmac-tests','ELIOT_OPENAI_ALLOWED_ORGANIZATIONS':ORG}.items():monkeypatch.setenv(k,v)
@pytest.mark.parametrize('org,subject,text',[(ORG,'other','respuesta'),('other','owner','respuesta'),(ORG,'owner','editada')])
def test_scope_denied_before_provider(org,subject,text):
 token=voice.grant(ORG,'owner','respuesta')
 with patch.object(voice.urllib.request,'urlopen') as network,pytest.raises(HTTPException):voice.synthesize(org,subject,text,token)
 network.assert_not_called()
def test_disabled_and_long_answer_have_no_grant(monkeypatch):
 assert voice.grant(ORG,'owner','x'*1801) is None
 monkeypatch.delenv('ELIOT_SERVER_VOICE_ENABLED')
 assert voice.grant(ORG,'owner','respuesta') is None

def test_audio_is_bounded_and_requires_both_budgets():
 response=MagicMock();response.__enter__.return_value=response;response.read.return_value=b'ID3fake';response.headers={'Content-Type':'audio/mpeg'}
 with patch.object(voice,'reserve_model_request',return_value=True),patch.object(voice.budget,'reserve',return_value=(True,None)),patch.object(voice.urllib.request,'urlopen',return_value=response) as net:
  assert voice.synthesize(ORG,'owner','respuesta',voice.grant(ORG,'owner','respuesta'))==b'ID3fake'
  assert net.call_args.kwargs['timeout']==30
  response.read.assert_called_once_with(2_000_001)
@pytest.mark.parametrize('local,durable',[(False,True),(True,False)])
def test_no_provider_when_budget_denies(local,durable):
 with patch.object(voice,'reserve_model_request',return_value=local),patch.object(voice.budget,'reserve',return_value=(durable,None)),patch.object(voice.urllib.request,'urlopen') as net,pytest.raises(HTTPException):voice.synthesize(ORG,'owner','respuesta',voice.grant(ORG,'owner','respuesta'))
 net.assert_not_called()
def test_expired_ticket_denied():
 with patch.object(voice.time,'time',return_value=100):token=voice.grant(ORG,'owner','respuesta')
 with pytest.raises(HTTPException):voice.synthesize(ORG,'owner','respuesta',token)

@pytest.mark.parametrize('role,status',[('member',403),(None,404),('owner',200)])
def test_route_rechecks_membership_before_audio(role,status):
 from fastapi import FastAPI
 from fastapi.testclient import TestClient
 from app.organizations_api import router
 app=FastAPI();app.include_router(router)
 connection=MagicMock();connection.__enter__.return_value.cursor.return_value.__enter__.return_value.fetchall.return_value=[] if role is None else [(ORG,'Company',role)]
 with patch('app.organizations_api.verified_identity',return_value='owner'),patch('app.organizations_api.psycopg.connect',return_value=connection),patch('app.organizations_api.db_params',return_value={}),patch.object(voice,'synthesize',return_value=b'ID3') as provider:
  r=TestClient(app).post(f'/v1/me/organizations/{ORG}/eliot/speech',json={'text':'respuesta','speech_grant':'signed-token-test','consent':True})
 assert r.status_code==status
 if status==200:assert r.headers['cache-control']=='no-store'
 else:provider.assert_not_called()

def test_route_requires_explicit_consent():
 from fastapi import FastAPI
 from fastapi.testclient import TestClient
 from app.organizations_api import router
 app=FastAPI();app.include_router(router)
 with patch('app.organizations_api.verified_identity',return_value='owner'),patch.object(voice,'synthesize') as provider:
  r=TestClient(app).post(f'/v1/me/organizations/{ORG}/eliot/speech',json={'text':'respuesta','speech_grant':'signed-token-test'})
 assert r.status_code==400;provider.assert_not_called()

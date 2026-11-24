"""Contrato HTTP del holding (034). BD simulada; el SQL se prueba en tests/pg/holding_companies.py."""
from contextlib import contextmanager
from unittest.mock import MagicMock,patch
from uuid import uuid4
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app import eliot_holding_api as api
from app import eliot_document_worker as worker
H=uuid4();ORG=uuid4();KEY=uuid4();D=uuid4();W=uuid4();R=uuid4()
app=FastAPI();app.include_router(api.router);client=TestClient(app)
company={'name':'Tienda Uno','project_name':'Tienda online','project_summary':'Proyecto de comercio electrónico',
 'repository':'tu-organizacion/tienda','website_url':'https://tienda.example.com','capabilities':['seo','orders'],'confirm':True,'request_key':str(KEY)}
cur=MagicMock()
@contextmanager
def cursor(_):yield cur
def ready(n):return [('fn',),(True,)]*n
def ok(**o):return {'holding_id':str(H),'organization_id':str(ORG),'slot':1,'replayed':False,'workers_created':8,'provider_called':False,
 'departments':[{'id':str(D),'name':'Dirección IA'}],**o}

def test_auth_required_before_storage():
 with patch.object(api,'_cursor') as db:
  assert client.get('/v1/me/holding').status_code==401
  assert client.post(f'/v1/me/holding/{H}/companies',json=company).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403)),patch.object(api,'_cursor') as db:
  assert client.post(f'/v1/me/organizations/{ORG}/routines/run-due').status_code==403
 db.assert_not_called()

@pytest.mark.parametrize('change',[{'confirm':False},{'capabilities':['telepathy']},{'capabilities':['seo','seo']},{'repository':'no repo'},
 {'website_url':'http://inseguro.example.com'},{'name':' '},{'project_summary':'corto'},{'extra':1},{'request_key':'x'}])
def test_invalid_company_never_touches_storage(change):
 with patch.object(api.identity,'_require_approval_scope',return_value='verified'),patch.object(api,'_cursor') as db:
  assert client.post(f'/v1/me/holding/{H}/companies',json={**company,**change}).status_code==422
 db.assert_not_called()

def test_company_provisioning_exact_args_and_strict_result():
 cur.reset_mock();cur.fetchone.side_effect=ready(2)+[(ok(secret='x'),)]
 with patch.object(api.identity,'_require_approval_scope',return_value='verified'),patch.object(api,'_cursor',cursor):
  r=client.post(f'/v1/me/holding/{H}/companies',json=company)
 assert r.status_code==201,r.text
 assert cur.execute.call_args.args[1]==(H,'Tienda Uno','Tienda online','Proyecto de comercio electrónico','tu-organizacion/tienda',
  'https://tienda.example.com',['seo','orders'],KEY)
 assert r.json()['slot']==1 and 'secret' not in r.text

@pytest.mark.parametrize('bad',[ok(slot=0),ok(slot=True),ok(provider_called=True),ok(departments=[]),ok(holding_id=str(uuid4())),
 ok(organization_id='x'),ok(replayed='no'),None])
def test_inconsistent_provisioning_is_unconfirmed(bad):
 cur.reset_mock();cur.fetchone.side_effect=ready(2)+[(bad,)]
 with patch.object(api.identity,'_require_approval_scope',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(f'/v1/me/holding/{H}/companies',json=company).status_code==503

def test_holding_403_devuelve_el_holding_por_tablas():
 holding={'id':str(H),'name':'Superempresa','max_companies':5,'is_owner':True,'companies':[]}
 @contextmanager
 def forbidden(_):
  raise HTTPException(403,'Tool control not authorized')
  yield
 with patch.object(api.identity,'verified_identity',return_value='iss|sub'), \
      patch.object(api.identity,'ensure_first_owner'), \
      patch.object(api,'_cursor',forbidden), \
      patch.object(api.identity,'holding_admin_read',return_value={'enabled':True,'holdings':[holding],'provider_called':False}):
  r=client.get('/v1/me/holding',headers={'Authorization':'Bearer t'})
 assert r.status_code==200 and r.json()['holdings'][0]['is_owner'] is True and r.json()['holdings'][0]['companies']==[]


def test_alta_empresa_403_usa_provision_admin():
 ack=ok()
 @contextmanager
 def forbidden(_):
  raise HTTPException(403,'Tool control not authorized')
  yield
 with patch.object(api.identity,'_require_approval_scope',return_value='iss|sub'), \
      patch.object(api,'_cursor',forbidden), \
      patch.object(api.identity,'holding_admin_provision',return_value=ack) as provision:
  r=client.post(f'/v1/me/holding/{H}/companies',json=company)
 assert r.status_code==201 and r.json()['slot']==1
 provision.assert_called_once()


def test_holding_disabled_without_migration_and_read_only_counts():
 cur.reset_mock();cur.fetchone.side_effect=[(None,)]
 with patch.object(api.identity,'verified_identity',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.get('/v1/me/holding').json()=={'enabled':False,'holdings':[],'provider_called':False}
 cur.reset_mock();cur.fetchone.side_effect=ready(2);cur.fetchall.return_value=[({'id':str(H),'companies':[]},)]
 with patch.object(api.identity,'verified_identity',return_value='verified'),patch.object(api,'_cursor',cursor):
  body=client.get('/v1/me/holding').json()['holdings'][0]
  assert body['id']==str(H) and body['max_companies']==5 and body['is_owner'] is True and body['companies']==[]


def test_holding_sucio_se_alinea_con_el_campus():
 from datetime import datetime,timezone
 messy={'enabled':True,'holdings':[{
  'id':H,'name':'  Superempresa Freddy  ','max_companies':'5','is_owner':1,
  'companies':[{'organization_id':ORG,'name':'Tienda','slot':'1','project_name':None,'project_summary':None,
    'repository':'','website_url':'http://inseguro.example.com','capabilities':[],
    'departments':2,'workers':2,'active_workers':1,'tasks':{'pending':0,'blocked':0,'completed':0,'other':0},
    'routines_active':0,'missions':0,'autopilots_active':0,'created_at':datetime(2026,11,1,tzinfo=timezone.utc)}]}]}
 clean=api.shape_holding_response(messy)
 h=clean['holdings'][0];c=h['companies'][0]
 assert clean['enabled'] is True and h['name']=='Superempresa Freddy' and h['max_companies']==5 and h['is_owner'] is True
 assert c['project_name']=='' and c['repository'] is None and c['website_url'] is None and c['created_at'].endswith('Z')

def test_capability_change_never_enables_connectors():
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:
  assert client.post(f'/v1/me/organizations/{ORG}/capabilities/email',json={'state':'enabled'}).status_code==422
  assert client.post(f'/v1/me/organizations/{ORG}/capabilities/telepathy',json={'state':'planned'}).status_code==422
 db.assert_not_called()
 cur.reset_mock();cur.fetchone.side_effect=ready(2)+[({'capability':'orders','state':'planned','departments_created':1},)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):
  r=client.post(f'/v1/me/organizations/{ORG}/capabilities/orders',json={'state':'planned'})
 assert r.json()=={'organization_id':str(ORG),'capability':'orders','state':'planned','departments_created':1,'connector_enabled':False}
 auth.assert_called_once_with(ORG,None,write=True)

def test_routines_create_and_run_due():
 body={'department_id':str(D),'worker_id':str(W),'title':'Revisión SEO','instructions':'Revisar posiciones semanales','cadence':'weekly',
  'capability':'seo','request_key':str(KEY)}
 cur.reset_mock();cur.fetchone.side_effect=ready(4)+[(R,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  r=client.post(f'/v1/me/organizations/{ORG}/routines',json=body)
 assert r.status_code==201 and r.json()['routine_id']==str(R) and r.json()['execution_started'] is False
 assert cur.execute.call_args.args[1]==(ORG,D,W,'Revisión SEO','Revisar posiciones semanales','weekly','seo',KEY)
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:
  assert client.post(f'/v1/me/organizations/{ORG}/routines',json={**body,'cadence':'hourly'}).status_code==422
 db.assert_not_called()
 cur.reset_mock();cur.fetchone.side_effect=ready(4)+[(2,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(f'/v1/me/organizations/{ORG}/routines/run-due').json()['tasks_created']==2

def test_messages_are_company_scoped_reads():
 cur.reset_mock();cur.fetchone.side_effect=ready(1);cur.fetchall.return_value=[({'id':str(KEY),'body':'hola'},)]
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor):
  r=client.get(f'/v1/me/organizations/{ORG}/agent-messages')
 assert r.json()['same_company_only'] is True and cur.execute.call_args.args[1]==(ORG,)
 auth.assert_called_once_with(ORG,None,write=False)

def test_worker_routine_materialization_is_optional_and_strict():
 store=MagicMock();store.call.side_effect=[(None,)]
 assert worker.run_due_routines(ORG,store) is None
 store=MagicMock();store.call.side_effect=[('fn',),(3,)]
 assert worker.run_due_routines(ORG,store)==3 and store.call.call_args.args[1]==(ORG,)
 store=MagicMock();store.call.side_effect=[('fn',),(-1,)]
 with pytest.raises(RuntimeError):worker.run_due_routines(ORG,store)


# --- 036: renombrar empresa
def test_rename_requires_owner_and_valid_name_before_storage():
 with patch.object(api,'_cursor') as db:
  assert client.post(f'/v1/me/organizations/{ORG}/name',json={'name':'Nova Demo Portal'}).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403)),patch.object(api,'_cursor') as db:
  assert client.post(f'/v1/me/organizations/{ORG}/name',json={'name':'Nova Demo Portal'}).status_code==403
 db.assert_not_called()
 for bad in ({},{'name':'X'},{'name':'   '},{'name':'x'*121},{'name':'Con\nsalto'},{'name':'Ok','extra':1},{'name':7}):
  with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:
   assert client.post(f'/v1/me/organizations/{ORG}/name',json=bad).status_code==422,bad
  db.assert_not_called()

def test_rename_exact_args_and_strict_result():
 cur.reset_mock();cur.fetchone.side_effect=ready(1)+[({'organization_id':str(ORG),'name':'Nova Demo Portal','renamed':True},)]
 with patch.object(api,'_owner',return_value='verified') as owner,patch.object(api,'_cursor',cursor):
  r=client.post(f'/v1/me/organizations/{ORG}/name',json={'name':'  Nova Demo Portal '})
 assert r.status_code==200 and r.json()=={'organization_id':str(ORG),'name':'Nova Demo Portal','renamed':True}
 assert owner.call_args.kwargs=={'write':True}
 assert cur.execute.call_args_list[-1].args==('SELECT eliot.owner_rename_company(%s,%s)',(ORG,'Nova Demo Portal'))

@pytest.mark.parametrize('result',[None,{},{'organization_id':str(uuid4()),'name':'Nova Demo Portal','renamed':True},
 {'organization_id':'x','name':'Otro','renamed':True},{'organization_id':'x','name':'Nova Demo Portal','renamed':'si'}])
def test_rename_unconfirmed_result_fails_closed(result):
 fixed=result if not result or result.get('organization_id')!='x' else {**result,'organization_id':str(ORG)}
 cur.reset_mock();cur.fetchone.side_effect=ready(1)+[(fixed,) if fixed is not None else None]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(f'/v1/me/organizations/{ORG}/name',json={'name':'Nova Demo Portal'}).status_code==503

def test_rename_fails_closed_without_migration():
 cur.reset_mock();cur.fetchone.side_effect=[(None,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(f'/v1/me/organizations/{ORG}/name',json={'name':'Nova Demo Portal'}).status_code==503
 assert not any('owner_rename_company(%s' in str(c) for c in cur.execute.call_args_list)


# --- 038: retirar una empresa (libera la parcela; no borra datos)
RETIRED={'organization_id':str(ORG),'name':'Juguetes Demo','slot':3,'retired':True,'routines_paused':2}
def test_retire_requires_owner_and_name_before_storage():
 with patch.object(api,'_cursor') as db:
  assert client.post(f'/v1/me/organizations/{ORG}/retire',json={'confirm_name':'Juguetes Demo'}).status_code==401
 db.assert_not_called()
 with patch.object(api,'_owner',side_effect=HTTPException(403)),patch.object(api,'_cursor') as db:
  assert client.post(f'/v1/me/organizations/{ORG}/retire',json={'confirm_name':'Juguetes Demo'}).status_code==403
 db.assert_not_called()
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor') as db:
  for bad in ({},{'confirm_name':' '},{'confirm_name':'x'},{'confirm_name':'Juguetes','extra':1},{'confirm_name':'a\nb'}):
   assert client.post(f'/v1/me/organizations/{ORG}/retire',json=bad).status_code==422
 db.assert_not_called()

def test_retire_exact_args_and_strict_result():
 cur.reset_mock();cur.fetchone.side_effect=ready(2)+[({**RETIRED,'secret':'x'},)]
 with patch.object(api,'_owner',return_value='verified') as owner,patch.object(api,'_cursor',cursor):
  r=client.post(f'/v1/me/organizations/{ORG}/retire',json={'confirm_name':' Juguetes Demo '})
 assert r.status_code==200 and r.json()==RETIRED
 assert owner.call_args.kwargs=={'write':True}
 assert cur.execute.call_args_list[-1].args==('SELECT eliot.owner_retire_company(%s,%s)',(ORG,'Juguetes Demo'))

@pytest.mark.parametrize('result',[None,{},{**RETIRED,'organization_id':str(uuid4())},{**RETIRED,'retired':'si'},{**RETIRED,'slot':'3'},
 {**RETIRED,'routines_paused':None},{**RETIRED,'name':None}])
def test_retire_unconfirmed_result_fails_closed(result):
 cur.reset_mock();cur.fetchone.side_effect=ready(2)+[(result,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(f'/v1/me/organizations/{ORG}/retire',json={'confirm_name':'Juguetes Demo'}).status_code==503

def test_retire_fails_closed_without_migration_and_explains_conflict():
 cur.reset_mock();cur.fetchone.side_effect=[(None,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor):
  assert client.post(f'/v1/me/organizations/{ORG}/retire',json={'confirm_name':'Juguetes Demo'}).status_code==503
 assert not any('owner_retire_company(%s' in str(c) for c in cur.execute.call_args_list)
 @contextmanager
 def conflict(_):
  raise HTTPException(409,'Task, worker, lease or authorization no longer eligible')
  yield
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',conflict):
  r=client.post(f'/v1/me/organizations/{ORG}/retire',json={'confirm_name':'Otra'})
 assert r.status_code==409 and 'name does not match' in r.json()['detail']

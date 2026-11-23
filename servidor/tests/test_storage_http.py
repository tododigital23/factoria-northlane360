"""Contrato HTTP del almacén (037). BD y Google simulados; el SQL se prueba en tests/pg/holding_storage.py."""
import base64,os
from contextlib import contextmanager
from unittest.mock import MagicMock,patch
from urllib.parse import parse_qs,urlparse
from uuid import uuid4
import httpx,pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from app import eliot_storage_api as api
from app import eliot_storage_crypto as crypto
from app import eliot_storage_drive as drive

H=uuid4();SUBJECT='auth0|owner';CID='1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com'
app=FastAPI();app.include_router(api.router);client=TestClient(app,follow_redirects=False)
cur=MagicMock()
@contextmanager
def cursor(_):yield cur
READY=[('fn',),(True,)]*len(api.FUNCTIONS)
def state(**o):return ({'holding_id':str(H),'connected':False,**o},)
@pytest.fixture(autouse=True)
def env(monkeypatch):
 monkeypatch.setenv('ELIOT_STORAGE_MASTER_KEY',base64.b64encode(bytes(range(32))).decode())
 monkeypatch.setenv('ELIOT_DRIVE_CLIENT_ID',CID);monkeypatch.setenv('ELIOT_DRIVE_CLIENT_SECRET','secreto-de-google-0001')
 monkeypatch.delenv('ELIOT_DRIVE_REDIRECT_URI',raising=False);monkeypatch.delenv('ELIOT_FRONTEND_ORIGIN',raising=False)
 drive._access.clear();cur.reset_mock();cur.fetchone.side_effect=None
def owner():return patch.object(api.identity,'_require_approval_scope',return_value=SUBJECT)
def reader():return patch.object(api.identity,'verified_identity',return_value=SUBJECT)
def db():return patch.object(api,'_cursor',cursor)
def sql():return [c.args[0] for c in cur.execute.call_args_list]
def location(r):return r.headers['location']

ROUTES=[('get',f'/v1/me/holding/{H}/storage',None),('post',f'/v1/me/holding/{H}/storage/google/start',None),('post',f'/v1/me/holding/{H}/storage/test',None),
 ('post',f'/v1/me/holding/{H}/storage/disconnect',None),('post',f'/v1/me/holding/{H}/name',{'name':'Northlane360'})]
@pytest.mark.parametrize('method,url,body',ROUTES)
def test_every_owner_route_requires_a_session_before_touching_storage(method,url,body):
 with patch.object(api,'_cursor') as store:
  assert getattr(client,method)(url,**({'json':body} if body else {})).status_code==401
 store.assert_not_called()

def test_status_reports_no_keys_and_fails_closed_without_migration():
 cur.fetchone.side_effect=[(None,)]
 with reader(),db():r=client.get(f'/v1/me/holding/{H}/storage')
 assert r.status_code==200 and r.json()=={'holding_id':str(H),'provider':'google_drive','encrypted_before_upload':True,'enabled':False,'server_configured':True,'connected':False}
 cur.reset_mock();cur.fetchone.side_effect=READY+[state(connected=True,token_cipher='nl360:v1:SECRETO',root_folder_id='root_folder_0001',connected_at='2026-11-18T10:00:00+00:00',companies_with_storage=2)]
 with reader(),db():r=client.get(f'/v1/me/holding/{H}/storage')
 body=r.json()
 assert body['enabled'] and body['connected'] and body['companies_with_storage']==2 and body['connected_at']
 assert 'SECRETO' not in r.text and 'token' not in r.text and 'root_folder' not in r.text

def test_status_says_when_the_server_lacks_configuration(monkeypatch):
 monkeypatch.delenv('ELIOT_STORAGE_MASTER_KEY')
 cur.fetchone.side_effect=READY+[state()]
 with reader(),db():assert client.get(f'/v1/me/holding/{H}/storage').json()['server_configured'] is False
 with owner(),patch.object(api,'_cursor') as store:
  assert client.post(f'/v1/me/holding/{H}/storage/google/start').status_code==503
  assert client.post(f'/v1/me/holding/{H}/storage/test').status_code==503
 store.assert_not_called()

@pytest.mark.parametrize('cid,secret,redirect',[('no-es-de-google','secreto-de-google-0001',None),(CID,'corto',None),(CID,'secreto-de-google-0001','http://inseguro.example/v1/storage/google/callback'),
 (CID,'secreto-de-google-0001','https://otro.example/otra/ruta')])
def test_bad_google_configuration_is_not_configured(monkeypatch,cid,secret,redirect):
 monkeypatch.setenv('ELIOT_DRIVE_CLIENT_ID',cid);monkeypatch.setenv('ELIOT_DRIVE_CLIENT_SECRET',secret)
 if redirect:monkeypatch.setenv('ELIOT_DRIVE_REDIRECT_URI',redirect)
 assert drive.client_config() is None

def test_start_returns_google_url_with_minimal_scope_and_signed_state():
 cur.fetchone.side_effect=READY+[state()]
 with owner(),db():r=client.post(f'/v1/me/holding/{H}/storage/google/start')
 assert r.status_code==200
 url=urlparse(r.json()['authorization_url']);q={k:v[0] for k,v in parse_qs(url.query).items()}
 assert url.netloc=='accounts.google.com' and q['client_id']==CID and q['response_type']=='code' and q['access_type']=='offline'
 assert q['scope']=='https://www.googleapis.com/auth/drive.file'           # solo los archivos que crea la app
 assert q['redirect_uri']==drive.DEFAULT_REDIRECT and 'secreto' not in r.text
 assert crypto.read_state(q['state'])==(str(H),SUBJECT)

def test_start_is_refused_to_someone_who_does_not_own_the_holding():
 @contextmanager
 def refusing(_):
  raise HTTPException(403,'Tool control not authorized')
  yield
 with owner(),patch.object(api,'_cursor',refusing):assert client.post(f'/v1/me/holding/{H}/storage/google/start').status_code==403

# ---- Vuelta desde Google
def callback(**params):return client.get('/v1/storage/google/callback',params=params)
def test_callback_rejects_cancelled_missing_forged_or_expired_without_touching_anything():
 good=crypto.sign_state(str(H),SUBJECT);old=crypto.sign_state(str(H),SUBJECT,now=1)
 with patch.object(api,'_cursor') as store,patch.object(drive,'exchange_code') as exchange:
  assert location(callback(error='access_denied',state=good)).endswith('?almacen=cancelado')
  assert location(callback(state=good)).endswith('?almacen=error')
  assert location(callback(code='c')).endswith('?almacen=error')
  for bad in ('falso',good[:-1]+('0' if good[-1]!='0' else '1'),old):assert location(callback(code='c',state=bad)).endswith('?almacen=caducado')
 store.assert_not_called();exchange.assert_not_called()

def test_callback_first_connection_creates_root_folder_and_stores_only_ciphertext():
 cur.fetchone.side_effect=READY+[state(),({'holding_id':str(H),'connected':True,'provider':'google_drive','reconnected':False},)]
 with db(),patch.object(drive,'exchange_code',return_value=('1//llave-permanente-secreta','acc')) as exchange,\
   patch.object(drive,'create_folder',return_value='root_folder_0001') as folder,patch.object(drive,'folder_usable') as usable:
  r=callback(code='codigo-de-google',state=crypto.sign_state(str(H),SUBJECT))
 assert r.status_code==303 and location(r)=='https://app.tu-factoria.example/?almacen=conectado'
 exchange.assert_called_once_with('codigo-de-google');folder.assert_called_once_with('acc','Northlane360');usable.assert_not_called()
 call=cur.execute.call_args_list[-1].args
 assert call[0]=='SELECT eliot.owner_connect_holding_storage(%s,%s,%s,%s)' and call[1][0]==H and call[1][1]=='google_drive' and call[1][3]=='root_folder_0001'
 assert call[1][2].startswith('nl360:v1:') and 'llave-permanente' not in call[1][2]
 assert crypto.open_provider_token(call[1][2],str(H))=='1//llave-permanente-secreta'
 assert 'llave' not in location(r) and 'codigo' not in location(r)

def test_callback_reconnection_keeps_the_same_root_folder_when_it_is_still_reachable():
 cur.fetchone.side_effect=READY+[state(connected=True,token_cipher='nl360:v1:x',root_folder_id='root_folder_0001'),({'holding_id':str(H),'connected':True},)]
 with db(),patch.object(drive,'exchange_code',return_value=('1//otra-llave-permanente-01','acc')),patch.object(drive,'folder_usable',return_value=True) as usable,\
   patch.object(drive,'create_folder') as folder:
  assert location(callback(code='c',state=crypto.sign_state(str(H),SUBJECT))).endswith('=conectado')
 usable.assert_called_once_with('acc','root_folder_0001');folder.assert_not_called()
 assert cur.execute.call_args_list[-1].args[1][3]=='root_folder_0001'

@pytest.mark.parametrize('failure,result',[(drive.DriveError('provider_rejected_credentials'),'rechazado'),(HTTPException(409),'otra_cuenta'),(HTTPException(403),'sin_permiso'),(HTTPException(503),'error')])
def test_callback_reports_failures_without_details(failure,result):
 cur.fetchone.side_effect=READY+[state()]
 with db(),patch.object(drive,'exchange_code',side_effect=failure if isinstance(failure,drive.DriveError) else None,return_value=('1//llave-permanente-secreta','acc')),\
   patch.object(drive,'create_folder',side_effect=None if isinstance(failure,drive.DriveError) else failure,return_value='root_folder_0001'):
  r=callback(code='c',state=crypto.sign_state(str(H),SUBJECT))
 assert location(r).endswith('?almacen='+result)

# ---- Prueba de extremo a extremo
def connected():return READY+[state(connected=True,token_cipher=crypto.seal_provider_token('1//llave-permanente-secreta',str(H)),root_folder_id='root_folder_0001')]
def test_roundtrip_uploads_only_ciphertext_verifies_and_deletes():
 box={}
 def upload(token,name,parent,content):box.update(token=token,name=name,parent=parent,content=content);return 'file_id_00000001'
 cur.fetchone.side_effect=connected()
 with owner(),db(),patch.object(drive,'access_token',return_value='acc') as access,patch.object(drive,'upload_small',side_effect=upload),\
   patch.object(drive,'download',side_effect=lambda t,f:box['content']) as down,patch.object(drive,'delete') as delete:
  r=client.post(f'/v1/me/holding/{H}/storage/test')
 assert r.json()=={'holding_id':str(H),'ok':True,'reason':None,'uploaded':True,'stored_unreadable':True,'downloaded_and_verified':True,'deleted':True}
 access.assert_called_once_with('1//llave-permanente-secreta',str(H))
 assert box['parent']=='root_folder_0001' and box['name'].startswith('prueba-') and box['content'].startswith(crypto.MAGIC)
 down.assert_called_once_with('acc','file_id_00000001');delete.assert_called_once_with('acc','file_id_00000001')

def test_roundtrip_detects_altered_content_and_still_cleans_up():
 cur.fetchone.side_effect=connected()
 with owner(),db(),patch.object(drive,'access_token',return_value='acc'),patch.object(drive,'upload_small',return_value='file_id_00000001'),\
   patch.object(drive,'download',return_value=crypto.MAGIC+b'x'*5000),patch.object(drive,'delete') as delete:
  body=client.post(f'/v1/me/holding/{H}/storage/test').json()
 assert body['ok'] is False and body['reason']=='verification_failed' and body['downloaded_and_verified'] is False
 delete.assert_called_once()

def test_roundtrip_reports_provider_failure_and_not_connected():
 cur.fetchone.side_effect=connected()
 with owner(),db(),patch.object(drive,'access_token',return_value='acc'),patch.object(drive,'upload_small',side_effect=drive.DriveError('provider_denied')),patch.object(drive,'delete') as delete:
  body=client.post(f'/v1/me/holding/{H}/storage/test').json()
 assert body['ok'] is False and body['reason']=='provider_denied' and body['uploaded'] is False
 delete.assert_not_called()
 cur.reset_mock();cur.fetchone.side_effect=READY+[state()]
 with owner(),db():assert client.post(f'/v1/me/holding/{H}/storage/test').status_code==409

def test_stored_access_that_does_not_open_fails_closed():
 cur.fetchone.side_effect=READY+[state(connected=True,token_cipher=crypto.seal_provider_token('1//x'*8,'otro-holding'),root_folder_id='root_folder_0001')]
 with owner(),db(),patch.object(drive,'access_token') as access:assert client.post(f'/v1/me/holding/{H}/storage/test').status_code==503
 access.assert_not_called()

# ---- Desconectar y nombre
def test_disconnect_and_rename_exact_calls_and_strict_results():
 cur.fetchone.side_effect=READY+[({'holding_id':str(H),'connected':False,'removed':True},)]
 with owner(),db():r=client.post(f'/v1/me/holding/{H}/storage/disconnect')
 assert r.json()=={'holding_id':str(H),'connected':False,'removed':True} and cur.execute.call_args_list[-1].args==('SELECT eliot.owner_disconnect_holding_storage(%s)',(H,))
 cur.reset_mock();cur.fetchone.side_effect=READY+[({'holding_id':str(H),'name':'Northlane360','renamed':True},)]
 with owner(),db():r=client.post(f'/v1/me/holding/{H}/name',json={'name':'  Northlane360 '})
 assert r.json()=={'holding_id':str(H),'name':'Northlane360','renamed':True} and cur.execute.call_args_list[-1].args==('SELECT eliot.owner_rename_holding(%s,%s)',(H,'Northlane360'))
 for bad in ({},{'name':'X'},{'name':'   '},{'name':'x'*121},{'name':'a\nb'},{'name':'Ok','extra':1}):
  with owner(),patch.object(api,'_cursor') as store:assert client.post(f'/v1/me/holding/{H}/name',json=bad).status_code==422
  store.assert_not_called()
 cur.reset_mock();cur.fetchone.side_effect=READY+[({'holding_id':str(uuid4()),'name':'Northlane360','renamed':True},)]
 with owner(),db():assert client.post(f'/v1/me/holding/{H}/name',json={'name':'Northlane360'}).status_code==503

# ---- Cliente de Google: peticiones exactas contra un Google simulado
def google(handler):
 return patch.object(drive,'_http',lambda:httpx.Client(transport=httpx.MockTransport(handler)))
def test_drive_client_requests_and_strict_responses():
 seen=[]
 def handler(req):
  seen.append(req)
  if req.url.host=='oauth2.googleapis.com':
   form=parse_qs(req.content.decode())
   if form['grant_type']==['authorization_code']:return httpx.Response(200,json={'access_token':'acc','refresh_token':'1//llave-permanente-secreta','scope':'https://www.googleapis.com/auth/drive.file','expires_in':3599})
   return httpx.Response(200,json={'access_token':'acc2','expires_in':3599})
  if req.method=='POST' and req.url.path=='/drive/v3/files':return httpx.Response(200,json={'id':'folder_id_0000001'})
  if req.method=='POST' and req.url.path=='/upload/drive/v3/files':return httpx.Response(200,json={'id':'file_id_00000001'})
  if req.method=='GET' and req.url.params.get('alt')=='media':return httpx.Response(200,content=b'cifrado')
  if req.method=='GET':return httpx.Response(200,json={'id':'folder_id_0000001','mimeType':drive.FOLDER,'trashed':False})
  return httpx.Response(204)
 with google(handler):
  assert drive.exchange_code('codigo')==('1//llave-permanente-secreta','acc')
  form=parse_qs(seen[-1].content.decode())
  assert form['code']==['codigo'] and form['client_id']==[CID] and form['redirect_uri']==[drive.DEFAULT_REDIRECT]
  assert drive.access_token('1//llave-permanente-secreta','h')=='acc2' and drive.access_token('1//llave-permanente-secreta','h')=='acc2'
  assert sum(1 for r in seen if r.url.host=='oauth2.googleapis.com')==2          # la segunda vez reutiliza la llave de acceso
  assert drive.create_folder('acc','Northlane360')=='folder_id_0000001'
  assert seen[-1].headers['authorization']=='Bearer acc' and b'"mimeType":"application/vnd.google-apps.folder"' in seen[-1].content.replace(b' ',b'')
  assert drive.folder_usable('acc','folder_id_0000001') is True
  assert drive.upload_small('acc','prueba-1','folder_id_0000001',b'\x00cifrado\xff')=='file_id_00000001'
  assert seen[-1].url.params['uploadType']=='multipart' and b'\x00cifrado\xff' in seen[-1].content and b'"parents": ["folder_id_0000001"]' in seen[-1].content
  assert drive.download('acc','file_id_00000001')==b'cifrado'
  drive.delete('acc','file_id_00000001');assert seen[-1].method=='DELETE' and seen[-1].url.path=='/drive/v3/files/file_id_00000001'

@pytest.mark.parametrize('response,reason',[(httpx.Response(401,json={}),'provider_denied'),(httpx.Response(403,json={}),'provider_denied'),(httpx.Response(404,json={}),'provider_not_found'),
 (httpx.Response(500,text='x'),'provider_error'),(httpx.Response(200,json={'id':'../malo'}),'provider_response_invalid'),(httpx.Response(200,text='no json'),'provider_response_invalid')])
def test_drive_client_maps_failures_without_leaking_bodies(response,reason):
 with google(lambda req:response),pytest.raises(drive.DriveError) as e:drive.create_folder('acc','x')
 assert e.value.reason==reason and 'malo' not in str(e.value)

def test_exchange_requires_permanent_access_and_the_exact_scope():
 for payload,reason in (({'access_token':'a','scope':drive.SCOPE},'provider_gave_no_permanent_access'),({'access_token':'a','refresh_token':'1//llave-permanente-secreta','scope':'https://www.googleapis.com/auth/drive.readonly'},'provider_scope_missing'),
  ({'error':'invalid_grant'},'provider_rejected_credentials')):
  with google(lambda req,p=payload:httpx.Response(200 if 'access_token' in p else 400,json=p)),pytest.raises(drive.DriveError) as e:drive.exchange_code('c')
  assert e.value.reason==reason
 def boom(req):raise httpx.ConnectError('x')
 with google(boom),pytest.raises(drive.DriveError) as e:drive.exchange_code('c')
 assert e.value.reason=='provider_unreachable'
 with google(lambda req:httpx.Response(200,json={'id':'folder_id_0000001','mimeType':'text/plain','trashed':False})):assert drive.folder_usable('acc','folder_id_0000001') is False
 with google(lambda req:httpx.Response(404,json={})):assert drive.folder_usable('acc','folder_id_0000001') is False

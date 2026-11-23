"""PG desechable (037): almacén cifrado por empresa y nombre del holding. Solo propietarios,
llave de cada empresa aislada, alta única (no se sustituye una llave) y auditoría sin llaves."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
PROVISION='SELECT eliot.owner_provision_company(%s,%s,%s,%s,%s,%s,%s,%s)'
def count(sql,args=()):return query(sql,args)[0][0]
def call(sql,args,subject='test|ownerA'):return query('SELECT '+sql,args,role='eliot_identity',subject=subject)[0][0]
TOKEN='nl360:v1:'+'t'*60;TOKEN2='nl360:v1:'+'u'*60;ROOT='root_folder_0001';KA='nl360:v1:'+'a'*60;KB='nl360:v1:'+'b'*60

owner_a=count("SELECT id FROM eliot.users WHERE external_subject='test|ownerA'")
H=count("INSERT INTO eliot.holdings(name) VALUES('Superempresa Freddy') RETURNING id")
query('INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(%s,%s)',(H,owner_a))
def provision(name):
 return query(PROVISION,(H,name,'Proyecto '+name,'Proyecto de prueba desechable para '+name,None,None,[],uuid4()),role='eliot_identity')[0][0]['organization_id']
a=provision('Almacen Portal');b=provision('Almacen LLC')
NOT_OWNER=psycopg.errors.InsufficientPrivilege;BAD=psycopg.errors.InvalidParameterValue;STATE=psycopg.errors.ObjectNotInPrerequisiteState

# --- 1. Nombre del holding: solo su propietario, auditado, repetir no hace nada.
r=call('eliot.owner_rename_holding(%s,%s)',(H,' Northlane360 '))
assert r=={'holding_id':str(H),'name':'Northlane360','renamed':True}
assert call('eliot.owner_rename_holding(%s,%s)',(H,'Northlane360'))['renamed'] is False
assert query("SELECT detail FROM eliot.holding_audit WHERE holding_id=%s AND action='holding_renamed'",(H,))==[({'from':'Superempresa Freddy','to':'Northlane360'},)]
for bad in ('X','x'*121,'Con\nsalto',None):denied(lambda:call('eliot.owner_rename_holding(%s,%s)',(H,bad)),BAD)
for intruder in ('test|ownerB','nadie|x'):
 denied(lambda:call('eliot.owner_rename_holding(%s,%s)',(H,'Robado'),intruder),NOT_OWNER)
 denied(lambda:call('eliot.owner_holding_storage(%s)',(H,),intruder),NOT_OWNER)
 denied(lambda:call('eliot.owner_connect_holding_storage(%s,%s,%s,%s)',(H,'google_drive',TOKEN,ROOT),intruder),NOT_OWNER)
 denied(lambda:call('eliot.owner_disconnect_holding_storage(%s)',(H,),intruder),NOT_OWNER)
 denied(lambda:call('eliot.owner_company_storage(%s)',(a,),intruder),NOT_OWNER)
 denied(lambda:call('eliot.owner_create_company_storage(%s,%s,%s)',(a,KA,'folder_a_000001'),intruder),NOT_OWNER)
assert count('SELECT name FROM eliot.holdings WHERE id=%s',(H,))=='Northlane360'

# --- 2. Sin conexión: nada de llaves; no se puede dar de alta el almacén de una empresa.
assert call('eliot.owner_holding_storage(%s)',(H,))=={'holding_id':str(H),'connected':False}
assert call('eliot.owner_company_storage(%s)',(a,))=={'organization_id':a,'connected':False,'ready':False}
denied(lambda:call('eliot.owner_create_company_storage(%s,%s,%s)',(a,KA,'folder_a_000001')),STATE)

# --- 3. Conectar: valida forma, guarda solo el texto cifrado y audita sin llaves.
for args in ((H,'dropbox',TOKEN,ROOT),(H,'google_drive','en-claro',ROOT),(H,'google_drive',TOKEN,'../x'),(H,'google_drive',None,ROOT)):
 denied(lambda:call('eliot.owner_connect_holding_storage(%s,%s,%s,%s)',args),BAD)
r=call('eliot.owner_connect_holding_storage(%s,%s,%s,%s)',(H,'google_drive',TOKEN,ROOT))
assert r=={'holding_id':str(H),'connected':True,'provider':'google_drive','reconnected':False}
s=call('eliot.owner_holding_storage(%s)',(H,))
assert s['connected'] is True and s['token_cipher']==TOKEN and s['root_folder_id']==ROOT and s['companies_with_storage']==0
assert 'nl360' not in str(query("SELECT detail FROM eliot.holding_audit WHERE holding_id=%s",(H,)))

# --- 4. Almacén por empresa: alta única; un segundo intento NO sustituye la llave.
r=call('eliot.owner_create_company_storage(%s,%s,%s)',(a,KA,'folder_a_000001'))
assert r=={'organization_id':a,'created':True,'key_cipher':KA,'folder_id':'folder_a_000001'}
r=call('eliot.owner_create_company_storage(%s,%s,%s)',(a,'nl360:v1:'+'z'*60,'folder_otra_0001'))
assert r=={'organization_id':a,'created':False,'key_cipher':KA,'folder_id':'folder_a_000001'}
call('eliot.owner_create_company_storage(%s,%s,%s)',(b,KB,'folder_b_000001'))
for args in ((a,'en-claro','folder_a_000001'),(a,KA,'mala carpeta')):denied(lambda:call('eliot.owner_create_company_storage(%s,%s,%s)',args),BAD)
sa=call('eliot.owner_company_storage(%s)',(a,));sb=call('eliot.owner_company_storage(%s)',(b,))
assert sa['ready'] and sa['key_cipher']==KA and sa['folder_id']=='folder_a_000001' and sa['token_cipher']==TOKEN
assert sb['key_cipher']==KB and sb['folder_id']=='folder_b_000001' and KA not in str(sb) and KB not in str(sa)
assert count("SELECT count(*) FROM eliot.holding_audit WHERE action='company_storage_created' AND holding_id=%s",(H,))==2
assert call('eliot.owner_holding_storage(%s)',(H,))['companies_with_storage']==2

# --- 5. Reconectar renueva el acceso; cambiar de carpeta raíz con empresas ya creadas se rechaza.
r=call('eliot.owner_connect_holding_storage(%s,%s,%s,%s)',(H,'google_drive',TOKEN2,ROOT))
assert r['reconnected'] is True and call('eliot.owner_holding_storage(%s)',(H,))['token_cipher']==TOKEN2
denied(lambda:call('eliot.owner_connect_holding_storage(%s,%s,%s,%s)',(H,'google_drive',TOKEN2,'otra_raiz_000001')),STATE)

# --- 6. El rol de aplicación no lee ni escribe las tablas directamente.
for table in ('holding_storage','company_storage'):
 try:rows=query('SELECT * FROM eliot.'+table,role='eliot_identity')
 except NOT_OWNER:rows=[]
 assert rows==[]

# --- 7. Desconectar borra el acceso pero conserva las llaves de las empresas.
assert call('eliot.owner_disconnect_holding_storage(%s)',(H,))=={'holding_id':str(H),'connected':False,'removed':True}
assert call('eliot.owner_disconnect_holding_storage(%s)',(H,))['removed'] is False
assert count('SELECT count(*) FROM eliot.holding_storage WHERE holding_id=%s',(H,))==0
assert count('SELECT count(*) FROM eliot.company_storage WHERE organization_id IN (%s,%s)',(a,b))==2
assert call('eliot.owner_company_storage(%s)',(a,))=={'organization_id':a,'connected':False,'ready':False}
call('eliot.owner_connect_holding_storage(%s,%s,%s,%s)',(H,'google_drive',TOKEN,ROOT))
assert call('eliot.owner_company_storage(%s)',(a,))['key_cipher']==KA

# --- 8. Carrera: dos altas simultáneas del almacén de la misma empresa dejan UNA llave.
c=provision('Almacen Carrera')
def race(n):return call('eliot.owner_create_company_storage(%s,%s,%s)',(c,'nl360:v1:'+str(n)*60,'folder_c_00000'+str(n)))
with ThreadPoolExecutor(2) as pool:res=list(pool.map(race,(1,2)))
assert sorted(r['created'] for r in res)==[False,True] and res[0]['key_cipher']==res[1]['key_cipher']
assert count('SELECT count(*) FROM eliot.company_storage WHERE organization_id=%s',(c,))==1
print('PG almacén 037: nombre del holding, conexión solo del propietario, llave por empresa aislada y de alta única, sin acceso directo, desconexión que conserva llaves y carreras superadas')

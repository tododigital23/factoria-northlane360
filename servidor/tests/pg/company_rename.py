"""PG desechable (036): renombrar una empresa. Solo su propietario, sin repetir nombre en el
holding, sin mover datos y con auditoría. Usa las funciones reales y los principales de CI."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
PROVISION='SELECT eliot.owner_provision_company(%s,%s,%s,%s,%s,%s,%s,%s)'
RENAME='SELECT eliot.owner_rename_company(%s,%s)'
def count(sql,args=()):return query(sql,args)[0][0]
def rename(org,name,subject='test|ownerA'):return query(RENAME,(org,name),role='eliot_identity',subject=subject)[0][0]

owner_a=count("SELECT id FROM eliot.users WHERE external_subject='test|ownerA'")
H=count("INSERT INTO eliot.holdings(name) VALUES('Holding renombrado CI') RETURNING id")
query('INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(%s,%s)',(H,owner_a))
def provision(name):
 return query(PROVISION,(H,name,'Proyecto '+name,'Proyecto de prueba desechable para '+name,None,None,['email'],uuid4()),role='eliot_identity')[0][0]['organization_id']
a=provision('Nova Demo');b=provision('Nova Demo LLC')
before=query("SELECT (SELECT count(*) FROM eliot.departments WHERE organization_id=%s),(SELECT count(*) FROM eliot.ai_workers WHERE organization_id=%s),"
 "(SELECT count(*) FROM eliot.organization_memberships WHERE organization_id=%s)",(a,a,a))[0]

# --- 1. El propietario renombra: cambia solo el nombre y queda auditado.
r=rename(a,'  Nova Demo Portal  ')
assert r=={'organization_id':a,'name':'Nova Demo Portal','renamed':True}
assert count('SELECT name FROM eliot.organizations WHERE id=%s',(a,))=='Nova Demo Portal'
assert count('SELECT name FROM eliot.organizations WHERE id=%s',(b,))=='Nova Demo LLC'
after=query("SELECT (SELECT count(*) FROM eliot.departments WHERE organization_id=%s),(SELECT count(*) FROM eliot.ai_workers WHERE organization_id=%s),"
 "(SELECT count(*) FROM eliot.organization_memberships WHERE organization_id=%s)",(a,a,a))[0]
assert after==before
audit=query("SELECT detail,actor FROM eliot.holding_audit WHERE organization_id=%s AND action='company_renamed'",(a,))
assert audit==[({'from':'Nova Demo','to':'Nova Demo Portal'},owner_a)]
holding=[h for (h,) in query('SELECT * FROM eliot.my_holding()',role='eliot_identity') if h['id']==str(H)][0]
assert sorted(c['name'] for c in holding['companies'])==['Nova Demo LLC','Nova Demo Portal']

# --- 2. Repetir el mismo nombre no hace nada ni añade auditoría.
assert rename(a,'Nova Demo Portal')['renamed'] is False
assert count("SELECT count(*) FROM eliot.holding_audit WHERE organization_id=%s AND action='company_renamed'",(a,))==1

# --- 3. Nombre ya usado en el holding (sin distinguir mayúsculas): rechazado, nada cambia.
denied(lambda:rename(a,'nova demo llc'),psycopg.errors.ObjectNotInPrerequisiteState)
assert count('SELECT name FROM eliot.organizations WHERE id=%s',(a,))=='Nova Demo Portal'

# --- 4. Nombres inválidos.
for bad in ('',' ','X','x'*121,'Con\nsalto',None):
 denied(lambda:rename(a,bad),psycopg.errors.InvalidParameterValue)

# --- 5. Quien no es propietario de ESA empresa no puede, aunque sea propietario de otra.
denied(lambda:rename(a,'Robada',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:rename(a,'Robada',subject='nadie|x'),psycopg.errors.InsufficientPrivilege)
denied(lambda:rename(uuid4(),'No existe'),psycopg.errors.InsufficientPrivilege)
assert count('SELECT name FROM eliot.organizations WHERE id=%s',(a,))=='Nova Demo Portal'

# --- 6. El rol de aplicación no puede tocar la tabla directamente, ni la auditoría se puede alterar.
try:direct=query("UPDATE eliot.organizations SET name='Directo' WHERE id=%s RETURNING id",(a,),role='eliot_identity')
except psycopg.errors.InsufficientPrivilege:direct=[]
assert direct==[]
assert count('SELECT name FROM eliot.organizations WHERE id=%s',(a,))=='Nova Demo Portal'
denied(lambda:query("UPDATE eliot.holding_audit SET detail='{}' WHERE organization_id=%s",(a,)),psycopg.Error)

# --- 7. Carrera: dos empresas intentan quedarse a la vez con el mismo nombre; solo una lo consigue.
def race(org):
 try:return rename(org,'Nombre Disputado')['renamed']
 except psycopg.errors.ObjectNotInPrerequisiteState:return None
with ThreadPoolExecutor(2) as pool:res=list(pool.map(race,(a,b)))
assert sorted(res,key=str)==[None,True]
assert count("SELECT count(*) FROM eliot.organizations o JOIN eliot.holding_companies c ON c.organization_id=o.id WHERE c.holding_id=%s AND lower(o.name)='nombre disputado'",(H,))==1
print('PG renombrar 036: solo el propietario, nombre único en el holding, sin mover datos, auditado, sin acceso directo y carreras superadas')

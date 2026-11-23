"""PG desechable (038): retirar una empresa de La Factoría. Libera la parcela, pausa sus tareas recurrentes,
no borra nada, solo el propietario, con el nombre escrito y con auditoría. Usa las funciones reales y los principales de CI."""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
PROVISION='SELECT eliot.owner_provision_company(%s,%s,%s,%s,%s,%s,%s,%s)'
RETIRE='SELECT eliot.owner_retire_company(%s,%s)'
def count(sql,args=()):return query(sql,args)[0][0]
def retire(org,name,subject='test|ownerA'):return query(RETIRE,(org,name),role='eliot_identity',subject=subject)[0][0]
def retired(subject='test|ownerA'):return sorted(str(r[0]) for r in query('SELECT * FROM eliot.my_retired_companies()',role='eliot_identity',subject=subject))

owner_a=count("SELECT id FROM eliot.users WHERE external_subject='test|ownerA'")
H=count("INSERT INTO eliot.holdings(name) VALUES('Holding retirada CI') RETURNING id")
query('INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(%s,%s)',(H,owner_a))
def provision(name):
 return query(PROVISION,(H,name,'Proyecto '+name,'Proyecto de prueba desechable para '+name,None,None,['email'],uuid4()),role='eliot_identity')[0][0]['organization_id']
a=provision('Juguetes Demo');b=provision('Se queda')
slot_a=count('SELECT slot FROM eliot.holding_companies WHERE organization_id=%s',(a,))
dept,worker=query('SELECT department_id,id FROM eliot.ai_workers WHERE organization_id=%s LIMIT 1',(a,))[0]
query("INSERT INTO eliot.department_routines(organization_id,department_id,worker_id,title,instructions,cadence,created_by,request_key) VALUES(%s,%s,%s,'Rutina de prueba','Instrucciones de la rutina de prueba','daily',%s,%s)",(a,dept,worker,owner_a,uuid4()))
shape=lambda org:query("SELECT (SELECT count(*) FROM eliot.departments WHERE organization_id=%s),(SELECT count(*) FROM eliot.ai_workers WHERE organization_id=%s),"
 "(SELECT count(*) FROM eliot.organization_memberships WHERE organization_id=%s),(SELECT count(*) FROM eliot.department_routines WHERE organization_id=%s)",(org,org,org,org))[0]
before=shape(a)
assert retired()==[]

# --- 1. Sin el nombre exacto no se retira nada.
for bad in ('juguetes demo','Juguetes','',None,'Se queda'):
 denied(lambda:retire(a,bad),psycopg.errors.InvalidParameterValue)
assert count('SELECT count(*) FROM eliot.holding_companies WHERE organization_id=%s',(a,))==1

# --- 2. Quien no es propietario de esa empresa no puede.
denied(lambda:retire(a,'Juguetes Demo',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:retire(a,'Juguetes Demo',subject='nadie|x'),psycopg.errors.InsufficientPrivilege)
denied(lambda:retire(uuid4(),'No existe'),psycopg.errors.InsufficientPrivilege)

# --- 3. El propietario la retira: la parcela queda libre, las rutinas pausadas, y no se borra nada.
r=retire(a,'  Juguetes Demo ')
assert r=={'organization_id':a,'name':'Juguetes Demo','slot':slot_a,'retired':True,'routines_paused':1}
assert count('SELECT count(*) FROM eliot.holding_companies WHERE organization_id=%s',(a,))==0
assert count('SELECT count(*) FROM eliot.holding_companies WHERE organization_id=%s',(b,))==1
assert shape(a)==before
assert count("SELECT count(*) FROM eliot.department_routines WHERE organization_id=%s AND state='active'",(a,))==0
assert count('SELECT name FROM eliot.organizations WHERE id=%s',(a,))=='Juguetes Demo'
audit=query("SELECT detail,actor FROM eliot.holding_audit WHERE organization_id=%s AND action='company_retired'",(a,))
assert audit==[({'name':'Juguetes Demo','slot':slot_a,'routines_paused':1},owner_a)]
holding=[h for (h,) in query('SELECT * FROM eliot.my_holding()',role='eliot_identity') if h['id']==str(H)][0]
assert [c['name'] for c in holding['companies']]==['Se queda']
assert retired()==[str(a)] and retired('test|ownerB')==[]

# --- 4. Retirarla otra vez: ya no está en el holding.
denied(lambda:retire(a,'Juguetes Demo'),psycopg.errors.ObjectNotInPrerequisiteState)

# --- 5. La parcela libre se puede volver a ocupar con una empresa nueva.
c=provision('Empresa nueva')
assert count('SELECT slot FROM eliot.holding_companies WHERE organization_id=%s',(c,))==slot_a
assert retired()==[str(a)]
print('COMPANY RETIREMENT OK')

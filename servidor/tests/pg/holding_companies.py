"""PG desechable (034): holding de Freddy, 5 empresas aisladas, mensajes solo dentro de cada
empresa y tareas recurrentes. Usa las funciones reales y los principales de CI existentes."""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
PROVISION='SELECT eliot.owner_provision_company(%s,%s,%s,%s,%s,%s,%s,%s)'
HOLDING='SELECT * FROM eliot.my_holding()'
WORKER_ROLE='ci_doc_worker'      # principal habilitado para ORG
OTHER_ROLE='ci_doc_other'        # principal habilitado para OTHER


def as_principal(role,sql,args):
 with psycopg.connect('') as c,c.cursor() as cur:
  cur.execute("SET statement_timeout='12s'");cur.execute('SET SESSION AUTHORIZATION '+role)
  cur.execute(sql,args);return cur.fetchall() if cur.description else []
def count(sql,args=()):return query(sql,args)[0][0]
def provision(name,caps=(),key=None,subject='test|ownerA',repo='tu-organizacion/demo',site='https://demo.example.com'):
 return query(PROVISION,(H,name,'Proyecto '+name,'Proyecto de prueba desechable para '+name,repo,site,list(caps),key or uuid4()),
  role='eliot_identity',subject=subject)[0][0]

owner_a=count("SELECT id FROM eliot.users WHERE external_subject='test|ownerA'")
H=count("INSERT INTO eliot.holdings(name) VALUES('Superempresa Freddy CI') RETURNING id")
query('INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(%s,%s)',(H,owner_a))

# --- 1. Alta de empresa: transacción completa, plantilla por capacidades, idempotencia.
key=uuid4();c1=provision('Empresa Uno',('seo','email'),key)
assert c1['slot']==1 and c1['replayed'] is False and c1['provider_called'] is False
names=[d['name'] for d in c1['departments']]
assert names==['Dirección IA','Desarrollo','Calidad','Operaciones','Marketing','Administración','SEO y Contenidos','Atención y Email']
o1=c1['organization_id']
assert c1['workers_created']==8 and count("SELECT count(*) FROM eliot.ai_workers WHERE organization_id=%s AND operating_state<>'inactive'",(o1,))==0
assert count("SELECT role FROM eliot.organization_memberships WHERE organization_id=%s AND user_id=%s",(o1,owner_a))=='owner'
assert count("SELECT count(*) FROM eliot.organization_capabilities WHERE organization_id=%s AND state='planned'",(o1,))==2
replay=provision('Empresa Uno',('seo','email'),key);assert replay['replayed'] is True and replay['organization_id']==o1
denied(lambda:provision('Otro nombre',(),key),psycopg.errors.InvalidParameterValue)
assert count('SELECT count(*) FROM eliot.holding_companies WHERE holding_id=%s',(H,))==1
# Validación: capacidades, enlaces y duplicados; nada se crea al fallar.
for caps in (('telepathy',),('seo','seo')):
 denied(lambda:provision('Mala',caps),psycopg.errors.InvalidParameterValue)
denied(lambda:provision('Mala',(),repo='no es repo'),psycopg.errors.InvalidParameterValue)
denied(lambda:provision('Mala',(),site='http://inseguro.example.com'),psycopg.errors.InvalidParameterValue)
denied(lambda:provision('empresa uno'),psycopg.errors.ObjectNotInPrerequisiteState)
assert count('SELECT count(*) FROM eliot.holding_companies WHERE holding_id=%s',(H,))==1
# Autorización: solo propietarios del holding.
denied(lambda:provision('Intrusa',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:provision('Intrusa',subject='test|not-a-member'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(PROVISION,(H,'X','Proyecto X','Proyecto de prueba desechable',None,None,[],uuid4()),role='eliot_execution_worker'),
       psycopg.errors.InsufficientPrivilege)

# --- 2. Hasta 5 empresas; la sexta se rechaza.
others=[provision(f'Empresa {n}',caps) for n,caps in (('Dos',('orders',)),('Tres',('monitoring','automation')),('Cuatro',()),('Cinco',('marketing',)))]
assert [c['slot'] for c in others]==[2,3,4,5]
denied(lambda:provision('Empresa Seis'),psycopg.errors.ObjectNotInPrerequisiteState)
o2=others[0]['organization_id']
assert 'Pedidos' in [d['name'] for d in others[0]['departments']]
h=[r[0] for r in owner(HOLDING)]
assert len(h)==1 and h[0]['max_companies']==5 and [c['slot'] for c in h[0]['companies']]==[1,2,3,4,5]
c=h[0]['companies'][0];assert c['departments']==8 and c['workers']==8 and c['active_workers']==0 and c['tasks']['pending']==0
assert c['repository']=='tu-organizacion/demo' and c['website_url']=='https://demo.example.com'
assert [r[0] for r in query(HOLDING,role='eliot_identity',subject='test|ownerB')]==[]   # no ve el holding
for table in ('holdings','holding_companies','organization_profiles','ai_worker_messages','department_routines'):
 denied(lambda:query('SELECT * FROM eliot.'+table,role='eliot_identity'),psycopg.errors.InsufficientPrivilege)

# --- 3. Perfil y capacidades: solo el propietario de esa empresa.
query('SELECT eliot.owner_update_company_profile(%s,%s,%s,%s,%s)',(o1,'Tienda online','Proyecto actualizado para pruebas CI',None,'https://tienda.example.com'),
      role='eliot_identity',subject='test|ownerA')
denied(lambda:query('SELECT eliot.owner_update_company_profile(%s,%s,%s,%s,%s)',(o1,'X','Intento ajeno de cambio',None,None),
       role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
r=owner('SELECT eliot.owner_set_company_capability(%s,%s,%s)',(o1,'orders','planned'))[0][0]
assert r['departments_created']==1 and count("SELECT count(*) FROM eliot.departments WHERE organization_id=%s AND name='Pedidos'",(o1,))==1
assert owner('SELECT eliot.owner_set_company_capability(%s,%s,%s)',(o1,'orders','planned'))[0][0]['departments_created']==0
owner('SELECT eliot.owner_set_company_capability(%s,%s,%s)',(o1,'orders','disabled'))
assert count("SELECT count(*) FROM eliot.departments WHERE organization_id=%s AND name='Pedidos'",(o1,))==1  # nunca borra
denied(lambda:owner('SELECT eliot.owner_set_company_capability(%s,%s,%s)',(o1,'email','enabled')),psycopg.errors.InvalidParameterValue)
assert count('SELECT count(*) FROM eliot.holding_audit WHERE holding_id=%s',(H,))>=9
denied(lambda:query('DELETE FROM eliot.holding_audit'),psycopg.errors.ObjectNotInPrerequisiteState)

# --- 4. Mensajes entre agentes: solo dentro de la misma empresa.
w_o1=count("SELECT id FROM eliot.ai_workers WHERE organization_id=%s AND display_name='Especialista SEO IA'",(o1,))
w_o2=count("SELECT id FROM eliot.ai_workers WHERE organization_id=%s AND display_name='Gestor de pedidos IA'",(o2,))
denied(lambda:query('INSERT INTO eliot.ai_worker_messages(organization_id,from_worker_id,to_worker_id,body) VALUES(%s,%s,%s,%s)',
       (o1,w_o1,w_o2,'cruce entre empresas')),psycopg.errors.ForeignKeyViolation)
peer=count("INSERT INTO eliot.ai_workers(organization_id,department_id,display_name,specialty,operating_state) VALUES(%s,%s,'Compañero CI','Revisión','inactive') RETURNING id",(ORG,DEPT))
query('UPDATE eliot.ai_model_budget_daily SET calls_reserved=0,token_units_reserved=0 WHERE organization_id=%s',(ORG,))
t=new_task();p,_=plan(t);l,a=approval(t);job=owner(ENQUEUE,(ORG,t,WORKER,l,a,uuid4(),p))[0][0]
while True:
 claim=as_principal(WORKER_ROLE,'SELECT * FROM eliot.worker_take_document_job_with_objective(%s)',(ORG,))
 assert claim
 if claim[0][0]==job:break
 as_principal(WORKER_ROLE,'SELECT eliot.worker_finish_document_job(%s,%s,%s,%s,%s)',(ORG,claim[0][0],claim[0][1],None,'rate_limited'))
token=claim[0][1];POST='SELECT eliot.worker_post_agent_message(%s,%s,%s,%s,%s)'
mid=as_principal(WORKER_ROLE,POST,(ORG,job,token,peer,'Necesito revisión de la sección 2'))[0][0]
denied(lambda:as_principal(WORKER_ROLE,POST,(ORG,job,token,w_o1,'Hola otra empresa')),psycopg.errors.ForeignKeyViolation)
denied(lambda:as_principal(WORKER_ROLE,POST,(ORG,job,uuid4(),peer,'token falso')),psycopg.errors.InsufficientPrivilege)
denied(lambda:as_principal(OTHER_ROLE,POST,(ORG,job,token,peer,'principal de otra empresa')),psycopg.errors.InsufficientPrivilege)
msgs=[r[0] for r in owner('SELECT * FROM eliot.my_agent_messages(%s)',(ORG,))]
assert msgs[0]['id']==str(mid) and msgs[0]['to_worker']=='Compañero CI' and msgs[0]['task_id']==str(t)
assert [r[0] for r in query('SELECT * FROM eliot.my_agent_messages(%s)',(o1,),role='eliot_identity',subject='test|ownerA')]==[]
denied(lambda:query('SELECT * FROM eliot.my_agent_messages(%s)',(o1,),role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query('UPDATE eliot.ai_worker_messages SET body=%s',('x',)),psycopg.errors.ObjectNotInPrerequisiteState)

# --- 5. Tareas recurrentes: una tarea por periodo, sin ejecución; principal limitado a su empresa.
seo_dept=count("SELECT id FROM eliot.departments WHERE organization_id=%s AND name='SEO y Contenidos'",(o1,))
ROUT='SELECT eliot.owner_create_routine(%s,%s,%s,%s,%s,%s,%s,%s)'
rk=uuid4();rargs=(o1,seo_dept,w_o1,'Revisión SEO semanal','Revisar posiciones y errores de indexación de la web','weekly','seo',rk)
rid=owner(ROUT,rargs)[0][0];assert owner(ROUT,rargs)[0][0]==rid
denied(lambda:owner(ROUT,(o1,seo_dept,w_o2,'Cruce','Instrucciones de prueba válidas','daily',None,uuid4())),psycopg.errors.InvalidParameterValue)
denied(lambda:owner(ROUT,(o1,seo_dept,w_o1,'Mala','Instrucciones de prueba válidas','hourly',None,uuid4())),psycopg.errors.InvalidParameterValue)
assert owner('SELECT eliot.owner_run_due_routines(%s)',(o1,))[0][0]==1
assert owner('SELECT eliot.owner_run_due_routines(%s)',(o1,))[0][0]==0          # idempotente por periodo
task=count("SELECT t.id FROM eliot.department_routine_runs r JOIN eliot.ai_tasks t ON t.id=r.task_id WHERE r.routine_id=%s",(rid,))
assert count('SELECT status FROM eliot.ai_tasks WHERE id=%s',(task,))=='pending'
assert count('SELECT assignee_worker_id FROM eliot.ai_tasks WHERE id=%s',(task,))==w_o1
assert count('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(task,))==0  # nada se ejecuta
# Principal de ORG materializa rutinas de ORG; otro principal no.
rorg=owner(ROUT,(ORG,DEPT,WORKER,'Control diario de fallos','Revisar errores registrados en las últimas 24 horas','daily','monitoring',uuid4()))[0][0]
denied(lambda:as_principal(OTHER_ROLE,'SELECT eliot.worker_run_due_routines(%s)',(ORG,)),psycopg.errors.InsufficientPrivilege)
denied(lambda:as_principal(WORKER_ROLE,'SELECT eliot.worker_run_due_routines(%s)',(o1,)),psycopg.errors.InsufficientPrivilege)
assert as_principal(WORKER_ROLE,'SELECT eliot.worker_run_due_routines(%s)',(ORG,))[0][0]==1
assert as_principal(WORKER_ROLE,'SELECT eliot.worker_run_due_routines(%s)',(ORG,))[0][0]==0
owner('SELECT eliot.owner_control_routine(%s,%s,%s)',(o1,rid,'paused'))
routines=[r[0] for r in owner('SELECT * FROM eliot.my_routines(%s)',(o1,))]
assert routines[0]['state']=='paused' and routines[0]['runs']==1 and routines[0]['department']=='SEO y Contenidos'
denied(lambda:query('SELECT * FROM eliot.my_routines(%s)',(o1,),role='eliot_identity',subject='test|ownerB'),psycopg.errors.InsufficientPrivilege)
h=[r[0] for r in owner(HOLDING)][0]
assert h['companies'][0]['tasks']['pending']==1 and h['companies'][0]['routines_active']==0

# --- 6. Altas concurrentes con claves distintas: huecos únicos, sin duplicados.
H2=count("INSERT INTO eliot.holdings(name,max_companies) VALUES('Holding carrera',2) RETURNING id")
query('INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(%s,%s)',(H2,owner_a))
barrier=Barrier(3)
def race(n):
 barrier.wait()
 try:return query(PROVISION,(H2,f'Carrera {n}','Proyecto carrera','Proyecto de carrera concurrente CI',None,None,[],uuid4()),role='eliot_identity')[0][0]['slot']
 except psycopg.errors.ObjectNotInPrerequisiteState:return None
with ThreadPoolExecutor(3) as pool:slots=list(pool.map(race,range(3)))
assert sorted(s for s in slots if s)==[1,2] and slots.count(None)==1
print('PG holding 034: alta transaccional e idempotente, plantilla por capacidades, límite 5, perfil/capacidades del propietario, '
      'agregados sin contenido, mensajes solo intra-empresa, rutinas por periodo sin ejecución, principales acotados y carreras superadas')

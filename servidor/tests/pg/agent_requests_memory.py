"""PG desechable (035): «Pedir una tarea» a un agente y memoria compartida por empresa, con aislamiento."""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
REQ='SELECT eliot.owner_request_agent_task(%s,%s,%s,%s,%s)'
MEM_SET='SELECT eliot.owner_set_company_memory(%s,%s,%s)'
def count(sql,args=()):return query(sql,args)[0][0]
def as_owner(sql,args,subject='test|ownerA'):return query(sql,args,role='eliot_identity',subject=subject)

owner_a=count("SELECT id FROM eliot.users WHERE external_subject='test|ownerA'")
H=count("INSERT INTO eliot.holdings(name) VALUES('Holding 035 CI') RETURNING id")
query('INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(%s,%s)',(H,owner_a))
PROV='SELECT eliot.owner_provision_company(%s,%s,%s,%s,%s,%s,%s,%s)'
c1=as_owner(PROV,(H,'Portal 035','Portal web','Portal de pruebas para el encargo de tareas',None,None,['seo'],uuid4()))[0][0]
c2=as_owner(PROV,(H,'Saas 035','Agentes SaaS','SaaS de pruebas para el aislamiento de memoria',None,None,['email'],uuid4()))[0][0]
o1,o2=c1['organization_id'],c2['organization_id']
seo=count("SELECT id FROM eliot.ai_workers WHERE organization_id=%s AND display_name='Especialista SEO IA'",(o1,))
mail=count("SELECT id FROM eliot.ai_workers WHERE organization_id=%s AND display_name='Gestor de email IA'",(o2,))

# --- 1. Encargo: una tarea pendiente asignada, con el texto completo; idempotente.
text='Revisa el posicionamiento de la página de precios\ny propone 5 mejoras concretas de títulos y descripciones.'
key=uuid4();r=as_owner(REQ,(o1,seo,text,'Lista de 5 mejoras con prioridad',key))[0][0]
assert r['status']=='pending' and r['replayed'] is False and r['execution_started'] is False
assert r['title']=='Revisa el posicionamiento de la página de precios'
t=r['task_id']
assert count('SELECT assignee_worker_id FROM eliot.ai_tasks WHERE id=%s',(t,))==seo
assert count('SELECT department_id FROM eliot.ai_tasks WHERE id=%s',(t,))==count('SELECT department_id FROM eliot.ai_workers WHERE id=%s',(seo,))
assert count('SELECT count(*) FROM eliot.ai_document_jobs WHERE task_id=%s',(t,))==0            # nada se ejecuta
again=as_owner(REQ,(o1,seo,text,'Lista de 5 mejoras con prioridad',key))[0][0]
assert again['replayed'] is True and again['task_id']==t
assert count('SELECT count(*) FROM eliot.ai_tasks WHERE organization_id=%s',(o1,))==1
denied(lambda:as_owner(REQ,(o1,seo,text+' cambiado',None,key)),psycopg.errors.InvalidParameterValue)
long='Analiza '+'la estructura de enlaces internos '*10
r2=as_owner(REQ,(o1,seo,long,None,uuid4()))[0][0]
assert len(r2['title'])<=151 and r2['title'].endswith('…')
denied(lambda:as_owner(REQ,(o1,seo,'corto',None,uuid4())),psycopg.errors.InvalidParameterValue)
denied(lambda:as_owner(REQ,(o1,seo,'x'*2001,None,uuid4())),psycopg.errors.InvalidParameterValue)
# Aislamiento: agente de otra empresa, no propietario, rol worker.
denied(lambda:as_owner(REQ,(o1,mail,'Encargo cruzado entre empresas',None,uuid4())),psycopg.errors.InvalidParameterValue)
denied(lambda:as_owner(REQ,(o1,seo,'Encargo de alguien ajeno',None,uuid4()),'test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query(REQ,(o1,seo,'Encargo desde el worker',None,uuid4()),role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
reqs=[x[0] for x in as_owner('SELECT * FROM eliot.my_task_requests(%s)',(o1,))]
assert [x['task_id'] for x in reqs]==[r2['task_id'],t] and reqs[1]['request']==text and reqs[1]['task_status']=='pending'
assert [x[0] for x in as_owner('SELECT * FROM eliot.my_task_requests(%s)',(o2,))]==[]
denied(lambda:as_owner('SELECT * FROM eliot.my_task_requests(%s)',(o1,),'test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:query('UPDATE eliot.ai_task_requests SET request=%s',('x'*20,)),psycopg.errors.ObjectNotInPrerequisiteState)

# --- 2. Memoria compartida por empresa.
assert as_owner(MEM_SET,(o1,'pricing','Plan básico 29 €/mes; plan pro 79 €/mes'))[0][0]['updated'] is True
as_owner(MEM_SET,(o1,'audience','Pymes de servicios en España'))
as_owner(MEM_SET,(o1,'pricing','Plan básico 35 €/mes; plan pro 89 €/mes'))                    # actualiza
mem=[x[0] for x in as_owner('SELECT * FROM eliot.my_company_memory(%s)',(o1,))]
assert [m['key'] for m in mem]==['audience','pricing'] and mem[1]['content'].startswith('Plan básico 35')
assert [x[0] for x in as_owner('SELECT * FROM eliot.my_company_memory(%s)',(o2,))]==[]           # no cruza
denied(lambda:as_owner(MEM_SET,(o1,'secret_sauce','x')),psycopg.errors.InvalidParameterValue)
denied(lambda:as_owner(MEM_SET,(o1,'faq','x'*2001)),psycopg.errors.InvalidParameterValue)
denied(lambda:as_owner(MEM_SET,(o1,'faq','Respuesta'),'test|ownerB'),psycopg.errors.InsufficientPrivilege)
denied(lambda:as_owner('SELECT * FROM eliot.my_company_memory(%s)',(o1,),'test|ownerB'),psycopg.errors.InsufficientPrivilege)
for table in ('ai_task_requests','company_memory'):
 denied(lambda:query('SELECT * FROM eliot.'+table,role='eliot_identity'),psycopg.errors.InsufficientPrivilege)
print('PG 035: encargos idempotentes como tarea pendiente asignada, título legible, sin ejecución, memoria por empresa, '
      'aislamiento entre empresas, permisos y append-only superados')

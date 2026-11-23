"""PG desechable (040): modo descanso por empresa. Solo el propietario lo enciende y apaga, es por empresa, y queda historial."""
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
def ident(sql,args=(),subject='test|ownerA'):return query(sql,args,role='eliot_identity',subject=subject)
def setb(org,on,subject='test|ownerA'):return ident('SELECT eliot.owner_set_company_break(%s,%s)',(org,on),subject)[0][0]
def on(org,role='eliot_execution_worker'):return query('SELECT eliot.company_on_break(%s)',(org,),role=role)[0][0]
def mine(org,subject='test|ownerA'):return ident('SELECT eliot.my_company_break(%s)',(org,),subject)[0][0]

# 1. Por defecto nadie está en descanso; el servidor y el trabajador pueden preguntarlo.
denied(lambda:on(ORG,'eliot_identity'),psycopg.errors.InsufficientPrivilege)   # el servidor web pregunta como miembro, no a ciegas
assert on(ORG) is False and mine(ORG)=={'organization_id':str(ORG),'on_break':False,'since':None}
# 2. Solo el propietario de ESA empresa.
AAA=UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
denied(lambda:setb(ORG,True,'nadie|x'),psycopg.errors.InsufficientPrivilege);denied(lambda:mine(ORG,'nadie|x'),psycopg.errors.InsufficientPrivilege)
denied(lambda:setb(OTHER,True),psycopg.errors.InsufficientPrivilege);denied(lambda:mine(OTHER),psycopg.errors.InsufficientPrivilege)   # empresa ajena
denied(lambda:setb(AAA,True,'test|memberA'),psycopg.errors.InsufficientPrivilege)                # un miembro lo ve pero no lo cambia
assert mine(AAA,'test|memberA')['on_break'] is False
denied(lambda:setb(ORG,None),psycopg.errors.InvalidParameterValue)
denied(lambda:query('SELECT eliot.owner_set_company_break(%s,true)',(ORG,),role='eliot_execution_worker'),psycopg.errors.InsufficientPrivilege)
# 3. Encender: una sola vez aunque se pulse dos; solo afecta a esa empresa.
r=setb(ORG,True);assert r['on_break'] is True and r['changed'] is True and r['since']
r2=setb(ORG,True);assert r2['on_break'] is True and r2['changed'] is False and r2['since']==r['since']
assert on(ORG) is True and on(OTHER) is False and mine(ORG)['since']==r['since']
# 4. Dos pulsaciones a la vez no abren dos descansos.
setb(ORG,False);b=Barrier(2)
def press():b.wait();return setb(ORG,True)['changed']
with ThreadPoolExecutor(2) as ex:res=list(ex.map(lambda _:press(),range(2)))
assert sorted(res)==[False,True] and query('SELECT count(*) FROM eliot.company_breaks WHERE organization_id=%s AND ended_at IS NULL',(ORG,))[0][0]==1
# 5. Apagar: todo vuelve; no se tocó el estado de ningún agente; queda el historial.
state=query('SELECT operating_state FROM eliot.ai_workers WHERE id=%s',(WORKER,))[0][0]
r=setb(ORG,False);assert r=={'organization_id':str(ORG),'on_break':False,'since':None,'changed':True} and setb(ORG,False)['changed'] is False
assert on(ORG) is False and query('SELECT operating_state FROM eliot.ai_workers WHERE id=%s',(WORKER,))[0][0]==state
assert query('SELECT count(*),count(ended_by) FROM eliot.company_breaks WHERE organization_id=%s',(ORG,))[0]==(2,2)
# 6. Sin acceso directo a la tabla.
for role in ('eliot_identity','eliot_execution_worker'):
 denied(lambda:query('SELECT * FROM eliot.company_breaks',role=role),psycopg.errors.InsufficientPrivilege)
print('PG descanso 040: propietario, por empresa, sin duplicados e historial superados')

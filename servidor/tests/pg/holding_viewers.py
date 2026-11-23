"""PG desechable (039): observadores de solo consulta dados de alta por invitación. Solo el propietario invita y retira,
la invitación vale una vez y caduca, el propietario no puede canjearla, y el servidor sabe a quién representa cada observador."""
import hashlib
from pathlib import Path
exec(Path('tests/pg/document_plans.py').read_text().split('\nt=new_task();')[0])
def count(sql,args=()):return query(sql,args)[0][0]
def h(token):return hashlib.sha256(token.encode()).hexdigest()
def ident(sql,args=(),subject='test|ownerA'):return query(sql,args,role='eliot_identity',subject=subject)
def invite(holding,label,token,hours=48,subject='test|ownerA'):return ident('SELECT eliot.owner_create_viewer_invite(%s,%s,%s,%s)',(holding,label,h(token),hours),subject)[0][0]
def redeem(token,subject):return ident('SELECT eliot.redeem_viewer_invite(%s)',(h(token),),subject)[0][0]
def represents(subject):return ident('SELECT eliot.my_viewer_owner_subject()',(),subject)[0][0]
def listing(holding,subject='test|ownerA'):return ident('SELECT eliot.owner_viewers(%s)',(holding,),subject)[0][0]

owner_a=count("SELECT id FROM eliot.users WHERE external_subject='test|ownerA'")
H=count("INSERT INTO eliot.holdings(name) VALUES('Holding observadores CI') RETURNING id")
query('INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(%s,%s)',(H,owner_a))

# --- 1. Solo el propietario del holding invita; datos inválidos no entran.
for sub in ('test|ownerB','nadie|x'):
 denied(lambda:invite(H,'Asesor','tok-x',subject=sub),psycopg.errors.InsufficientPrivilege)
for label,token_hash,hours in (('', h('a'),48),('x'*81,h('a'),48),('Asesor','no-es-huella',48),('Asesor',h('a'),0),('Asesor',h('a'),200)):
 denied(lambda:ident('SELECT eliot.owner_create_viewer_invite(%s,%s,%s,%s)',(H,label,token_hash,hours)),psycopg.errors.InvalidParameterValue)
r=invite(H,'  Asesor fiscal ','tok-1')
assert r['created'] is True and r['label']=='Asesor fiscal' and r['holding_id']==str(H)
assert count('SELECT count(*) FROM eliot.viewer_invites WHERE holding_id=%s',(H,))==1
assert 'tok-1' not in str(query('SELECT token_hash FROM eliot.viewer_invites WHERE holding_id=%s',(H,)))      # solo la huella

# --- 2. Nadie es observador todavía; el propietario no puede canjear su propia invitación.
assert represents('visitante|1') is None and represents('test|ownerA') is None
denied(lambda:redeem('tok-1','test|ownerA'),psycopg.errors.ObjectNotInPrerequisiteState)
denied(lambda:redeem('tok-inventado','visitante|1'),psycopg.errors.InvalidParameterValue)

# --- 3. La persona invitada la canjea con su cuenta: queda como observador y representa al propietario.
j=redeem('tok-1','visitante|1')
assert j=={'holding_id':str(H),'holding':'Holding observadores CI','joined':True}
assert represents('visitante|1')=='test|ownerA' and represents('visitante|2') is None
denied(lambda:redeem('tok-1','visitante|2'),psycopg.errors.InvalidParameterValue)                             # de un solo uso
l=listing(H)
assert [v['label'] for v in l['viewers']]==['Asesor fiscal'] and l['invites']==[] and 'visitante' not in str(l)   # la lista no enseña identificadores
denied(lambda:listing(H,'visitante|1'),psycopg.errors.InsufficientPrivilege)                                  # el observador no ve la lista
denied(lambda:invite(H,'Otro','tok-z',subject='visitante|1'),psycopg.errors.InsufficientPrivilege)             # ni invita a nadie

# --- 4. Un observador no puede serlo dos veces; una invitación caducada no vale.
invite(H,'Segundo','tok-2')
denied(lambda:redeem('tok-2','visitante|1'),psycopg.errors.ObjectNotInPrerequisiteState)
query("UPDATE eliot.viewer_invites SET expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=%s",(h('tok-2'),))
denied(lambda:redeem('tok-2','visitante|2'),psycopg.errors.InvalidParameterValue)
assert listing(H)['invites']==[]

# --- 5. El propietario retira el acceso: deja de representar a nadie al momento. Y anula una invitación pendiente.
vid=listing(H)['viewers'][0]['id']
denied(lambda:ident('SELECT eliot.owner_revoke_viewer(%s,%s)',(H,vid),'test|ownerB'),psycopg.errors.InsufficientPrivilege)
assert ident('SELECT eliot.owner_revoke_viewer(%s,%s)',(H,vid))[0][0]=={'holding_id':str(H),'id':vid,'kind':'viewer','revoked':True}
assert represents('visitante|1') is None and listing(H)['viewers']==[]
denied(lambda:ident('SELECT eliot.owner_revoke_viewer(%s,%s)',(H,vid)),psycopg.errors.InvalidParameterValue)
p=invite(H,'Pendiente','tok-3')
assert ident('SELECT eliot.owner_revoke_viewer(%s,%s)',(H,p['invite_id']))[0][0]['kind']=='invite'
denied(lambda:redeem('tok-3','visitante|3'),psycopg.errors.InvalidParameterValue)

# --- 6. Tope de 10 entre observadores e invitaciones vivas; todo auditado; sin acceso directo a las tablas.
for i in range(10):invite(H,'Inv '+str(i),'tope-'+str(i))
denied(lambda:invite(H,'Uno más','tope-x'),psycopg.errors.ObjectNotInPrerequisiteState)
acts=[a for (a,) in query("SELECT action FROM eliot.holding_audit WHERE holding_id=%s AND action LIKE 'viewer_%%' ORDER BY id",(H,))]
assert acts[:6]==['viewer_invited','viewer_joined','viewer_invited','viewer_revoked','viewer_invited','viewer_revoked'],acts
for table in ('holding_viewers','viewer_invites'):
 denied(lambda:query('SELECT * FROM eliot.'+table,role='eliot_identity'),psycopg.errors.InsufficientPrivilege)
print('PG observadores 039: solo el propietario invita y retira, invitación de un uso y con caducidad guardada como huella, el propietario no se invita a sí mismo, el observador representa a su propietario solo mientras está activo, tope y auditoría superados')

# --- (041) El alta de cuentas pregunta si una invitación sigue viva: sí solo mientras lo está, y sin gastarla. En un holding aparte.
H2=count("INSERT INTO eliot.holdings(name) VALUES('Holding altas CI') RETURNING id")
query('INSERT INTO eliot.holding_owners(holding_id,user_id) VALUES(%s,%s)',(H2,owner_a))
is_open=lambda token,raw=False:ident('SELECT eliot.viewer_invite_is_open(%s)',(token if raw else h(token),),'nadie|sin-cuenta')[0][0]
viva=invite(H2,'Viva','tok-viva')
assert is_open('tok-viva') is True and is_open('tok-viva') is True          # preguntar no la gasta
assert is_open('tok-1') is False and is_open('tok-2') is False and is_open('tok-inventado') is False     # usada, caducada, inexistente
assert is_open('no es una huella',raw=True) is False and is_open(None,raw=True) in (False,None)
ident('SELECT eliot.owner_revoke_viewer(%s,%s)',(H2,viva['invite_id']))
assert is_open('tok-viva') is False
print('PG altas 041: la invitación solo cuenta mientras está viva')

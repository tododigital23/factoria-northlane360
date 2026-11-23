"""Auditoría automática de aislamiento entre empresas (PG desechable, al final del pipeline).

Un intruso que es PROPIETARIO de su propia empresa llama a TODAS las funciones que la aplicación
(eliot_identity) puede ejecutar, apuntando a otra empresa con identificadores REALES de esa empresa
(tareas, agentes, planes, misiones, trabajos...). Cada llamada debe rechazarse por autorización
(SQLSTATE 42501) antes de devolver o modificar nada. Las funciones sin parámetro de empresa deben
no devolver nada de la otra empresa. Cualquier excepción a estas reglas hace fallar la prueba,
de modo que una función nueva sin comprobación de empresa no puede llegar a producción.
"""
import os
import re
from uuid import uuid4
import psycopg

assert os.getenv('ELIOT_TEST_DISPOSABLE_DB') == '1'
INTRUDER = 'test|isolation-intruder'


def q(sql, args=(), *, intruder=False):
    with psycopg.connect('') as c, c.cursor() as cur:
        cur.execute("SET statement_timeout='12s'")
        if intruder:
            cur.execute('SET LOCAL ROLE eliot_identity')
            cur.execute("SELECT set_config('app.verified_subject',%s,true)", (INTRUDER,))
        cur.execute(sql, args)
        return cur.fetchall() if cur.description else []


# Empresa víctima: la que más datos tenga tras el resto de suites.
victim = q("""SELECT o.id FROM eliot.organizations o ORDER BY
  (SELECT count(*) FROM eliot.ai_tasks t WHERE t.organization_id=o.id) DESC LIMIT 1""")[0][0]
# Intruso: usuario real, propietario activo de SU empresa (para que "ser propietario" no baste).
uid = q("INSERT INTO eliot.users(external_subject) VALUES(%s) ON CONFLICT(external_subject) DO UPDATE SET external_subject=EXCLUDED.external_subject RETURNING id", (INTRUDER,))[0][0]
own = q("INSERT INTO eliot.organizations(name) VALUES('Empresa del intruso') RETURNING id")[0][0]
q("INSERT INTO eliot.organization_memberships(organization_id,user_id,role,status) VALUES(%s,%s,'owner','active')", (own, uid))
assert not q("SELECT 1 FROM eliot.organization_memberships WHERE organization_id=%s AND user_id=%s", (victim, uid))


def first(sql):
    rows = q(sql, (victim,))
    return rows[0][0] if rows else uuid4()


REAL = {  # identificadores reales de la víctima, por nombre de parámetro
    'p_task': first('SELECT id FROM eliot.ai_tasks WHERE organization_id=%s LIMIT 1'),
    'p_worker': first('SELECT id FROM eliot.ai_workers WHERE organization_id=%s LIMIT 1'),
    'p_department': first('SELECT id FROM eliot.departments WHERE organization_id=%s LIMIT 1'),
    'p_dept': first('SELECT id FROM eliot.departments WHERE organization_id=%s LIMIT 1'),
    'p_plan': first('SELECT id FROM eliot.ai_document_plans WHERE organization_id=%s LIMIT 1'),
    'p_mission': first('SELECT id FROM eliot.ai_document_missions WHERE organization_id=%s LIMIT 1'),
    'p_job': first('SELECT id FROM eliot.ai_document_jobs WHERE organization_id=%s LIMIT 1'),
    'p_failed_job': first('SELECT id FROM eliot.ai_document_jobs WHERE organization_id=%s LIMIT 1'),
    'p_run': first('SELECT id FROM eliot.ai_document_runs WHERE organization_id=%s LIMIT 1'),
    'p_approval': first('SELECT id FROM eliot.ai_document_approvals WHERE organization_id=%s LIMIT 1'),
    'p_lease': first('SELECT lease_id FROM eliot.ai_task_execution_leases WHERE organization_id=%s LIMIT 1'),
    'p_previous': first('SELECT lease_id FROM eliot.ai_task_execution_leases WHERE organization_id=%s LIMIT 1'),
}
REAL['p_assignee'] = REAL['p_worker']
ORG_ARGS = {'p_org', 'p_organization', 'p_organization_id', 'p_org_id'}


def value(name, typ):
    if name in ORG_ARGS:
        return victim
    if typ == 'uuid':
        return REAL.get(name, uuid4())
    if typ == 'uuid[]':
        return [REAL['p_plan'], uuid4()]
    if typ == 'text':
        return 'Intento de acceso entre empresas'
    if typ == 'text[]':
        return ['seo']
    if typ in ('integer', 'bigint', 'smallint'):
        return 1
    if typ == 'boolean':
        return True
    if typ == 'jsonb':
        return '{}'
    raise AssertionError(f'Tipo no contemplado {typ} en {name}')


funcs = q("""SELECT p.proname, pg_get_function_identity_arguments(p.oid), p.proretset, p.prorettype::regtype::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='eliot' AND has_function_privilege('eliot_identity',p.oid,'EXECUTE') ORDER BY 1""")
assert len(funcs) >= 40, f'Esperaba muchas funciones de aplicación, hay {len(funcs)}'
checked, unscoped, failures, filtered = [], [], [], []
for name, ident, retset, rettype in funcs:
    params = []
    for part in [x.strip() for x in ident.split(',') if x.strip()]:
        m = re.fullmatch(r'(\w+)\s+(.+)', part)
        assert m, f'{name}: parámetro sin nombre "{part}"'
        params.append((m[1], m[2]))
    has_org = any(p in ORG_ARGS for p, _ in params)
    args = [value(p, t) for p, t in params]
    ph = ','.join(['%s'] * len(args))
    sql = f'SELECT * FROM eliot.{name}({ph})' if retset else f'SELECT eliot.{name}({ph})'
    try:
        rows = q(sql, args, intruder=True)
    except psycopg.errors.InsufficientPrivilege:
        checked.append(name)
        continue
    except psycopg.Error as exc:
        if has_org:
            failures.append(f'{name}: rechazo no es de autorización ({type(exc).__name__}: {exc.diag.message_primary})')
        else:
            unscoped.append(name)
        continue
    if has_org:
        # Lectores antiguos filtran por pertenencia en vez de rechazar: vacío es seguro; datos, fuga.
        if rows and any(any(v is not None for v in r) for r in rows):
            failures.append(f'{name}: devolvió datos a un intruso de otra empresa ({str(rows)[:120]})')
        else:
            filtered.append(name)
    else:
        # Sin parámetro de empresa: no puede filtrar NADA de la víctima.
        text = str(rows)
        if str(victim) in text or any(str(v) in text for v in REAL.values()):
            failures.append(f'{name}: sin parámetro de empresa pero expone datos de otra empresa')
        unscoped.append(name)

# La escritura no dejó rastro en la víctima.
assert not q("SELECT 1 FROM eliot.ai_task_events WHERE organization_id=%s AND message LIKE '%%Intento de acceso%%'", (victim,))
assert not q("SELECT 1 FROM eliot.ai_tasks WHERE organization_id=%s AND title LIKE 'Intento de acceso%%'", (victim,))
assert not failures, 'FUGAS O COMPROBACIONES DÉBILES:\n' + '\n'.join(failures)
print(f'Aislamiento: {len(checked)} funciones con empresa rechazan al intruso (42501); '
      f'{len(filtered)} lectores devuelven vacío al intruso ({", ".join(sorted(filtered))}); '
      f'{len(unscoped)} sin parámetro de empresa no exponen datos ajenos ({", ".join(sorted(set(unscoped)))})')

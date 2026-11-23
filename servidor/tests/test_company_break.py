"""Modo descanso: mientras dura, la empresa no arranca trabajo de IA y el chat contesta sin modelo."""
from contextlib import contextmanager
from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import eliot_break as br
from app import eliot_document_worker as worker

pytestmark = pytest.mark.real_break
ORG = UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
OWNER = 'https://t.example.com|auth0|jefe'


@pytest.fixture(autouse=True)
def limpio():
    br.forget()


def base(state, installed=True, set_result=None):
    """state: dict mutable {'on': bool}. Devuelve (cursor falso, lista de consultas)."""
    cur, calls, last = MagicMock(), [], {}

    def execute(sql, params=None):
        last['sql'], last['params'] = sql, params
        calls.append(sql)
        if 'owner_set_company_break' in sql and set_result is None:
            state['on'] = params[1]
    cur.execute.side_effect = execute

    def fetchone():
        sql = last['sql']
        if 'to_regprocedure' in sql:
            return ('f',) if installed else (None,)
        if 'owner_set_company_break' in sql:
            return (set_result if set_result is not None else {'organization_id': str(ORG), 'on_break': state['on'], 'since': '2026-11-21T16:00:00+00:00' if state['on'] else None, 'changed': True},)
        return ({'organization_id': str(ORG), 'on_break': state['on'], 'since': '2026-11-21T16:00:00+00:00' if state['on'] else None},)
    cur.fetchone.side_effect = fetchone

    @contextmanager
    def cursor(_subject):
        yield cur
    return cursor, calls


def test_se_pregunta_a_la_base_y_se_recuerda_unos_segundos():
    state = {'on': True}
    cursor, calls = base(state)
    with patch.object(br, '_cursor', cursor):
        assert br.on_break(OWNER, ORG, now=100) is True
        n = len(calls)
        assert br.on_break(OWNER, ORG, now=102) is True and len(calls) == n
        state['on'] = False
        assert br.on_break(OWNER, ORG, now=100 + br.CACHE_SECONDS + 1) is False
        state['on'] = True
        br.forget(ORG)
        with pytest.raises(HTTPException) as e:
            br.require_working(OWNER, ORG)
        assert e.value.status_code == 409 and 'descanso' in e.value.detail


def test_sin_migracion_o_sin_base_no_hay_descanso():
    cursor, _ = base({'on': True}, installed=False)
    with patch.object(br, '_cursor', cursor):
        assert br.on_break(OWNER, ORG) is False

    @contextmanager
    def roto(_s):
        raise HTTPException(503, 'x')
        yield
    br.forget()
    with patch.object(br, '_cursor', roto):
        assert br.on_break(OWNER, ORG) is False
        br.require_working(OWNER, ORG)


def test_rutas_ver_encender_y_apagar():
    state = {'on': False}
    cursor, calls = base(state)
    app = FastAPI()
    app.include_router(br.router)
    with patch.object(br, '_cursor', cursor), patch.object(br.identity, 'verified_identity', lambda a: OWNER), patch.object(br.identity, '_require_approval_scope', lambda a: OWNER):
        c = TestClient(app)
        assert c.get(f'/v1/me/organizations/{ORG}/break').json() == {'organization_id': str(ORG), 'available': True, 'on_break': False, 'since': None}
        br._cache[str(ORG)] = (False, 9e12)
        r = c.post(f'/v1/me/organizations/{ORG}/break', json={'on': True})
        assert r.status_code == 200 and r.json()['on_break'] is True and r.json()['changed'] is True and str(ORG) not in br._cache
        assert c.get(f'/v1/me/organizations/{ORG}/break').json()['since'].startswith('2026-11-21')
        assert c.post(f'/v1/me/organizations/{ORG}/break', json={'on': False}).json()['on_break'] is False
        for bad in ({}, {'on': 'si'}, {'on': 1}, {'on': True, 'x': 1}):
            assert c.post(f'/v1/me/organizations/{ORG}/break', json=bad).status_code == 422
    cursor, _ = base({'on': False}, set_result={'organization_id': str(ORG), 'on_break': False})
    with patch.object(br, '_cursor', cursor), patch.object(br.identity, '_require_approval_scope', lambda a: OWNER):
        assert TestClient(app).post(f'/v1/me/organizations/{ORG}/break', json={'on': True}).status_code == 503      # sin confirmar no se da por hecho
    cursor, _ = base({'on': False}, installed=False)
    with patch.object(br, '_cursor', cursor), patch.object(br.identity, '_require_approval_scope', lambda a: OWNER), patch.object(br.identity, 'verified_identity', lambda a: OWNER):
        assert TestClient(app).post(f'/v1/me/organizations/{ORG}/break', json={'on': True}).status_code == 503
        assert TestClient(app).get(f'/v1/me/organizations/{ORG}/break').json()['available'] is False


class Store:
    def __init__(self, on, installed=True, fail=False):
        self.on, self.installed, self.fail, self.sql = on, installed, fail, []

    def call(self, sql, args):
        self.sql.append(sql)
        if self.fail:
            raise OSError('sin base')
        if 'to_regprocedure' in sql:
            return ('f',) if self.installed else (None,)
        if 'company_on_break' in sql:
            return (self.on,)
        raise AssertionError('en descanso no se debe tocar nada más: ' + sql)

    def take(self, org):
        raise AssertionError('en descanso no se toma trabajo')


def test_el_trabajador_en_segundo_plano_no_toma_trabajo_ni_crea_tareas(monkeypatch):
    monkeypatch.setattr(worker, 'allowed_organizations', lambda: [ORG])
    s = Store(True)
    assert worker.process_one(ORG, s) == 'on_break'
    assert worker.run_due_routines(ORG, Store(True)) in (0, None)
    assert worker.company_on_break(ORG, Store(False)) is False
    assert worker.company_on_break(ORG, Store(True, installed=False)) is False
    assert worker.company_on_break(ORG, Store(True, fail=True)) is False


def test_cada_punto_de_arranque_de_ia_consulta_el_descanso():
    """Si alguien añade un punto nuevo de trabajo de IA, aquí se ve cuáles están cubiertos."""
    import pathlib
    covered = {'organizations_api.py': 3, 'eliot_objective_planning_api.py': 1, 'eliot_integration_assistant.py': 1,
               'eliot_document_jobs_api.py': 1, 'eliot_mission_autopilot_api.py': 3, 'eliot_document_worker.py': 3}
    for name, minimum in covered.items():
        text = pathlib.Path('app', name).read_text()
        assert text.count('require_working(') + text.count('on_break(') >= minimum, name

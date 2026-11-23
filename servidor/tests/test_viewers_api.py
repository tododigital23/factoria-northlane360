"""Observadores por invitación: solo el propietario invita y retira; el código se enseña una vez y en la base solo va su huella."""
import hashlib
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import eliot_readonly as ro
from app import eliot_viewers_api as api

H = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
OWNER, GUEST = 'https://t.example.com|auth0|jefe', 'https://t.example.com|auth0|nuevo'


@pytest.fixture(autouse=True)
def limpio(monkeypatch):
    monkeypatch.delenv('ELIOT_READONLY_VIEWERS', raising=False)
    ro.forget()
    ro.remember('GET', '/v1/me/x')
    ro._viewer.set(False)


def client(answers, subject=OWNER, viewer=False):
    """answers: lo que devuelve la base a cada función, por nombre."""
    cur = MagicMock()
    state = {'last': None}

    def execute(sql, params=None):
        state['last'] = (sql, params)
        cur.calls.append((sql, params))
    cur.calls = []
    cur.execute.side_effect = execute

    def fetchone():
        sql, params = state['last']
        if 'to_regprocedure' in sql:
            return (params[0],) if answers.get('ready', True) else (None,)
        for name, value in answers.items():
            if name in sql:
                if isinstance(value, Exception):
                    raise value
                return (value,)
        return None
    cur.fetchone.side_effect = fetchone

    @contextmanager
    def cursor(who):
        assert who == subject
        yield cur

    def ident(_authorization):
        ro._viewer.set(viewer)
        return subject
    app = FastAPI()
    app.include_router(api.router)
    patches = [patch.object(api, '_cursor', cursor), patch.object(api.identity, 'verified_identity', ident),
               patch.object(api.identity, '_require_approval_scope', ident)]
    for p in patches:
        p.start()
    return TestClient(app), cur, lambda: [p.stop() for p in patches]


def test_invitar_devuelve_el_codigo_una_vez_y_guarda_solo_su_huella():
    c, cur, stop = client({'owner_create_viewer_invite': {'created': True, 'holding_id': H, 'invite_id': ITEM, 'label': 'Gestor', 'expires_at': '2026-11-24T10:00:00+00:00'}})
    try:
        r = c.post(f'/v1/me/holding/{H}/viewers/invites', json={'label': ' Gestor '})
    finally:
        stop()
    assert r.status_code == 201
    token = r.json()['token']
    assert api.TOKEN.fullmatch(token) and r.json()['invite_id'] == ITEM
    sql, params = [x for x in cur.calls if 'owner_create_viewer_invite' in x[0]][0]
    assert params[1] == 'Gestor' and params[2] == hashlib.sha256(token.encode()).hexdigest() and params[3] == api.HOURS
    assert token not in repr(params)                                        # a la base nunca llega el código


def test_un_observador_no_puede_ver_la_lista_ni_invitar_ni_retirar():
    c, cur, stop = client({}, viewer=True)
    try:
        assert c.get(f'/v1/me/holding/{H}/viewers').status_code == 403
        assert c.post(f'/v1/me/holding/{H}/viewers/invites', json={'label': 'x'}).status_code == 403
        assert c.post(f'/v1/me/holding/{H}/viewers/{ITEM}/revoke').status_code == 403
        assert c.post('/v1/me/viewer-invites/redeem', json={'token': 'a' * 43}).status_code == 409
    finally:
        stop()
    assert cur.calls == []                                                  # ni se toca la base


def test_lista_solo_lo_necesario():
    c, _, stop = client({'owner_viewers': {'holding_id': H, 'viewers': [{'id': ITEM, 'label': 'Gestor', 'since': '2026-11-21', 'viewer_subject': 'secreto'}],
                                           'invites': [{'id': ITEM, 'label': 'Socio', 'expires_at': '2026-11-24', 'token_hash': 'x'}]}})
    try:
        r = c.get(f'/v1/me/holding/{H}/viewers')
    finally:
        stop()
    assert r.status_code == 200 and 'secreto' not in r.text and 'token_hash' not in r.text
    assert r.json()['viewers'] == [{'id': ITEM, 'label': 'Gestor', 'since': '2026-11-21'}] and r.json()['invite_hours'] == 72


def test_retirar_se_nota_al_momento():
    ro._cache[GUEST] = (OWNER, 9e12)
    c, _, stop = client({'owner_revoke_viewer': {'revoked': True, 'id': ITEM, 'kind': 'viewer'}})
    try:
        r = c.post(f'/v1/me/holding/{H}/viewers/{ITEM}/revoke')
    finally:
        stop()
    assert r.status_code == 200 and r.json()['revoked'] is True and ro._cache == {}


def test_canjear_bien_mal_y_sin_confirmar():
    good = 'A' * 43
    c, cur, stop = client({'redeem_viewer_invite': {'joined': True, 'holding': 'Nova'}}, subject=GUEST)
    try:
        r = c.post('/v1/me/viewer-invites/redeem', json={'token': good})
        assert r.status_code == 200 and r.json() == {'joined': True, 'holding': 'Nova'}
        assert [x for x in cur.calls if 'redeem' in x[0]][0][1] == (hashlib.sha256(good.encode()).hexdigest(),)
        assert c.post('/v1/me/viewer-invites/redeem', json={'token': 'con espacios y cosas raras !!!!!!!!!!!!!!!!'}).status_code == 422
        assert c.post('/v1/me/viewer-invites/redeem', json={'token': good, 'extra': 1}).status_code == 422
    finally:
        stop()
    c, _, stop = client({'redeem_viewer_invite': HTTPException(409, 'x')}, subject=GUEST)
    try:
        r = c.post('/v1/me/viewer-invites/redeem', json={'token': good})
        assert r.status_code == 409 and 'caducado' in r.json()['detail']
    finally:
        stop()
    c, _, stop = client({'redeem_viewer_invite': {'joined': False}}, subject=GUEST)
    try:
        assert c.post('/v1/me/viewer-invites/redeem', json={'token': good}).status_code == 503
    finally:
        stop()


def test_sin_la_migracion_no_hay_servicio():
    c, _, stop = client({'ready': False})
    try:
        assert c.get(f'/v1/me/holding/{H}/viewers').status_code == 503
    finally:
        stop()


def _db(owner=None, fail=False, missing=False):
    cur = MagicMock()
    last = {}
    cur.execute.side_effect = lambda sql, params=None: last.update(sql=sql)
    cur.fetchone.side_effect = lambda: ((None,) if missing else ('f',)) if 'to_regprocedure' in last['sql'] else (owner,)
    conn = MagicMock()
    conn.__enter__.return_value = conn
    conn.cursor.return_value.__enter__.return_value = cur
    connect = MagicMock(return_value=conn)
    if fail:
        connect.side_effect = OSError('sin base')
    return connect


def test_el_invitado_consulta_como_el_propietario_y_no_puede_cambiar_nada(monkeypatch):
    connect = _db(owner=OWNER)
    with patch.object(api.identity.psycopg, 'connect', connect), patch.object(api.identity, 'db_params', lambda: {}):
        assert ro.resolve(GUEST) == OWNER and ro.is_viewer() is True
        assert ro.resolve(GUEST) == OWNER and connect.call_count == 1        # recordado: no se pregunta a la base en cada petición
        ro.remember('POST', f'/v1/me/holding/{H}/viewers/invites')
        with pytest.raises(HTTPException) as e:
            ro.resolve(GUEST)
        assert e.value.status_code == 403
        ro.forget(GUEST)
        ro.remember('GET', '/v1/me/x')
        ro.resolve(GUEST)
        assert connect.call_count == 2


def test_sin_base_o_sin_migracion_no_se_concede_nada():
    for kw in ({'fail': True}, {'missing': True}, {'owner': None}, {'owner': ''}):
        ro.forget()
        with patch.object(api.identity.psycopg, 'connect', _db(**kw)), patch.object(api.identity, 'db_params', lambda: {}):
            ro._viewer.set(False)
            assert ro.resolve(GUEST) == GUEST and ro.is_viewer() is False
    assert GUEST not in ro._cache or ro._cache[GUEST][0] is None

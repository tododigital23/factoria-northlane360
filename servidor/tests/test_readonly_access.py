"""Acceso de solo consulta: el observador ve lo del propietario y no puede cambiar nada, decidido en un único punto."""
import json
from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

from app import eliot_readonly as ro
from app import organizations_api as api

ISS = 'https://tenant.example.com'
OWNER, VIEWER, OTRO = 'auth0|jefe', 'auth0|lector', 'auth0|otro'
ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    monkeypatch.setenv('ELIOT_READONLY_VIEWERS', json.dumps({VIEWER: OWNER}))
    ro.remember('GET', '/v1/me/organizations')


def test_sin_configurar_no_cambia_nada(monkeypatch):
    monkeypatch.delenv('ELIOT_READONLY_VIEWERS')
    ro.remember('POST', '/v1/me/x')
    assert ro.resolve(ISS + '|' + VIEWER) == ISS + '|' + VIEWER and ro.is_viewer() is False
    for malo in ('no json', '[]', '{"a":1}', json.dumps({VIEWER: VIEWER}), json.dumps({'x y': OWNER})):
        monkeypatch.setenv('ELIOT_READONLY_VIEWERS', malo)
        assert ro.viewers() == {}                                            # ante la duda, no hay observadores


def test_el_observador_consulta_como_el_propietario_y_no_puede_cambiar_nada():
    assert ro.resolve(ISS + '|' + VIEWER) == ISS + '|' + OWNER and ro.is_viewer() is True
    for metodo in ('POST', 'PUT', 'PATCH', 'DELETE', None):
        ro.remember(metodo, f'/v1/me/organizations/{ORG}/retire')
        with pytest.raises(HTTPException) as e:
            ro.resolve(ISS + '|' + VIEWER)
        assert e.value.status_code == 403 and 'solo consulta' in e.value.detail and ro.is_viewer() is False
    ro.remember('POST', f'/v1/me/organizations/{ORG}/eliot/chat')
    assert ro.resolve(ISS + '|' + VIEWER) == ISS + '|' + OWNER              # preguntar sí
    ro.remember('POST', f'/v1/me/organizations/{ORG}/eliot/chat/../retire')
    with pytest.raises(HTTPException):
        ro.resolve(ISS + '|' + VIEWER)


def test_los_demas_usuarios_no_se_ven_afectados():
    ro.remember('POST', f'/v1/me/organizations/{ORG}/retire')
    assert ro.resolve(ISS + '|' + OWNER) == ISS + '|' + OWNER and ro.is_viewer() is False
    assert ro.resolve(ISS + '|' + OTRO) == ISS + '|' + OTRO and ro.is_viewer() is False


def app_de_prueba(quien):
    """La identidad real (token) se sustituye por «quien»; todo lo demás es el camino real, con el control incluido."""
    app = FastAPI(); app.include_router(api.router)

    @app.post('/v1/me/organizations/{org}/cambio')
    def cambio(org: UUID, authorization: str | None = Header(default=None)):
        return {'como': api.verified_identity(authorization)}

    class Recuerda:
        def __init__(self, inner): self.inner = inner
        async def __call__(self, scope, receive, send):
            if scope.get('type') == 'http': ro.remember(scope.get('method'), scope.get('path'))
            await self.inner(scope, receive, send)
    app.add_middleware(Recuerda)
    token = MagicMock(); token.get_signing_key_from_jwt.return_value.key = 'k'
    return app, patch.multiple(api, jwks_client=lambda: token), patch.object(api.jwt, 'decode', return_value={'sub': quien, 'scope': 'read:tasks'})


def test_access_sin_scope_read_tasks_sigue_comprobando(monkeypatch):
    monkeypatch.setenv('ELIOT_OIDC_ISSUER', ISS + '/'); monkeypatch.setenv('ELIOT_OIDC_AUDIENCE', 'api')
    monkeypatch.delenv('ELIOT_AUTO_PROVISION_USER', raising=False)
    monkeypatch.delenv('RAILWAY_ENVIRONMENT', raising=False)
    monkeypatch.delenv('RAILWAY_ENVIRONMENT_ID', raising=False)
    app, a, b = app_de_prueba(OWNER)
    with a, patch.object(api.jwt, 'decode', return_value={'sub': OWNER, 'scope': 'openid profile email'}), \
         patch.object(api, 'has_any_access', return_value=True):
        r = TestClient(app).get('/v1/me/access', headers={'Authorization': 'Bearer t'})
    assert r.status_code == 200 and r.json()['allowed'] is True


def test_por_http_el_observador_lee_y_recibe_403_al_intentar_cambiar(monkeypatch):
    monkeypatch.setenv('ELIOT_OIDC_ISSUER', ISS + '/'); monkeypatch.setenv('ELIOT_OIDC_AUDIENCE', 'api')
    h = {'Authorization': 'Bearer t'}
    app, a, b = app_de_prueba(VIEWER)
    with a, b:
        c = TestClient(app)
        assert c.get('/v1/me/access', headers=h).json() == {'read_only': True, 'allowed': True}
        r = c.post(f'/v1/me/organizations/{ORG}/cambio', headers=h)
        assert r.status_code == 403 and 'solo consulta' in r.json()['detail']
    app, a, b = app_de_prueba(OWNER)
    with a, b:
        c = TestClient(app)
        with patch.object(api, 'has_any_access', return_value=True):
            assert c.get('/v1/me/access', headers=h).json() == {'read_only': False, 'allowed': True}
        with patch.object(api, 'has_any_access', return_value=False):          # cuenta sin nada: p. ej. un observador expulsado
            assert c.get('/v1/me/access', headers=h).json() == {'read_only': False, 'allowed': False}
        assert c.post(f'/v1/me/organizations/{ORG}/cambio', headers=h).json() == {'como': ISS + '|' + OWNER}
    assert TestClient(app).get('/v1/me/access').status_code == 401


def test_el_observador_pregunta_pero_freddy_no_le_da_datos_de_clientes_ni_voz():
    def conexion():
        connection = MagicMock(); cur = connection.__enter__.return_value.cursor.return_value.__enter__.return_value
        cur.fetchall.side_effect = [[(UUID(ORG), 'Tienda', 'owner')], [], [], [], []]
        return connection
    app = FastAPI(); app.include_router(api.router); c = TestClient(app)
    for observador in (True, False):
        with patch.object(api, 'verified_identity', return_value=ISS + '|' + OWNER), patch.object(api, 'db_params', return_value={}), \
             patch.object(api.psycopg, 'connect', return_value=conexion()), patch.object(ro, 'is_viewer', return_value=observador), \
             patch('app.eliot_freddy_chat.web_answer', return_value=('la clave del cliente es X', True)) as freddy, \
             patch('app.eliot_server_voice.grant', return_value='g') as voz:
            r = c.post(f'/v1/me/organizations/{ORG}/eliot/chat', headers={'Authorization': 'Bearer t'}, json={'question': 'Dame un resumen'})
        assert r.status_code == 200
        if observador:
            freddy.assert_not_called(); voz.assert_not_called(); assert 'clave' not in r.json()['answer'] and 'speech_grant' not in r.json()
        else:
            freddy.assert_called_once(); assert 'clave' in r.json()['answer']


def _base(orgs, holdings, holding_installed=True):
    cur, last = MagicMock(), {}
    cur.execute.side_effect = lambda sql, params=None: last.update(sql=sql)
    def fetchone():
        s = last['sql']
        if 'to_regprocedure' in s: return ('f',) if holding_installed else (None,)
        if 'my_organizations' in s: return (orgs,)
        if 'my_holding' in s: return (holdings,)
        return None
    cur.fetchone.side_effect = fetchone
    conn = MagicMock(); conn.__enter__.return_value = conn; conn.cursor.return_value.__enter__.return_value = cur
    return conn


def test_primer_login_crea_holding_si_esta_vacio(monkeypatch):
    monkeypatch.setenv("ELIOT_AUTO_PROVISION_USER", "on")
    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres:x@db/railway")
    conn = MagicMock()
    conn.__enter__.return_value = conn
    conn.execute.side_effect = lambda *a, **k: MagicMock(fetchone=lambda: (0,) if "count" in str(a).lower() else ("id",))
    with patch("psycopg.connect", return_value=conn) as connect:
        api.ensure_first_owner("https://tenant.example.com|google-oauth2|1")
    connect.assert_called_once()
    sql = " ".join(str(c.args[0]) for c in conn.execute.call_args_list)
    assert "eliot.users" in sql and "eliot.holdings" in sql and "eliot.holding_owners" in sql


def test_primer_login_no_toca_un_holding_ya_creado(monkeypatch):
    monkeypatch.setenv("ELIOT_AUTO_PROVISION_USER", "on")
    monkeypatch.setenv("DATABASE_URL", "postgresql://postgres:x@db/railway")
    conn = MagicMock()
    conn.__enter__.return_value = conn
    def execute(sql, params=None):
        result = MagicMock()
        result.fetchone.return_value = (1,) if "holding_owners" in str(sql) and "count" in str(sql).lower() else (0,)
        return result
    conn.execute.side_effect = execute
    with patch("psycopg.connect", return_value=conn):
        api.ensure_first_owner("https://tenant.example.com|auth0|otro")
    sql = " ".join(str(c.args[0]) for c in conn.execute.call_args_list)
    assert "INSERT INTO eliot.users" not in sql


def test_tiene_acceso_quien_es_miembro_o_dueno_de_un_holding_y_nadie_mas(monkeypatch):
    monkeypatch.setattr(api, 'db_params', lambda: {})
    for orgs, holdings, installed, expected in ((2, 0, True, True), (0, 1, True, True), (0, 0, True, False), (0, 1, False, False)):
        with patch.object(api.psycopg, 'connect', return_value=_base(orgs, holdings, installed)):
            assert api.has_any_access(ISS + '|' + OTRO) is expected
    with patch.object(api.psycopg, 'connect', side_effect=OSError('sin base')):
        with pytest.raises(HTTPException) as e:
            api.has_any_access(ISS + '|' + OTRO)
        assert e.value.status_code == 503          # si no se puede comprobar, no se da por bueno ni por malo

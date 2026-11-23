"""Acceso propio: entrar, crear cuenta (solo con invitación) y recuperar contraseña sin pantalla de Auth0.
La contraseña solo viaja a Auth0, hay tope de intentos y los errores no dicen si un correo existe."""
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import eliot_auth_api as au

PASSWORD = 'Sup3r-Secreta-2026'
INVITE = 'A' * 43


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    for k, v in {'ELIOT_OWN_LOGIN': 'on', 'ELIOT_OIDC_ISSUER': 'https://tenant.eu.auth0.com/', 'ELIOT_OIDC_AUDIENCE': 'https://api.eliot.internal',
                 'ELIOT_AUTH0_CLIENT_ID': 'abcdefghijklmnopqrstuvwxyz012345', 'ELIOT_AUTH0_CLIENT_SECRET': 's' * 48}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv('ELIOT_AUTH0_CONNECTION', raising=False)
    au._tries.clear()


def cliente(respuestas, aceptado=True, invitacion=True):
    """respuestas: {ruta de Auth0: (código, cuerpo)}. Devuelve (cliente, llamadas)."""
    llamadas = []

    def post(conf, path, body, ip=None):
        llamadas.append((path, body, ip))
        return respuestas.get(path, (500, {}))
    app = FastAPI()
    app.include_router(au.router)
    parches = [patch.object(au, 'post', post), patch.object(au, 'token_accepted', lambda t: aceptado), patch.object(au, 'invite_open', lambda t: invitacion)]
    for p in parches:
        p.start()
    return TestClient(app), llamadas, lambda: [p.stop() for p in parches]


OK = (200, {'access_token': 'permiso.firmado.xyz', 'expires_in': 86400, 'id_token': 'x.eyJuYW1lIjoiQW5hIiwiZW1haWwiOiJhbmFAZWplbXBsby5lcyJ9.y'})


def test_apagado_por_defecto_y_solo_se_enciende_bien_configurado(monkeypatch):
    c, _, stop = cliente({})
    try:
        assert c.get('/v1/auth/config').json() == {'own_login': True, 'signup': False}
        for var, value in (('ELIOT_OWN_LOGIN', 'off'), ('ELIOT_AUTH0_CLIENT_ID', 'corto'), ('ELIOT_AUTH0_CLIENT_SECRET', 'corta'), ('ELIOT_OIDC_ISSUER', 'http://sin-cifrar/')):
            monkeypatch.setenv(var, value)
            assert c.get('/v1/auth/config').json()['own_login'] is False
            assert c.post('/v1/auth/login', json={'email': 'ana@ejemplo.es', 'password': PASSWORD}).status_code == 503
            entorno_ok = {'ELIOT_OWN_LOGIN': 'on', 'ELIOT_AUTH0_CLIENT_ID': 'abcdefghijklmnopqrstuvwxyz012345', 'ELIOT_AUTH0_CLIENT_SECRET': 's' * 48, 'ELIOT_OIDC_ISSUER': 'https://tenant.eu.auth0.com/'}
            monkeypatch.setenv(var, entorno_ok[var])
    finally:
        stop()


def test_entrar_devuelve_el_permiso_y_la_contrasena_solo_va_a_auth0(capsys):
    c, llamadas, stop = cliente({'/oauth/token': OK})
    try:
        r = c.post('/v1/auth/login', json={'email': ' ana@ejemplo.es ', 'password': PASSWORD}, headers={'x-forwarded-for': '203.0.113.7, 10.0.0.1'})
    finally:
        stop()
    assert r.status_code == 200 and r.json() == {'access_token': 'permiso.firmado.xyz', 'expires_in': 86400, 'user': {'name': 'Ana', 'email': 'ana@ejemplo.es'}}
    path, body, ip = llamadas[0]
    assert path == '/oauth/token' and body['grant_type'] == au.GRANT and body['realm'] == 'Username-Password-Authentication' and body['username'] == 'ana@ejemplo.es'
    assert body['password'] == PASSWORD and body['client_secret'] == 's' * 48 and body['scope'] == au.SCOPE and ip == '203.0.113.7'
    assert PASSWORD not in r.text and PASSWORD not in capsys.readouterr().out and 's' * 48 not in r.text


def test_los_errores_no_dicen_si_el_correo_existe_y_un_permiso_que_el_servidor_no_aceptaria_no_se_entrega():
    for respuesta in ((403, {'error': 'invalid_grant', 'error_description': 'Wrong email or password.'}), (401, {'error': 'access_denied'}), (400, {'error': 'invalid_request'})):
        au._tries.clear()
        c, _, stop = cliente({'/oauth/token': respuesta})
        try:
            r = c.post('/v1/auth/login', json={'email': 'ana@ejemplo.es', 'password': 'x'})
        finally:
            stop()
        assert r.status_code == 401 and r.json()['detail'] == au.BAD_LOGIN
    c, llamadas, stop = cliente({'/oauth/token': OK})
    try:
        assert c.post('/v1/auth/login', json={'email': 'no es un correo', 'password': 'x'}).json()['detail'] == au.BAD_LOGIN and llamadas == []
        for malo in ({}, {'email': 'ana@ejemplo.es'}, {'email': 'ana@ejemplo.es', 'password': 'x', 'extra': 1}, {'email': 'ana@ejemplo.es', 'password': 5}):
            assert c.post('/v1/auth/login', json=malo).status_code == 422
    finally:
        stop()
    au._tries.clear()
    c, _, stop = cliente({'/oauth/token': OK}, aceptado=False)
    try:
        assert c.post('/v1/auth/login', json={'email': 'ana@ejemplo.es', 'password': PASSWORD}).status_code == 503
    finally:
        stop()
    for respuesta, code in (((403, {'error': 'mfa_required'}), 409), ((429, {'error': 'too_many_attempts'}), 429), ((None, None), 503), ((403, {'error': 'unauthorized_client', 'error_description': 'Grant type not allowed'}), 503)):
        au._tries.clear()
        c, _, stop = cliente({'/oauth/token': respuesta})
        try:
            assert c.post('/v1/auth/login', json={'email': 'ana@ejemplo.es', 'password': PASSWORD}).status_code == code
        finally:
            stop()


def test_tope_de_intentos_por_persona_y_al_acertar_se_perdona():
    c, llamadas, stop = cliente({'/oauth/token': (403, {'error': 'invalid_grant'})})
    try:
        codes = [c.post('/v1/auth/login', json={'email': 'Ana@Ejemplo.es', 'password': 'mala'}).status_code for _ in range(au.PER_ACCOUNT + 2)]
        assert codes == [401] * au.PER_ACCOUNT + [429, 429] and len(llamadas) == au.PER_ACCOUNT          # pasado el tope ya ni se pregunta a Auth0
        assert c.post('/v1/auth/login', json={'email': 'otra@ejemplo.es', 'password': 'mala'}).status_code == 401   # el tope es por persona
    finally:
        stop()
    assert au.allow('login', 'a@b.es', '1.1.1.1', now=0) and not all(au.allow('login', 'x%d@b.es' % i, '9.9.9.9', now=0) for i in range(au.PER_ADDRESS + 1))
    au._tries.clear()
    for _ in range(au.PER_ACCOUNT - 1):
        au.allow('login', 'ana@ejemplo.es', '1.1.1.1', now=0)
    au.forgive('login', 'ANA@ejemplo.es')
    assert au.allow('login', 'ana@ejemplo.es', '1.1.1.1', now=1)
    assert all(len(k) == 64 for k in au._tries)                                                    # en memoria no queda ningún correo


def test_los_registros_nuevos_estan_cerrados_hasta_nueva_orden(monkeypatch):
    alta = {'email': 'nuevo@ejemplo.es', 'password': PASSWORD, 'name': 'Nuevo', 'invite': INVITE}
    for valor in (None, 'off', 'ON', '1', 'true'):                 # solo vale «on», escrito tal cual
        monkeypatch.delenv('ELIOT_SIGNUP', raising=False) if valor is None else monkeypatch.setenv('ELIOT_SIGNUP', valor)
        c, llamadas, stop = cliente({'/dbconnections/signup': (200, {'_id': '1'}), '/oauth/token': OK})
        try:
            r = c.post('/v1/auth/signup', json=alta)
            assert r.status_code == 403 and 'cerrados' in r.json()['detail'] and llamadas == []      # ni con invitación válida, ni se toca Auth0
            assert c.get('/v1/auth/config').json()['signup'] is False
            assert c.post('/v1/auth/login', json={'email': 'ana@ejemplo.es', 'password': PASSWORD}).status_code == 200   # entrar sigue funcionando
        finally:
            stop()
        au._tries.clear()


def test_crear_cuenta_solo_con_invitacion_viva_y_entra_a_continuacion(monkeypatch):
    monkeypatch.setenv('ELIOT_SIGNUP', 'on')
    alta = {'email': 'nuevo@ejemplo.es', 'password': PASSWORD, 'name': 'Nuevo', 'invite': INVITE}
    c, llamadas, stop = cliente({'/dbconnections/signup': (200, {'_id': '1'}), '/oauth/token': OK}, invitacion=False)
    try:
        r = c.post('/v1/auth/signup', json=alta)
        assert r.status_code == 403 and 'invitación' in r.json()['detail'] and llamadas == []            # sin invitación no se toca Auth0
    finally:
        stop()
    au._tries.clear()
    c, llamadas, stop = cliente({'/dbconnections/signup': (200, {'_id': '1'}), '/oauth/token': OK})
    try:
        r = c.post('/v1/auth/signup', json=alta)
        assert r.status_code == 201 and r.json()['access_token'] == 'permiso.firmado.xyz'
        assert [x[0] for x in llamadas] == ['/dbconnections/signup', '/oauth/token'] and llamadas[0][1]['connection'] == 'Username-Password-Authentication' and 'client_secret' not in llamadas[0][1]
        for malo in ({**alta, 'password': 'corta'}, {**alta, 'name': '<b>x'}, {**alta, 'invite': 'corta'}, {k: v for k, v in alta.items() if k != 'invite'}):
            assert c.post('/v1/auth/signup', json=malo).status_code == 422
    finally:
        stop()
    au._tries.clear()
    c, _, stop = cliente({'/dbconnections/signup': (400, {'code': 'invalid_password', 'name': 'PasswordStrengthError'}), '/oauth/token': OK})
    try:
        assert c.post('/v1/auth/signup', json=alta).status_code == 422
    finally:
        stop()
    au._tries.clear()
    c, _, stop = cliente({'/dbconnections/signup': (400, {'code': 'invalid_signup'}), '/oauth/token': (403, {'error': 'invalid_grant'})})
    try:
        r = c.post('/v1/auth/signup', json=alta)
        assert r.status_code == 409 and 'ya tienes cuenta' in r.json()['detail']                          # correo ya usado, con otra contraseña
    finally:
        stop()


def test_recuperar_contrasena_contesta_siempre_lo_mismo():
    c, llamadas, stop = cliente({'/dbconnections/change_password': (200, {})})
    try:
        assert c.post('/v1/auth/password-reset', json={'email': 'ana@ejemplo.es'}).json() == {'sent': True}
        assert c.post('/v1/auth/password-reset', json={'email': 'no es correo'}).json() == {'sent': True}
        assert [x[0] for x in llamadas] == ['/dbconnections/change_password'] and 'password' not in llamadas[0][1]
    finally:
        stop()


def test_piezas(monkeypatch):
    assert au.person('x.eyJuYW1lIjoiQW5hIiwiZW1haWwiOiJhbmFAZWplbXBsby5lcyJ9.y') == {'name': 'Ana', 'email': 'ana@ejemplo.es'}
    assert au.person('basura') == {'name': None, 'email': None} and au.token_accepted('no es un permiso') is False
    assert au.invite_open('corta') is False
    monkeypatch.setattr(au.identity, 'db_params', lambda: (_ for _ in ()).throw(OSError('sin base')))
    assert au.invite_open(INVITE) is False                                                        # ante la duda, no hay invitación
    class R:
        headers = {'x-forwarded-for': '<script>'}; client = None
    assert au.address(R()) == 'desconocida'

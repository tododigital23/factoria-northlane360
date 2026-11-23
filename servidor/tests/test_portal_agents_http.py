"""Agentes del portal de una empresa vistos desde Freddy: solo el propietario, solo cifras, nada guardado."""
import json
from unittest.mock import MagicMock, patch
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app import eliot_portal_agents_api as api

ORG, OTHER = uuid4(), uuid4()
SECRET = 'clave-compartida-con-el-portal-0123456789'
URL = 'https://clientes.ejemplo/api/cron/resumen-freddy'
PANEL = 'https://clientes.ejemplo/admin/clients.html'
app = FastAPI(); app.include_router(api.router); client = TestClient(app)
path = f'/v1/me/organizations/{ORG}/portal-agents'


def portal(**over):
    body = {'ok': True, 'empresa': 'portal-demo', 'version': 1, 'generado': '2026-11-17T14:00:00.000Z',
            'agentes': [
                {'id': 'atencion', 'nombre': 'Agente de atención al cliente', 'capacidad': 'email', 'modelo': 'claude-opus-5-5',
                 'estado': 'activo', 'ultimas_24h': {'respuestas': 12, 'pasadas_al_dueno': 3, 'graves': 1, 'sin_respuesta': 0, 'frenos': 0, 'gestiones': 2},
                 'mes': {'mes': '2026-11', 'gasto_usd': 4.256, 'tope_usd': 30, 'respuestas': 71}, 'ultima_actividad': '2026-11-17T13:58:01.123+00:00'},
                {'id': 'cobros', 'nombre': 'Vigilante de cobros', 'capacidad': 'orders', 'estado': 'alerta',
                 'alertas': {'urgentes': 1, 'importantes': 0, 'informativas': 0}}],
            'vigilancia': {'contando_desde': '2026-11-17T10:00:00.000Z', 'ultima_ronda_programada': None}, 'panel': '/admin/clients.html'}
    body.update(over)
    return body


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    api._cache.clear()
    monkeypatch.setenv('ELIOT_PORTAL_FEEDS', json.dumps({str(ORG): {'url': URL, 'secret_env': 'ELIOT_PORTAL_SECRET_NOVA', 'panel_url': PANEL}}))
    monkeypatch.setenv('ELIOT_PORTAL_SECRET_NOVA', SECRET)


def llamar(respuesta=None, status=200, error=None):
    cliente = MagicMock()
    cliente.__enter__.return_value = cliente
    if error:
        cliente.get.side_effect = error
    else:
        cuerpo = respuesta if isinstance(respuesta, (bytes, str)) else json.dumps(respuesta if respuesta is not None else portal())
        cliente.get.return_value = httpx.Response(status, content=cuerpo if isinstance(cuerpo, bytes) else cuerpo.encode())
    return patch.object(api.httpx, 'Client', return_value=cliente), cliente


def test_auth_before_any_fetch():
    parche, cliente = llamar()
    with parche:
        assert client.get(path).status_code == 401
        with patch.object(api, '_owner', side_effect=HTTPException(403)):
            assert client.get(path).status_code == 403
    cliente.get.assert_not_called()


def test_owner_gets_numbers_only():
    parche, cliente = llamar()
    with parche, patch.object(api, '_owner', return_value='verified') as auth:
        r = client.get(path)
    assert r.status_code == 200, r.text
    auth.assert_called_once_with(ORG, None, write=False)
    d = r.json()
    assert d['configured'] is True and d['available'] is True and d['stored_in_freddy'] is False and d['panel_url'] == PANEL
    a = d['agents'][0]
    assert a == {'id': 'atencion', 'name': 'Agente de atención al cliente', 'state': 'activo', 'capability': 'email', 'model': 'claude-opus-5-5',
                 'last_24h': {'respuestas': 12, 'pasadas_al_dueno': 3, 'graves': 1, 'sin_respuesta': 0, 'frenos': 0, 'gestiones': 2},
                 'month': {'month': '2026-11', 'spent_usd': 4.26, 'cap_usd': 30.0, 'replies': 71}, 'last_activity': '2026-11-17T13:58:01.123+00:00'}
    assert d['agents'][1]['alerts'] == {'urgentes': 1, 'importantes': 0, 'informativas': 0}
    assert d['watch']['counting_since'] == '2026-11-17T10:00:00.000Z'
    # la clave viaja solo en la cabecera hacia el portal y nunca vuelve en la respuesta
    args, kwargs = cliente.get.call_args
    assert args == (URL,) and kwargs['headers']['Authorization'] == 'Bearer ' + SECRET
    assert SECRET not in r.text and 'secret' not in r.text.lower().replace('stored_in_freddy', '')


def test_anything_personal_from_the_portal_is_dropped():
    sucio = portal()
    sucio['clientes'] = [{'nombre': 'NOMBRE-SECRETO', 'telefono': '600SECRETO'}]
    sucio['agentes'][0].update({'ultimo_cliente': 'NOMBRE-SECRETO', 'texto': 'pedido ab-ORD-SECRETO', 'nombre': 'Agente de atención al cliente'})
    sucio['agentes'][0]['ultimas_24h'].update({'respuestas': 'MENSAJE-SECRETO', 'detalle': ['USUARIO-SECRETO'], 'graves': -4})
    sucio['agentes'][0]['mes'].update({'mes': 'SECRETO', 'gasto_usd': 'SECRETO'})
    sucio['agentes'][0]['ultima_actividad'] = 'ayer con SECRETO'
    sucio['agentes'][1]['alertas'] = {'urgentes': 2, 'importantes': 'ab-ORD-SECRETO', 'textos': ['SECRETO']}
    sucio['agentes'] += [{'id': 'cobros', 'nombre': 'Duplicado', 'capacidad': 'orders', 'estado': 'ok'},
                         {'id': 'x SECRETO', 'nombre': 'Vigilante', 'capacidad': 'orders', 'estado': 'ok'},
                         {'id': 'raro', 'nombre': 'NOMBRE <b>SECRETO</b> 600111222', 'capacidad': 'orders', 'estado': 'ok'},
                         {'id': 'otro', 'nombre': 'Vigilante de algo', 'capacidad': 'clientes', 'estado': 'ok'},
                         {'id': 'otro_mas', 'nombre': 'Vigilante de algo', 'capacidad': 'orders', 'estado': 'SECRETO'},
                         'SECRETO', None]
    sucio['vigilancia'] = {'contando_desde': 'SECRETO', 'ultima_ronda_programada': '2026-11-17T12:00:00Z', 'nota': 'SECRETO'}
    parche, _ = llamar(sucio)
    with parche, patch.object(api, '_owner', return_value='verified'):
        r = client.get(path)
    assert r.status_code == 200 and 'SECRET' not in r.text.upper().replace('ELIOT_PORTAL_SECRET', ''), r.text
    d = r.json()
    assert [a['id'] for a in d['agents']] == ['atencion', 'cobros']
    assert d['agents'][0]['last_24h']['respuestas'] is None and d['agents'][0]['last_24h']['graves'] is None
    assert d['agents'][0]['month']['month'] is None and d['agents'][0]['month']['spent_usd'] is None
    assert 'last_activity' not in d['agents'][0]
    assert d['agents'][1]['alerts'] == {'urgentes': 2, 'importantes': None, 'informativas': None}
    assert d['watch'] == {'counting_since': None, 'last_scheduled_run': '2026-11-17T12:00:00Z'}


def test_notices_carry_only_level_code_count_and_order_refs():
    cuerpo = portal()
    cuerpo['agentes'][1]['avisos'] = [
        {'nivel': 'urgente', 'clave': 'parciales', 'n': 3, 'texto': 'NOMBRE-SECRETO debe dinero',
         'refs': ['ab-ORD-1373', 'ab-ORD-1378-C', 'NOMBRE SECRETO', 'correo@secreto.es', '+34 600 111 222', 'usuario_secreto', 'ab-ORD-1373', None, {'x': 1}],
         'cliente': 'NOMBRE-SECRETO'},
        {'nivel': 'importante', 'clave': 'sin_aviso', 'n': 'SECRETO', 'refs': 'SECRETO'},
        {'nivel': 'SECRETO', 'clave': 'parciales', 'n': 1, 'refs': []},
        {'nivel': 'urgente', 'clave': 'Con espacios SECRETO', 'n': 1, 'refs': []},
        'SECRETO', None]
    parche, _ = llamar(cuerpo)
    with parche, patch.object(api, '_owner', return_value='verified'):
        r = client.get(path)
    assert r.status_code == 200 and 'SECRET' not in r.text.upper().replace('ELIOT_PORTAL_SECRET', ''), r.text
    d = r.json()
    assert d['agents'][1]['notices'] == [
        {'level': 'urgente', 'code': 'parciales', 'count': 3, 'refs': ['ab-ORD-1373', 'ab-ORD-1378-C']},
        {'level': 'importante', 'code': 'sin_aviso', 'count': None, 'refs': []}]
    assert 'notices' not in d['agents'][0]


def test_notices_are_capped():
    cuerpo = portal()
    cuerpo['agentes'][1]['avisos'] = [{'nivel': 'info', 'clave': 'chat', 'n': i, 'refs': [f'ab-ORD-{100 + k}' for k in range(9)]} for i in range(40)]
    parche, _ = llamar(cuerpo)
    with parche, patch.object(api, '_owner', return_value='verified'):
        d = client.get(path).json()
    assert len(d['agents'][1]['notices']) == 12 and all(len(n['refs']) == 6 for n in d['agents'][1]['notices'])


def test_company_without_portal_never_fetches():
    parche, cliente = llamar()
    with parche, patch.object(api, '_owner', return_value='verified'):
        r = client.get(f'/v1/me/organizations/{OTHER}/portal-agents')
    assert r.status_code == 200 and r.json()['configured'] is False and r.json()['agents'] == [] and r.json()['reason'] == 'not_configured'
    cliente.get.assert_not_called()


def test_each_company_reads_only_its_own_portal(monkeypatch):
    monkeypatch.setenv('ELIOT_PORTAL_FEEDS', json.dumps({
        str(ORG): {'url': URL, 'secret_env': 'ELIOT_PORTAL_SECRET_NOVA', 'panel_url': PANEL},
        str(OTHER): {'url': 'https://otra.ejemplo/api/cron/resumen-freddy', 'secret_env': 'ELIOT_PORTAL_SECRET_OTRA', 'panel_url': 'https://otra.ejemplo/admin'}}))
    monkeypatch.setenv('ELIOT_PORTAL_SECRET_OTRA', 'la-clave-de-la-otra-empresa-0123456789ab')
    parche, cliente = llamar()
    with parche, patch.object(api, '_owner', return_value='verified'):
        client.get(f'/v1/me/organizations/{OTHER}/portal-agents')
    args, kwargs = cliente.get.call_args
    assert args == ('https://otra.ejemplo/api/cron/resumen-freddy',)
    assert kwargs['headers']['Authorization'] == 'Bearer la-clave-de-la-otra-empresa-0123456789ab' and SECRET not in str(kwargs)


@pytest.mark.parametrize('entrada', [
    'no es json', '[]', '{}',
    json.dumps({'x': {'url': URL, 'secret_env': 'ELIOT_PORTAL_SECRET_NOVA'}}),
    None,
])
def test_broken_config_is_not_configured(monkeypatch, entrada):
    if entrada is None:
        monkeypatch.delenv('ELIOT_PORTAL_FEEDS')
    else:
        monkeypatch.setenv('ELIOT_PORTAL_FEEDS', entrada)
    assert api.feed_for(ORG) is None


@pytest.mark.parametrize('cambio', [
    {'url': 'http://clientes.ejemplo/api'}, {'url': 'https://clientes.ejemplo/api?key=abc'}, {'url': 'https://user:pass@clientes.ejemplo/x'},
    {'url': 'file:///etc/passwd'}, {'url': 12}, {'secret_env': 'DATABASE_URL'}, {'secret_env': 'ELIOT_WORKER_DB_PASSWORD'}, {'secret_env': None},
])
def test_unsafe_feed_settings_are_refused(monkeypatch, cambio):
    monkeypatch.setenv('DATABASE_URL', 'x' * 40); monkeypatch.setenv('ELIOT_WORKER_DB_PASSWORD', 'y' * 40)
    entrada = {'url': URL, 'secret_env': 'ELIOT_PORTAL_SECRET_NOVA', 'panel_url': PANEL, **cambio}
    monkeypatch.setenv('ELIOT_PORTAL_FEEDS', json.dumps({str(ORG): entrada}))
    assert api.feed_for(ORG) is None


def test_short_or_missing_secret_is_not_configured(monkeypatch):
    monkeypatch.setenv('ELIOT_PORTAL_SECRET_NOVA', 'corta')
    assert api.feed_for(ORG) is None
    monkeypatch.delenv('ELIOT_PORTAL_SECRET_NOVA')
    assert api.feed_for(ORG) is None


def test_bad_panel_url_is_dropped_but_feed_works(monkeypatch):
    monkeypatch.setenv('ELIOT_PORTAL_FEEDS', json.dumps({str(ORG): {'url': URL, 'secret_env': 'ELIOT_PORTAL_SECRET_NOVA', 'panel_url': 'javascript:alert(1)'}}))
    assert api.feed_for(ORG)['panel_url'] is None


@pytest.mark.parametrize('status,cuerpo,error,motivo', [
    (401, '{}', None, 'portal_rejected_key'), (403, '{}', None, 'portal_rejected_key'), (500, 'ERROR con NOMBRE-SECRETO', None, 'portal_error'),
    (302, '', None, 'portal_error'), (200, 'esto no es json SECRETO', None, 'portal_response_invalid'),
    (200, json.dumps({'ok': False, 'error': 'SECRETO'}), None, 'portal_response_invalid'),
    (200, json.dumps({'ok': True, 'version': 2, 'agentes': []}), None, 'portal_response_invalid'),
    (200, json.dumps({'ok': True, 'version': 1, 'agentes': 'SECRETO'}), None, 'portal_response_invalid'),
    (200, b'x' * (64 * 1024 + 1), None, 'portal_response_too_large'),
    (200, None, httpx.ConnectTimeout('tardó'), 'portal_unreachable'), (200, None, httpx.ConnectError('SECRETO'), 'portal_unreachable'),
])
def test_portal_failures_are_reported_without_leaking(status, cuerpo, error, motivo):
    parche, _ = llamar(cuerpo, status, error)
    with parche, patch.object(api, '_owner', return_value='verified'):
        r = client.get(path)
    d = r.json()
    assert r.status_code == 200 and d['available'] is False and d['reason'] == motivo and d['agents'] == [] and d['panel_url'] == PANEL
    assert 'SECRETO' not in r.text and SECRET not in r.text


def test_no_redirects_and_short_timeout():
    parche, _ = llamar()
    with parche as constructor, patch.object(api, '_owner', return_value='verified'):
        client.get(path)
    assert constructor.call_args.kwargs['follow_redirects'] is False and constructor.call_args.kwargs['timeout'].read <= 8.0


def test_cached_for_a_minute_per_company_and_failures_are_not_cached():
    parche, cliente = llamar()
    with parche, patch.object(api, '_owner', return_value='verified'):
        client.get(path); client.get(path)
    assert cliente.get.call_count == 1
    api._cache.clear()
    parche, cliente = llamar('{}', 500)
    with parche, patch.object(api, '_owner', return_value='verified'):
        client.get(path); client.get(path)
    assert cliente.get.call_count == 2


def test_cache_still_requires_ownership():
    parche, _ = llamar()
    with parche, patch.object(api, '_owner', return_value='verified'):
        client.get(path)
    with patch.object(api, '_owner', side_effect=HTTPException(403)):
        assert client.get(path).status_code == 403


def test_nothing_is_written_to_the_database():
    import inspect
    fuente = inspect.getsource(api)
    assert 'psycopg' not in fuente and '_cursor' not in fuente and 'INSERT' not in fuente.upper()

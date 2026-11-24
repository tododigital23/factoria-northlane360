import json
from unittest.mock import patch

import pytest

from app import eliot_notifier as nt

ORG = '11111111-1111-4111-8111-111111111111'
PANEL = 'https://clientes.ejemplo/admin/clients.html'
TOKEN = '123456789:' + 'A' * 35


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    monkeypatch.setenv('ELIOT_PORTAL_FEEDS', json.dumps({ORG: {'url': 'https://clientes.ejemplo/api/cron/resumen-freddy',
                                                               'secret_env': 'ELIOT_PORTAL_SECRET_NOVA', 'panel_url': PANEL}}))
    monkeypatch.setenv('ELIOT_PORTAL_SECRET_NOVA', 's' * 40)


def resumen(*avisos):
    return {'company': 'portal-demo', 'agents': [{'id': 'cobros', 'name': 'Vigilante de cobros', 'notices': list(avisos)},
                                                      {'id': 'soporte', 'name': 'Vigilante de soporte', 'notices': [{'level': 'info', 'code': 'chat', 'count': 2, 'refs': []}]}]}


def aviso(nivel='urgente', clave='parciales', n=1, refs=('ab-ORD-1373',)):
    return {'level': nivel, 'code': clave, 'count': n, 'refs': list(refs)}


class Banco:
    def __init__(self):
        self.enviados, self.t, self.respuesta = [], 1000.0, (resumen(), None)
        self.n = nt.Notifier(lambda texto: self.enviados.append(texto) or True, now=lambda: self.t)

    def ronda(self, respuesta, avanzar=60):
        self.t += avanzar
        self.enviados.clear()
        with patch.object(nt.portal, 'fetch', return_value=respuesta):
            self.n.tick()
        return list(self.enviados)


def test_first_round_sends_one_digest_and_nothing_when_all_is_quiet():
    b = Banco()
    m = b.ronda((resumen(), None))                    # también lo menor se cuenta: el jefe quiere saber cualquier anomalía
    assert len(m) == 1 and 'ℹ️ Vigilante de soporte' in m[0]
    b = Banco()
    m = b.ronda((resumen(aviso(n=3, refs=('ab-ORD-1370', 'ab-ORD-1373')), aviso('importante', 'decision', 1, ())), None))
    assert len(m) == 1 and m[0].startswith('📋 Avisos abiertos\n🏢 PORTAL DEMO')
    assert 'Vigilante de cobros: 3 pedidos cobrados se quedaron a medias' in m[0] and 'ab-ORD-1370, ab-ORD-1373 y 1 más' in m[0]
    assert 'Una renovación espera tu decisión' in m[0] and PANEL in m[0] and 'ℹ️ Vigilante de soporte: 2 conversaciones de chat' in m[0]


def test_new_escalated_and_grown_notices_are_sent_once():
    b = Banco()
    b.ronda((resumen(), None))
    m = b.ronda((resumen(aviso()), None))
    assert len(m) == 1 and m[0].startswith('🚨 URGENTE\n🏢 PORTAL DEMO') and 'Un pedido cobrado se quedó a medias' in m[0] and 'Pedidos: ab-ORD-1373' in m[0]
    assert 'Rescátalo desde Reparaciones' in m[0] and m[0].endswith('Panel: ' + PANEL)
    assert b.ronda((resumen(aviso()), None)) == []                                   # igual que antes: silencio
    m = b.ronda((resumen(aviso(n=2, refs=('ab-ORD-1373', 'ab-ORD-1380'))), None))    # se suma un pedido
    assert len(m) == 1 and 'ab-ORD-1380' in m[0]
    b.ronda((resumen(aviso('importante', 'decision', 1, ())), None))
    m = b.ronda((resumen(aviso('urgente', 'decision', 1, ())), None))                # sube de gravedad
    assert len(m) == 1 and m[0].startswith('🚨 URGENTE')


def test_resolved_is_announced_and_a_silent_portal_never_counts_as_resolved():
    b = Banco()
    b.ronda((resumen(aviso()), None))
    assert b.ronda((None, 'portal_unreachable')) == []                                # no contesta: NO es «resuelto»
    assert b.ronda((resumen(aviso()), None)) == []                                    # vuelve con lo mismo: silencio
    m = b.ronda((resumen(), None))
    assert m == ['✅ Resuelto\n🏢 PORTAL DEMO\nVigilante de cobros: Un pedido cobrado se quedó a medias\nPedidos: ab-ORD-1373']


def test_urgent_is_reminded_every_six_hours_but_important_is_not():
    b = Banco()
    b.ronda((resumen(aviso(), aviso('importante', 'decision', 1, ())), None))
    assert b.ronda((resumen(aviso(), aviso('importante', 'decision', 1, ())), None), avanzar=5 * 3600) == []
    m = b.ronda((resumen(aviso(), aviso('importante', 'decision', 1, ())), None), avanzar=3700)
    assert len(m) == 1 and m[0].startswith('⏰ Sigue abierto · 🚨 URGENTE')
    assert b.ronda((resumen(aviso(), aviso('importante', 'decision', 1, ())), None)) == []


def test_portal_down_for_fifteen_minutes_is_told_once_and_recovery_too():
    b = Banco()
    b.ronda((resumen(), None))
    assert b.ronda((None, 'portal_error')) == []
    assert b.ronda((None, 'portal_error'), avanzar=10 * 60) == []
    m = b.ronda((None, 'portal_error'), avanzar=6 * 60)
    assert len(m) == 1 and 'no consigo hablar' in m[0]
    assert b.ronda((None, 'portal_error'), avanzar=3600) == []
    m = b.ronda((resumen(), None))
    assert m == ['✅ 🏢 PORTAL DEMO\nJefe, vuelvo a hablar con los agentes de esta empresa.']


def test_messages_never_carry_portal_text_and_unknown_codes_are_neutral():
    b = Banco()
    b.ronda((resumen(), None))
    sucio = dict(aviso('urgente', 'clave_rara', 1, ()), texto='NOMBRE-SECRETO debe 65 €', cliente='SECRETO')
    m = b.ronda((resumen(sucio), None))
    assert len(m) == 1 and 'SECRET' not in m[0].upper() and 'Aviso de un agente' in m[0]


def test_settings_need_both_values_well_formed(monkeypatch):
    for token, chat in (('', ''), (TOKEN, ''), ('', '12345678'), ('mal', '12345678'), (TOKEN, 'yo'), (TOKEN + ' ', '12345678')):
        monkeypatch.setenv('ELIOT_TELEGRAM_BOT_TOKEN', token); monkeypatch.setenv('ELIOT_TELEGRAM_CHAT_ID', chat)
        assert nt.settings() is None and nt.start() is False
    monkeypatch.setenv('ELIOT_TELEGRAM_BOT_TOKEN', TOKEN); monkeypatch.setenv('ELIOT_TELEGRAM_CHAT_ID', '-1001234567')
    assert nt.settings() == (TOKEN, '-1001234567')
    monkeypatch.setenv('ELIOT_NOTIFIER', 'off')
    assert nt.start() is False


def test_sender_posts_to_telegram_and_a_failure_never_prints_the_token(capsys):
    enviado = {}

    class Cliente:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, url, json):
            enviado.update(url=url, json=json)
            return nt.httpx.Response(enviado.get('status', 200))
    with patch.object(nt.httpx, 'Client', return_value=Cliente()):
        assert nt.telegram_sender(TOKEN, '12345678')('hola') is True
        assert enviado['url'] == f'https://api.telegram.org/bot{TOKEN}/sendMessage'
        assert enviado['json'] == {'chat_id': '12345678', 'text': 'hola', 'disable_web_page_preview': True}
        enviado['status'] = 403
        assert nt.telegram_sender(TOKEN, '12345678')('x' * 5000) is False and len(enviado['json']['text']) == 3900
    salida = capsys.readouterr().out
    assert 'no se pudo enviar' in salida and TOKEN not in salida and 'xxx' not in salida


def test_company_name_from_config_wins(monkeypatch):
    monkeypatch.setenv('ELIOT_PORTAL_FEEDS', json.dumps({ORG: {'url': 'https://clientes.ejemplo/api/cron/resumen-freddy', 'name': 'Nova Demo Portal',
                                                               'secret_env': 'ELIOT_PORTAL_SECRET_NOVA', 'panel_url': PANEL}, 'no-es-uuid': {}}))
    assert [(o, n) for o, n, _ in nt.companies()] == [(ORG, 'Nova Demo Portal')]


# ---------- Órdenes por Telegram ----------
def con_datos():
    b = Banco()
    b.ronda(({'company': 'portal-demo', 'agents': [
        {'id': 'atencion', 'name': 'Agente de atención al cliente', 'state': 'activo', 'notices': []},
        {'id': 'cobros', 'name': 'Vigilante de cobros', 'state': 'alerta', 'notices': [aviso(n=2, refs=('ab-ORD-1373', 'ab-ORD-1378'))]},
        {'id': 'soporte', 'name': 'Vigilante de soporte', 'state': 'aviso', 'notices': [aviso('importante', 'whatsapp', 13, ())]}]}, None))
    return b


def test_orders_answer_from_memory_without_customer_data():
    b = con_datos()
    r = nt.answer(b.n, 'Avisos')
    assert r.startswith('Portal Demo') and '🚨 Vigilante de cobros: 2 pedidos cobrados se quedaron a medias' in r and 'ab-ORD-1373, ab-ORD-1378' in r
    assert '⚠️ Vigilante de soporte: 13 avisos de WhatsApp' in r and PANEL in r
    r = nt.answer(b.n, '/estado@novadigitalbot')
    assert '🟢 Agente de atención al cliente: activo' in r and '🔴 Vigilante de cobros: alerta urgente' in r and '🟡 Vigilante de soporte: con avisos' in r
    assert nt.answer(b.n, 'EMPRESAS').startswith('Empresas que vigilo:\n• Portal Demo — 3 agentes')
    assert 'ab-ORD-1373 sale en:' in nt.answer(b.n, 'pedido ab-ORD-1373') and 'Vigilante de cobros' in nt.answer(b.n, 'Pedido ab-ORD-1373')
    assert 'no sale en ningún aviso abierto' in nt.answer(b.n, 'pedido ab-ORD-9999')
    assert 'por ejemplo' in nt.answer(b.n, 'pedido el de Pedro García')
    for texto in ('ayuda', '/start', 'hola', ''):
        assert nt.answer(b.n, texto) == nt.HELP
    assert 'No he entendido' in nt.answer(b.n, 'dame el teléfono de Pedro')


def test_orders_before_first_round_and_when_all_is_quiet():
    b = Banco()
    assert 'Todavía no he podido hablar' in nt.answer(b.n, 'avisos')
    b.ronda(({'company': 'portal-demo', 'agents': [{'id': 'cobros', 'name': 'Vigilante de cobros', 'notices': []}]}, None))
    assert nt.answer(b.n, 'avisos').startswith('✅ Jefe, tus agentes no tienen nada pendiente')


def test_estado_sin_agentes_explica_el_vacio():
    b = Banco()
    b.ronda(({'company': 'Digital services llc', 'agents': []}, None))
    text = nt.answer(b.n, 'estado')
    assert 'Digital' in text and 'Sin agentes de vigilancia' in text


def test_listener_answers_only_the_owner_and_skips_backlog():
    b = con_datos(); b.enviados.clear(); b.n.asked = b.t
    parar = nt.threading.Event()
    pedidos = []
    lotes = [
        [{'update_id': 9, 'message': {'chat': {'id': 12345678}, 'from': {'id': 12345678}, 'text': 'avisos'}}],            # cola anterior al arranque: se descarta
        [{'update_id': 10, 'message': {'chat': {'id': 99999999}, 'text': 'avisos'}},            # un desconocido: silencio total
         {'update_id': 11, 'message': {'chat': {'id': 12345678}, 'from': {'id': 12345678}, 'text': 'empresas'}},
         {'update_id': 11, 'message': {'chat': {'id': 12345678}, 'from': {'id': 99999999}, 'text': 'avisos'}},          # otro escribe en ese chat: silencio
         {'update_id': 11, 'message': {'chat': {'id': 12345678}, 'text': 'avisos'}},                                    # sin remitente: silencio          # el propietario
         {'update_id': 12, 'message': {'chat': {'id': 12345678}, 'photo': []}},                 # sin texto
         'basura', {'update_id': 'x'}],
    ]

    def poll(method, **params):
        pedidos.append(params)
        if lotes:
            return lotes.pop(0)
        parar.set()
        return []
    nt.listen(b.n, TOKEN, '12345678', stop=parar, poll=poll)
    assert len(b.enviados) == 1 and b.enviados[0].startswith('Empresas que vigilo:')
    assert pedidos[0] == {'offset': -1, 'timeout': 0} and pedidos[1]['offset'] == 10 and pedidos[2]['offset'] == 13


def test_una_empresa_avisa_por_su_cuenta_y_freddy_lo_cuenta_al_momento():
    b = Banco()
    b.ronda(({'company': 'portal-demo', 'agents': []}, None))
    b.enviados.clear()
    assert b.n.receive(ORG, resumen(aviso())) is True
    assert any(m.startswith('🚨 URGENTE') for m in b.enviados) and any(m.startswith('ℹ️ Aviso menor') for m in b.enviados)
    b.enviados.clear()
    b.n.receive(ORG, resumen(aviso()))
    assert b.enviados == []                                   # lo mismo otra vez: no repite
    b.n.receive(ORG, {'company': 'portal-demo', 'agents': []})
    assert sum(m.startswith('✅ Resuelto') for m in b.enviados) == 2
    assert b.n.receive('22222222-2222-4222-8222-222222222222', resumen(aviso())) is False   # una empresa que Freddy no conoce


def test_ya_no_pregunta_cada_minuto_y_si_cuando_el_jefe_pregunta():
    assert nt.INTERVAL >= 30 * 60
    b = Banco(); b.ronda((resumen(), None))
    with patch.object(nt.portal, 'fetch', return_value=(resumen(), None)) as fetch:
        b.t += 5; nt.respond(b.n, 'hola'); assert fetch.call_count == 0          # un saludo no consulta
        nt.respond(b.n, 'avisos'); assert fetch.call_count == 0                   # acaba de leer: no repite
        b.t += 60; nt.respond(b.n, 'avisos'); assert fetch.call_count == 1         # pregunta → consulta en ese momento


def test_entrega_de_avisos_del_portal(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.eliot_portal_agents_api import push_router
    app = FastAPI(); app.include_router(push_router); c = TestClient(app)
    cuerpo = {'ok': True, 'version': 1, 'empresa': 'portal-demo', 'agentes': [{'id': 'cobros', 'nombre': 'Vigilante de cobros', 'estado': 'alerta', 'capacidad': 'orders',
              'avisos': [{'nivel': 'urgente', 'clave': 'parciales', 'n': 1, 'refs': ['ab-ORD-1373'], 'texto': 'NOMBRE-SECRETO'}]}]}
    bien = {'Authorization': 'Bearer ' + 's' * 40}
    assert c.post('/v1/portal-push', json=cuerpo).status_code == 401
    assert c.post('/v1/portal-push', json=cuerpo, headers={'Authorization': 'Bearer ' + 'x' * 40}).status_code == 401
    monkeypatch.setattr(nt, '_notifier', None)
    assert c.post('/v1/portal-push', json=cuerpo, headers=bien).status_code == 503
    b = Banco(); b.ronda(({'company': 'portal-demo', 'agents': []}, None)); b.enviados.clear()
    monkeypatch.setattr(nt, '_notifier', b.n)
    assert c.post('/v1/portal-push', json={'ok': True}, headers=bien).status_code == 422
    assert c.post('/v1/portal-push', content=b'x' * 70000, headers=bien).status_code == 413
    assert c.post('/v1/portal-push', json=cuerpo, headers=bien).json() == {'ok': True}
    assert len(b.enviados) == 1 and 'ab-ORD-1373' in b.enviados[0] and 'SECRETO' not in b.enviados[0]


def test_freddy_entiende_las_notas_de_voz_del_jefe():
    b = con_datos(); b.enviados.clear(); b.n.asked = b.t
    parar, oidos = nt.threading.Event(), []
    yo = {'chat': {'id': 12345678}, 'from': {'id': 12345678}}
    lotes = [[], [
        {'update_id': 20, 'message': {**yo, 'voice': {'file_id': 'AUDIO-1', 'duration': 4}}},                       # «empresas», dicho
        {'update_id': 21, 'message': {**yo, 'voice': {'file_id': 'AUDIO-LARGO', 'duration': 600}}},                 # demasiado largo
        {'update_id': 22, 'message': {**yo, 'voice': {'file_id': 'AUDIO-RUIDO', 'duration': 3}}},                   # no se entiende
        {'update_id': 23, 'message': {'chat': {'id': 12345678}, 'from': {'id': 99999999}, 'voice': {'file_id': 'AJENO', 'duration': 3}}}]]

    def poll(method, **params):
        if lotes:
            return lotes.pop(0)
        parar.set(); return []

    def hear(file_id):
        oidos.append(file_id)
        return 'empresas' if file_id == 'AUDIO-1' else None
    nt.listen(b.n, TOKEN, '12345678', stop=parar, poll=poll, hear=hear)
    assert oidos == ['AUDIO-1', 'AUDIO-RUIDO']                                   # el largo y el ajeno ni se descargan
    assert b.enviados[0].startswith('🎙 Te he entendido: «empresas»') and 'Empresas que vigilo:' in b.enviados[0]
    assert 'demasiado largo' in b.enviados[1] and 'no he podido entender' in b.enviados[2] and len(b.enviados) == 3


def test_sin_voz_configurada_una_nota_de_voz_se_ignora():
    b = con_datos(); b.enviados.clear(); b.n.asked = b.t
    parar = nt.threading.Event()
    lotes = [[], [{'update_id': 30, 'message': {'chat': {'id': 12345678}, 'from': {'id': 12345678}, 'voice': {'file_id': 'A', 'duration': 3}}}]]
    nt.listen(b.n, TOKEN, '12345678', stop=parar, poll=lambda m, **p: lotes.pop(0) if lotes else (parar.set() or []))
    assert b.enviados == []


def test_lo_urgente_tambien_de_viva_voz_y_solo_lo_urgente():
    dichos = []
    b = Banco(); b.n.say = lambda texto, dia: dichos.append(texto) or True
    b.ronda(({'company': 'portal-demo', 'agents': []}, None))
    b.ronda((resumen(aviso(), aviso('importante', 'decision', 1, ())), None))
    assert len(dichos) == 1 and dichos[0].startswith('Jefe, aviso urgente en Portal Demo. Vigilante de cobros:')
    assert 'ab-ORD' not in dichos[0]                                              # las referencias van por escrito, no en el audio
    b.ronda((resumen(aviso(), aviso('importante', 'decision', 1, ())), None))
    assert len(dichos) == 1                                                       # no repite
    b.n.say = lambda texto, dia: (_ for _ in ()).throw(RuntimeError('x'))
    assert any(m.startswith('🚨 URGENTE') for m in b.ronda((resumen(aviso(refs=('ab-ORD-1373', 'ab-ORD-1999'))), None)))   # un fallo de voz no impide el texto


def test_la_voz_tiene_tope_diario_y_se_apaga_sin_clave(monkeypatch):
    from app import eliot_freddy_voice as fv
    monkeypatch.delenv('OPENAI_API_KEY', raising=False)
    assert fv.enabled() is False and fv.voice_sender(TOKEN, '1')('hola', '2026-11-20') is False
    monkeypatch.setenv('OPENAI_API_KEY', 'k'); monkeypatch.setenv('ELIOT_FREDDY_VOICE', 'off'); assert fv.enabled() is False
    monkeypatch.delenv('ELIOT_FREDDY_VOICE')
    enviados = []

    class Falso:
        def __init__(self, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, url, **k):
            enviados.append(url)
            return nt.httpx.Response(200, content=b'OGG')
    monkeypatch.setattr(fv, 'speak', lambda texto: b'OGG'); monkeypatch.setattr(fv.httpx, 'Client', Falso)
    say = fv.voice_sender(TOKEN, '1')
    assert all(say('aviso', '2026-11-20') for _ in range(fv.MAX_SPOKEN_PER_DAY)) and say('uno más', '2026-11-20') is False
    assert say('otro día', '2026-11-21') is True and all('/sendVoice' in u and TOKEN in u for u in enviados)


def test_olvidar_un_aviso_desde_la_web(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import eliot_portal_agents_api as api, eliot_freddy_chat as fc
    app = FastAPI(); app.include_router(api.router); c = TestClient(app)
    url = f'/v1/me/organizations/{ORG}/portal-agents/forget'
    monkeypatch.setattr(api, '_owner', lambda org, auth, write: 'auth0|jefe')
    b = Banco(); b.ronda((resumen(aviso()), None)); monkeypatch.setattr(nt, '_notifier', b.n)
    api._cache[ORG] = (0, {})
    with patch.object(fc, 'act_on_portal', return_value={'ok': True, 'hecho': True, 'resumen': 'Hecho'}) as portal, patch.object(nt.portal, 'fetch', return_value=({'company': 'portal-demo', 'agents': []}, None)):
        b.enviados.clear()
        assert c.post(url, json={'code': 'rescate_fallido', 'refs': ['ab-ORD-1390-C']}).json() == {'organization_id': ORG, 'forgotten': True}
        assert portal.call_args[0][1] == {'accion': 'olvidar', 'modo': 'ejecutar', 'clave': 'rescate_fallido', 'refs': ['ab-ORD-1390-C']}
        assert ORG not in api._cache and any(m.startswith('✅ Resuelto') for m in b.enviados)       # la bandeja y Telegram se enteran al momento
        c.post(url, json={'code': 'chat', 'count': 3}); assert portal.call_args[0][1] == {'accion': 'olvidar', 'modo': 'ejecutar', 'clave': 'chat', 'n': 3}
        antes = portal.call_count
        for malo in ({'code': 'x'}, {'code': 'DROP', 'refs': ['ab-ORD-1']}, {'code': 'chat'}, {'code': 'chat', 'refs': ["a' or 1=1"]}, {'code': 'chat', 'refs': ['ab-ORD-1'], 'modo': 'x'}):
            assert c.post(url, json=malo).status_code == 422, malo
        assert portal.call_count == antes
        portal.return_value = {'ok': False, 'hecho': False, 'resumen': 'Las acciones de Freddy están apagadas en el portal.'}
        assert c.post(url, json={'code': 'chat', 'count': 3}).status_code == 409
        portal.return_value = None
        assert c.post(url, json={'code': 'chat', 'count': 3}).status_code == 503


def test_en_telegram_cada_caso_va_por_su_cliente_y_no_por_el_pedido():
    b = Banco(); preguntas = []

    def who(org, refs):
        preguntas.append(list(refs))
        return {'ab-ORD-1373': '«600000001» · Ana García · 600111222'}
    b.n.who = who
    b.ronda(({'company': 'portal-demo', 'agents': []}, None))
    m = b.ronda((resumen(aviso(n=3, refs=('ab-ORD-1373', 'ab-ORD-1378'))), None))
    urgente = next(x for x in m if x.startswith('🚨'))
    assert '• «600000001» · Ana García · 600111222' in urgente and 'ab-ORD-1373' not in urgente
    assert '• ab-ORD-1378' in urgente and '• y 1 más' in urgente and 'Pedidos:' not in urgente       # del que no se sabe quién es, queda la referencia
    assert preguntas == [['ab-ORD-1373', 'ab-ORD-1378']]
    b.ronda((resumen(aviso(n=3, refs=('ab-ORD-1373', 'ab-ORD-1378'))), None))
    assert preguntas == [['ab-ORD-1373', 'ab-ORD-1378'], ['ab-ORD-1378']]                              # lo ya sabido no se vuelve a preguntar
    assert '«600000001» · Ana García' in nt.answer(b.n, 'avisos')
    b.n.who = lambda org, refs: (_ for _ in ()).throw(RuntimeError('x'))
    m = b.ronda((resumen(aviso(n=1, refs=('ab-ORD-2000',))), None))
    assert any('• ab-ORD-2000' in x for x in m)                                                          # si falla la consulta, el aviso sale igual
    dichos = []; b.n.say = lambda texto, dia: dichos.append(texto) or True; b.n.who = who
    b.ronda((resumen(aviso(n=1, refs=('ab-ORD-1373', 'ab-ORD-3000'))), None))
    assert dichos and 'Ana' not in dichos[0] and '600000001' not in dichos[0]                             # en el audio no van datos de clientes


def test_de_quien_es_cada_pedido():
    from app import eliot_freddy_chat as fc
    datos = {'personas': {'ab-ORD-1': {'usuario': 'u1', 'nombre': 'Ana García', 'telefono': '600'}, 'ab-ORD-2': {'usuario': None, 'nombre': 'Luis', 'telefono': None}, 'ab-ORD-3': {}}}
    with patch.object(fc, 'ask_portal', return_value=datos) as portal:
        r = fc.people(ORG, ['ab-ORD-1', 'ab-ORD-2', 'ab-ORD-3', "x' or 1=1"])
        assert r == {'ab-ORD-1': '«u1» · Ana García · 600', 'ab-ORD-2': 'Luis'}
        assert portal.call_args[0][1:] == ('quienes', {'refs': 'ab-ORD-1,ab-ORD-2,ab-ORD-3'})
        assert fc.people('22222222-2222-4222-8222-222222222222', ['ab-ORD-1']) == {}
    with patch.object(fc, 'ask_portal', return_value=None):
        assert fc.people(ORG, ['ab-ORD-1']) == {}


def test_un_cliente_necesita_al_jefe_llega_al_momento_con_su_mensaje(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.eliot_portal_agents_api import push_router
    app = FastAPI(); app.include_router(push_router); c = TestClient(app)
    bien = {'Authorization': 'Bearer ' + 's' * 40}
    ev = {'version': 1, 'empresa': 'portal-demo', 'tipo': 'pide_admin', 'grave': True, 'motivo': 'pide administrador', 'mensaje': 'No me funciona y quiero hablar con alguien',
          'cliente': {'usuario': '600000001', 'nombre': 'Ana García', 'telefono': '600111222', 'clave': 'SECRETO'}, 'otro': 'x'}
    dichos = []
    b = con_datos(); b.enviados.clear(); b.n.say = lambda texto, dia: dichos.append(texto) or True
    monkeypatch.setattr(nt, '_notifier', b.n)
    assert c.post('/v1/portal-event', json=ev).status_code == 401
    assert c.post('/v1/portal-event', json=ev, headers=bien).json() == {'ok': True, 'sent': True}
    m = b.enviados[0]
    assert m.startswith('🚨 🆘 Un cliente quiere hablar contigo\n🏢 PORTAL DEMO') and '«600000001» · Ana García · 600111222' in m
    assert 'Dice: «No me funciona y quiero hablar con alguien»' in m and 'Motivo: pide administrador' in m and PANEL in m and 'SECRETO' not in m
    assert len(dichos) == 1 and 'Ana' not in dichos[0] and '600000001' not in dichos[0]                    # el audio, sin datos del cliente
    c.post('/v1/portal-event', json={**ev, 'tipo': 'sin_respuesta', 'grave': False, 'cliente': {}}, headers=bien)
    assert b.enviados[1].startswith('🤷 El asistente no ha sabido responder') and 'Cliente sin identificar' in b.enviados[1] and len(dichos) == 1
    for malo in ({**ev, 'tipo': 'borrar'}, {**ev, 'version': 2}, {'x': 1}, []):
        assert c.post('/v1/portal-event', json=malo, headers=bien).status_code == 422
    assert c.post('/v1/portal-event', content=b'x' * 9000, headers=bien).status_code == 413
    antes = len(b.enviados)
    for _ in range(nt.EVENTS_PER_HOUR + 5):
        c.post('/v1/portal-event', json=ev, headers=bien)
    assert len(b.enviados) == antes + nt.EVENTS_PER_HOUR - 2                                                # tope por hora: no inunda
    monkeypatch.setattr(nt, '_notifier', None)
    assert c.post('/v1/portal-event', json=ev, headers=bien).status_code == 503


def test_textos_de_los_avisos_nuevos():
    for clave in ('sin_claves', 'agente_frenado', 'telegram_aviso'):
        titulo, propuesta = nt.copy_for(clave, 2)
        assert titulo and propuesta and clave not in titulo


def test_una_empresa_nueva_puede_traer_sus_propios_avisos():
    from app import eliot_portal_agents_api as api
    limpio = api.clean({'ok': True, 'version': 1, 'empresa': 'otra-tienda', 'agentes': [{'id': 'almacen', 'nombre': 'Vigilante de almacén', 'estado': 'alerta', 'capacidad': 'orders', 'avisos': [
        {'nivel': 'urgente', 'clave': 'sin_stock', 'n': 2, 'refs': ['jd-ORD-1042', 'jd-FAC-20260007', '#1042', 'ana@correo.es', '600111222', 'x' * 40],
         'titulo': '2 productos vendidos sin existencias', 'propuesta': 'Repón o avisa al cliente.'},
        {'nivel': 'importante', 'clave': 'raro', 'n': 1, 'refs': [], 'titulo': 'Llama a Ana al 600111222 ahora'},
        {'nivel': 'importante', 'clave': 'parciales', 'n': 1, 'refs': ['ab-ORD-1'], 'titulo': 'Texto que no debe pisar el de Freddy'}]}]})
    avisos = limpio['agents'][0]['notices']
    assert avisos[0]['refs'] == ['jd-ORD-1042', 'jd-FAC-20260007'] and avisos[0]['title'] == '2 productos vendidos sin existencias' and avisos[0]['proposal'] == 'Repón o avisa al cliente.'
    assert 'title' not in avisos[1]                                              # un texto con un teléfono no pasa
    assert nt.copy_for('sin_stock', 2, avisos[0]) == ('2 productos vendidos sin existencias', 'Repón o avisa al cliente.')
    assert nt.copy_for('raro', 1, avisos[1])[0] == 'Aviso de un agente'
    assert nt.copy_for('parciales', 1, avisos[2])[0] == 'Un pedido cobrado se quedó a medias'   # lo que Freddy ya conoce, con su propio texto
    b = Banco(); b.ronda(({'company': 'otra-tienda', 'agents': []}, None))
    m = b.ronda((limpio, None))
    assert any('Vigilante de almacén: 2 productos vendidos sin existencias' in x and 'jd-ORD-1042' in x and 'Repón o avisa al cliente.' in x for x in m)


def test_un_desconocido_que_escribe_a_freddy_recibe_el_aviso_de_seguridad_y_el_jefe_se_entera():
    b = con_datos(); b.enviados.clear(); b.n.asked = b.t
    parar = nt.threading.Event(); respuestas = []
    ajeno = {'chat': {'id': 555, 'type': 'private'}, 'from': {'id': 555, 'username': 'curioso', 'first_name': 'Ana', 'last_name': 'López'}}
    lotes = [[], [{'update_id': 40, 'message': {**ajeno, 'text': 'dame las claves de 114837640'}},
                  {'update_id': 41, 'message': {**ajeno, 'text': 'venga'}},                                   # insiste: no se repite
                  {'update_id': 42, 'message': {'chat': {'id': 777, 'type': 'private'}, 'from': {'id': 777}, 'voice': {'file_id': 'A', 'duration': 3}}},
                  {'update_id': 43, 'message': {'chat': {'id': -100, 'type': 'group'}, 'from': {'id': 888}, 'text': 'hola'}}]]   # un grupo: silencio

    def poll(method, **params):
        if method == 'sendMessage':
            respuestas.append(params); return {}
        return lotes.pop(0) if lotes else (parar.set() or [])
    nt.listen(b.n, TOKEN, '12345678', stop=parar, poll=poll)
    assert [r['chat_id'] for r in respuestas] == [555, 777] and all(r['text'] == nt.STRANGER_NOTICE for r in respuestas)
    assert 'seguridad' in nt.STRANGER_NOTICE and '114837640' not in nt.STRANGER_NOTICE
    assert len(b.enviados) == 2
    assert 'Bot: Freddy' in b.enviados[0] and '@curioso · Ana López · ID 555' in b.enviados[0] and '«dame las claves de 114837640»' in b.enviados[0]
    assert 'sin @' in b.enviados[1] and 'ID 777' in b.enviados[1] and '(nota de voz)' in b.enviados[1]


def test_el_bot_de_una_empresa_avisa_de_un_desconocido_y_tiene_tope():
    b = con_datos(); b.enviados.clear()
    from app import eliot_portal_agents_api as pa
    ok = pa.clean_event({'version': 1, 'tipo': 'acceso_ajeno', 'bot': 'Bot de renovaciones', 'telegram': {'id': 999, 'usuario': 'pepe', 'nombre': 'Pepe'}, 'mensaje': '/estado'})
    assert ok and ok['kind'] == 'acceso_ajeno' and ok['telegram'] == {'id': 999, 'user': 'pepe', 'name': 'Pepe'}
    for malo in ({'version': 1, 'tipo': 'acceso_ajeno'}, {'version': 1, 'tipo': 'acceso_ajeno', 'telegram': {'id': 'x'}}, {'version': 1, 'tipo': 'acceso_ajeno', 'telegram': {'id': True}}):
        assert pa.clean_event(malo) is None
    assert b.n.event(ORG, ok) is True
    assert 'Bot de renovaciones' in b.enviados[0] and '@pepe · Pepe · ID 999' in b.enviados[0] and '«/estado»' in b.enviados[0] and 'ningún dato' in b.enviados[0]
    for _ in range(nt.STRANGERS_PER_HOUR + 5):
        b.n.event(ORG, ok)
    assert len(b.enviados) == nt.STRANGERS_PER_HOUR


def test_el_aviso_de_un_desconocido_trae_acceso_directo_a_su_chat(monkeypatch):
    vistos = []
    n = nt.Notifier(lambda texto, button=None: vistos.append((texto, button)) or True, now=lambda: 1000.0)
    n.stranger('Freddy', {'id': 555, 'user': '@curioso', 'name': 'Ana'}, 'hola')
    n.stranger('Freddy', {'id': 777, 'user': None, 'name': ''}, 'hola')
    n.stranger('Freddy', {'id': 888, 'user': 'x y<script>', 'name': ''}, 'hola')          # un @ imposible no se convierte en enlace
    assert vistos[0][1] == ('💬 Abrir su chat', 'https://t.me/curioso') and 'Abrir su chat: https://t.me/curioso' in vistos[0][0]
    assert vistos[1][1] == ('💬 Abrir su chat', 'tg://user?id=777') and 'No tiene @' in vistos[1][0]
    assert vistos[2][1] == ('💬 Abrir su chat', 'tg://user?id=888') and 't.me/' not in vistos[2][0]
    enviados = []

    class Falso:
        def __init__(self, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, url, json=None):
            enviados.append(json); return nt.httpx.Response(400 if 'reply_markup' in json and 'tg://' in str(json) else 200, content=b'{}')
    monkeypatch.setattr(nt.httpx, 'Client', Falso)
    send = nt.telegram_sender(TOKEN, '1')
    assert send('a', button=('💬 Abrir su chat', 'https://t.me/curioso')) is True and len(enviados) == 1 and enviados[0]['reply_markup']['inline_keyboard'][0][0]['url'] == 'https://t.me/curioso'
    assert send('b', button=('💬 Abrir su chat', 'tg://user?id=777')) is True and len(enviados) == 3 and 'reply_markup' not in enviados[2]   # Telegram lo rechaza: llega sin botón
    assert send('c') is True and 'reply_markup' not in enviados[3]

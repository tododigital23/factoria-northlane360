import json
from types import SimpleNamespace as NS
from unittest.mock import patch

import pytest

from app import eliot_freddy_chat as fc
from app import eliot_notifier as nt

ORG = '11111111-1111-4111-8111-111111111111'
FEED = 'https://clientes.ejemplo/api/cron/resumen-freddy'


@pytest.fixture(autouse=True)
def entorno(monkeypatch):
    monkeypatch.setenv('ELIOT_PORTAL_FEEDS', json.dumps({ORG: {'url': FEED, 'secret_env': 'ELIOT_PORTAL_SECRET_NOVA', 'panel_url': 'https://clientes.ejemplo/admin'}}))
    monkeypatch.setenv('ELIOT_PORTAL_SECRET_NOVA', 's' * 40)


def notifier(spent=1.0, cap=20.0):
    n = nt.Notifier(lambda t: True, now=lambda: 1000.0)
    n.asked = 1000.0
    n.last[ORG] = {'company': 'Nova Demo Portal', 'panel': None, 'at': 990.0, 'summary': {'agents': [
        {'id': 'atencion', 'name': 'Agente de atención', 'state': 'activo', 'month': {'month': '2026-11', 'spent_usd': spent, 'cap_usd': cap}, 'notices': []},
        {'id': 'cobros', 'name': 'Vigilante de cobros', 'state': 'alerta', 'notices': [{'level': 'urgente', 'code': 'parciales', 'count': 1, 'refs': ['ab-ORD-1373']}]}]}}
    return n


def texto(t, tin=1000, tout=100):
    return NS(stop_reason='end_turn', content=[NS(type='text', text=t)], usage=NS(input_tokens=tin, output_tokens=tout))


def llamada(name, args, id='tu_1'):
    return NS(stop_reason='tool_use', content=[NS(type='tool_use', id=id, name=name, input=args)], usage=NS(input_tokens=1000, output_tokens=100))


class Cliente:
    def __init__(self, *respuestas):
        self.respuestas, self.peticiones = list(respuestas), []
        self.beta = NS(messages=NS(create=self._create))

    def _create(self, **kw):
        self.peticiones.append(json.loads(json.dumps(kw, default=lambda o: vars(o))))
        r = self.respuestas.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def chat(n, *respuestas):
    c = Cliente(*respuestas)
    return fc.Chat(n, client=c, now=lambda: 1000.0), c


def test_pregunta_sencilla_y_apunta_el_gasto():
    ch, c = chat(notifier(), texto('Hoy van 3 ventas.'))
    with patch.object(fc, 'report_spend', return_value=False) as gasto:
        assert ch.ask('¿cómo va el día?') == 'Hoy van 3 ventas.'
    p = c.peticiones[0]
    assert p['model'] == 'claude-opus-5-5' and p['fallbacks'] == 'default' and 'temperature' not in p and 'tool_choice' not in p
    assert gasto.call_args[0][1] == pytest.approx((1000 * 4 + 100 * 20) / 1e6)


def test_consulta_a_la_empresa_con_herramienta():
    ch, c = chat(notifier(), llamada('consultar', {'empresa': 'nova demo portal', 'tipo': 'ventas', 'periodo': 'hoy'}), texto('2 cobros, 130 €.'))
    datos = {'periodo': 'hoy', 'cobros': 2, 'importe_eur': 130}
    with patch.object(fc, 'ask_portal', return_value=datos) as portal, patch.object(fc, 'report_spend', return_value=False):
        assert ch.ask('ventas de hoy') == '2 cobros, 130 €.'
    assert portal.call_args[0][1:] == ('ventas', {'periodo': 'hoy'})
    resultado = c.peticiones[1]['messages'][-1]['content'][0]
    assert resultado['type'] == 'tool_result' and resultado['tool_use_id'] == 'tu_1' and json.loads(resultado['content'])['datos'] == datos


def test_herramientas_locales():
    n = notifier()
    assert fc.run_tool(n, 'empresas', {}, 1000.0, {})['empresas'][0]['empresa'] == 'Nova Demo Portal'
    avisos = fc.run_tool(n, 'avisos', {}, 1000.0, {})['avisos']
    assert len(avisos) == 1 and avisos[0]['pedidos'] == ['ab-ORD-1373'] and avisos[0]['gravedad'] == 'urgente'
    assert 'error' in fc.run_tool(n, 'avisos', {'empresa': 'otra'}, 1000.0, {})
    assert 'error' in fc.run_tool(n, 'consultar', {'empresa': 'nova', 'tipo': 'pedido', 'ref': "x' or 1=1"}, 1000.0, {ORG: {}})
    assert 'error' in fc.run_tool(n, 'consultar', {'empresa': 'nova', 'tipo': 'borrar'}, 1000.0, {ORG: {}})
    assert 'error' in fc.run_tool(n, 'borrar_pedido', {}, 1000.0, {})


def test_la_limpieza_no_deja_pasar_datos_de_clientes():
    sucio = {'encontrado': True, 'ref': 'ab-ORD-1373', 'email': 'a@b.es', 'nombre': 'Ana', 'pago': {'tipo': 'alta', 'plan': '12m', 'importe_eur': 65, 'fecha': '2026-11-20T10:00:00Z', 'cliente': 'Ana'},
             'envios': [{'ref': 'ab-ORD-1373', 'estado': 'ok', 'usuario': '600111222'}],
             'plataformas': [{'plataforma': 'PlataformaA', 'estado': 'active', 'caduca': '2027-11-20', 'usuario': 'u', 'clave': 'p'}, {'plataforma': 'ana@correo.es', 'estado': 'x', 'caduca': 'mañana'}]}
    limpio = json.dumps(fc.clean_query('pedido', sucio))
    for prohibido in ('a@b.es', 'Ana', '600111222', 'usuario', 'clave', 'correo'):
        assert prohibido not in limpio
    assert '"PlataformaA"' in limpio and '2027-11-20' in limpio
    ventas = fc.clean_query('ventas', {'periodo': 'hoy', 'cobros': 2, 'importe_eur': 130, 'por_plan': {'12m': {'cobros': 2, 'importe_eur': 130}, 'ana@b.es': {'cobros': 1}}, 'clientes': ['Ana']})
    assert list(ventas['por_plan']) == ['12m'] and 'clientes' not in ventas
    assert fc.clean_query('cuentas', {'accesos_por_plataforma': {'PlataformaA': 5, 'x' * 40: 1}, 'cuentas_de_pago_activas': 'muchas'}) == {
        'clientes_con_servicio_de_pago': None, 'cuentas_de_pago_activas': None, 'pruebas_activas': None, 'accesos_por_plataforma': {'PlataformaA': 5}}
    assert fc.clean_query('otra', {}) is None and fc.clean_query('ventas', 'x') is None


def test_tope_de_gasto_compartido():
    ch, c = chat(notifier(spent=20.0, cap=20.0), texto('no debería'))
    assert 'tope de gasto' in ch.ask('ventas de hoy') and not c.peticiones
    ch, c = chat(notifier(), texto('uno'), texto('dos'))
    with patch.object(fc, 'report_spend', return_value=True):
        assert ch.ask('a') == 'uno'
    assert 'tope de gasto' in ch.ask('b') and len(c.peticiones) == 1


def test_maximo_diario_y_memoria_corta():
    ch, c = chat(notifier(), *[texto(str(i)) for i in range(4)])
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'MAX_PER_DAY', 2):
        ch.ask('una'); ch.ask('dos')
        assert 'máximo de preguntas' in ch.ask('tres')
    assert [m['content'] for m in c.peticiones[1]['messages']] == ['una', '0', 'dos']


def test_rechazo_bucle_sin_fin_y_errores():
    with patch.object(fc, 'report_spend', return_value=False):
        ch, _ = chat(notifier(), NS(stop_reason='refusal', content=[], usage=NS(input_tokens=10, output_tokens=0)))
        assert ch.ask('x') == 'No puedo ayudarte con eso.'
        ch, c = chat(notifier(), *[llamada('empresas', {}) for _ in range(fc.MAX_TURNS)])
        assert 'más concreta' in ch.ask('x') and len(c.peticiones) == fc.MAX_TURNS
        ch, _ = chat(notifier(), fc.anthropic.APIConnectionError(request=None))
        assert 'conectar' in ch.ask('x')


def test_reparto_entre_ordenes_fijas_y_conversacion():
    n = notifier()
    falso = NS(ask=lambda t: 'IA: ' + t)
    assert nt.respond(n, 'avisos', falso).startswith('IA') is False
    assert nt.respond(n, 'pedido ab-ORD-1373', falso).startswith('IA') is False
    assert nt.respond(n, '¿cuánto se ha vendido hoy?', falso) == 'IA: ¿cuánto se ha vendido hoy?'
    assert nt.respond(n, 'estado de las ventas de esta semana', falso).startswith('IA')
    assert nt.respond(n, '¿cuánto se ha vendido hoy?', None)   # sin IA: contesta el nivel 1


def test_apagado_sin_clave(monkeypatch):
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    assert fc.enabled() is False
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'k')
    assert fc.enabled() is True
    monkeypatch.setenv('ELIOT_FREDDY_CHAT', 'off')
    assert fc.enabled() is False


def test_direccion_de_consultas():
    assert fc.query_url(FEED) == 'https://clientes.ejemplo/api/cron/consulta-freddy'


def test_nivel_3_el_jefe_recibe_la_ficha_completa():
    pide = llamada('cliente', {'empresa': 'Nova Demo Portal', 'buscar': 'ab-ORD-1310'})
    ficha = {'encontrados': 1, 'clientes': [{'nombre': 'Ana García', 'telefono': '600111222', 'cuentas': [{'usuario': '600000001', 'clave': 'pw-1'}]}]}
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'ask_portal', return_value=ficha) as portal:
        ch, c = chat(notifier(), pide, texto('Jefe, es Ana García, 600111222.'), texto('Su clave es pw-1.'))
        assert ch.ask('¿de quién es ab-ORD-1310?') == 'Jefe, es Ana García, 600111222.'
        assert portal.call_args[0][1:] == ('cliente', {'q': 'ab-ORD-1310'})
        assert json.loads(c.peticiones[1]['messages'][-1]['content'][0]['content'])['datos'] == ficha
        ch.ask('¿y su clave?')
        assert 'Ana García' in json.dumps(c.peticiones[2]['messages'], ensure_ascii=False)   # sigue el hilo durante 30 minutos
        assert 'jefe' in c.peticiones[0]['system'] and 'sin ocultar' in c.peticiones[0]['system']
        ch, c = chat(notifier(), pide, texto('x'))
        ch.lookups, ch.day = fc.MAX_CLIENT_LOOKUPS, '1970-01-01'
        portal.reset_mock(); ch.ask('ficha de ab-ORD-1310')
        assert not portal.called                                                            # freno diario ante un bucle


def test_herramientas_de_cliente_validan_lo_que_piden():
    n, feeds = notifier(), {ORG: {'url': FEED, 'secret': 's' * 40}}
    with patch.object(fc, 'ask_portal', return_value={'ok': 1}) as portal:
        assert 'error' in fc.run_tool(n, 'cliente', {'empresa': 'Nova Demo Portal', 'buscar': 'ab'}, 1000.0, feeds)
        assert 'error' in fc.run_tool(n, 'cliente', {'empresa': 'otra', 'buscar': 'ana garcia'}, 1000.0, feeds)
        assert 'error' in fc.run_tool(n, 'usuario_de_pedido', {'empresa': 'Nova Demo Portal', 'ref': 'cualquiera'}, 1000.0, feeds)
        assert not portal.called
        fc.run_tool(n, 'conversacion', {'empresa': 'nova', 'buscar': ' 600111222 '}, 1000.0, feeds)
        assert portal.call_args[0][1:] == ('conversacion', {'q': '600111222'})
        fc.run_tool(n, 'incidencias', {'empresa': 'nova', 'horas': 5}, 1000.0, feeds)
        assert portal.call_args[0][1:] == ('incidencias', {'horas': 24})
    grande = fc.clean_query('cliente', {'clientes': [{'nombre': 'x' * 5000, 'raro': object()}] * 80})
    assert len(grande['clientes']) == 30 and len(grande['clientes'][0]['nombre']) == 600 and grande['clientes'][0]['raro'] is None


def test_limpieza_del_usuario():
    assert fc.clean_query('usuario', {'encontrado': True, 'ref': 'ab-ORD-1310', 'usuarios': ['600000001', 'ana@correo.es', 5], 'clave': 'p', 'nombre': 'Ana'}) == {
        'encontrado': True, 'ref': 'ab-ORD-1310', 'usuarios': ['600000001']}
    assert fc.clean_query('usuario', {'encontrado': False, 'motivo': 'no_existe'}) == {'encontrado': False, 'motivo': 'no_existe'}


def test_la_ficha_llega_entera_hasta_lo_contratado():
    ficha = {'encontrados': 1, 'clientes': [{'nombre': 'Ana', 'cuentas': [{'usuario': 'u1', 'clave': 'p1', 'plataformas': ['P2P', 'XUI'], 'contratado': {'plan': '12m', 'conexiones': 2}}], 'pagos': [{'importe_eur': 65}]}]}
    assert fc.run_tool.__defaults__ is not None and fc.clean_query('cliente', ficha) == ficha
    with patch.object(fc.httpx, 'Client') as cliente:
        cliente.return_value.__enter__.return_value.get.return_value = NS(status_code=200, content=b'x', json=lambda: {'ok': True, 'tipo': 'cliente', 'datos': ficha})
        assert fc.ask_portal({'url': FEED, 'secret': 's' * 40}, 'cliente', {'q': 'ana'}) == ficha


def test_en_la_web_contesta_el_mismo_freddy_solo_al_propietario_y_solo_de_sus_empresas(monkeypatch):
    n = notifier(); OTRA = '22222222-2222-4222-8222-222222222222'
    n.last[OTRA] = {'company': 'Ajena', 'panel': None, 'at': 990.0, 'summary': {'agents': []}}
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'k'); fc._web.clear()
    monkeypatch.setattr(nt, '_notifier', None)
    assert fc.web_answer('auth0|jefe', ORG, [ORG], '¿ventas?') is None                 # sin avisos en marcha, no hay nada
    monkeypatch.setattr(nt, '_notifier', n)
    assert fc.web_answer('auth0|otro', ORG, [], '¿ventas?') is None                    # no es propietario de esa empresa
    assert fc.web_answer('auth0|jefe', '33333333-3333-4333-8333-333333333333', ['33333333-3333-4333-8333-333333333333'], 'hola') is None   # empresa sin portal
    c = Cliente(llamada('empresas', {}), texto('Jefe, 2 cobros hoy.'), llamada('cliente', {'empresa': 'Nova Demo Portal', 'buscar': 'ab-ORD-1'}), texto('Es Ana.'))
    monkeypatch.setattr(fc.anthropic, 'Anthropic', lambda: c)
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'ask_portal', return_value={'encontrados': 1}):
        assert fc.web_answer('auth0|jefe', ORG, [ORG], '¿ventas de hoy?', 'Tareas: 3 pendientes') == ('Jefe, 2 cobros hoy.', False)
        vistas = json.loads(c.peticiones[1]['messages'][-1]['content'][0]['content'])['empresas']
        assert [e['empresa'] for e in vistas] == ['Nova Demo Portal']          # la empresa ajena no existe para él
        assert 'oficina de «Nova Demo Portal»' in c.peticiones[0]['system'] and 'Tareas: 3 pendientes' in c.peticiones[0]['system']
        assert fc.web_answer('auth0|jefe', ORG, [ORG], '¿de quién es ab-ORD-1?') == ('Es Ana.', True)   # con datos de clientes: se marca
    assert len(fc._web) == 1


# ---------- Acciones: Freddy propone, el jefe dice «sí», el código ejecuta ----------
def con_acciones(*respuestas):
    c = Cliente(*respuestas)
    reloj = {'t': 1000.0}
    ch = fc.Chat(notifier(), client=c, now=lambda: reloj['t'], actions=True)
    return ch, c, reloj


PROPONE = llamada('proponer_accion', {'empresa': 'Nova Demo Portal', 'accion': 'responder', 'buscar': 'ab-ORD-1310', 'mensaje': 'Ya está resuelto.'})
PREVIA = {'ok': True, 'hecho': False, 'resumen': 'Escribir a Ana García por el chat del portal:\n«Ya está resuelto.»', 'client_id': '11111111-2222-4333-8444-555555555555'}


def test_propone_y_no_ejecuta_hasta_el_si():
    ch, c, _ = con_acciones(PROPONE, texto('Escribir a Ana García… ¿Lo hago? Responde sí.'))
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal', return_value=PREVIA) as portal:
        ch.ask('dile a la clienta de ab-ORD-1310 que ya está resuelto')
        assert portal.call_count == 1 and portal.call_args[0][1]['modo'] == 'previa'            # solo la vista previa
        assert ch.pending and 'proponer_accion' in [t['name'] for t in c.peticiones[0]['tools']] and 'Tú nunca ejecutas' in c.peticiones[0]['system']
        portal.return_value = {'ok': True, 'hecho': True, 'resumen': 'Hecho: mensaje enviado a Ana García.'}
        assert nt.respond(ch.notifier, 'Sí', ch) == '✅ Hecho: mensaje enviado a Ana García.'
        enviado = portal.call_args[0][1]
        assert enviado == {'accion': 'responder', 'mensaje': 'Ya está resuelto.', 'client_id': PREVIA['client_id'], 'modo': 'ejecutar'}   # al mismo cliente que se enseñó
        assert ch.pending is None and portal.call_count == 2
        assert nt.respond(ch.notifier, 'hola', ch) == nt.HELP and portal.call_count == 2        # un segundo «sí» o cualquier cosa ya no ejecuta nada


def test_cualquier_cosa_que_no_sea_si_cancela():
    for dicho in ('no', 'espera', 'sí pero cámbiale el texto', 'avisos', 'vale', 'ok'):
        ch, c, _ = con_acciones(PROPONE, texto('¿Lo hago?'), texto('otra cosa'))
        with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal', return_value=PREVIA) as portal:
            ch.ask('escríbele')
            r = nt.respond(ch.notifier, dicho, ch)
            assert r.startswith('He cancelado la acción que estaba pendiente') and ch.pending is None, dicho
            assert all(k[0][1]['modo'] == 'previa' for k in portal.call_args_list), dicho           # nunca llegó a ejecutarse


def test_el_si_caduca_a_los_dos_minutos():
    ch, c, reloj = con_acciones(PROPONE, texto('¿Lo hago?'))
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal', return_value=PREVIA) as portal:
        ch.ask('escríbele')
        reloj['t'] += fc.CONFIRM_SECONDS + 1
        assert 'ha caducado' in nt.respond(ch.notifier, 'sí', ch) and portal.call_count == 1 and ch.pending is None


def test_si_el_portal_dice_que_no_se_puede_no_queda_nada_pendiente():
    ch, c, _ = con_acciones(PROPONE, texto('Hay dos clientes que encajan.'))
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal', return_value={'ok': False, 'hecho': False, 'resumen': 'Hay 2 clientes que encajan.'}) as portal:
        ch.ask('escríbele a Ana')
        assert ch.pending is None
        assert json.loads(c.peticiones[1]['messages'][-1]['content'][0]['content']) == {'no_se_puede': 'Hay 2 clientes que encajan.'}
    ch, c, _ = con_acciones(PROPONE, texto('El portal no contesta.'))
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal', return_value=None):
        ch.ask('escríbele')
        assert ch.pending is None


def test_si_la_ejecucion_falla_o_no_contesta_no_se_da_por_hecha():
    ch, c, _ = con_acciones(PROPONE, texto('¿Lo hago?'), PROPONE, texto('¿Lo hago?'))
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal', return_value=PREVIA) as portal:
        ch.ask('escríbele')
        portal.return_value = None
        assert 'No doy la acción por hecha' in nt.respond(ch.notifier, 'si', ch)
        portal.return_value = PREVIA; ch.ask('escríbele otra vez')
        portal.return_value = {'ok': False, 'hecho': False, 'resumen': 'No he podido enviar el mensaje.'}
        assert nt.respond(ch.notifier, 'confirmo', ch) == '⚠️ No se ha hecho. No he podido enviar el mensaje.'


def test_una_accion_cada_vez_y_solo_en_el_chat_del_jefe():
    dos = NS(stop_reason='tool_use', usage=NS(input_tokens=10, output_tokens=10), content=[
        NS(type='tool_use', id='a', name='proponer_accion', input={'empresa': 'Nova Demo Portal', 'accion': 'agente', 'activo': False}),
        NS(type='tool_use', id='b', name='proponer_accion', input={'empresa': 'Nova Demo Portal', 'accion': 'descartar', 'ref': 'ab-ORD-1373'})])
    ch, c, _ = con_acciones(dos, texto('¿Lo hago?'))
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal', return_value={'ok': True, 'hecho': False, 'resumen': 'Apagar el agente.'}) as portal:
        ch.ask('apaga el agente y quita el 1373')
        assert portal.call_count == 1 and ch.pending['payload'] == {'accion': 'agente', 'activo': False}
        segundo = json.loads(c.peticiones[1]['messages'][-1]['content'][1]['content'])
        assert 'Solo una acción cada vez' in segundo['error']
    web, c2 = chat(notifier(), PROPONE, texto('Desde la web solo informo.'))                      # la conversación de la web no tiene acciones
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal') as portal:
        web.ask('escríbele')
        assert not portal.called and web.pending is None and 'proponer_accion' not in [t['name'] for t in c2.peticiones[0]['tools']]


def test_lo_que_viaja_al_portal_esta_acotado():
    ch, c, _ = con_acciones(llamada('proponer_accion', {'empresa': 'Nova Demo Portal', 'accion': 'fecha', 'usuario': 'ana700', 'fecha': '2027-03-13', 'modo': 'ejecutar', 'client_id': 'x', 'sql': 'drop'}), texto('¿Lo hago?'))
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal', return_value={'ok': True, 'hecho': False, 'resumen': 'Cambiar la fecha.'}) as portal:
        ch.ask('pon ana700 al 13 de marzo de 2027')
        assert portal.call_args[0][1] == {'accion': 'fecha', 'usuario': 'ana700', 'fecha': '2027-03-13', 'modo': 'previa'}   # el modelo no puede colar «ejecutar» ni campos propios
    feed = {'url': FEED, 'secret': 's' * 40}
    with patch.object(fc.httpx, 'Client') as cliente:
        post = cliente.return_value.__enter__.return_value.post
        post.return_value = NS(status_code=200, content=b'x', json=lambda: {'ok': True, 'hecho': True, 'resumen': 'R' * 5000, 'client_id': 'no-es-un-id', 'extra': 'x'})
        r = fc.act_on_portal(feed, {'accion': 'agente'})
        assert r == {'ok': True, 'hecho': True, 'resumen': 'R' * 900} and post.call_args[0][0] == 'https://clientes.ejemplo/api/cron/accion-freddy'
        post.return_value = NS(status_code=500, content=b'x', json=lambda: {})
        assert fc.act_on_portal(feed, {'accion': 'agente'}) is None


def test_cada_empresa_trae_sus_propias_consultas_y_acciones():
    n = notifier(); OTRA = '22222222-2222-4222-8222-222222222222'
    n.last[OTRA] = {'company': 'Mi Tienda', 'panel': None, 'at': 990.0, 'summary': {'agents': [], 'queries': ['stock'], 'actions': ['reenviar']}}
    feeds = {ORG: {'url': FEED, 'secret': 's' * 40}, OTRA: {'url': 'https://mi-tienda.example/api/cron/resumen-freddy', 'secret': 't' * 40}}
    vistas = fc.run_tool(n, 'empresas', {}, 1000.0, feeds)['empresas']
    assert next(e for e in vistas if e['empresa'] == 'Mi Tienda')['consultas_propias'] == ['stock'] and 'consultas_propias' not in next(e for e in vistas if e['empresa'] != 'Mi Tienda')
    with patch.object(fc, 'ask_portal', return_value={'bajo_minimos': 4}) as portal:
        r = fc.run_tool(n, 'consultar', {'empresa': 'Mi Tienda', 'tipo': 'stock', 'parametros': {'almacen': 'norte', 'RARO; DROP': 'x', 'obj': {'a': 1}}}, 1000.0, feeds)
        assert r['datos'] == {'bajo_minimos': 4} and portal.call_args[0][1:] == ('stock', {'almacen': 'norte'}) and portal.call_args[1] == {'custom': True}
        assert 'error' in fc.run_tool(n, 'consultar', {'empresa': 'Mi Tienda', 'tipo': 'ventas'}, 1000.0, feeds)                 # esa empresa no la tiene
        assert 'error' in fc.run_tool(n, 'consultar', {'empresa': 'Nova Demo Portal', 'tipo': 'stock'}, 1000.0, feeds)   # ni Nova la de la otra
    assert fc.clean_query('stock', {'a': 1}) is None and fc.clean_query('stock', {'a': 1}, custom=True) == {'a': 1}
    c = Cliente(llamada('proponer_accion', {'empresa': 'Mi Tienda', 'accion': 'reenviar', 'datos': {'pedido': 'mt-ORD-7', 'modo': 'ejecutar', 'client_id': 'x'}}), texto('¿Lo hago?'),
                llamada('proponer_accion', {'empresa': 'Mi Tienda', 'accion': 'fecha', 'usuario': 'u', 'fecha': '2027-01-01'}), texto('No existe.'))
    ch = fc.Chat(n, client=c, now=lambda: 1000.0, actions=True)
    with patch.object(fc, 'report_spend', return_value=False), patch.object(fc, 'act_on_portal', return_value={'ok': True, 'hecho': False, 'resumen': 'Reenviar mt-ORD-7.'}) as portal, \
            patch.object(nt, 'companies', return_value=[(ORG, 'Nova Demo Portal', feeds[ORG]), (OTRA, 'Mi Tienda', feeds[OTRA])]):
        ch.ask('reenvía el pedido 7 de mi tienda')
        assert portal.call_args[0][1] == {'pedido': 'mt-ORD-7', 'accion': 'reenviar', 'modo': 'previa'} and ch.pending['feed'] == feeds[OTRA]
        ch.ask('cámbiale la fecha en mi tienda')
        assert portal.call_count == 1 and ch.pending is None                                  # «fecha» es de Nova, no de esta empresa


def test_el_resumen_de_una_empresa_dice_que_deja_preguntar_y_hacer():
    from app import eliot_portal_agents_api as api
    limpio = api.clean({'ok': True, 'version': 1, 'agentes': [], 'consultas': ['ventas', 'stock', 'DROP TABLE', 7], 'acciones': ['reenviar', 'x' * 50]})
    assert limpio['queries'] == ['ventas', 'stock'] and limpio['actions'] == ['reenviar']
    assert api.clean({'ok': True, 'version': 1, 'agentes': []})['queries'] == []

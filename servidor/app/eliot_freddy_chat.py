"""Freddy conversa con el jefe por Telegram: entiende la pregunta y consulta a los agentes de la empresa que toque.

Solo consulta: no puede cambiar nada en ninguna empresa. Herramientas de lectura:
  * empresas, avisos            → qué empresas hay, cómo están sus agentes y qué tienen abierto
  * consultar                   → ventas, un pedido, caducidades o cuentas (cifras)
  * cliente, conversacion, incidencias, usuario_de_pedido → datos de clientes (nivel 3)

Nivel 3, por decisión expresa del propietario (21/11/2026): en su chat privado de Telegram —y solo ahí; el escuchador
descarta cualquier mensaje que no venga de su chat y de su propia cuenta— Freddy le da cualquier dato de sus clientes,
incluidas las credenciales de las cuentas entregadas. Cada consulta con datos de cliente queda registrada en la empresa.
La conversación reciente se recuerda 30 minutos, solo en memoria, para poder seguir el hilo; nunca se guarda en disco.

Presupuesto: comparte contador mensual y tope con el agente de atención de la empresa principal, y hay un máximo diario.

Variables del servidor: ANTHROPIC_API_KEY (la lee el SDK). Sin ella, Freddy solo atiende las órdenes fijas.
Se apaga con ELIOT_FREDDY_CHAT=off.
"""
import json
import os
import re
import threading
import time

import anthropic
import httpx

from app import eliot_notifier as notifier_mod
from app import eliot_portal_agents_api as portal

MODEL = 'claude-opus-5-5'                     # el mismo modelo que el agente de atención del portal
PRICE_IN, PRICE_OUT = 4.0, 20.0               # $ por millón de tokens
MAX_TURNS = 6                                 # idas y vueltas con herramientas por pregunta
MAX_PER_DAY = 80                              # preguntas con IA al día
HISTORY = 6                                   # mensajes recientes que se recuerdan
HISTORY_TTL = 30 * 60
PLATFORM = re.compile(r'^[A-Za-z0-9&+ .-]{2,30}$')
PLAN = re.compile(r'^\d{1,2}m$|^otro$')
DAY = re.compile(r'^\d{4}-\d{2}-\d{2}$')
USERNAME = re.compile(r'^[A-Za-z0-9._-]{2,40}$')
MAX_CLIENT_LOOKUPS = 150                      # consultas con datos de cliente al día (freno ante un bucle, no un límite de uso)
CLIENT_TOOLS = {'cliente': 'cliente', 'conversacion': 'conversacion', 'incidencias': 'incidencias', 'usuario_de_pedido': 'usuario'}
QUERY_TYPES = ('ventas', 'pedido', 'caducidades', 'cuentas')

SYSTEM = """Eres Freddy, el director de La Factoría Northlane360. Hablas por Telegram con el propietario del holding, en su chat privado. Llámale siempre «jefe».

Tu trabajo aquí es informar. Para saber algo de una empresa preguntas a sus agentes con tus herramientas; no supongas ni inventes nada. Si una herramienta no devuelve un dato, dilo tal cual. Si no está claro de qué empresa habla y hay más de una, pregúntaselo.

El jefe es el dueño de las empresas y este chat es solo suyo: dale cualquier dato que pida, completo y sin ocultar nada, incluidos nombre, teléfono, correo, Telegram, usuarios y contraseñas de las cuentas de sus clientes, sus pagos y sus conversaciones. No le pongas pegas ni advertencias de privacidad. Eso sí: da los datos de clientes cuando los pida o cuando hagan falta para contestar; no los vuelques por tu cuenta.

Al jefe le hablas de cada caso por el usuario de la suscripción y el nombre del cliente (y su teléfono si viene al caso), nunca por el número de pedido: a él los números de pedido no le dicen nada. El número de pedido úsalo solo por dentro, para tus herramientas, o si él te lo pide expresamente. Si el jefe te da un usuario o un nombre y necesitas el pedido para una consulta o una acción, búscalo tú con «cliente».

Solo puedes consultar, salvo que tengas la herramienta «proponer_accion». Si no la tienes y el jefe te pide una acción, dile en una frase que desde aquí solo informas y dónde se hace (el panel de la empresa).

Cómo contestas: en castellano, breve y directo, pensado para leerse en el móvil. Empieza por la respuesta. Texto plano: sin tablas, sin Markdown y sin asteriscos. Importes en euros, salvo el gasto de inteligencia artificial, que va en dólares. Si hay algo urgente relacionado con lo que te pregunta, menciónalo."""

ACTIONS_PROMPT = """Acciones. En este chat el jefe también puede mandarte hacer cosas. Cada empresa tiene las suyas: si «empresas» lista «acciones_propias» para una empresa, son esas y solo esas. Si no lista ninguna, son estas: encender o apagar el agente de atención; reintentar la entrega de un pedido que quedó a medias; quitar un pedido de la lista de problemas; escribir a un cliente por el chat del portal; corregir la fecha de caducidad de una cuenta; y dejar de avisarle de un pedido que él ya arregló a mano (olvidar), o volver a avisarle (recordar).

Tú nunca ejecutas nada directamente. Cuando el jefe te pida una de esas cosas, usa «proponer_accion» con los datos exactos. La herramienta comprueba que se puede y deja la acción PENDIENTE; el sistema la ejecuta solo cuando el jefe conteste «sí». Después de proponerla, copia al jefe tal cual el resumen que te devuelve y termina con: «¿Lo hago? Responde sí.». No digas que está hecho: todavía no lo está.

Reglas: una acción cada vez. No propongas una acción que el jefe no haya pedido de forma clara; si dudas de qué pedido, qué cliente o qué fecha, pregúntaselo antes. Para escribir a un cliente, usa las palabras del jefe: corrige solo la ortografía, no añadas promesas, precios ni plazos que él no haya dicho. Las fechas, siempre con día, mes y año. Cualquier otra acción (cobros, devoluciones, altas, bajas, borrar) no puedes hacerla: dile que eso va en el panel.

Puedes recomendar una acción cuando veas que procede («ab-ORD-1373 quedó a medias, ¿quieres que lo reintente?»), pero solo la propones con la herramienta cuando él diga que sí quiere."""

ACTION_TOOL = {'name': 'proponer_accion', 'description': 'Prepara una acción en una empresa y la deja pendiente de que el jefe la confirme con «sí». No ejecuta nada. Devuelve el resumen exacto de lo que se hará, o el motivo por el que no se puede.',
               'input_schema': {'type': 'object', 'properties': {
                   'empresa': {'type': 'string', 'description': 'Nombre de la empresa tal como lo devuelve «empresas».'},
                   'accion': {'type': 'string',
                              'description': 'agente: encender/apagar el agente de atención (activo). reintentar: reintentar un pedido a medias (ref). descartar: quitar un pedido de la lista de problemas (ref). responder: escribir a un cliente por el chat del portal (buscar, mensaje). fecha: cambiar la caducidad de una cuenta (usuario, fecha, y buscar si hace falta distinguir al cliente). olvidar: dejar de avisar de un pedido que el jefe ya arregló a mano (ref); no arregla nada. recordar: deshacer un olvidar (ref).'},
                   'activo': {'type': 'boolean', 'description': 'Solo para agente: true enciende, false apaga.'},
                   'ref': {'type': 'string', 'description': 'Referencia exacta del pedido, por ejemplo ab-ORD-1373.'},
                   'buscar': {'type': 'string', 'description': 'Para localizar al cliente: referencia de pedido, usuario, teléfono, correo o nombre.'},
                   'mensaje': {'type': 'string', 'description': 'Solo para responder: el texto que recibirá el cliente (hasta 600 caracteres).'},
                   'usuario': {'type': 'string', 'description': 'Solo para fecha: el usuario de la cuenta.'},
                   'fecha': {'type': 'string', 'description': 'Solo para fecha: la nueva caducidad, en formato AAAA-MM-DD.'},
                   'datos': {'type': 'object', 'description': 'Solo para acciones propias de una empresa (las lista «empresas»): sus datos, como texto.', 'additionalProperties': {'type': 'string'}}},
                   'required': ['empresa', 'accion'], 'additionalProperties': False}}
ACTIONS = ('agente', 'reintentar', 'descartar', 'responder', 'fecha', 'olvidar', 'recordar')   # las de una empresa sin lista propia
ACTION_FIELDS = ('activo', 'ref', 'buscar', 'mensaje', 'usuario', 'fecha')
CONFIRM_SECONDS = 120
YES = {'si', 'si hazlo', 'hazlo', 'confirmo', 'si confirmo', 'adelante', 'si adelante'}

TOOLS = [
    {'name': 'empresas', 'description': 'Lista las empresas del holding que tienen agentes conectados, con el estado actual de cada agente y, si lo hay, su actividad de las últimas 24 horas y su gasto del mes. Úsala para saber qué empresas existen y cómo están sus agentes.',
     'input_schema': {'type': 'object', 'properties': {}, 'additionalProperties': False}},
    {'name': 'avisos', 'description': 'Avisos urgentes e importantes que los agentes de las empresas tienen abiertos ahora mismo, con las referencias de los pedidos afectados y la acción que proponen.',
     'input_schema': {'type': 'object', 'properties': {'empresa': {'type': 'string', 'description': 'Nombre de la empresa tal como lo devuelve «empresas». Omítelo para verlas todas.'}}, 'additionalProperties': False}},
    {'name': 'consultar', 'description': 'Pregunta al portal de una empresa. tipo=ventas: cobros de suscripciones en un periodo (cuántos, importe, altas y renovaciones, por plan). tipo=pedido: estado de un pedido, sus envíos y las plataformas entregadas con su caducidad. tipo=caducidades: cuántas cuentas caducan en los próximos días y cuántas caducaron sin renovar. tipo=cuentas: cuentas de pago activas, pruebas activas y accesos por plataforma.',
     'input_schema': {'type': 'object', 'properties': {
         'empresa': {'type': 'string', 'description': 'Nombre de la empresa tal como lo devuelve «empresas».'},
         'tipo': {'type': 'string', 'description': 'ventas, pedido, caducidades o cuentas; o una de las consultas propias de esa empresa (las lista «empresas»).'},
         'parametros': {'type': 'object', 'description': 'Solo para consultas propias de una empresa: sus parámetros, como texto.', 'additionalProperties': {'type': 'string'}},
         'periodo': {'type': 'string', 'enum': ['hoy', 'ayer', '7d', '30d', 'mes'], 'description': 'Solo para ventas. «mes» es el mes natural en curso.'},
         'ref': {'type': 'string', 'description': 'Solo para pedido. Referencia exacta, por ejemplo ab-ORD-1373.'},
         'dias': {'type': 'integer', 'enum': [1, 3, 7, 15, 30], 'description': 'Solo para caducidades.'}},
         'required': ['empresa', 'tipo'], 'additionalProperties': False}},
    {'name': 'usuario_de_pedido', 'description': 'Devuelve solo el usuario de acceso de un pedido concreto. Para la ficha entera usa «cliente».',
     'input_schema': {'type': 'object', 'properties': {
         'empresa': {'type': 'string', 'description': 'Nombre de la empresa tal como lo devuelve «empresas».'},
         'ref': {'type': 'string', 'description': 'Referencia exacta del pedido, por ejemplo ab-ORD-1373.'}},
         'required': ['empresa', 'ref'], 'additionalProperties': False}},
    {'name': 'cliente', 'description': 'Ficha completa de un cliente de una empresa: nombre, teléfono, correo, Telegram, notas, sus cuentas y sus pagos. Cada cuenta es un usuario con su contraseña que sirve en varias plataformas: cuéntalas como cuentas, no como plataformas, y di de cada una qué tiene contratado (plan en meses y conexiones), su estado y cuándo caduca. Se busca por referencia de pedido, usuario, teléfono, correo o nombre. Devuelve como mucho 3 fichas.',
     'input_schema': {'type': 'object', 'properties': {
         'empresa': {'type': 'string', 'description': 'Nombre de la empresa tal como lo devuelve «empresas».'},
         'buscar': {'type': 'string', 'description': 'Referencia de pedido, usuario, teléfono, correo o nombre (mínimo 3 caracteres).'}},
         'required': ['empresa', 'buscar'], 'additionalProperties': False}},
    {'name': 'conversacion', 'description': 'Los últimos mensajes del chat de atención entre un cliente y la empresa. Se busca igual que en «cliente».',
     'input_schema': {'type': 'object', 'properties': {
         'empresa': {'type': 'string', 'description': 'Nombre de la empresa tal como lo devuelve «empresas».'},
         'buscar': {'type': 'string', 'description': 'Referencia de pedido, usuario, teléfono, correo o nombre.'}},
         'required': ['empresa', 'buscar'], 'additionalProperties': False}},
    {'name': 'incidencias', 'description': 'Casos que el agente de atención ha pasado al jefe, ha frenado o ha dejado sin respuesta, con el cliente y su teléfono. Úsala cuando pregunte por conversaciones graves o por quién necesita atención.',
     'input_schema': {'type': 'object', 'properties': {
         'empresa': {'type': 'string', 'description': 'Nombre de la empresa tal como lo devuelve «empresas».'},
         'horas': {'type': 'integer', 'enum': [6, 24, 72, 168]}},
         'required': ['empresa'], 'additionalProperties': False}},
]


def enabled():
    return bool(os.getenv('ANTHROPIC_API_KEY')) and os.getenv('ELIOT_FREDDY_CHAT') != 'off'


# ---------- Limpieza de lo que contesta el portal: campo por campo, nada pasa por defecto ----------
def _num(v, top=10_000_000):
    return v if type(v) in (int, float) and 0 <= v <= top else None


def _instant(v):
    return v if isinstance(v, str) and portal.INSTANT.fullmatch(v) else None


def clean_query(kind, data, custom=False):
    if not isinstance(data, dict):
        return None
    if kind == 'ventas':
        block = lambda b: {'cobros': _num(b.get('cobros')), 'importe_eur': _num(b.get('importe_eur'))} if isinstance(b, dict) else None
        plans = data.get('por_plan') if isinstance(data.get('por_plan'), dict) else {}
        return {'periodo': data.get('periodo') if data.get('periodo') in ('hoy', 'ayer', '7d', '30d', 'mes') else None,
                'desde': _instant(data.get('desde')), 'hasta': _instant(data.get('hasta')),
                'cobros': _num(data.get('cobros')), 'importe_eur': _num(data.get('importe_eur')),
                'altas': block(data.get('altas')), 'renovaciones': block(data.get('renovaciones')),
                'por_plan': {k: block(v) for k, v in list(plans.items())[:12] if isinstance(k, str) and PLAN.fullmatch(k)}}
    if kind == 'pedido':
        if data.get('encontrado') is not True:
            return {'encontrado': False, 'motivo': data.get('motivo') if data.get('motivo') in ('no_existe', 'referencia_no_valida') else None}
        ref = data.get('ref')
        pay = data.get('pago') if isinstance(data.get('pago'), dict) else None
        ref_ok = lambda r: r if isinstance(r, str) and portal.ORDER_REF.fullmatch(r) else None
        word = lambda v, allowed: v if v in allowed else 'otro'
        return {'encontrado': True, 'ref': ref_ok(ref),
                'pago': {'tipo': word(pay.get('tipo'), ('alta', 'renovacion')), 'plan': pay.get('plan') if isinstance(pay.get('plan'), str) and PLAN.fullmatch(pay.get('plan')) else None,
                         'importe_eur': _num(pay.get('importe_eur')), 'fecha': _instant(pay.get('fecha'))} if pay else None,
                'envios': [{'ref': ref_ok(e.get('ref')), 'estado': word(e.get('estado'), ('ok', 'partial', 'failed', 'timeout', 'sent', 'processing', 'queued', 'awaiting_decision', 'dismissed')),
                            'plataformas_pedidas': _num(e.get('plataformas_pedidas'), 50), 'creado': _instant(e.get('creado')), 'actualizado': _instant(e.get('actualizado'))}
                           for e in (data.get('envios') if isinstance(data.get('envios'), list) else [])[:6] if isinstance(e, dict)],
                'plataformas': [{'plataforma': p.get('plataforma') if isinstance(p.get('plataforma'), str) and PLATFORM.fullmatch(p.get('plataforma')) else 'Plataforma',
                                 'estado': word(p.get('estado'), ('active', 'replaced', 'expired', 'cancelled')),
                                 'caduca': p.get('caduca') if isinstance(p.get('caduca'), str) and DAY.fullmatch(p.get('caduca')) else None}
                                for p in (data.get('plataformas') if isinstance(data.get('plataformas'), list) else [])[:30] if isinstance(p, dict)]}
    if kind == 'caducidades':
        return {'dias': _num(data.get('dias'), 365), 'cuentas_que_caducan': _num(data.get('cuentas_que_caducan')),
                'cuentas_caducadas_ultimos_7_dias_sin_renovar': _num(data.get('cuentas_caducadas_ultimos_7_dias_sin_renovar'))}
    if kind == 'cuentas':
        per = data.get('accesos_por_plataforma') if isinstance(data.get('accesos_por_plataforma'), dict) else {}
        return {'clientes_con_servicio_de_pago': _num(data.get('clientes_con_servicio_de_pago')), 'cuentas_de_pago_activas': _num(data.get('cuentas_de_pago_activas')),
                'pruebas_activas': _num(data.get('pruebas_activas')),
                'accesos_por_plataforma': {k: _num(v) for k, v in list(per.items())[:20] if isinstance(k, str) and PLATFORM.fullmatch(k)}}
    if kind == 'usuario':
        if data.get('encontrado') is not True:
            return {'encontrado': False, 'motivo': data.get('motivo') if data.get('motivo') in ('no_existe', 'referencia_no_valida') else None}
        users = data.get('usuarios') if isinstance(data.get('usuarios'), list) else []
        return {'encontrado': True, 'ref': data.get('ref') if isinstance(data.get('ref'), str) and portal.ORDER_REF.fullmatch(data.get('ref')) else None,
                'usuarios': [u for u in users[:5] if isinstance(u, str) and USERNAME.fullmatch(u)]}
    if kind in ('cliente', 'conversacion', 'incidencias', 'quienes'):
        return _bounded(data)
    return _bounded(data) if custom else None


def _bounded(value, depth=0):
    """Datos de cliente para el jefe: pasan tal cual, pero acotados en tamaño y forma (texto, números, listas y fichas)."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:600]
    if depth >= 7:   # respuesta → clientes → ficha → cuentas → cuenta → contratado
        return None
    if isinstance(value, list):
        return [_bounded(v, depth + 1) for v in value[:30]]
    if isinstance(value, dict):
        return {str(k)[:40]: _bounded(v, depth + 1) for k, v in list(value.items())[:30]}
    return None


def query_url(feed_url):
    """La dirección de consultas está junto a la del resumen, en el mismo portal."""
    return feed_url.rsplit('/', 1)[0] + '/consulta-freddy'


def ask_portal(feed, kind, params, custom=False):
    if feed.get('kind') == 'database':
        from app import eliot_company_db
        datos = eliot_company_db.query(feed, kind, params)
        return clean_query(kind, datos, custom) if datos is not None else None
    try:
        with httpx.Client(timeout=httpx.Timeout(10.0, connect=4.0), follow_redirects=False) as client:
            r = client.get(query_url(feed['url']), params={'tipo': kind, **params}, headers={'Authorization': 'Bearer ' + feed['secret'], 'Accept': 'application/json'})
        if r.status_code != 200 or len(r.content) > portal.MAX_BYTES:
            return None
        body = r.json()
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(body, dict) or body.get('ok') is not True or body.get('tipo') != kind:
        return None
    return clean_query(kind, body.get('datos'), custom)


def act_on_portal(feed, payload):
    """Pide al portal la vista previa o la ejecución de una acción. Devuelve su respuesta acotada, o None si no contestó."""
    if feed.get('kind') == 'database':
        from app import eliot_company_db
        body = eliot_company_db.act(feed, payload)
        if not isinstance(body, dict) or not isinstance(body.get('resumen'), str):
            return None
        return {'ok': body.get('ok') is True, 'hecho': body.get('hecho') is True, 'resumen': body['resumen'][:900]}
    try:
        with httpx.Client(timeout=httpx.Timeout(25.0, connect=4.0), follow_redirects=False) as client:
            r = client.post(feed['url'].rsplit('/', 1)[0] + '/accion-freddy', json=payload, headers={'Authorization': 'Bearer ' + feed['secret']})
        if r.status_code not in (200, 403) or len(r.content) > portal.MAX_BYTES:
            return None
        body = r.json()
    except (httpx.HTTPError, ValueError):
        return None
    if not isinstance(body, dict) or not isinstance(body.get('resumen'), str):
        return None
    out = {'ok': body.get('ok') is True, 'hecho': body.get('hecho') is True, 'resumen': body['resumen'][:900]}
    if isinstance(body.get('client_id'), str) and re.fullmatch(r'[0-9a-fA-F-]{36}', body['client_id']):
        out['client_id'] = body['client_id']
    return out


def people(org, refs):
    """De quién es cada pedido, en una línea: «usuario» · nombre · teléfono. Para los avisos del chat privado del jefe."""
    feed = next((f for o, _name, f in notifier_mod.companies() if o == org), None)
    refs = [r for r in refs if isinstance(r, str) and portal.ORDER_REF.fullmatch(r)][:12]
    if feed is None or not refs:
        return {}
    data = ask_portal(feed, 'quienes', {'refs': ','.join(refs)})
    found = data.get('personas') if isinstance(data, dict) and isinstance(data.get('personas'), dict) else {}
    out = {}
    for ref in refs:
        p = found.get(ref)
        if isinstance(p, dict):
            parts = [f"«{p['usuario']}»" if p.get('usuario') else None, p.get('nombre') or None, p.get('telefono') or None]
            text = ' · '.join(str(x) for x in parts if x)
            if text:
                out[ref] = text
    return out


def report_spend(feed, usd):
    """Apunta el gasto en el contador que Freddy comparte con el agente de atención. Devuelve True si el tope queda agotado."""
    if feed.get('kind') == 'database' or not feed.get('url'):
        return False
    try:
        with httpx.Client(timeout=httpx.Timeout(8.0, connect=4.0), follow_redirects=False) as client:
            r = client.post(query_url(feed['url']), params={'tipo': 'gasto'}, json={'usd': round(min(max(usd, 0.0), 2.0), 6)},
                            headers={'Authorization': 'Bearer ' + feed['secret']})
        return r.status_code == 200 and r.json().get('agotado') is True
    except (httpx.HTTPError, ValueError):
        return False


# ---------- Herramientas ----------
def _known(notifier):
    with notifier.lock:
        return sorted(notifier.last.items(), key=lambda kv: kv[1]['company'])


def _find(notifier, name):
    wanted = notifier_mod._plain(name)
    items = _known(notifier)
    for org, e in items:
        if notifier_mod._plain(e['company']) == wanted:
            return org, e
    hits = [(org, e) for org, e in items if wanted and wanted in notifier_mod._plain(e['company'])]
    return hits[0] if len(hits) == 1 else (None, None)


def run_tool(notifier, name, args, now, feeds, client_allowed=True):
    args = args if isinstance(args, dict) else {}
    if name in CLIENT_TOOLS:
        if not client_allowed:
            return {'error': 'Hoy ya se ha alcanzado el máximo de consultas con datos de cliente.'}
        org, e = _find(notifier, args.get('empresa'))
        if e is None or org not in feeds:
            return {'error': 'No conozco esa empresa o no tiene portal conectado. Usa «empresas» para ver los nombres.'}
        kind, params = CLIENT_TOOLS[name], {}
        if name == 'usuario_de_pedido':
            if not (isinstance(args.get('ref'), str) and portal.ORDER_REF.fullmatch(args['ref'])):
                return {'error': 'Necesito la referencia exacta del pedido, por ejemplo ab-ORD-1373.'}
            params['ref'] = args['ref']
        elif name == 'incidencias':
            params['horas'] = args.get('horas') if args.get('horas') in (6, 24, 72, 168) else 24
        else:
            term = args.get('buscar')
            if not isinstance(term, str) or len(term.strip()) < 3:
                return {'error': 'Necesito algo por lo que buscar: referencia de pedido, usuario, teléfono, correo o nombre.'}
            params['q'] = term.strip()[:60]
        data = ask_portal(feeds[org], kind, params)
        return {'empresa': e['company'], 'datos': data} if data is not None else {'error': 'El portal de esa empresa no ha contestado a la consulta.'}
    items = _known(notifier)
    if name == 'empresas':
        return {'empresas': [{'empresa': e['company'], 'datos_leidos_hace_segundos': int(now - e['at']),
                              **({'consultas_propias': e['summary']['queries']} if e['summary'].get('queries') else {}),
                              **({'acciones_propias': e['summary']['actions']} if e['summary'].get('actions') else {}),
                              'agentes': [{k: a[k] for k in ('name', 'state', 'last_24h', 'month', 'alerts', 'last_activity') if k in a} for a in e['summary'].get('agents', [])]}
                             for _org, e in items],
                'nota': 'Solo aparecen las empresas con agentes conectados a Freddy.'}
    if name == 'avisos':
        chosen = items
        if args.get('empresa'):
            org, e = _find(notifier, args['empresa'])
            if e is None:
                return {'error': 'No conozco esa empresa. Usa «empresas» para ver los nombres.'}
            chosen = [(org, e)]
        out = []
        for _org, e in chosen:
            for n in sorted(notifier_mod.notices_of(e).values(), key=lambda n: notifier_mod.RANK[n['level']]):
                title, proposal = notifier_mod.copy_for(n['code'], n['count'], n)
                out.append({'empresa': e['company'], 'gravedad': n['level'], 'agente': n['agent'], 'aviso': title, 'casos': n['count'], 'clientes': n.get('people'), 'pedidos': n['refs'], 'propuesta': proposal})
        return {'avisos': out}
    if name == 'consultar':
        kind = args.get('tipo')
        org, e = _find(notifier, args.get('empresa'))
        if e is None or org not in feeds:
            return {'error': 'No conozco esa empresa o no tiene portal conectado. Usa «empresas» para ver los nombres.'}
        own = e['summary'].get('queries') or []
        if kind in own and kind not in QUERY_TYPES:
            # Consulta propia de esa empresa (la define su conector): se le pasan los parámetros tal cual, acotados.
            extra = args.get('parametros') if isinstance(args.get('parametros'), dict) else {}
            params = {str(k)[:30]: str(v)[:60] for k, v in list(extra.items())[:8] if isinstance(v, (str, int, float)) and re.fullmatch(r'[a-z_]{1,30}', str(k))}
            data = ask_portal(feeds[org], kind, params, custom=True)
            return {'empresa': e['company'], 'tipo': kind, 'datos': data} if data is not None else {'error': 'Esa empresa no ha contestado a la consulta.'}
        if kind not in QUERY_TYPES or (own and kind not in own):
            return {'error': 'Esa consulta no existe en esa empresa.' + (' Tiene: ' + ', '.join(own) + '.' if own else '')}
        params = {}
        if kind == 'ventas':
            params['periodo'] = args.get('periodo') if args.get('periodo') in ('hoy', 'ayer', '7d', '30d', 'mes') else 'hoy'
        elif kind == 'pedido':
            ref = args.get('ref')
            if not (isinstance(ref, str) and portal.ORDER_REF.fullmatch(ref)):
                return {'error': 'Necesito la referencia exacta del pedido, por ejemplo ab-ORD-1373.'}
            params['ref'] = ref
        elif kind == 'caducidades':
            params['dias'] = args.get('dias') if args.get('dias') in (1, 3, 7, 15, 30) else 7
        data = ask_portal(feeds[org], kind, params)
        return {'empresa': e['company'], 'tipo': kind, 'datos': data} if data is not None else {'error': 'El portal de esa empresa no ha contestado a la consulta.'}
    return {'error': 'Herramienta desconocida.'}


# ---------- Conversación ----------
class Chat:
    def __init__(self, notifier, client=None, now=time.time, context=None, actions=False):
        self.actions = actions     # solo el chat privado de Telegram del jefe puede proponer acciones
        self.pending = None        # la acción propuesta que espera su «sí»: {'feed','payload','resumen','until','company'}
        self.context = context     # dónde está hablando (p. ej. la oficina de una empresa en la web); se añade a las instrucciones
        self.private = False       # la última respuesta usó datos de clientes
        self.cancelled = False     # el último mensaje canceló una acción pendiente
        self.busy = threading.Lock()
        self.notifier, self.now = notifier, now
        self.client = client or anthropic.Anthropic()
        self.history = []          # [(instante, role, texto)]
        self.day, self.count, self.exhausted_month, self.lookups = None, 0, None, 0

    def _budget(self):
        """(empresa que paga, gasto del mes, tope) según lo último que dijo su agente de atención."""
        with self.notifier.lock:
            visible = set(self.notifier.last)
        feeds = {org: feed for org, _name, feed in notifier_mod.companies() if org in visible}
        for org, e in _known(self.notifier):
            for a in e['summary'].get('agents', []):
                m = a.get('month') if isinstance(a.get('month'), dict) else None
                if m and m.get('cap_usd') is not None and org in feeds:
                    return feeds, org, m.get('spent_usd') or 0.0, m['cap_usd'], m.get('month')
        return feeds, None, 0.0, None, None

    def ask(self, text):
        with self.busy:   # una pregunta cada vez por conversación
            return self._ask(text)

    def confirm(self, text):
        """Si hay una acción esperando: con un «sí» claro se ejecuta; con cualquier otra cosa se cancela. Lo decide el código, no el modelo.

        Devuelve la respuesta para el jefe, o None si no había nada pendiente (o se canceló y el mensaje debe atenderse normal).
        """
        with self.busy:
            p, self.pending = self.pending, None
            if p is None:
                return None
            now = self.now()
            said = re.sub(r'[^a-z ]', '', notifier_mod._plain(text)).strip()
            if now > p['until']:
                return 'Jefe, esa acción ha caducado (pasaron más de dos minutos). No he hecho nada; pídemela otra vez si la quieres.' if said in YES else None
            if said not in YES:
                self.cancelled = True
                return None
            result = act_on_portal(p['feed'], {**p['payload'], 'modo': 'ejecutar'})
            if result is None:
                reply = 'Jefe, el portal no me ha contestado. No doy la acción por hecha: compruébalo en el panel antes de repetirla.'
            elif result['ok'] and result['hecho']:
                reply = '✅ ' + result['resumen']
            else:
                reply = '⚠️ No se ha hecho. ' + result['resumen']
            self.history += [(now, 'user', text), (now, 'assistant', reply)]
            return reply

    def _propose(self, args, feeds, now):
        org, e = _find(self.notifier, args.get('empresa'))
        if e is None or org not in feeds:
            return {'error': 'No conozco esa empresa o no tiene portal conectado. Usa «empresas» para ver los nombres.'}
        own = e['summary'].get('actions') or []
        allowed = own if own else ACTIONS
        if args.get('accion') not in allowed:
            return {'error': 'Esa acción no existe en esa empresa. Tiene: ' + ', '.join(allowed) + '.'}
        extra = args.get('datos') if isinstance(args.get('datos'), dict) else {}
        payload = {**{str(k)[:30]: str(v)[:600] for k, v in list(extra.items())[:8] if re.fullmatch(r'[a-z_]{1,30}', str(k)) and str(k) not in ('modo', 'accion', 'client_id')},
                   'accion': args['accion'], **{k: args[k] for k in ACTION_FIELDS if k in args and isinstance(args[k], (str, bool))}}
        preview = act_on_portal(feeds[org], {**payload, 'modo': 'previa'})
        if preview is None:
            return {'error': 'El portal de esa empresa no ha contestado. No hay nada pendiente.'}
        if not preview['ok']:
            return {'no_se_puede': preview['resumen']}
        if 'client_id' in preview:   # el segundo paso va al mismo cliente que se enseñó, no a una búsqueda nueva
            payload = {k: v for k, v in payload.items() if k != 'buscar'} | {'client_id': preview['client_id']}
        self.pending = {'feed': feeds[org], 'payload': payload, 'resumen': preview['resumen'], 'until': now + CONFIRM_SECONDS, 'company': e['company']}
        return {'pendiente_de_confirmar': True, 'empresa': e['company'], 'resumen': preview['resumen'],
                'instruccion': 'Copia este resumen al jefe tal cual y pregúntale: «¿Lo hago? Responde sí.». No está hecho todavía.'}

    def _ask(self, text):
        self.private = False
        now = self.now()
        feeds, payer, spent, cap, month = self._budget()
        if cap is not None and (spent >= cap or self.exhausted_month == month):
            return f'Jefe, he llegado al tope de gasto de inteligencia artificial de este mes ({cap:g} $). Sigo atendiendo las órdenes fijas: avisos, estado, empresas y pedido.'
        day = time.strftime('%Y-%m-%d', time.gmtime(now))
        if day != self.day:
            self.day, self.count, self.lookups = day, 0, 0
        if self.count >= MAX_PER_DAY:
            return 'Jefe, hoy ya he atendido el máximo de preguntas con inteligencia artificial. Mañana vuelvo; mientras, puedes usar: avisos, estado, empresas y pedido.'
        self.count += 1
        self.history = [h for h in self.history if now - h[0] < HISTORY_TTL][-HISTORY:]
        messages = [{'role': role, 'content': content} for _t, role, content in self.history] + [{'role': 'user', 'content': text}]
        usd, reply, proposed = 0.0, None, False
        self.pending = None   # una pregunta nueva deja sin efecto cualquier acción que estuviera esperando
        try:
            for _ in range(MAX_TURNS):
                response = self.client.beta.messages.create(
                    model=MODEL, max_tokens=4000, system=SYSTEM + ('\n\n' + ACTIONS_PROMPT if self.actions else '') + ('\n\n' + self.context if self.context else ''),
                    tools=TOOLS + ([ACTION_TOOL] if self.actions else []), messages=messages,
                    output_config={'effort': 'low'},
                    betas=['server-side-fallback-2026-07-01'], fallbacks='default')
                usage = response.usage
                tokens_in = (getattr(usage, 'input_tokens', 0) or 0) + (getattr(usage, 'cache_creation_input_tokens', 0) or 0) + (getattr(usage, 'cache_read_input_tokens', 0) or 0)
                usd += (tokens_in * PRICE_IN + (getattr(usage, 'output_tokens', 0) or 0) * PRICE_OUT) / 1e6
                if response.stop_reason == 'refusal':
                    reply = 'No puedo ayudarte con eso.'
                    break
                if response.stop_reason == 'pause_turn':
                    messages.append({'role': 'assistant', 'content': response.content})
                    continue
                calls = [b for b in response.content if b.type == 'tool_use']
                if response.stop_reason != 'tool_use' or not calls:
                    reply = '\n'.join(b.text for b in response.content if b.type == 'text').strip() or None
                    break
                messages.append({'role': 'assistant', 'content': response.content})
                results = []
                for call in calls:
                    allowed = True
                    if call.name in CLIENT_TOOLS:
                        allowed, self.lookups = self.lookups < MAX_CLIENT_LOOKUPS, self.lookups + 1
                        self.private = self.private or allowed
                    if call.name == 'proponer_accion':
                        if not self.actions:
                            out = {'error': 'Desde aquí no se pueden hacer acciones.'}
                        elif proposed:
                            out = {'error': 'Solo una acción cada vez. Ya hay una pendiente de confirmar en esta respuesta.'}
                        else:
                            out = self._propose(call.input if isinstance(call.input, dict) else {}, feeds, now)
                            proposed = 'pendiente_de_confirmar' in out
                    else:
                        out = run_tool(self.notifier, call.name, call.input, now, feeds, allowed)
                    results.append({'type': 'tool_result', 'tool_use_id': call.id, 'content': json.dumps(out, ensure_ascii=False)})
                messages.append({'role': 'user', 'content': results})
        except anthropic.RateLimitError:
            reply = 'Ahora mismo hay demasiadas consultas. Vuelve a preguntarme en un minuto.'
        except anthropic.APIStatusError:
            reply = 'No he podido pensar la respuesta ahora mismo. Prueba otra vez en un momento, o usa: avisos, estado, empresas.'
        except anthropic.APIConnectionError:
            reply = 'No he podido conectar con mi inteligencia artificial. Prueba otra vez en un momento.'
        if usd > 0 and payer:
            if report_spend(feeds[payer], usd):
                self.exhausted_month = month
        if reply is None:
            reply = 'No he conseguido cerrar la respuesta. Hazme la pregunta de forma más concreta.'
        self.history += [(now, 'user', text), (now, 'assistant', reply)]
        return reply[:3900]


# ---------- La misma conversación desde la web de La Factoría («Director virtual») ----------
class Scoped:
    """Vista del notificador limitada a unas empresas: desde la web solo se ven las que el usuario posee."""
    def __init__(self, notifier, orgs):
        self._n, self._orgs, self.lock = notifier, set(orgs), notifier.lock

    @property
    def last(self):
        return {k: v for k, v in self._n.last.items() if k in self._orgs}


_web, _web_lock = {}, threading.Lock()
WEB_SESSIONS = 40


def web_answer(subject, organization_id, owner_orgs, question, snapshot=None):
    """Respuesta de Freddy para el propietario en la web, o None si aquí no hay nada que consultar.

    Solo para empresas que el usuario posee y que tienen portal conectado. Devuelve (texto, usó_datos_de_clientes).
    """
    notifier = notifier_mod._notifier
    org = str(organization_id)
    owned = {str(o) for o in owner_orgs}
    if notifier is None or not enabled() or org not in owned:
        return None
    notifier.refresh()
    with notifier.lock:
        entry = notifier.last.get(org)
    if entry is None:
        return None
    context = (f"Ahora hablas con el jefe en la web de La Factoría, dentro de la oficina de «{entry['company']}». Si no nombra otra empresa, pregunta por esta. "
               'Aquí sí puedes usar listas cortas con guiones, pero no tablas.')
    if snapshot:
        context += '\n\nLo que La Factoría sabe de esta empresa por dentro (departamentos, agentes y tareas):\n' + str(snapshot)[:1500]
    key = (subject, org)
    with _web_lock:
        chat = _web.get(key)
        if chat is None:
            if len(_web) >= WEB_SESSIONS:
                _web.pop(next(iter(_web)))
            chat = _web[key] = Chat(Scoped(notifier, owned))
        chat.context = context
    return chat.ask(question[:1000]), chat.private

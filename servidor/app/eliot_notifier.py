"""Freddy avisa al propietario por Telegram de lo que dicen los agentes de cada empresa.

Un hilo dentro del servidor pregunta cada minuto al portal de cada empresa configurada (el mismo
resumen que ya lee la oficina) y escribe al propietario:
  * cada aviso urgente o importante NUEVO (o que sube de gravedad, o suma pedidos);
  * cuando un aviso deja de existir («resuelto»);
  * un recordatorio de lo urgente que siga abierto cada 6 horas;
  * si un portal lleva 15 minutos sin contestar, una vez.

Qué viaja: gravedad, agente, un texto compuesto AQUÍ a partir de la clave del aviso y las referencias
de pedido. Nunca el texto del portal ni datos de clientes.

No se guarda nada en la base de datos: el estado vive en memoria. Tras un reinicio, si hay avisos
abiertos se envía UN resumen con todos (mejor repetir que callar).

Variables del servidor: ELIOT_TELEGRAM_BOT_TOKEN y ELIOT_TELEGRAM_CHAT_ID. Sin las dos, no hace nada.
La clave del bot nunca se imprime ni aparece en errores.
"""
import json
import os
import re
import threading
import time
import unicodedata
from uuid import UUID

import httpx

from app import eliot_portal_agents_api as portal

TOKEN = re.compile(r'^\d{6,12}:[A-Za-z0-9_-]{30,60}$')
CHAT = re.compile(r'^-?\d{5,15}$')
COMPANY = re.compile(r'^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .·-]{2,60}$')
INTERVAL = 30 * 60   # comprobación de seguridad; lo normal es que cada empresa avise ella misma cuando algo cambia
REMIND_URGENT = 6 * 3600
PORTAL_SILENT = 15 * 60
STRANGERS_PER_HOUR = 20   # avisos al jefe por desconocidos que escriben a un bot; por encima no se envían más
STRANGER_REPLY_EVERY = 600   # a un mismo desconocido se le contesta como mucho una vez cada 10 minutos
STRANGER_NOTICE = ('🔒 Este es un asistente privado. Por motivos de seguridad no puedo atender tu mensaje ni facilitar ninguna información, '
                   'porque esta cuenta de Telegram no está autorizada.\n\nSi eres cliente y necesitas ayuda, escríbenos por el chat de tu portal de cliente.')
EVENTS_PER_HOUR = 40   # avisos de «un cliente te necesita» por hora; por encima no se envían más
SENT_LEVELS = ('urgente', 'importante', 'info')   # el jefe quiere saber cualquier anomalía, por pequeña que sea
RANK = {'urgente': 0, 'importante': 1, 'info': 2}
ICON = {'urgente': '🚨 URGENTE', 'importante': '⚠️ Importante', 'info': 'ℹ️ Aviso menor'}
MARK = {'urgente': '🚨', 'importante': '⚠️', 'info': 'ℹ️'}


def _pl(n, one, many):
    return one if n == 1 else f'{n if n is not None else "Varios"} {many}'


COPY = {
    'parciales': lambda n: (_pl(n, 'Un pedido cobrado se quedó a medias', 'pedidos cobrados se quedaron a medias'),
                            'Al cliente le falta alguna plataforma que ha pagado. Rescátalo desde Reparaciones.'),
    'rescate_fallido': lambda n: (_pl(n, 'Un segundo intento de entrega ha fallado', 'segundos intentos de entrega han fallado'),
                                  'Al cliente le falta una plataforma que ha pagado. Hay que ponérsela a mano desde su ficha.'),
    'paquete_incompleto': lambda n: (_pl(n, 'Un pedido cobrado se cerró a mano y al cliente le sigue faltando una plataforma en la web',
                                         'pedidos cobrados se cerraron a mano y a sus clientes les sigue faltando una plataforma en la web'),
                                     'Si ya la pusiste en el panel, márcalo como resuelto en Reparaciones para registrarla; si no, ponla.'),
    'dias_de_mas': lambda n: (_pl(n, 'El panel aplicó más días de los pagados en un pedido', 'pedidos en los que el panel aplicó más días de los pagados'),
                              'La web ya guarda la fecha correcta. Corrige la caducidad también en el panel.'),
    'sin_claves': lambda n: (_pl(n, 'Una compra pagada lleva más de 10 minutos sin entregar las claves', 'compras pagadas llevan más de 10 minutos sin entregar las claves'),
                             'El cliente ha pagado y está esperando. Mira el pedido en Reparaciones y avísale.'),
    'agente_frenado': lambda n: ('El asistente del chat ha llegado a su tope de gasto y ha dejado de contestar', 'Sube el tope o atiende el chat a mano.'),
    'pedidos_atascados': lambda n: (_pl(n, 'Un pedido cobrado sigue sin completar', 'pedidos cobrados siguen sin completar'),
                                    'Revisa el panel de la tienda y avisa al cliente si hace falta.'),
    'pagos_fallidos': lambda n: (_pl(n, 'Un cobro ha fallado', 'cobros han fallado'),
                                 'Comprueba la pasarela y el estado del pedido.'),
    'fallos_abiertos': lambda n: (_pl(n, 'Hay un fallo abierto en la tienda', 'hay fallos abiertos en la tienda'),
                                  'Prioriza los que afectan a pedidos o al checkout.'),
    'chats_pendientes': lambda n: (_pl(n, 'Hay un chat o mensaje pendiente', 'hay chats o mensajes pendientes'),
                                   'Responde o cierra lo pendiente en atención al cliente.'),
    'consulta_fallida': lambda n: ('No pude consultar la tienda',
                                   'Revisa Hosting y bases: acceso MySQL remoto o prefijo de tablas.'),
    'telegram_aviso': lambda n: (_pl(n, 'Un aviso de caducidad no se ha podido entregar por Telegram', 'avisos de caducidad no se han podido entregar por Telegram'),
                                 'Avisa a esos clientes por otro medio.'),
    'duplicados': lambda n: (_pl(n, 'Un posible cobro duplicado', 'posibles cobros duplicados'),
                             'Compruébalo en Stripe y devuelve uno si se cobró dos veces.'),
    'sin_aviso': lambda n: (_pl(n, 'Una cuenta caduca en 3 días o menos sin aviso de renovación', 'cuentas caducan en 3 días o menos sin aviso de renovación'),
                            'Revisa el envío de avisos y avisa a mano desde el panel.'),
    'cron_avisos': lambda n: ('Los avisos de caducidad llevan más de 36 horas sin enviarse', 'Comprueba que el envío programado sigue activo.'),
    'decision': lambda n: (_pl(n, 'Una renovación espera tu decisión', 'renovaciones esperan tu decisión'),
                           'El usuario no existe en el panel. Decide en Reparaciones si se crea una cuenta nueva.'),
    'caducidad_larga': lambda n: (_pl(n, 'Una cuenta nueva caduca a más de 400 días', 'cuentas nuevas caducan a más de 400 días'),
                                  'Comprueba si se sumaron días de más.'),
    'repetidos': lambda n: (_pl(n, 'Un pago o aviso de pago repetido en 24 horas', 'pagos o avisos de pago repetidos en 24 horas'),
                            'Comprueba que no se sumaron días dos veces.'),
    'pruebas_vivas': lambda n: (_pl(n, 'Una prueba de 24 horas sigue activa pasadas 48 horas', 'pruebas de 24 horas siguen activas pasadas 48 horas'),
                                'Revisa por qué no caducó.'),
    'duplicadas': lambda n: (_pl(n, 'Una cuenta nueva comparte usuario y plataforma con otro cliente', 'cuentas nuevas comparten usuario y plataforma con otro cliente'),
                             'Revísalo antes de que dos clientes tengan la misma cuenta.'),
    'premio_sin_derecho': lambda n: (_pl(n, 'Un premio de referidos pendiente sin los 5 amigos pagados', 'premios de referidos pendientes sin los 5 amigos pagados'),
                                     'Revísalo antes de que lo canjeen.'),
    'cupones': lambda n: (_pl(n, 'Un cupón usado más veces de lo permitido', 'cupones usados más veces de lo permitido'), 'Desactívalo y revisa las compras.'),
    'chat': lambda n: (_pl(n, 'Una conversación de chat espera respuesta desde hace más de 2 horas', 'conversaciones de chat esperan respuesta desde hace más de 2 horas'), None),
    'whatsapp': lambda n: (_pl(n, 'Un aviso de WhatsApp lleva más de 24 horas sin enviarse', 'avisos de WhatsApp llevan más de 24 horas sin enviarse'), 'Revisa el envío de WhatsApp.'),
    'claves_en_claro': lambda n: (_pl(n, 'Una cuenta nueva se guardó con la contraseña sin cifrar', 'cuentas nuevas se guardaron con la contraseña sin cifrar'),
                                  'Revisa la ruta que las crea y cifra las que falten.'),
    'login': lambda n: ('Pico de intentos de acceso sobre una misma clave', 'Revisa si alguien está probando contraseñas.'),
}


def copy_for(code, count, notice=None):
    if code in COPY:
        return COPY[code](count)
    if notice and notice.get('title'):   # aviso propio de una empresa: trae su texto (ya filtrado)
        return (notice['title'], notice.get('proposal'))
    return ('Aviso de un agente', 'Ábrelo en el panel de la empresa.')


def settings():
    """(clave del bot, chat) o None si falta algo o tiene mala forma."""
    token, chat = os.getenv('ELIOT_TELEGRAM_BOT_TOKEN') or '', os.getenv('ELIOT_TELEGRAM_CHAT_ID') or ''
    return (token, chat) if TOKEN.fullmatch(token) and CHAT.fullmatch(chat) else None


def companies():
    """Empresas con portal o conector de tienda: [(uuid, nombre para mostrar, feed)]."""
    try:
        feeds = json.loads(os.getenv('ELIOT_PORTAL_FEEDS') or '{}')
    except ValueError:
        feeds = {}
    out = []
    seen = set()
    for key, entry in (feeds.items() if isinstance(feeds, dict) else []):
        try:
            org = UUID(str(key))
        except ValueError:
            continue
        feed = portal.feed_for(org)
        if feed is None:
            continue
        name = entry.get('name') if isinstance(entry, dict) else None
        out.append((str(org), name if isinstance(name, str) and COMPANY.fullmatch(name) else 'Empresa', feed))
        seen.add(str(org))
    try:
        from app.eliot_store_feed import list_store_organizations
        for org, name, feed in list_store_organizations():
            if org in seen:
                continue
            label = name if isinstance(name, str) and COMPANY.fullmatch(name) else 'Empresa'
            out.append((org, label, feed))
            seen.add(org)
    except Exception:
        pass
    return out


def open_notices(summary):
    """{clave: aviso} con todo lo que los agentes tienen abierto en un resumen ya limpio."""
    out = {}
    for agent in summary.get('agents', []):
        for n in agent.get('notices', []):
            if n['level'] in SENT_LEVELS:
                out[agent['id'] + ':' + n['code']] = {**n, 'agent': agent['name']}
    return out


def notices_of(entry):
    """Los avisos abiertos de una empresa, ya con el cliente de cada caso si se pudo saber."""
    return entry['notices'] if isinstance(entry.get('notices'), dict) else open_notices(entry['summary'])


def line(n):
    title, _ = copy_for(n['code'], n['count'], n)
    refs = ''
    if n['refs']:
        more = n['count'] - len(n['refs']) if isinstance(n['count'], int) and n['count'] > len(n['refs']) else 0
        if n.get('people'):   # al jefe se le habla de cada caso por su cliente, no por el número de pedido
            refs = '\n' + '\n'.join('• ' + p for p in n['people']) + (f'\n• y {more} más' if more else '')
        else:
            refs = '\nPedidos: ' + ', '.join(n['refs']) + (f' y {more} más' if more else '')
    return f"{n['agent']}: {title}{refs}"


def tag(company):
    """La empresa, resaltada y en su propia línea: con varias empresas, lo primero es saber de cuál se habla."""
    return '🏢 ' + str(company).upper()


def message(kind, company, n, panel):
    title, proposal = copy_for(n['code'], n['count'], n)
    head = {'new': ICON[n['level']], 'remind': '⏰ Sigue abierto · ' + ICON[n['level']], 'solved': '✅ Resuelto'}[kind]
    text = f'{head}\n{tag(company)}\n{line(n)}'
    if kind != 'solved':
        if proposal:
            text += '\n' + proposal
        if panel:
            text += '\nPanel: ' + panel
    return text


class Notifier:
    def __init__(self, send, now=time.time, say=None):
        self.send, self.now = send, now
        self.who = None      # (org, [pedidos]) -> {pedido: 'usuario · nombre · teléfono'}; None si Freddy no puede preguntar por clientes
        self.people = {}     # (org, pedido) -> ese texto, para no preguntar dos veces por el mismo
        self.say = say       # (texto, día) -> bool: dice un aviso urgente en voz alta; None si Freddy no tiene voz
        self.state = {}      # org -> {clave: {'n': aviso, 'sent': instante}}
        self.names = {}      # org -> nombre para mostrar
        self.last = {}       # org -> {'company','summary','panel','at'}: lo último que contestó cada empresa (para responder órdenes)
        self.lock = threading.Lock()
        self.failing = {}    # org -> {'since': instante, 'told': bool}
        self.round = threading.Lock()   # una sola lectura a la vez (la ronda, un aviso entrante o una pregunta del jefe)
        self.asked = float('-inf')

    def tick(self):
        """Pregunta a cada empresa. Se usa al arrancar, como comprobación de seguridad cada media hora y cuando el jefe pregunta."""
        for org, company, feed in companies():
            summary, _reason = portal.fetch(feed)
            self.ingest(org, company, feed['panel_url'], summary)
        self.asked = self.now()

    def receive(self, org, summary):
        """Una empresa avisa por su cuenta de que algo ha cambiado (resumen ya limpio)."""
        for known, company, feed in companies():
            if known == org:
                self.ingest(org, company, feed['panel_url'], summary)
                return True
        return False

    def ingest(self, org, company, panel, summary):
        with self.round:
            self._ingest(org, company, panel, summary)

    def _ingest(self, org, company, panel, summary):
        now = self.now()
        # Nombre para mostrar: el de la configuración; si no hay, el que el propio portal dice de sí mismo (se recuerda).
        if company == 'Empresa':
            if summary and summary.get('company'):
                self.names[org] = summary['company'].replace('-', ' ').title()
            company = self.names.get(org, company)
        if summary is None:
            # Un portal que no contesta NO significa que sus avisos estén resueltos: se conserva lo último que se supo.
            f = self.failing.setdefault(org, {'since': now, 'told': False})
            if not f['told'] and now - f['since'] >= PORTAL_SILENT:
                f['told'] = self.send(f'⚠️ {tag(company)}\nJefe, no consigo hablar con los agentes de esta empresa. Sus avisos pueden no estar al día.')
            return
        if self.failing.pop(org, {}).get('told'):
            self.send(f'✅ {tag(company)}\nJefe, vuelvo a hablar con los agentes de esta empresa.')
        current = open_notices(summary)
        self._name(org, current)
        with self.lock:
            self.last[org] = {'company': company, 'summary': summary, 'panel': panel, 'at': now, 'notices': current}
        if org not in self.state:
            # Primera lectura tras arrancar: un solo mensaje con lo que haya abierto.
            if current:
                ordered = sorted(current.values(), key=lambda n: RANK[n['level']])
                body = '\n\n'.join(MARK[n['level']] + ' ' + line(n) for n in ordered)
                self.send(f'📋 Avisos abiertos\n{tag(company)}\n\n{body}' + (f'\n\nPanel: {panel}' if panel else ''))
            self.state[org] = {k: {'n': n, 'sent': now} for k, n in current.items()}
            return
        known, nxt = self.state[org], {}
        for key, n in current.items():
            prev = known.get(key)
            changed = prev is None or RANK[n['level']] < RANK[prev['n']['level']] or any(r not in prev['n']['refs'] for r in n['refs'])
            if changed:
                self.send(message('new', company, n, panel)); nxt[key] = {'n': n, 'sent': now}
                if n['level'] == 'urgente' and self.say:   # lo urgente, además, de viva voz
                    try:
                        self.say(spoken(company, n), time.strftime('%Y-%m-%d', time.gmtime(now)))
                    except Exception:
                        print('notifier: fallo al decir un aviso urgente', flush=True)
            elif n['level'] == 'urgente' and now - prev['sent'] >= REMIND_URGENT:
                self.send(message('remind', company, n, panel)); nxt[key] = {'n': n, 'sent': now}
            else:
                nxt[key] = {'n': n, 'sent': prev['sent']}
        for key, prev in known.items():
            if key not in current:
                self.send(message('solved', company, prev['n'], panel))
        self.state[org] = nxt

    def _name(self, org, notices):
        """Pone a cada aviso de quién es cada caso. Si no se puede saber, se queda la referencia del pedido."""
        if self.who is None:
            return
        missing = sorted({r for n in notices.values() for r in n['refs'] if (org, r) not in self.people})
        if missing:
            try:
                found = self.who(org, missing[:12]) or {}
            except Exception:
                found = {}
            for ref, text in found.items():
                if isinstance(text, str) and text:
                    self.people[(org, ref)] = text[:160]
            if len(self.people) > 2000:
                self.people.clear()
        for n in notices.values():
            if n['refs']:
                n['people'] = [self.people.get((org, r), r) for r in n['refs']]

    def stranger(self, bot, who, message, now=None):
        """Alguien que no es el jefe ni un cliente identificado ha escrito a uno de los bots. Se le cuenta al jefe: qué bot, quién y qué puso."""
        now = self.now() if now is None else now
        self.strangers = [t for t in getattr(self, 'strangers', []) if now - t < 3600]
        if len(self.strangers) >= STRANGERS_PER_HOUR:
            return False
        self.strangers.append(now)
        user = str(who.get('user') or '').lstrip('@')[:40]
        name = str(who.get('name') or '')[:80]
        ident = ' · '.join(x for x in ('@' + user if user else 'sin @', name or None, f"ID {str(who.get('id') or '')[:20]}" if who.get('id') else None) if x)
        text = f'🛡 Jefe, alguien sin identificar ha escrito a un bot\nBot: {str(bot)[:80]}\nQuién: {ident}'
        text += f"\n\nEscribió: «{str(message)[:600]}»" if message else '\n\n(No envió texto)'
        text += '\n\nNo se le ha dado ningún dato. Si crees que es un cliente que necesita ayuda, puedes escribirle tú.'
        # Acceso directo a su chat: con @ es un enlace normal; sin @ solo queda el enlace por ID, que Telegram no siempre deja abrir.
        ident_n = who.get('id') if type(who.get('id')) is int and who.get('id') > 0 else None
        if re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{3,31}', user):
            link = f'https://t.me/{user}'
            text += f'\n\nAbrir su chat: {link}'
        elif ident_n:
            link = f'tg://user?id={ident_n}'
            text += '\n\nNo tiene @: usa el botón de abajo para abrir su chat. Si no se abre, es que su privacidad de Telegram lo impide.'
        else:
            link = None
        if link:
            try:
                return self.send(text, button=('💬 Abrir su chat', link))
            except TypeError:   # un emisor que no sabe de botones
                pass
        return self.send(text)

    def event(self, org, ev, now=None):
        """Un cliente necesita al jefe ahora mismo (lo cuenta el chat de la empresa). Se le manda tal cual, con quién es y qué ha escrito."""
        now = self.now() if now is None else now
        self.events = [t for t in getattr(self, 'events', []) if now - t < 3600]
        if len(self.events) >= EVENTS_PER_HOUR:
            return False
        self.events.append(now)
        if ev['kind'] == 'acceso_ajeno':
            self.events.pop()   # tiene su propio tope
            company = next((name for known, name, _feed in companies() if known == org), None) or self.names.get(org) or 'Empresa'
            return self.stranger(f"{ev.get('bot') or 'Bot de avisos'} · {company}", ev.get('telegram') or {}, ev['message'], now)
        company, panel = self.names.get(org), None
        for known, name, feed in companies():
            if known == org:
                company, panel = (name if name != 'Empresa' else company) or name, feed['panel_url']
        with self.lock:
            company = (self.last.get(org) or {}).get('company') or company or 'Empresa'
        c = ev['client']
        who = ' · '.join(x for x in (f"«{c['user']}»" if c['user'] else None, c['name'], c['phone']) if x) or 'Cliente sin identificar'
        head = {'pide_admin': '🆘 Un cliente quiere hablar contigo', 'sin_respuesta': '🤷 El asistente no ha sabido responder', 'frenado': '✋ El asistente está frenado y no ha contestado'}[ev['kind']]
        text = f"{'🚨 ' if ev['grave'] else ''}{head}\n{tag(company)}\n{who}"
        if ev['message']:
            text += f"\n\nDice: «{ev['message']}»"
        if ev['reason']:
            text += f"\n\nMotivo: {ev['reason']}"
        if panel:
            text += f'\n\nPanel: {panel}'
        sent = self.send(text)
        if ev['grave'] and self.say:   # de viva voz solo lo grave, y sin datos del cliente
            try:
                self.say(f'Jefe, un cliente de {company} necesita hablar contigo y es grave. Tienes el detalle por escrito.', time.strftime('%Y-%m-%d', time.gmtime(now)))
            except Exception:
                pass
        return sent

    def refresh(self, max_age=20):
        """Cuando el jefe pregunta, Freddy consulta a las empresas en ese momento (salvo que acabe de hacerlo)."""
        if self.now() - self.asked >= max_age:
            try:
                self.tick()
            except Exception:
                print('notifier: no se pudo refrescar al preguntar', flush=True)


# ---------- Órdenes: el propietario escribe al bot y Freddy contesta con lo último que sabe de cada empresa ----------
STATE_ICON = {'activo': '🟢', 'ok': '🟢', 'aviso': '🟡', 'alerta': '🔴', 'frenado': '🟠', 'apagado': '⚪', 'error': '🔴'}
def spoken(company, n):
    """Lo que Freddy dice en voz alta ante algo urgente: empresa, qué pasa y qué propone. Sin referencias ni datos de clientes."""
    title, proposal = copy_for(n['code'], n['count'], n)
    return f"Jefe, aviso urgente en {company}. {n['agent']}: {title}." + (f' {proposal}' if proposal else '') + ' Tienes el detalle por escrito.'


STATE_TEXT = {'activo': 'activo', 'ok': 'sin incidencias', 'aviso': 'con avisos', 'alerta': 'alerta urgente', 'frenado': 'frenado por tope de gasto',
              'apagado': 'apagado', 'error': 'no pudo revisar'}
HELP = ('A tus órdenes, jefe. Puedes escribirme:\n'
        '• avisos — lo que tus agentes tienen pendiente de decirte\n'
        '• estado — cómo está cada agente de cada empresa\n'
        '• empresas — las empresas que vigilo\n'
        '• pedido ab-ORD-1234 — si ese pedido sale en algún aviso\n'
        '• ayuda — este mensaje\n'
        'También puedes preguntarme con tus palabras, por escrito o con una nota de voz: «¿cuánto se ha vendido hoy?».\n\n'
        'Este chat es solo tuyo: aquí te doy cualquier dato que necesites de tus empresas.')


def _plain(text):
    text = unicodedata.normalize('NFD', str(text or '').strip().lower())
    return ''.join(c for c in text if unicodedata.category(c) != 'Mn').lstrip('/').split('@')[0].strip()


def _age(seconds):
    return 'ahora mismo' if seconds < 90 else f'hace {int(seconds // 60)} min'


def answer(notifier, text, now=None):
    """Respuesta a una orden del propietario. Solo usa lo que ya está en memoria: no llama a nadie."""
    now = notifier.now() if now is None else now
    words = _plain(text).split()
    order = words[0] if words else ''
    with notifier.lock:
        known = sorted(notifier.last.values(), key=lambda e: e['company'])
    if order in ('ayuda', 'help', 'start', 'hola', ''):
        return HELP
    if not known:
        return 'Todavía no he podido hablar con los agentes de ninguna empresa. Vuelve a preguntarme en un minuto.'
    if order == 'empresas':
        return 'Empresas que vigilo:\n' + '\n'.join(f"• {e['company']} — {len(e['summary'].get('agents', []))} agentes (leído {_age(now - e['at'])})" for e in known)
    if order == 'estado':
        blocks = []
        for e in known:
            agents = e['summary'].get('agents', [])
            rows = []
            for a in agents:
                line = f"{STATE_ICON.get(a['state'], '⚪')} {a['name']}: {STATE_TEXT.get(a['state'], a['state'])}"
                if a.get('state') == 'error':
                    hint = next((n.get('proposal') or n.get('title') for n in (a.get('notices') or []) if n.get('proposal') or n.get('title')), None)
                    if hint:
                        line += f"\n   → {hint}"
                rows.append(line)
            body = '\n'.join(rows) if rows else '⚪ Sin agentes de vigilancia (la base no devolvió consultas útiles todavía).'
            blocks.append(f"{e['company']} (leído {_age(now - e['at'])})\n" + body)
        return '\n\n'.join(blocks)
    if order == 'avisos':
        blocks = []
        for e in known:
            items = sorted(notices_of(e).values(), key=lambda n: RANK[n['level']])
            if items:
                blocks.append(f"{e['company']}\n\n" + '\n\n'.join(MARK[n['level']] + ' ' + line(n) for n in items)
                              + (f"\n\nPanel: {e['panel']}" if e['panel'] else ''))
        return '\n\n———\n\n'.join(blocks) if blocks else '✅ Jefe, tus agentes no tienen nada pendiente que decirte.'
    if order == 'pedido':
        ref = next((w for w in str(text).split() if portal.ORDER_REF.fullmatch(w)), None)
        if ref is None:
            return 'Dime la referencia tal cual, por ejemplo: pedido ab-ORD-1373'
        hits = [(e['company'], n) for e in known for n in notices_of(e).values() if ref in n['refs']]
        if not hits:
            return (f'{ref} no sale en ningún aviso abierto. Eso significa que ningún agente ve un problema con él ahora mismo; '
                    'todavía no puedo darte su ficha completa.')
        return f'{ref} sale en:\n\n' + '\n\n'.join(f"{MARK[n['level']]} {company} · {line(n)}" for company, n in hits)
    return 'No he entendido esa orden. Escribe «ayuda» para ver lo que puedo hacer.'


FIXED = ('ayuda', 'help', 'start', 'hola', 'empresas', 'estado', 'avisos', 'pedido')


def respond(notifier, text, chat=None):
    """Las órdenes fijas se contestan al instante y sin coste; cualquier otra pregunta va a la conversación, si está disponible."""
    note = ''
    if chat is not None and getattr(chat, 'pending', None) is not None:
        # Hay una acción esperando su «sí»: lo resuelve el código (ejecutar, caducar o cancelar) antes de cualquier otra cosa.
        done = chat.confirm(text)
        if done is not None:
            return done
        note = 'He cancelado la acción que estaba pendiente: no he hecho nada.\n\n'
    return note + _respond(notifier, text, chat)


def _respond(notifier, text, chat):
    words = _plain(text).split()
    if words and words[0] not in ('ayuda', 'help', 'start', 'hola'):
        notifier.refresh()   # el jefe pregunta: Freddy consulta a las empresas en ese momento
    if chat is None or not words or (words[0] in FIXED and len(words) <= 2):
        return answer(notifier, text[:200])
    return chat.ask(text[:1000])


MAX_VOICE_SECONDS = 120


def listen(notifier, token, chat_id, stop=None, poll=None, chat=None, hear=None):
    """Escucha los mensajes del bot (espera larga) y contesta SOLO al propietario. Los mensajes anteriores al arranque se ignoran."""
    def call(method, **params):
        with httpx.Client(timeout=httpx.Timeout(40.0, connect=5.0), follow_redirects=False) as client:
            r = client.post(f'https://api.telegram.org/bot{token}/{method}', json=params)
        data = r.json() if r.status_code == 200 else {}
        return data.get('result') if isinstance(data, dict) and data.get('ok') is True else None
    poll = poll or call
    send = notifier.send
    offset = None
    strangers = {}   # desconocido → última vez que se le contestó
    try:   # descartar lo que hubiera en cola antes de arrancar
        old = poll('getUpdates', offset=-1, timeout=0)
        if isinstance(old, list) and old and isinstance(old[-1].get('update_id'), int):
            offset = old[-1]['update_id'] + 1
    except Exception:
        pass
    while not (stop and stop.is_set()):
        try:
            updates = poll('getUpdates', timeout=25, allowed_updates=['message'], **({'offset': offset} if offset is not None else {}))
        except Exception:
            updates = None
        if not isinstance(updates, list):
            if stop is None:
                time.sleep(5)
            else:
                stop.wait(0.01)
            continue
        for u in updates:
            if not isinstance(u, dict) or not isinstance(u.get('update_id'), int):
                continue
            offset = u['update_id'] + 1
            msg = u.get('message') if isinstance(u.get('message'), dict) else {}
            sender = msg.get('chat', {}).get('id') if isinstance(msg.get('chat'), dict) else None
            author = msg.get('from', {}).get('id') if isinstance(msg.get('from'), dict) else None
            text = msg.get('text')
            # Chat privado del jefe: tienen que coincidir el chat Y quien escribe. Un grupo o un reenvío de otro no valen.
            if str(sender) != str(chat_id) or str(author) != str(chat_id):
                # Un desconocido que abre su propio chat privado con el bot: se le dice que no se le puede atender (sin ningún dato)
                # y se avisa al jefe con lo que ha puesto. En el chat del jefe, lo que escriba otro sigue sin respuesta.
                if (msg.get('chat') or {}).get('type') == 'private' and isinstance(sender, int) and sender == author:
                    try:
                        seen = strangers.get(sender, 0); nowt = time.time()
                        if nowt - seen >= STRANGER_REPLY_EVERY:
                            strangers[sender] = nowt
                            if len(strangers) > 500:
                                strangers.clear(); strangers[sender] = nowt
                            poll('sendMessage', chat_id=sender, text=STRANGER_NOTICE, disable_web_page_preview=True)
                            frm = msg.get('from') or {}
                            said = text if isinstance(text, str) else ('(nota de voz)' if msg.get('voice') else '(envió algo que no es texto)')
                            notifier.stranger('Freddy', {'id': sender, 'user': frm.get('username'), 'name': ' '.join(x for x in (frm.get('first_name'), frm.get('last_name')) if isinstance(x, str))}, said)
                    except Exception:
                        print('notifier: no se pudo avisar de un desconocido', flush=True)
                continue
            heard = False
            note = msg.get('voice') if isinstance(msg.get('voice'), dict) else None
            if not isinstance(text, str) and note and hear:
                # Nota de voz del jefe: se pasa a texto y se atiende como si la hubiera escrito.
                if not isinstance(note.get('file_id'), str) or (note.get('duration') or 0) > MAX_VOICE_SECONDS:
                    send('Jefe, ese audio es demasiado largo para mí. Dímelo en menos de dos minutos o escríbemelo.')
                    continue
                try:
                    text = hear(note['file_id'])
                except Exception:
                    text = None
                if not text:
                    send('Jefe, no he podido entender ese audio. ¿Me lo repites o me lo escribes?')
                    continue
                heard = True
            if not isinstance(text, str):
                continue
            try:
                answer_text = respond(notifier, text, chat)
                send((f'🎙 Te he entendido: «{text}»\n\n' if heard else '') + answer_text)
            except Exception:
                print('notifier: no se pudo contestar una orden', flush=True)


def telegram_sender(token, chat):
    def send(text, button=None):
        body = {'chat_id': chat, 'text': text[:3900], 'disable_web_page_preview': True}
        try:
            with httpx.Client(timeout=httpx.Timeout(8.0, connect=4.0), follow_redirects=False) as client:
                r = None
                if button:
                    r = client.post(f'https://api.telegram.org/bot{token}/sendMessage', json={**body, 'reply_markup': {'inline_keyboard': [[{'text': button[0][:60], 'url': button[1]}]]}})
                if r is None or r.status_code != 200:   # sin botón, o Telegram no lo admite (privacidad de esa persona): el aviso llega igual
                    r = client.post(f'https://api.telegram.org/bot{token}/sendMessage', json=body)
            ok = r.status_code == 200
        except httpx.HTTPError:
            ok = False
        if not ok:
            print('notifier: no se pudo enviar el aviso a Telegram', flush=True)   # sin clave, sin texto
        return ok
    return send


_thread = None
_notifier = None   # el que está en marcha, para que una empresa pueda entregarle un aviso


def start():
    """Arranca el hilo una sola vez, y solo si Telegram está configurado."""
    global _thread, _notifier
    conf = settings()
    if conf is None or _thread is not None or os.getenv('ELIOT_NOTIFIER') == 'off':
        return False
    hear = say = None
    try:   # voz: Freddy entiende los audios del jefe y le habla en lo urgente, si hay proveedor de voz configurado
        from app import eliot_freddy_voice
        if eliot_freddy_voice.enabled():
            say = eliot_freddy_voice.voice_sender(*conf)
            hear = lambda file_id: eliot_freddy_voice.transcribe(conf[0], file_id)
            print('notifier: voz activa', flush=True)
    except Exception:
        print('notifier: voz no disponible', flush=True)
    notifier = _notifier = Notifier(telegram_sender(*conf), say=say)

    def loop():
        time.sleep(5)
        while True:
            try:
                notifier.tick()
            except Exception:   # un fallo no debe matar el hilo ni filtrar nada
                print('notifier: ronda fallida', flush=True)
            time.sleep(INTERVAL)
    _thread = threading.Thread(target=loop, name='freddy-notifier', daemon=True)
    _thread.start()
    chat = None
    try:   # conversación con IA: solo si está configurada; si no, Freddy atiende las órdenes fijas
        from app import eliot_freddy_chat
        if eliot_freddy_chat.enabled():
            notifier.who = eliot_freddy_chat.people   # este chat es el privado del jefe: los avisos le llegan con el cliente de cada caso
            chat = eliot_freddy_chat.Chat(notifier, actions=os.getenv('ELIOT_FREDDY_ACTIONS') != 'off')   # solo este chat, el privado del jefe, puede proponer acciones
            print('notifier: conversación con IA activa', flush=True)
    except Exception:
        print('notifier: conversación con IA no disponible', flush=True)
    threading.Thread(target=listen, args=(notifier, conf[0], conf[1]), kwargs={'chat': chat, 'hear': hear}, name='freddy-ordenes', daemon=True).start()
    try:   # resumen del día a las 21:00
        from app import eliot_daily_report
        eliot_daily_report.start(notifier, conf)
    except Exception:
        print('notifier: resumen diario no disponible', flush=True)
    print('notifier: avisos por Telegram activos', flush=True)
    return True

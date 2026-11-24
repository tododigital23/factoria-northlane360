"""Resumen diario de Freddy: cada noche, a las 21:00 (hora de Madrid), un mensaje al Telegram privado del propietario con
el día de cada empresa: ventas, lo facturado ese día, clientes nuevos, renovaciones y las incidencias leves o medias que quedan para mañana.

· El nombre de cada empresa va siempre resaltado, para saber de cuál se habla.
· Solo cifras y avisos: nada de nombres, teléfonos ni datos de clientes.
· Lo urgente no espera a este resumen: se avisa en el momento. Aquí se cuenta cuánto sigue abierto.
· Los importes son únicamente lo facturado ese día (de medianoche a la hora del resumen, hora de Madrid). No se calculan beneficios ni acumulados.
· Variables: ELIOT_DAILY_REPORT=off lo apaga; ELIOT_DAILY_REPORT_HOUR cambia la hora (0-23, por defecto 21).
· No guarda nada en la base: si el servidor se reinicia dentro de esa hora, el resumen puede llegar repetido (mejor repetir que callar).
"""
import html
import os
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

from app import eliot_notifier as notifier_mod

MADRID = ZoneInfo('Europe/Madrid')
LATER = ('importante', 'info')     # leves o medias: se arreglan al día siguiente
WEEKDAY = ('lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo')
MONTH = ('enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre')


def hour():
    try:
        value = int(os.getenv('ELIOT_DAILY_REPORT_HOUR') or '21')
    except ValueError:
        return 21
    return value if 0 <= value <= 23 else 21


def enabled():
    return os.getenv('ELIOT_DAILY_REPORT') != 'off'


def due(now, sent_day):
    """¿Toca enviarlo? Solo dentro de la hora fijada y una vez por día."""
    local = datetime.fromtimestamp(now, MADRID)
    return local.hour == hour() and sent_day != local.date().isoformat()


def euros(value):
    if isinstance(value, bool) or value is None:
        return '—'
    try:
        amount = float(value)
    except (TypeError, ValueError, OverflowError):
        return '—'
    text = f'{amount:,.2f}'.replace(',', '·').replace('.', ',').replace('·', '.')
    return text + ' €'


def _n(value):
    return value if isinstance(value, int) and value >= 0 else None


def company_block(company, sales, notices):
    """El trozo de una empresa. sales: lo que contestó el portal sobre hoy (o None). notices: avisos abiertos (o None si no se sabe)."""
    lines = ['🏢 <b>' + html.escape(company.upper()) + '</b>']
    if isinstance(sales, dict) and _n(sales.get('cobros')) is not None:
        new, ren = sales.get('altas') or {}, sales.get('renovaciones') or {}
        lines += [f"🛒 Ventas: <b>{sales['cobros']}</b>",
                  f"💶 Facturado hoy: <b>{euros(sales.get('importe_eur'))}</b>",
                  f"🆕 Clientes nuevos: <b>{_n(new.get('cobros')) if _n(new.get('cobros')) is not None else '—'}</b> ({euros(new.get('importe_eur'))})",
                  f"🔁 Renovaciones: <b>{_n(ren.get('cobros')) if _n(ren.get('cobros')) is not None else '—'}</b> ({euros(ren.get('importe_eur'))})"]
    else:
        lines.append('🛒 Ventas: no he podido consultarlas hoy.')
    if notices is None:
        lines.append('🛠 Incidencias: no he podido hablar con sus agentes.')
    else:
        later = sorted((n for n in notices if n.get('level') in LATER), key=lambda n: notifier_mod.RANK[n['level']])
        urgent = sum(1 for n in notices if n.get('level') == 'urgente')
        if later:
            lines.append(f'🛠 Para mañana ({len(later)}):')
            for n in later[:8]:
                title, _ = notifier_mod.copy_for(n['code'], n['count'], n)
                lines.append(f"  {notifier_mod.MARK[n['level']]} " + html.escape(f"{n['agent']}: {title}"))
            if len(later) > 8:
                lines.append(f'  … y {len(later) - 8} más')
        else:
            lines.append('🛠 Incidencias leves o medias: ninguna ✅')
        if urgent:
            lines.append(f'🚨 Urgentes que siguen abiertas: <b>{urgent}</b> (ya avisadas)')
    return '\n'.join(lines)


def compose(entries, now):
    """entries: [(empresa, ventas|None, avisos|None)]."""
    local = datetime.fromtimestamp(now, MADRID)
    head = f'🌙 <b>Resumen del día</b> · {WEEKDAY[local.weekday()]} {local.day} de {MONTH[local.month - 1]}'
    if not entries:
        return head + '\n\nJefe, todavía no hay ninguna empresa conectada de la que pueda darte cifras.'
    blocks = [company_block(*e) for e in sorted(entries, key=lambda e: e[0].lower())]
    known = [e[1] for e in entries if isinstance(e[1], dict) and _n(e[1].get('cobros')) is not None]
    total = ''
    if len(entries) > 1 and known:
        money = sum(s['importe_eur'] for s in known if isinstance(s.get('importe_eur'), (int, float)))
        total = f"\n\n———\n📊 <b>TOTAL</b> ({len(known)} de {len(entries)} empresas): <b>{sum(s['cobros'] for s in known)}</b> ventas · <b>{euros(money)}</b>"
    return head + '\n\n' + '\n\n'.join(blocks) + total


def gather(notifier, ask=None, companies=None):
    """Pregunta a cada empresa por sus ventas de hoy y lee sus avisos abiertos. Una empresa que no contesta no para a las demás."""
    if ask is None:
        from app import eliot_freddy_chat
        ask = lambda feed: eliot_freddy_chat.ask_portal(feed, 'ventas', {'periodo': 'hoy'})
    try:
        notifier.refresh(max_age=120)
    except Exception:
        pass
    with notifier.lock:
        last = dict(notifier.last)
    out = []
    for org, company, feed in (companies() if companies else notifier_mod.companies()):
        try:
            sales = ask(feed)
        except Exception:
            sales = None
        entry = last.get(org)
        try:
            notices = list(notifier_mod.notices_of(entry).values()) if entry else None
        except Exception:
            notices = None
        out.append((company, sales, notices))
    return out


def html_sender(token, chat):
    """Envía con negritas. Si Telegram rechaza el formato, lo manda en texto plano: el resumen llega igual."""
    def send(text):
        url = f'https://api.telegram.org/bot{token}/sendMessage'
        body = {'chat_id': chat, 'text': text[:3900], 'disable_web_page_preview': True}
        try:
            with httpx.Client(timeout=httpx.Timeout(8.0, connect=4.0), follow_redirects=False) as client:
                r = client.post(url, json={**body, 'parse_mode': 'HTML'})
                if r.status_code != 200:
                    plain = html.unescape(text.replace('<b>', '').replace('</b>', ''))
                    r = client.post(url, json={**body, 'text': plain[:3900]})
            return r.status_code == 200
        except httpx.HTTPError:
            print('resumen diario: no se pudo enviar a Telegram', flush=True)     # sin clave, sin texto
            return False
    return send


def run_once(notifier, send, now=None, ask=None, companies=None):
    now = time.time() if now is None else now
    return send(compose(gather(notifier, ask, companies), now))


def maybe_propose_improve(notifier, send):
    """Tras el resumen: 0–1 propuesta de mejora pendiente de «sí» (si ELIOT_STORE_IMPROVE no está off)."""
    from app import eliot_store_improve as improve
    if not improve.improve_enabled() or not improve.writes_enabled():
        return False
    try:
        text = improve.pick_and_arm(notifier)
    except Exception:
        print('resumen diario: propuesta de mejora fallida', flush=True)
        return False
    if not text or text.startswith('No hay mejoras'):
        return False
    return send(text)


_thread = None


def start(notifier, conf):
    """Arranca el hilo del resumen, una sola vez. conf = (clave del bot, chat) ya validados."""
    global _thread
    if _thread is not None or not enabled() or notifier is None or conf is None:
        return False
    send = html_sender(*conf)

    def loop():
        sent_day = None
        while True:
            time.sleep(60)
            try:
                now = time.time()
                if due(now, sent_day):
                    sent_day = datetime.fromtimestamp(now, MADRID).date().isoformat()     # se apunta antes: un fallo no lo repite cada minuto
                    run_once(notifier, send, now)
                    maybe_propose_improve(notifier, send)
            except Exception:
                print('resumen diario: ronda fallida', flush=True)
    _thread = threading.Thread(target=loop, name='freddy-resumen-diario', daemon=True)
    _thread.start()
    print(f'resumen diario: activo a las {hour()}:00 (Madrid)', flush=True)
    return True

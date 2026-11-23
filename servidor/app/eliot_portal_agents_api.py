"""Agentes que trabajan en el portal de una empresa, vistos desde Freddy. Cifras y, de cada aviso, su clave y sus referencias de pedido.

Cada empresa puede tener un portal propio (p. ej. portal-demo) con agentes que atienden su
chat o vigilan su negocio. Esos datos NO se copian a Freddy: cuando el propietario abre la oficina
de SU empresa, este módulo pide al portal su resumen, se queda solo con lo que está en la lista
blanca (estados, recuentos, importes agregados, horas y, de cada aviso, gravedad, clave, número de
casos y referencias de pedido) y lo devuelve. No se guarda nada en la
base de datos de Freddy.

Aislamiento entre empresas:
* La dirección y la clave de cada portal se configuran por empresa (id de organización) en el
  entorno del servidor; el propietario de una empresa solo puede provocar la lectura del portal
  de ESA empresa.
* La clave nunca sale del servidor ni aparece en respuestas o registros.
* Cualquier campo que no esté en la lista blanca, o que no tenga la forma esperada (un texto
  donde debe ir un número, un estado desconocido), se descarta: aunque un portal devolviera por
  error datos de clientes, aquí no pasan.

Configuración (variables de entorno del servidor):
  ELIOT_PORTAL_FEEDS   JSON  {"<uuid de la organización>": {"url": "https://…/api/cron/resumen-freddy",
                              "secret_env": "ELIOT_PORTAL_SECRET_NOVA", "panel_url": "https://…/admin/clients.html"}}
  <secret_env>         la clave compartida con ese portal (32 caracteres o más)
"""
import json
import os
import re
import time
from uuid import UUID

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from app.eliot_tool_control_api import _owner

router = APIRouter(prefix='/v1/me', tags=['portal-agents'])

CAPABILITIES = ('repository', 'website', 'seo', 'marketing', 'email', 'orders', 'monitoring', 'automation')
STATES = ('activo', 'apagado', 'frenado', 'ok', 'aviso', 'alerta', 'error')
COUNTERS_24H = ('respuestas', 'pasadas_al_dueno', 'graves', 'sin_respuesta', 'frenos', 'gestiones')
ALERT_LEVELS = ('urgentes', 'importantes', 'informativas')
HTTPS_URL = re.compile(r'^https://[A-Za-z0-9.-]{3,200}(:[0-9]{2,5})?(/[A-Za-z0-9._~/-]*)?$')
SECRET_ENV = re.compile(r'^ELIOT_PORTAL_SECRET_[A-Z0-9_]{1,40}$')
AGENT_ID = re.compile(r'^[a-z][a-z_]{1,29}$')
AGENT_NAME = re.compile(r'^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]{3,60}$')
MODEL = re.compile(r'^claude-[a-z0-9-]{3,40}$')
INSTANT = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$')
MONTH = re.compile(r'^\d{4}-\d{2}$')
NOTICE_LEVELS = ('urgente', 'importante', 'info')
NOTICE_CODE = re.compile(r'^[a-z_]{2,30}$')
# Referencia de pedido (ab-ORD-1373, man-REN-abc123-C): lo ÚNICO de un caso concreto que puede pasar a Freddy.
ORDER_REF = re.compile(r'^[a-z]{2,5}-[A-Z]{3}-[A-Za-z0-9]{1,16}(-[A-Z])?$')
MAX_NOTICES, MAX_REFS = 12, 6
# Texto propio de un aviso que Freddy no conoce: una frase corta y llana, sin correos ni números largos (teléfonos, tarjetas).
NOTICE_TEXT = re.compile(r"^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .,:;()«»¿?¡!%€$/+'-]{3,140}$")


def _notice_text(value):
    return value.strip() if isinstance(value, str) and NOTICE_TEXT.fullmatch(value.strip()) and not re.search(r'\d{7,}', value) else None
COMPANY_SLUG = re.compile(r'^[a-z0-9-]{2,40}$')
CACHE_SECONDS = 60
MAX_BYTES = 64 * 1024
_cache: dict[str, tuple[float, dict]] = {}


def feed_for(organization_id: UUID):
    """Configuración del portal de ESA empresa, o None. Una configuración mal formada equivale a no tenerla."""
    try:
        feeds = json.loads(os.getenv('ELIOT_PORTAL_FEEDS') or '{}')
    except ValueError:
        return None
    entry = feeds.get(str(organization_id)) if isinstance(feeds, dict) else None
    if not isinstance(entry, dict):
        return None
    secret_env, panel = entry.get('secret_env'), entry.get('panel_url')
    if not (isinstance(secret_env, str) and SECRET_ENV.fullmatch(secret_env)):
        return None
    secret = os.getenv(secret_env) or ''
    if len(secret) < 32:
        return None
    if not (isinstance(panel, str) and HTTPS_URL.fullmatch(panel)):
        panel = None
    kind = entry.get('kind') if isinstance(entry.get('kind'), str) else 'https'
    if kind == 'database':
        db_url_env = entry.get('db_url_env')
        if not (isinstance(db_url_env, str) and re.fullmatch(r'^ELIOT_COMPANY_DB_[A-Z0-9_]{1,40}$', db_url_env)):
            return None
        db_url = os.getenv(db_url_env) or ''
        if len(db_url) < 8:
            return None
        empresa = entry.get('empresa') if isinstance(entry.get('empresa'), str) else None
        return {'kind': 'database', 'db_url': db_url, 'secret': secret, 'panel_url': panel,
                'watchers': entry.get('watchers'), 'queries': entry.get('queries'),
                'actions': entry.get('actions'), 'empresa': empresa}
    url = entry.get('url')
    if not (isinstance(url, str) and HTTPS_URL.fullmatch(url)):
        return None
    return {'kind': 'https', 'url': url, 'secret': secret, 'panel_url': panel}


def _count(value):
    return value if type(value) is int and 0 <= value <= 10_000_000 else None


def _money(value):
    return round(float(value), 2) if type(value) in (int, float) and 0 <= value <= 1_000_000 else None


def _instant(value):
    return value if isinstance(value, str) and INSTANT.fullmatch(value) else None


def _notice(raw):
    """Un aviso de un agente: gravedad, clave, número de casos, referencias y, si la clave es propia de esa empresa, su título."""
    if not isinstance(raw, dict):
        return None
    level, code = raw.get('nivel'), raw.get('clave')
    if level not in NOTICE_LEVELS or not (isinstance(code, str) and NOTICE_CODE.fullmatch(code)):
        return None
    refs = raw.get('refs') if isinstance(raw.get('refs'), list) else []
    kept = []
    for ref in refs:
        if isinstance(ref, str) and ORDER_REF.fullmatch(ref) and ref not in kept:
            kept.append(ref)
    out = {'level': level, 'code': code, 'count': _count(raw.get('n')), 'refs': kept[:MAX_REFS]}
    title, proposal = _notice_text(raw.get('titulo')), _notice_text(raw.get('propuesta'))
    if title:      # solo se usa si Freddy no tiene ya un texto propio para esa clave
        out['title'] = title
        if proposal:
            out['proposal'] = proposal
    return out


def _agent(raw):
    """Un agente del portal reducido a la lista blanca; None si no es reconocible."""
    if not isinstance(raw, dict):
        return None
    ident, name, state, capability = raw.get('id'), raw.get('nombre'), raw.get('estado'), raw.get('capacidad')
    if not (isinstance(ident, str) and AGENT_ID.fullmatch(ident)):
        return None
    if not (isinstance(name, str) and AGENT_NAME.fullmatch(name)):
        return None
    if state not in STATES or capability not in CAPABILITIES:
        return None
    out = {'id': ident, 'name': name, 'state': state, 'capability': capability}
    model = raw.get('modelo')
    if isinstance(model, str) and MODEL.fullmatch(model):
        out['model'] = model
    day = raw.get('ultimas_24h')
    if isinstance(day, dict):
        out['last_24h'] = {key: _count(day.get(key)) for key in COUNTERS_24H}
    month = raw.get('mes')
    if isinstance(month, dict):
        label = month.get('mes')
        out['month'] = {'month': label if isinstance(label, str) and MONTH.fullmatch(label) else None,
                        'spent_usd': _money(month.get('gasto_usd')), 'cap_usd': _money(month.get('tope_usd')),
                        'replies': _count(month.get('respuestas'))}
    alerts = raw.get('alertas')
    if isinstance(alerts, dict):
        out['alerts'] = {key: _count(alerts.get(key)) for key in ALERT_LEVELS}
    notices = raw.get('avisos')
    if isinstance(notices, list):
        out['notices'] = [n for n in (_notice(x) for x in notices[:MAX_NOTICES]) if n]
    last = _instant(raw.get('ultima_actividad'))
    if last:
        out['last_activity'] = last
    return out


def clean(payload):
    """Resumen de un portal reducido a la lista blanca. Devuelve None si no tiene la forma esperada."""
    if not isinstance(payload, dict) or payload.get('ok') is not True or payload.get('version') != 1:
        return None
    agents = payload.get('agentes')
    if not isinstance(agents, list) or len(agents) > 30:
        return None
    kept, seen = [], set()
    for raw in agents:
        agent = _agent(raw)
        if agent and agent['id'] not in seen:
            seen.add(agent['id'])
            kept.append(agent)
    watch = payload.get('vigilancia') if isinstance(payload.get('vigilancia'), dict) else {}
    slug = payload.get('empresa')
    names = lambda v: [x for x in (v if isinstance(v, list) else [])[:20] if isinstance(x, str) and NOTICE_CODE.fullmatch(x)]
    return {'generated_at': _instant(payload.get('generado')), 'agents': kept,
            'queries': names(payload.get('consultas')), 'actions': names(payload.get('acciones')),   # lo que esa empresa deja preguntar y mandar hacer
            'company': slug if isinstance(slug, str) and COMPANY_SLUG.fullmatch(slug) else None,
            'watch': {'counting_since': _instant(watch.get('contando_desde')),
                      'last_scheduled_run': _instant(watch.get('ultima_ronda_programada'))}}


def fetch(feed):
    """Pide el resumen al portal. Devuelve (resumen limpio, None) o (None, motivo). Nunca lanza ni filtra la respuesta."""
    if feed.get('kind') == 'database':
        from app import eliot_company_db
        payload, reason = eliot_company_db.summary(feed)
        if payload is None:
            return None, reason or 'portal_unreachable'
        summary = clean(payload)
        return (summary, None) if summary is not None else (None, 'portal_response_invalid')
    try:
        with httpx.Client(timeout=httpx.Timeout(8.0, connect=4.0), follow_redirects=False) as client:
            response = client.get(feed['url'], headers={'Authorization': 'Bearer ' + feed['secret'],
                                                        'Accept': 'application/json'})
    except httpx.HTTPError:
        return None, 'portal_unreachable'
    if response.status_code in (401, 403):
        return None, 'portal_rejected_key'
    if response.status_code != 200:
        return None, 'portal_error'
    if len(response.content) > MAX_BYTES:
        return None, 'portal_response_too_large'
    try:
        summary = clean(response.json())
    except ValueError:
        summary = None
    return (summary, None) if summary is not None else (None, 'portal_response_invalid')


@router.get('/organizations/{organization_id}/portal-agents')
def portal_agents(organization_id: UUID, authorization: str | None = Header(default=None)):
    _owner(organization_id, authorization, write=False)   # solo el propietario de ESTA empresa
    base = {'organization_id': str(organization_id), 'stored_in_freddy': False}
    feed = feed_for(organization_id)
    if feed is None:
        return {**base, 'configured': False, 'available': False, 'reason': 'not_configured', 'panel_url': None, 'agents': []}
    key = str(organization_id)
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        summary, reason = cached[1], None
    else:
        summary, reason = fetch(feed)
        if summary is not None:
            _cache[key] = (time.monotonic(), summary)
    if summary is None:
        return {**base, 'configured': True, 'available': False, 'reason': reason, 'panel_url': feed['panel_url'], 'agents': []}
    return {**base, 'configured': True, 'available': True, 'reason': None, 'panel_url': feed['panel_url'], **summary}


class ForgetNotice(BaseModel):
    """El aviso que el propietario da por arreglado: su clave, los pedidos que muestra y, si no lleva pedidos, su número de casos."""
    model_config = ConfigDict(extra='forbid')
    code: str = Field(pattern=r'^[a-z_]{2,30}$')
    refs: list[str] = Field(default_factory=list, max_length=12)
    count: int | None = Field(default=None, ge=1, le=99999)


@router.post('/organizations/{organization_id}/portal-agents/forget')
def forget_notice(organization_id: UUID, body: ForgetNotice, authorization: str | None = Header(default=None)):
    """«Olvidar»: el propietario ya lo arregló a mano. La empresa deja de contar ese aviso para esos pedidos; no se toca ningún pedido."""
    _owner(organization_id, authorization, write=True)
    feed = feed_for(organization_id)
    if feed is None:
        raise HTTPException(status_code=404, detail='Empresa sin portal conectado')
    if any(not ORDER_REF.fullmatch(r) for r in body.refs) or (not body.refs and body.count is None):
        raise HTTPException(status_code=422, detail='Aviso no válido')
    from app import eliot_freddy_chat, eliot_notifier
    payload = {'accion': 'olvidar', 'modo': 'ejecutar', 'clave': body.code, **({'refs': body.refs} if body.refs else {'n': body.count})}
    result = eliot_freddy_chat.act_on_portal(feed, payload)
    if result is None:
        raise HTTPException(status_code=503, detail='La empresa no ha contestado')
    if not (result['ok'] and result['hecho']):
        raise HTTPException(status_code=409, detail=result['resumen'])
    _cache.pop(str(organization_id), None)            # la bandeja vuelve a preguntar a la empresa
    if eliot_notifier._notifier is not None:          # y Telegram deja de recordarlo
        eliot_notifier._notifier.refresh(max_age=0)
    return {'organization_id': str(organization_id), 'forgotten': True}


# ---------- Una empresa avisa a Freddy por su cuenta, en cuanto algo cambia ----------
push_router = APIRouter(prefix='/v1', tags=['portal-agents'])


@push_router.post('/portal-push')
async def portal_push(request: Request, authorization: str | None = Header(default=None)):
    """El portal de una empresa entrega su resumen. Se identifica con la misma clave con la que Freddy le pregunta.

    Lleva lo mismo que el resumen de siempre (estados, recuentos y referencias de pedido) y pasa por el mismo filtro.
    """
    import hmac
    from app import eliot_notifier
    token = (authorization or '').removeprefix('Bearer ').strip()
    org = next((o for o, _name, feed in eliot_notifier.companies() if token and hmac.compare_digest(token.encode(), feed['secret'].encode())), None)
    if org is None:
        raise HTTPException(status_code=401, detail='No autorizado')
    raw = await request.body()
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail='Resumen demasiado grande')
    try:
        summary = clean(json.loads(raw))
    except ValueError:
        summary = None
    if summary is None:
        raise HTTPException(status_code=422, detail='Resumen no válido')
    if eliot_notifier._notifier is None:
        raise HTTPException(status_code=503, detail='Avisos no configurados')
    await run_in_threadpool(eliot_notifier._notifier.receive, org, summary)   # puede enviar mensajes: fuera del hilo de la web
    return {'ok': True}


def _short(value, limit):
    return value.strip()[:limit] if isinstance(value, str) and value.strip() else None


def clean_event(payload):
    """Un aviso del chat de una empresa, reducido a lo esperado. None si no tiene esa forma."""
    if isinstance(payload, dict) and payload.get('version') == 1 and payload.get('tipo') == 'acceso_ajeno':
        # Alguien sin identificar ha escrito al bot de la empresa: quién es en Telegram y qué puso. Ningún dato de cliente.
        tg = payload.get('telegram') if isinstance(payload.get('telegram'), dict) else {}
        ident = tg.get('id')
        if type(ident) is not int or ident <= 0:
            return None
        return {'kind': 'acceso_ajeno', 'grave': False, 'bot': _short(payload.get('bot'), 60), 'client': {'user': None, 'name': None, 'phone': None},
                'telegram': {'id': ident, 'user': _short(tg.get('usuario'), 40), 'name': _short(tg.get('nombre'), 80)},
                'message': _short(payload.get('mensaje'), 600), 'reason': None}
    if not isinstance(payload, dict) or payload.get('version') != 1 or payload.get('tipo') not in ('pide_admin', 'sin_respuesta', 'frenado'):
        return None
    client = payload.get('cliente') if isinstance(payload.get('cliente'), dict) else {}
    return {'kind': payload['tipo'], 'grave': payload.get('grave') is True,
            'client': {'user': _short(client.get('usuario'), 60), 'name': _short(client.get('nombre'), 80), 'phone': _short(client.get('telefono'), 30)},
            'message': _short(payload.get('mensaje'), 600), 'reason': _short(payload.get('motivo'), 200)}


@push_router.post('/portal-event')
async def portal_event(request: Request, authorization: str | None = Header(default=None)):
    """El chat de una empresa avisa de que un cliente necesita al propietario. Misma clave que el resumen; va directo a su Telegram."""
    import hmac
    from app import eliot_notifier
    token = (authorization or '').removeprefix('Bearer ').strip()
    org = next((o for o, _name, feed in eliot_notifier.companies() if token and hmac.compare_digest(token.encode(), feed['secret'].encode())), None)
    if org is None:
        raise HTTPException(status_code=401, detail='No autorizado')
    raw = await request.body()
    if len(raw) > 8 * 1024:
        raise HTTPException(status_code=413, detail='Aviso demasiado grande')
    try:
        event = clean_event(json.loads(raw))
    except ValueError:
        event = None
    if event is None:
        raise HTTPException(status_code=422, detail='Aviso no válido')
    if eliot_notifier._notifier is None:
        raise HTTPException(status_code=503, detail='Avisos no configurados')
    sent = await run_in_threadpool(eliot_notifier._notifier.event, org, event)
    return {'ok': True, 'sent': bool(sent)}

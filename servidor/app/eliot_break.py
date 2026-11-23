"""Modo descanso por empresa: el propietario manda a todos sus agentes a la sala de descanso y, mientras dura,
esa empresa no arranca trabajo de IA.

· Encender y apagar: solo el propietario (lo comprueba la base, migración 040).
· Cada punto donde un agente empezaría a trabajar llama a `require_working`: si hay descanso, contesta 409 sin llamar a ningún modelo.
· El chat no da error: el agente contesta, sin IA, que está en el descanso.
· Sin la migración instalada no hay descanso: todo funciona como antes.
"""
import threading
import time
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from app import organizations_api as identity
from app.eliot_tool_control_api import _cursor

router = APIRouter(prefix='/v1/me/organizations', tags=['eliot-break'])
NOTE = 'Empresa en modo descanso: los agentes están apagados hasta que el propietario lo termine.'
CHAT_NOTE = '🪩 Ahora mismo estamos en la sala de descanso: el jefe nos ha dado un respiro y estamos apagados. En cuanto termine el descanso te atiendo.'
CACHE_SECONDS = 5
_cache, _lock = {}, threading.Lock()


def forget(org=None):
    with _lock:
        _cache.clear() if org is None else _cache.pop(str(org), None)


def _read(cur, org):
    cur.execute("SELECT to_regprocedure('eliot.my_company_break(uuid)')")
    row = cur.fetchone()
    if not row or not row[0]:
        return None
    cur.execute('SELECT eliot.my_company_break(%s)', (org,))
    row = cur.fetchone()
    data = row[0] if row else None
    if not isinstance(data, dict) or type(data.get('on_break')) is not bool:
        raise HTTPException(503, 'Break state unconfirmed')
    return data


def on_break(subject, org, now=None):
    """¿Está la empresa en descanso? Se recuerda unos segundos. Si no se puede saber, se responde que no:
    el descanso es una comodidad del propietario, no un cierre de seguridad, y no debe tumbar el servicio."""
    now = time.time() if now is None else now
    key = str(org)
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[1] < CACHE_SECONDS:
            return hit[0]
    try:
        with _cursor(subject) as cur:
            data = _read(cur, org)
    except Exception:
        return False
    value = bool(data and data['on_break'])
    with _lock:
        if len(_cache) > 2000:
            _cache.clear()
        _cache[key] = (value, now)
    return value


def require_working(subject, org):
    if on_break(subject, org):
        raise HTTPException(409, NOTE)


class BreakRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    on: bool


def _shape(org, data):
    since = data.get('since') if data else None
    return {'organization_id': str(org), 'available': data is not None, 'on_break': bool(data and data['on_break']),
            'since': since if isinstance(since, str) else None}


@router.get('/{organization_id}/break')
def get_break(organization_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization)
    with _cursor(subject) as cur:
        data = _read(cur, organization_id)
    return _shape(organization_id, data)


@router.post('/{organization_id}/break')
def set_break(organization_id: UUID, body: BreakRequest, authorization: str | None = Header(default=None)):
    subject = identity._require_approval_scope(authorization)
    with _cursor(subject) as cur:
        if _read(cur, organization_id) is None:
            raise HTTPException(503, 'Break mode unavailable')
        cur.execute('SELECT eliot.owner_set_company_break(%s,%s)', (organization_id, body.on))
        row = cur.fetchone()
        data = row[0] if row else None
        if not isinstance(data, dict) or data.get('on_break') is not body.on or data.get('organization_id') != str(organization_id):
            raise HTTPException(503, 'Break change unconfirmed')
    forget(organization_id)
    return {**_shape(organization_id, data), 'changed': data.get('changed') is True}

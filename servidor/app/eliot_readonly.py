"""Acceso de SOLO CONSULTA a La Factoría: una persona que puede mirarlo todo y no puede cambiar nada.

El propietario nombra a un observador (variable ELIOT_READONLY_VIEWERS). Cuando el observador entra con su propia cuenta:
  · las consultas (GET) se contestan con lo mismo que vería el propietario;
  · cualquier otra petición —crear, aprobar, activar, retirar, guardar, encargar— se rechaza con 403 ANTES de llegar a la
    función que la atiende. No depende de que cada pantalla se acuerde de comprobarlo: hay un único punto de control.
La única petición que no es GET y se le permite es preguntar en el chat, que no cambia nada; y ahí no recibe datos de clientes.

ELIOT_READONLY_VIEWERS es un JSON {"<usuario del observador>": "<usuario del propietario>"}, con los identificadores de Auth0
(«auth0|…», «google-oauth2|…»). Sin la variable, nada de esto existe y todo funciona como siempre.
"""
import contextvars
import json
import os
import re
import threading
import time

from fastapi import HTTPException

_request = contextvars.ContextVar('eliot_request', default=(None, None))     # (método, ruta) de la petición en curso
_viewer = contextvars.ContextVar('eliot_viewer', default=False)
SAFE = ('GET', 'HEAD', 'OPTIONS')
ASK = re.compile(r'^/v1/me/organizations/[0-9a-fA-F-]{36}/eliot/chat/?$')    # preguntar no cambia nada
ID = re.compile(r'^[A-Za-z0-9_.|@:/-]{3,400}$')


def remember(method, path):
    _request.set((method, path)); _viewer.set(False)


def is_viewer():
    return _viewer.get()


def viewers():
    """{observador: propietario} tal como está configurado; {} si falta o no es válido (cerrado por defecto)."""
    try:
        raw = json.loads(os.getenv('ELIOT_READONLY_VIEWERS') or '{}')
    except ValueError:
        return {}
    if not isinstance(raw, dict) or len(raw) > 20:
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str) and ID.fullmatch(k) and ID.fullmatch(v) and k != v}


_cache, _cache_lock = {}, threading.Lock()
CACHE_SECONDS = 45      # lo que tarda, como mucho, en notarse un alta o una retirada de acceso


def forget(subject=None):
    """Olvida lo recordado (tras invitar, canjear o retirar), para que el cambio se note al momento en este proceso."""
    with _cache_lock:
        _cache.clear() if subject is None else _cache.pop(subject, None)


def invited_owner(subject, now=None):
    """A qué propietario representa ese usuario según la base (alta por invitación), o None. Ante cualquier fallo, None:
    sin base no se concede nada, y el usuario se queda con lo suyo, que es no ver nada ajeno."""
    now = time.time() if now is None else now
    with _cache_lock:
        hit = _cache.get(subject)
        if hit and now - hit[1] < CACHE_SECONDS:
            return hit[0]
    owner = None
    try:
        from app import organizations_api as identity
        with identity.psycopg.connect(**identity.db_params()) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.verified_subject',%s,true)", (subject,))
                    cur.execute("SELECT to_regprocedure('eliot.my_viewer_owner_subject()')")
                    row = cur.fetchone()
                    if row and row[0]:
                        cur.execute('SELECT eliot.my_viewer_owner_subject()')
                        row = cur.fetchone()
                        owner = row[0] if row and isinstance(row[0], str) and row[0] else None
    except Exception:
        return None     # no se guarda: se volverá a intentar en la siguiente petición
    with _cache_lock:
        if len(_cache) > 5000:
            _cache.clear()
        _cache[subject] = (owner, now)
    return owner


def resolve(subject):
    """Recibe el usuario ya verificado. Si es un observador: bloquea lo que no sea consulta y devuelve el usuario del propietario."""
    table = viewers()
    issuer, _, own = subject.partition('|')
    owner = table.get(subject) or table.get(own) or invited_owner(subject)
    if not owner:
        return subject
    method, path = _request.get()
    if method not in SAFE and not (method == 'POST' and path and ASK.fullmatch(path)):
        raise HTTPException(status_code=403, detail='Acceso de solo consulta: no puedes hacer cambios')
    _viewer.set(True)
    owner = owner if owner.startswith('http') else issuer + '|' + owner
    if owner == subject:
        return subject
    return owner

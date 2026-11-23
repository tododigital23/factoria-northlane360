"""Acceso propio de La Factoría: entrar, crear cuenta y recuperar la contraseña desde nuestra web, sin pasar por la pantalla de Auth0.

Auth0 sigue siendo quien guarda las cuentas y firma los permisos; aquí solo se le reenvían el usuario y la contraseña por un canal
cifrado y se devuelve a la web el permiso que él emite. Por eso:

· La contraseña nunca se guarda, ni se escribe en registros, ni aparece en errores. Solo viaja a Auth0.
· Hay tope de intentos por persona y por dirección; pasado el tope se espera. Auth0 mantiene además su propio bloqueo.
· Las respuestas de error son siempre las mismas: no dicen si el correo existe.
· Los registros nuevos están CERRADOS por defecto: no se puede crear ninguna cuenta hasta que el propietario lo ordene (ELIOT_SIGNUP=on).
  Y aun abiertos, crear cuenta solo es posible con una invitación viva (041): el registro nunca queda abierto a cualquiera.
· Apagado por defecto: hasta que no estén las variables del servidor, la web sigue entrando por la página de Auth0.

Variables: ELIOT_OWN_LOGIN=on, ELIOT_AUTH0_CLIENT_ID, ELIOT_AUTH0_CLIENT_SECRET (recomendada), ELIOT_AUTH0_CONNECTION
(por defecto «Username-Password-Authentication»). El dominio y la audiencia salen de ELIOT_OIDC_ISSUER y ELIOT_OIDC_AUDIENCE.
"""
import base64
import hashlib
import json
import os
import re
import threading
import time

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from app import organizations_api as identity

router = APIRouter(prefix='/v1/auth', tags=['eliot-auth'])
SCOPE = 'openid profile email read:tasks create:tasks'
GRANT = 'http://auth0.com/oauth/grant-type/password-realm'
EMAIL = re.compile(r'^[^\s@<>"\']{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$')
CLIENT_ID = re.compile(r'^[A-Za-z0-9_-]{16,64}$')
CONNECTION = re.compile(r'^[A-Za-z0-9_-]{1,60}$')
INVITE = re.compile(r'^[A-Za-z0-9_-]{30,80}$')
WINDOW, PER_ACCOUNT, PER_ADDRESS = 600, 6, 30       # intentos en 10 minutos
BAD_LOGIN = 'Usuario o contraseña incorrectos.'
TOO_MANY = 'Demasiados intentos. Espera unos minutos y vuelve a probar.'
_lock, _tries = threading.Lock(), {}


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Login(Strict):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=1, max_length=200)


class Signup(Strict):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=10, max_length=200)
    name: str = Field(min_length=1, max_length=80, pattern=r'^[^\x00-\x1f\x7f<>]+$')
    invite: str = Field(min_length=30, max_length=80)


class Reset(Strict):
    email: str = Field(min_length=5, max_length=254)


def settings():
    """Lo necesario para hablar con Auth0, o None si el acceso propio no está encendido o le falta algo."""
    if os.getenv('ELIOT_OWN_LOGIN') != 'on':
        return None
    issuer, audience = os.getenv('ELIOT_OIDC_ISSUER') or '', os.getenv('ELIOT_OIDC_AUDIENCE') or ''
    client, secret = os.getenv('ELIOT_AUTH0_CLIENT_ID') or '', os.getenv('ELIOT_AUTH0_CLIENT_SECRET') or ''
    connection = os.getenv('ELIOT_AUTH0_CONNECTION') or 'Username-Password-Authentication'
    if not re.fullmatch(r'https://[A-Za-z0-9.-]{4,120}/?', issuer) or not audience or not CLIENT_ID.fullmatch(client) or not CONNECTION.fullmatch(connection):
        return None
    if secret and not 20 <= len(secret) <= 200:
        return None
    return {'base': issuer.rstrip('/'), 'audience': audience, 'client': client, 'secret': secret or None, 'connection': connection}


def signup_open():
    """¿Se pueden crear cuentas nuevas? Solo si el propietario lo ha encendido expresamente. Por defecto, no."""
    return os.getenv('ELIOT_SIGNUP') == 'on'


def address(request):
    forwarded = (request.headers.get('x-forwarded-for') or '').split(',')[0].strip()
    value = forwarded or (request.client.host if request.client else '')
    return value if re.fullmatch(r'[0-9A-Fa-f:.]{3,45}', value or '') else 'desconocida'


def allow(kind, email, ip, now=None):
    """Apunta un intento y dice si cabe. Las claves son huellas: en memoria no queda ningún correo."""
    now = time.time() if now is None else now
    keys = [(hashlib.sha256(f'{kind}|{email.lower()}'.encode()).hexdigest(), PER_ACCOUNT), (hashlib.sha256(f'ip|{ip}'.encode()).hexdigest(), PER_ADDRESS)]
    with _lock:
        if len(_tries) > 20000:
            _tries.clear()
        ok = True
        for key, limit in keys:
            recent = [t for t in _tries.get(key, []) if now - t < WINDOW]
            if len(recent) >= limit:
                ok = False
            recent.append(now)
            _tries[key] = recent[-limit * 2:]
    return ok


def forgive(kind, email):
    with _lock:
        _tries.pop(hashlib.sha256(f'{kind}|{email.lower()}'.encode()).hexdigest(), None)


def post(conf, path, body, ip=None):
    """Una llamada a Auth0. Devuelve (código, respuesta) o (None, None) si no contestó. Nunca imprime lo que envía."""
    headers = {'Content-Type': 'application/json'}
    if ip and conf['secret'] and ip != 'desconocida':
        headers['auth0-forwarded-for'] = ip        # para que el bloqueo de Auth0 cuente por la persona y no por nuestro servidor
    try:
        with httpx.Client(timeout=httpx.Timeout(10.0, connect=4.0), follow_redirects=False) as client:
            r = client.post(conf['base'] + path, json=body, headers=headers)
        try:
            data = r.json()
        except ValueError:
            data = None
        return r.status_code, data if isinstance(data, dict) else {}
    except httpx.HTTPError:
        return None, None


def person(id_token):
    """Nombre y correo para saludar, leídos del documento que Auth0 acaba de entregar por canal cifrado."""
    try:
        part = id_token.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
    except Exception:
        return {'name': None, 'email': None}
    text = lambda v, n: v[:n] if isinstance(v, str) and v and not re.search(r'[\x00-\x1f<>]', v) else None
    return {'name': text(claims.get('name'), 80), 'email': text(claims.get('email'), 254)}


def token_accepted(token):
    """¿Aceptaría el resto del servidor este permiso? Misma firma, emisor, audiencia y alcance mínimo que en cada petición."""
    try:
        key = identity.jwks_client().get_signing_key_from_jwt(token).key
        claims = identity.jwt.decode(token, key, algorithms=['RS256'], audience=os.environ['ELIOT_OIDC_AUDIENCE'], issuer=os.environ['ELIOT_OIDC_ISSUER'],
                                     options={'require': ['exp', 'iat', 'sub', 'iss', 'aud']}, leeway=20)
        return 'read:tasks' in set(str(claims.get('scope', '')).split())
    except Exception:
        return False


def sign_in(conf, email, password, ip):
    body = {'grant_type': GRANT, 'realm': conf['connection'], 'username': email, 'password': password,
            'audience': conf['audience'], 'scope': SCOPE, 'client_id': conf['client']}
    if conf['secret']:
        body['client_secret'] = conf['secret']
    status, data = post(conf, '/oauth/token', body, ip)
    if status is None:
        raise HTTPException(503, 'No se pudo comprobar el acceso ahora. Inténtalo de nuevo.')
    if status == 200 and isinstance(data.get('access_token'), str):
        token = data['access_token']
        if not token_accepted(token):    # no se entrega nada que el resto del servidor no vaya a aceptar
            raise HTTPException(503, 'El acceso propio no está bien configurado. Avisa al administrador.')
        expires = data.get('expires_in')
        return {'access_token': token, 'expires_in': expires if isinstance(expires, int) and 60 <= expires <= 2_592_000 else 3600,
                'user': person(data.get('id_token') or '')}
    error = data.get('error')
    if error == 'mfa_required':
        raise HTTPException(409, 'Esta cuenta tiene verificación en dos pasos: entra por la página segura de acceso.')
    if error == 'too_many_attempts' or status == 429:
        raise HTTPException(429, TOO_MANY)
    if error in ('unauthorized_client', 'access_denied') and 'grant' in str(data.get('error_description', '')).lower():
        raise HTTPException(503, 'El acceso propio no está bien configurado. Avisa al administrador.')
    if status in (400, 401, 403):
        raise HTTPException(401, BAD_LOGIN)
    raise HTTPException(503, 'No se pudo comprobar el acceso ahora. Inténtalo de nuevo.')


def invite_open(token):
    """¿Sigue viva esa invitación? Ante cualquier duda, no."""
    if not INVITE.fullmatch(token or ''):
        return False
    try:
        with identity.psycopg.connect(**identity.db_params()) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT to_regprocedure('eliot.viewer_invite_is_open(text)')")
                row = cur.fetchone()
                if not row or not row[0]:
                    return False
                cur.execute('SELECT eliot.viewer_invite_is_open(%s)', (hashlib.sha256(token.encode()).hexdigest(),))
                row = cur.fetchone()
                return bool(row and row[0] is True)
    except Exception:
        return False


def _conf():
    conf = settings()
    if conf is None:
        raise HTTPException(503, 'El acceso propio no está disponible.')
    return conf


@router.get('/config')
def config():
    """La web pregunta cómo se entra: con nuestro formulario o por la página de Auth0."""
    return {'own_login': settings() is not None, 'signup': signup_open()}


@router.post('/login')
def login(body: Login, request: Request):
    conf, email, ip = _conf(), body.email.strip(), address(request)
    if not EMAIL.fullmatch(email):
        raise HTTPException(401, BAD_LOGIN)
    if not allow('login', email, ip):
        raise HTTPException(429, TOO_MANY)
    result = sign_in(conf, email, body.password, ip)
    forgive('login', email)
    return result


@router.post('/signup', status_code=201)
def signup(body: Signup, request: Request):
    if not signup_open():      # lo primero: con los registros cerrados no se mira nada más ni se habla con Auth0
        raise HTTPException(403, 'Los registros nuevos están cerrados por ahora.')
    conf, email, ip = _conf(), body.email.strip(), address(request)
    if not EMAIL.fullmatch(email):
        raise HTTPException(422, 'Escribe un correo válido.')
    if not allow('signup', email, ip):
        raise HTTPException(429, TOO_MANY)
    if not invite_open(body.invite):
        raise HTTPException(403, 'Para crear una cuenta hace falta una invitación válida. Pide una nueva al propietario.')
    status, data = post(conf, '/dbconnections/signup', {'client_id': conf['client'], 'email': email, 'password': body.password,
                                                        'connection': conf['connection'], 'name': body.name.strip()}, ip)
    if status is None:
        raise HTTPException(503, 'No se pudo crear la cuenta ahora. Inténtalo de nuevo.')
    if status != 200:
        code = str(data.get('code') or data.get('name') or '')
        if 'password' in code.lower() or 'PasswordStrengthError' in code:
            raise HTTPException(422, 'La contraseña es demasiado débil: usa al menos 10 caracteres con letras y números.')
        # Si el correo ya tenía cuenta no se dice: se intenta entrar con lo que ha escrito, que es lo que haría su dueño.
        if status != 400:
            raise HTTPException(503, 'No se pudo crear la cuenta ahora. Inténtalo de nuevo.')
    try:
        return sign_in(conf, email, body.password, ip)
    except HTTPException as error:
        if error.status_code == 401:
            raise HTTPException(409, 'No se pudo crear la cuenta con ese correo. Si ya tienes cuenta, entra con ella.') from None
        raise


@router.post('/password-reset')
def password_reset(body: Reset, request: Request):
    conf, email, ip = _conf(), body.email.strip(), address(request)
    if EMAIL.fullmatch(email) and allow('reset', email, ip):
        post(conf, '/dbconnections/change_password', {'client_id': conf['client'], 'email': email, 'connection': conf['connection']}, ip)
    # Siempre la misma respuesta, exista o no la cuenta.
    return {'sent': True}

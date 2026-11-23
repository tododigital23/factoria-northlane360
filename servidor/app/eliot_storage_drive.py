"""Cliente mínimo de Google Drive para el almacén de Northlane360.

Solo pide el permiso «drive.file»: la aplicación ve y gestiona ÚNICAMENTE los archivos y carpetas
que ella misma crea, nada más de la cuenta. Todo lo que sube llega ya cifrado (eliot_storage_crypto):
Google guarda contenido ilegible con nombres sin significado.

Nunca registra ni devuelve llaves, códigos ni respuestas del proveedor.
"""
import json
import os
import re
import time
from urllib.parse import urlencode

import httpx

SCOPE = 'https://www.googleapis.com/auth/drive.file'
AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
API = 'https://www.googleapis.com/drive/v3'
UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
FOLDER = 'application/vnd.google-apps.folder'
DEFAULT_REDIRECT = 'https://api.tu-factoria.example/v1/storage/google/callback'
FILE_ID = re.compile(r'^[A-Za-z0-9_-]{10,200}$')
_access: dict[str, tuple[float, str]] = {}


class DriveError(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def client_config():
    """(client_id, client_secret, redirect_uri) o None si falta algo en el entorno."""
    cid, secret = os.getenv('ELIOT_DRIVE_CLIENT_ID') or '', os.getenv('ELIOT_DRIVE_CLIENT_SECRET') or ''
    redirect = os.getenv('ELIOT_DRIVE_REDIRECT_URI') or DEFAULT_REDIRECT
    if not re.fullmatch(r'[0-9A-Za-z._-]{20,200}\.apps\.googleusercontent\.com', cid) or len(secret) < 16:
        return None
    if not re.fullmatch(r'https://[A-Za-z0-9.-]{3,200}/v1/storage/google/callback', redirect):
        return None
    return cid, secret, redirect


def authorization_url(state: str) -> str:
    cid, _, redirect = client_config()
    return AUTH_URL + '?' + urlencode({'client_id': cid, 'redirect_uri': redirect, 'response_type': 'code', 'scope': SCOPE,
                                       'access_type': 'offline', 'prompt': 'consent', 'include_granted_scopes': 'false', 'state': state})


def _http():
    return httpx.Client(timeout=httpx.Timeout(30.0, connect=8.0), follow_redirects=False)


def _token_request(fields: dict) -> dict:
    cid, secret, _ = client_config()
    try:
        with _http() as http:
            r = http.post(TOKEN_URL, data={'client_id': cid, 'client_secret': secret, **fields})
    except httpx.HTTPError:
        raise DriveError('provider_unreachable') from None
    try:
        data = r.json()
    except ValueError:
        data = None
    if r.status_code != 200 or not isinstance(data, dict) or not isinstance(data.get('access_token'), str):
        raise DriveError('provider_rejected_credentials')
    return data


def exchange_code(code: str) -> tuple[str, str]:
    """Código de un solo uso → (llave permanente, llave de acceso). Exige que Google conceda solo lo pedido."""
    _, _, redirect = client_config()
    data = _token_request({'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect})
    refresh = data.get('refresh_token')
    if not isinstance(refresh, str) or len(refresh) < 20:
        raise DriveError('provider_gave_no_permanent_access')
    if SCOPE not in str(data.get('scope') or '').split():
        raise DriveError('provider_scope_missing')
    return refresh, data['access_token']


def access_token(refresh: str, cache_key: str) -> str:
    """Llave de acceso de una hora; se reutiliza mientras valga."""
    cached = _access.get(cache_key)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    data = _token_request({'grant_type': 'refresh_token', 'refresh_token': refresh})
    ttl = data.get('expires_in')
    _access[cache_key] = (time.monotonic() + max(60, min(int(ttl) if type(ttl) is int else 3000, 3500) - 120), data['access_token'])
    return data['access_token']


def forget(cache_key: str):
    _access.pop(cache_key, None)


def _call(method: str, url: str, token: str, **kwargs) -> httpx.Response:
    try:
        with _http() as http:
            r = http.request(method, url, headers={'Authorization': 'Bearer ' + token, **kwargs.pop('headers', {})}, **kwargs)
    except httpx.HTTPError:
        raise DriveError('provider_unreachable') from None
    if r.status_code in (401, 403):
        raise DriveError('provider_denied')
    if r.status_code == 404:
        raise DriveError('provider_not_found')
    if r.status_code >= 300:
        raise DriveError('provider_error')
    return r


def _id(response: httpx.Response) -> str:
    try:
        ident = response.json().get('id')
    except (ValueError, AttributeError):
        ident = None
    if not isinstance(ident, str) or not FILE_ID.fullmatch(ident):
        raise DriveError('provider_response_invalid')
    return ident


def create_folder(token: str, name: str, parent: str | None = None) -> str:
    body = {'name': name, 'mimeType': FOLDER, **({'parents': [parent]} if parent else {})}
    return _id(_call('POST', API + '/files?fields=id', token, json=body))


def folder_usable(token: str, folder_id: str) -> bool:
    """True si la carpeta existe, es de esta aplicación y no está en la papelera."""
    try:
        data = _call('GET', API + '/files/' + folder_id + '?fields=id,mimeType,trashed', token).json()
    except (DriveError, ValueError):
        return False
    return isinstance(data, dict) and data.get('id') == folder_id and data.get('mimeType') == FOLDER and data.get('trashed') is False


def upload_small(token: str, name: str, parent: str, content: bytes) -> str:
    """Sube un archivo pequeño ya cifrado (una sola petición)."""
    boundary = 'nl360' + os.urandom(12).hex()
    meta = json.dumps({'name': name, 'parents': [parent]})
    body = (('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + boundary
             + '\r\nContent-Type: application/octet-stream\r\n\r\n').encode() + content + ('\r\n--' + boundary + '--').encode())
    return _id(_call('POST', UPLOAD + '?uploadType=multipart&fields=id', token, content=body,
                     headers={'Content-Type': 'multipart/related; boundary=' + boundary}))


def download(token: str, file_id: str) -> bytes:
    return _call('GET', API + '/files/' + file_id + '?alt=media', token).content


def delete(token: str, file_id: str):
    _call('DELETE', API + '/files/' + file_id, token)

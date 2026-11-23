"""037: almacén cifrado de Northlane360 (Google Drive) y nombre del holding.

Qué ofrece esta primera parte:
* Estado de la conexión, sin llaves.
* Conectar la cuenta exclusiva de Google Drive (flujo oficial de permisos de Google).
* Prueba de extremo a extremo: sube un archivo cifrado, lo baja, lo verifica y lo borra.
* Desconectar (las llaves de cada empresa se conservan).
* Cambiar el nombre del holding.

Aislamiento: solo el propietario del holding (verificado en la base de datos) puede usar estas
rutas. Ninguna respuesta lleva llaves, códigos ni contenido de archivos. Falla cerrado (503 o
enabled:false) si falta la migración 037 o la configuración del servidor.
"""
import os
from uuid import UUID, uuid4

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import RedirectResponse
from pydantic import Field

from app import eliot_storage_crypto as crypto
from app import eliot_storage_drive as drive
from app import organizations_api as identity
from app.eliot_tool_control_api import StrictRequest, _cursor

router = APIRouter(prefix='/v1', tags=['storage'])
FUNCTIONS = ('eliot.owner_holding_storage(uuid)', 'eliot.owner_connect_holding_storage(uuid,text,text,text)',
             'eliot.owner_disconnect_holding_storage(uuid)', 'eliot.owner_rename_holding(uuid,text)')
ROOT_FOLDER_NAME = 'Northlane360'
FRONTEND = 'https://app.tu-factoria.example'


def ready(cur) -> bool:
    for signature in FUNCTIONS:
        cur.execute('SELECT to_regprocedure(%s)', (signature,))
        row = cur.fetchone()
        if not row or not row[0]:
            return False
        cur.execute("SELECT has_function_privilege(current_user,%s,'EXECUTE')", (row[0],))
        if cur.fetchone() != (True,):
            return False
    return True


def _server_configured() -> bool:
    return crypto.configured() and drive.client_config() is not None


def _state(cur, holding_id: UUID) -> dict:
    """Estado del almacén del holding. La base rechaza (403) a quien no sea su propietario."""
    cur.execute('SELECT eliot.owner_holding_storage(%s)', (holding_id,))
    row = cur.fetchone()
    state = row[0] if row else None
    if not isinstance(state, dict) or state.get('holding_id') != str(holding_id) or type(state.get('connected')) is not bool:
        raise HTTPException(503, 'Storage state unconfirmed')
    return state


class HoldingName(StrictRequest):
    name: str = Field(min_length=2, max_length=120, pattern=r'^[^\x00-\x1f\x7f]+$')


@router.post('/me/holding/{holding_id}/name')
def rename_holding(holding_id: UUID, body: HoldingName, authorization: str | None = Header(default=None)):
    subject = identity._require_approval_scope(authorization)
    name = body.name.strip()
    if len(name) < 2:
        raise HTTPException(422, 'Text too short after trimming')
    with _cursor(subject) as cur:
        if not ready(cur):
            raise HTTPException(503, 'Storage migration unavailable')
        cur.execute('SELECT eliot.owner_rename_holding(%s,%s)', (holding_id, name))
        row = cur.fetchone()
        r = row[0] if row else None
        if not isinstance(r, dict) or r.get('holding_id') != str(holding_id) or r.get('name') != name or type(r.get('renamed')) is not bool:
            raise HTTPException(503, 'Holding rename unconfirmed')
    return {'holding_id': str(holding_id), 'name': name, 'renamed': r['renamed']}


@router.get('/me/holding/{holding_id}/storage')
def storage_status(holding_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization)
    base = {'holding_id': str(holding_id), 'provider': 'google_drive', 'encrypted_before_upload': True}
    with _cursor(subject) as cur:
        if not ready(cur):
            return {**base, 'enabled': False, 'server_configured': _server_configured(), 'connected': False}
        state = _state(cur, holding_id)
    return {**base, 'enabled': True, 'server_configured': _server_configured(), 'connected': state['connected'],
            'connected_at': state.get('connected_at'), 'companies_with_storage': state.get('companies_with_storage', 0)}


@router.post('/me/holding/{holding_id}/storage/google/start')
def start_connection(holding_id: UUID, authorization: str | None = Header(default=None)):
    """Devuelve la dirección de Google donde el propietario concede el permiso. No guarda nada."""
    subject = identity._require_approval_scope(authorization)
    if not _server_configured():
        raise HTTPException(503, 'Storage is not configured on the server')
    with _cursor(subject) as cur:
        if not ready(cur):
            raise HTTPException(503, 'Storage migration unavailable')
        _state(cur, holding_id)          # 403 si no es el propietario del holding
    return {'holding_id': str(holding_id), 'authorization_url': drive.authorization_url(crypto.sign_state(str(holding_id), subject))}


def _back(result: str) -> RedirectResponse:
    origin = os.getenv('ELIOT_FRONTEND_ORIGIN') or FRONTEND
    return RedirectResponse(origin + '/?almacen=' + result, status_code=303)


@router.get('/storage/google/callback', include_in_schema=False)
def google_callback(code: str | None = Query(default=None, max_length=600), state: str | None = Query(default=None, max_length=1200),
                    error: str | None = Query(default=None, max_length=200)):
    """Vuelta desde Google. No lleva sesión: quién es y para qué holding va firmado en «state»
    (10 minutos de validez) y la base de datos vuelve a comprobar que sigue siendo el propietario."""
    if error or not code or not state or not _server_configured():
        return _back('cancelado' if error else 'error')
    try:
        holding, subject = crypto.read_state(state)
        holding_id = UUID(holding)
    except (crypto.StorageCryptoError, ValueError):
        return _back('caducado')
    try:
        refresh, access = drive.exchange_code(code)
        with _cursor(subject) as cur:
            if not ready(cur):
                return _back('error')
            previous = _state(cur, holding_id)
            root = previous.get('root_folder_id') if previous['connected'] else None
            if not (isinstance(root, str) and drive.folder_usable(access, root)):
                root = drive.create_folder(access, ROOT_FOLDER_NAME)      # cuenta nueva o primera conexión
            cur.execute('SELECT eliot.owner_connect_holding_storage(%s,%s,%s,%s)',
                        (holding_id, 'google_drive', crypto.seal_provider_token(refresh, str(holding_id)), root))
            row = cur.fetchone()
            if not row or not isinstance(row[0], dict) or row[0].get('connected') is not True:
                return _back('error')
        drive.forget(str(holding_id))
    except drive.DriveError:
        return _back('rechazado')
    except crypto.StorageCryptoError:
        return _back('error')
    except HTTPException as exc:
        return _back('otra_cuenta' if exc.status_code == 409 else ('sin_permiso' if exc.status_code == 403 else 'error'))
    return _back('conectado')


def _session(cur, holding_id: UUID) -> tuple[str, str]:
    """(llave de acceso al proveedor, carpeta raíz) del holding, o 409 si no está conectado."""
    state = _state(cur, holding_id)
    if not state['connected']:
        raise HTTPException(409, 'Storage is not connected')
    try:
        refresh = crypto.open_provider_token(state['token_cipher'], str(holding_id))
    except (crypto.StorageCryptoError, KeyError, TypeError):
        raise HTTPException(503, 'Stored access does not open with the server key') from None
    return drive.access_token(refresh, str(holding_id)), state['root_folder_id']


@router.post('/me/holding/{holding_id}/storage/test')
def test_storage(holding_id: UUID, authorization: str | None = Header(default=None)):
    """Prueba real: cifra un archivo de prueba, lo sube, lo baja, lo descifra, lo compara y lo borra."""
    subject = identity._require_approval_scope(authorization)
    if not _server_configured():
        raise HTTPException(503, 'Storage is not configured on the server')
    with _cursor(subject) as cur:
        if not ready(cur):
            raise HTTPException(503, 'Storage migration unavailable')
        token, root = _session(cur, holding_id)
    key, file_id, plain = crypto.new_company_key(), str(uuid4()), os.urandom(4096)
    steps = {'uploaded': False, 'stored_unreadable': False, 'downloaded_and_verified': False, 'deleted': False}
    remote = None
    try:
        sealed = b''.join(crypto.encrypt_stream(key, file_id, [plain]))
        remote = drive.upload_small(token, 'prueba-' + file_id, root, sealed)
        steps['uploaded'] = True
        fetched = drive.download(token, remote)
        steps['stored_unreadable'] = plain not in fetched and plain[:64] not in fetched
        steps['downloaded_and_verified'] = b''.join(crypto.decrypt_stream(key, file_id, [fetched])) == plain
    except drive.DriveError as exc:
        return {'holding_id': str(holding_id), 'ok': False, 'reason': exc.reason, **steps}
    except crypto.StorageCryptoError:
        return {'holding_id': str(holding_id), 'ok': False, 'reason': 'verification_failed', **steps}
    finally:
        if remote:
            try:
                drive.delete(token, remote)
                steps['deleted'] = True
            except drive.DriveError:
                pass
    return {'holding_id': str(holding_id), 'ok': all(steps.values()), 'reason': None if all(steps.values()) else 'incomplete', **steps}


@router.post('/me/holding/{holding_id}/storage/disconnect')
def disconnect(holding_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity._require_approval_scope(authorization)
    with _cursor(subject) as cur:
        if not ready(cur):
            raise HTTPException(503, 'Storage migration unavailable')
        cur.execute('SELECT eliot.owner_disconnect_holding_storage(%s)', (holding_id,))
        row = cur.fetchone()
        r = row[0] if row else None
        if not isinstance(r, dict) or r.get('holding_id') != str(holding_id) or r.get('connected') is not False:
            raise HTTPException(503, 'Storage disconnect unconfirmed')
    drive.forget(str(holding_id))
    return {'holding_id': str(holding_id), 'connected': False, 'removed': bool(r.get('removed'))}

"""Cifrado del almacén de Northlane360. Todo se cifra AQUÍ, antes de salir hacia el proveedor.

* Llave maestra: 32 bytes en base64, solo en el entorno del servidor (ELIOT_STORAGE_MASTER_KEY).
  Nunca se guarda en la base de datos ni se devuelve en ninguna respuesta. Si se pierde, los
  archivos no se pueden recuperar.
* Cada empresa tiene su propia llave de 32 bytes, generada al azar. En la base solo se guarda
  «envuelta» (cifrada con la maestra) y atada al identificador de esa empresa: una llave envuelta
  copiada a otra empresa no se abre.
* Los archivos se cifran por bloques con AES-256-GCM. Cada bloque va atado al archivo, a su
  posición y a si es el último, así que no se pueden reordenar, mezclar entre archivos ni truncar
  sin que se detecte al descifrar.
"""
import base64
import hashlib
import hmac
import json
import os
import struct
import time

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PREFIX = 'nl360:v1:'
MAGIC = b'NL360F1\n'
CHUNK = 1024 * 1024          # texto en claro por bloque
TAG = 16
STATE_TTL = 600              # segundos de validez del permiso de conexión


class StorageCryptoError(Exception):
    """Llave ausente o mal formada, o datos que no superan la verificación."""


def master_key() -> bytes:
    raw = os.getenv('ELIOT_STORAGE_MASTER_KEY') or ''
    try:
        key = base64.b64decode(raw, validate=True)
    except (ValueError, TypeError):
        raise StorageCryptoError('master key malformed') from None
    if len(key) != 32:
        raise StorageCryptoError('master key missing or not 32 bytes')
    return key


def configured() -> bool:
    try:
        master_key()
    except StorageCryptoError:
        return False
    return True


def _derive(purpose: bytes) -> bytes:
    """Llaves distintas para usos distintos, todas derivadas de la maestra."""
    return hmac.new(master_key(), b'nl360:' + purpose, hashlib.sha256).digest()


def seal(plain: bytes, purpose: str, bound_to: str) -> str:
    """Cifra un secreto pequeño (llave de empresa, acceso al proveedor) atado a su dueño."""
    nonce = os.urandom(12)
    cipher = AESGCM(_derive(purpose.encode())).encrypt(nonce, plain, (purpose + ':' + bound_to).encode())
    return PREFIX + base64.b64encode(nonce + cipher).decode()


def unseal(sealed: str, purpose: str, bound_to: str) -> bytes:
    if not isinstance(sealed, str) or not sealed.startswith(PREFIX):
        raise StorageCryptoError('not a sealed value')
    try:
        raw = base64.b64decode(sealed[len(PREFIX):], validate=True)
        return AESGCM(_derive(purpose.encode())).decrypt(raw[:12], raw[12:], (purpose + ':' + bound_to).encode())
    except (ValueError, TypeError, InvalidTag):
        raise StorageCryptoError('sealed value does not open') from None


def new_company_key() -> bytes:
    return os.urandom(32)


def seal_company_key(key: bytes, organization_id: str) -> str:
    return seal(key, 'company-key', str(organization_id))


def open_company_key(sealed: str, organization_id: str) -> bytes:
    key = unseal(sealed, 'company-key', str(organization_id))
    if len(key) != 32:
        raise StorageCryptoError('company key has the wrong size')
    return key


def seal_provider_token(token: str, holding_id: str) -> str:
    return seal(token.encode(), 'provider-token', str(holding_id))


def open_provider_token(sealed: str, holding_id: str) -> str:
    return unseal(sealed, 'provider-token', str(holding_id)).decode()


# ---- Permiso de conexión («state» de OAuth): firmado, con caducidad y atado a quien lo pidió.
def sign_state(holding_id: str, subject: str, now: float | None = None) -> str:
    body = base64.urlsafe_b64encode(json.dumps(
        {'h': str(holding_id), 's': subject, 'e': int((now or time.time()) + STATE_TTL), 'n': base64.b64encode(os.urandom(9)).decode()},
        separators=(',', ':')).encode()).decode().rstrip('=')
    mac = hmac.new(_derive(b'oauth-state'), body.encode(), hashlib.sha256).hexdigest()
    return body + '.' + mac


def read_state(state: str, now: float | None = None) -> tuple[str, str]:
    """Devuelve (holding_id, subject) o lanza StorageCryptoError."""
    try:
        body, mac = state.split('.')
        expected = hmac.new(_derive(b'oauth-state'), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(mac, expected):
            raise ValueError
        data = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
        if int(data['e']) < (now or time.time()) or not isinstance(data['h'], str) or not isinstance(data['s'], str) or not data['s']:
            raise ValueError
        return data['h'], data['s']
    except (ValueError, KeyError, TypeError, AttributeError):
        raise StorageCryptoError('connection permit invalid or expired') from None


# ---- Archivos: cifrado por bloques en flujo.
def _nonce(prefix: bytes, index: int) -> bytes:
    return prefix + struct.pack('>I', index)


def _aad(file_id: str, index: int, last: bool) -> bytes:
    return b'nl360-file:' + str(file_id).encode() + b':' + struct.pack('>IB', index, 1 if last else 0)


def encrypt_stream(key: bytes, file_id: str, chunks):
    """Recibe bloques de bytes de cualquier tamaño y entrega el archivo cifrado por partes."""
    aes = AESGCM(key)
    prefix = os.urandom(8)
    yield MAGIC + prefix
    buffer = b''
    index = 0
    for piece in chunks:
        buffer += piece
        while len(buffer) > CHUNK:        # se conserva al menos un bloque para poder marcar el último
            block, buffer = buffer[:CHUNK], buffer[CHUNK:]
            yield aes.encrypt(_nonce(prefix, index), block, _aad(file_id, index, False))
            index += 1
            if index >= 2 ** 32 - 1:
                raise StorageCryptoError('file too large')
    yield aes.encrypt(_nonce(prefix, index), buffer, _aad(file_id, index, True))


def decrypt_stream(key: bytes, file_id: str, chunks):
    """Descifra y verifica. Lanza StorageCryptoError si el archivo está alterado, truncado o no es de esta empresa."""
    aes = AESGCM(key)
    buffer = b''
    source = iter(chunks)
    header = len(MAGIC) + 8
    exhausted = False

    def fill(size):
        nonlocal buffer, exhausted
        while len(buffer) < size and not exhausted:
            try:
                buffer += next(source)
            except StopIteration:
                exhausted = True

    fill(header)
    if len(buffer) < header or buffer[:len(MAGIC)] != MAGIC:
        raise StorageCryptoError('not an encrypted Northlane360 file')
    prefix, buffer = buffer[len(MAGIC):header], buffer[header:]
    index = 0
    sealed = CHUNK + TAG
    while True:
        fill(sealed + 1)                   # un byte más para saber si este bloque es el último
        last = len(buffer) <= sealed
        block, buffer = buffer[:sealed], buffer[sealed:]
        if len(block) < TAG:
            raise StorageCryptoError('file is truncated')
        try:
            yield aes.decrypt(_nonce(prefix, index), block, _aad(file_id, index, last))
        except InvalidTag:
            raise StorageCryptoError('file does not pass verification') from None
        if last:
            return
        index += 1


def encrypted_size(plain_size: int) -> int:
    blocks = max(1, -(-plain_size // CHUNK))
    return len(MAGIC) + 8 + plain_size + blocks * TAG

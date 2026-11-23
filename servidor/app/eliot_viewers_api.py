"""Observadores de La Factoría: el propietario invita con un enlace de un solo uso, ve a quién tiene y retira el acceso.

· El enlace lleva un código que solo se enseña una vez, al crearlo. En la base se guarda su huella, no el código.
· Invitar y retirar exigen ser el propietario del holding (lo comprueba la base) y el permiso de gestión del token.
· Un observador no puede ver esta lista, ni invitar, ni retirar: sus peticiones que no son de consulta se rechazan antes de llegar aquí.
· Canjear lo hace la persona invitada, con su propia cuenta; no necesita ningún permiso previo.
"""
import hashlib
import re
import secrets
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import Field

from app import eliot_readonly
from app import organizations_api as identity
from app.eliot_tool_control_api import StrictRequest, _cursor

router = APIRouter(prefix='/v1/me', tags=['eliot-viewers'])
FUNCTIONS = ('eliot.owner_create_viewer_invite(uuid,text,text,integer)', 'eliot.redeem_viewer_invite(text)', 'eliot.owner_viewers(uuid)',
             'eliot.owner_revoke_viewer(uuid,uuid)', 'eliot.my_viewer_owner_subject()')
HOURS = 72
TOKEN = re.compile(r'^[A-Za-z0-9_-]{30,80}$')


def _ready(cur):
    for signature in FUNCTIONS:
        cur.execute('SELECT to_regprocedure(%s)', (signature,))
        row = cur.fetchone()
        if not row or not row[0]:
            raise HTTPException(503, 'Viewer access unavailable')


def _fingerprint(token):
    return hashlib.sha256(token.encode()).hexdigest()


class NewInvite(StrictRequest):
    label: str = Field(min_length=1, max_length=80, pattern=r'^[^\x00-\x1f\x7f]+$')


class Redeem(StrictRequest):
    token: str = Field(min_length=30, max_length=80)


def _owner_only():
    if eliot_readonly.is_viewer():
        raise HTTPException(403, 'Acceso de solo consulta')


@router.get('/holding/{holding_id}/viewers')
def list_viewers(holding_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization)
    _owner_only()
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute('SELECT eliot.owner_viewers(%s)', (holding_id,))
        row = cur.fetchone()
    data = row[0] if row else None
    if not isinstance(data, dict) or data.get('holding_id') != str(holding_id) or not isinstance(data.get('viewers'), list) or not isinstance(data.get('invites'), list):
        raise HTTPException(503, 'Viewer list unconfirmed')
    return {'holding_id': str(holding_id), 'invite_hours': HOURS,
            'viewers': [{'id': v['id'], 'label': v['label'], 'since': v['since']} for v in data['viewers'][:20]],
            'invites': [{'id': i['id'], 'label': i['label'], 'expires_at': i['expires_at']} for i in data['invites'][:20]]}


@router.post('/holding/{holding_id}/viewers/invites', status_code=201)
def create_invite(holding_id: UUID, body: NewInvite, authorization: str | None = Header(default=None)):
    subject = identity._require_approval_scope(authorization)
    _owner_only()
    if not body.label.strip():
        raise HTTPException(422, 'Label required')
    token = secrets.token_urlsafe(32)
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute('SELECT eliot.owner_create_viewer_invite(%s,%s,%s,%s)', (holding_id, body.label.strip(), _fingerprint(token), HOURS))
        row = cur.fetchone()
        r = row[0] if row else None
        if not isinstance(r, dict) or r.get('created') is not True or r.get('holding_id') != str(holding_id) or not isinstance(r.get('invite_id'), str):
            raise HTTPException(503, 'Invite unconfirmed')
    # El código solo sale aquí, una vez. Después nadie puede recuperarlo.
    return {'holding_id': str(holding_id), 'invite_id': r['invite_id'], 'label': r['label'], 'expires_at': r['expires_at'], 'token': token}


@router.post('/holding/{holding_id}/viewers/{item_id}/revoke')
def revoke(holding_id: UUID, item_id: UUID, authorization: str | None = Header(default=None)):
    subject = identity._require_approval_scope(authorization)
    _owner_only()
    with _cursor(subject) as cur:
        _ready(cur)
        cur.execute('SELECT eliot.owner_revoke_viewer(%s,%s)', (holding_id, item_id))
        row = cur.fetchone()
        r = row[0] if row else None
        if not isinstance(r, dict) or r.get('revoked') is not True or r.get('id') != str(item_id):
            raise HTTPException(503, 'Revocation unconfirmed')
    eliot_readonly.forget()     # se nota al momento
    return {'holding_id': str(holding_id), 'id': str(item_id), 'kind': r.get('kind'), 'revoked': True}


@router.post('/viewer-invites/redeem')
def redeem(body: Redeem, authorization: str | None = Header(default=None)):
    subject = identity.verified_identity(authorization)
    if eliot_readonly.is_viewer():
        raise HTTPException(409, 'Ya tienes acceso de consulta')
    if not TOKEN.fullmatch(body.token):
        raise HTTPException(422, 'Invitación no válida')
    try:
        with _cursor(subject) as cur:
            _ready(cur)
            cur.execute('SELECT eliot.redeem_viewer_invite(%s)', (_fingerprint(body.token),))
            row = cur.fetchone()
            r = row[0] if row else None
            if not isinstance(r, dict) or r.get('joined') is not True or not isinstance(r.get('holding'), str):
                raise HTTPException(503, 'Invite unconfirmed')
    except HTTPException as error:
        if error.status_code == 409:
            raise HTTPException(409, 'La invitación no es válida: ha caducado, ya se usó, o esta cuenta no puede usarla') from None
        raise
    eliot_readonly.forget(subject)
    return {'joined': True, 'holding': r['holding']}

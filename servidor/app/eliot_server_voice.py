"""Bounded TTS for a signed, recently issued Eliot answer; no arbitrary text proxy."""
import hashlib
import hmac
import json
import os
import time
import urllib.request
from uuid import uuid4
import jwt
from fastapi import HTTPException
from app import eliot_durable_budget as budget
from app.eliot_model_limits import reserve_model_request

MAX_TEXT = 1800
MODEL = 'gpt-4o-mini-tts'

def enabled(org):
    return (os.getenv('ELIOT_SERVER_VOICE_ENABLED') == 'true'
            and os.getenv('ELIOT_OPENAI_ENABLED') == 'true'
            and bool(os.getenv('OPENAI_API_KEY'))
            and str(org) in {s.strip() for s in os.getenv('ELIOT_OPENAI_ALLOWED_ORGANIZATIONS','').split(',')})

def signing_key():
    return hmac.new(os.environ['OPENAI_API_KEY'].encode(),b'eliot-answer-voice-v1',hashlib.sha256).digest()

def grant(org,subject,text):
    if not enabled(org) or not isinstance(text,str) or not 1 <= len(text) <= MAX_TEXT:
        return None
    return jwt.encode({'aud':'eliot-answer-voice-v1','sub':subject,'org':str(org),
        'digest':hashlib.sha256(text.encode()).hexdigest(),'exp':int(time.time())+600,
        'jti':str(uuid4())},signing_key(),algorithm='HS256')

def synthesize(org,subject,text,token):
    if not enabled(org):
        raise HTTPException(503,'Server voice unavailable')
    try:
        claims=jwt.decode(token,signing_key(),algorithms=['HS256'],audience='eliot-answer-voice-v1',options={'require':['exp','sub','org','digest','jti']})
        if claims['sub'] != subject or claims['org'] != str(org) or not hmac.compare_digest(claims['digest'],hashlib.sha256(text.encode()).hexdigest()):
            raise ValueError('scope')
    except (jwt.PyJWTError,ValueError,TypeError):
        raise HTTPException(403,'Voice answer authorization expired or invalid') from None
    if not reserve_model_request(str(org)):
        raise HTTPException(429,'Voice request limit reached')
    # Separate durable reservation per playback; audio units are conservative capacity,
    # not provider token usage or a currency invoice. No invented reconciliation.
    ok,_=budget.reserve(str(org),subject,estimated_units=10000)
    if not ok:
        raise HTTPException(429,'Voice budget unavailable')
    req=urllib.request.Request('https://api.openai.com/v1/audio/speech',
        data=json.dumps({'model':MODEL,'voice':'alloy','input':text,'response_format':'mp3',
                         'instructions':'Habla en español de España, con tono sereno y profesional.'}).encode(),
        headers={'Authorization':'Bearer '+os.environ['OPENAI_API_KEY'],'Content-Type':'application/json'},method='POST')
    try:
        with urllib.request.urlopen(req,timeout=30) as response:
            content=response.read(2_000_001)
            media=response.headers.get('Content-Type','').split(';')[0]
        if not content or len(content)>2_000_000 or media not in ('audio/mpeg','audio/mp3','application/octet-stream'):
            raise ValueError('audio')
        return content
    except Exception:
        raise HTTPException(502,'Voice provider unavailable; written answer remains available') from None

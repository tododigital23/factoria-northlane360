"""La voz de Freddy en Telegram: entiende los audios del jefe y le habla cuando algo es urgente.

  * transcribe(): baja la nota de voz de Telegram y la pasa a texto. A partir de ahí se trata como un mensaje escrito.
  * speak() + send_voice(): convierte un aviso urgente en una nota de voz y la envía al chat del jefe.

Claude no tiene voz ni oído, así que las dos cosas van por OpenAI (el mismo proveedor que ya da voz a Freddy en la web).
Eso significa que lo que el jefe dice en un audio, y el texto de un aviso urgente, viajan a OpenAI. El aviso hablado
lleva la empresa, el tipo de aviso y cuántos casos; nunca datos de clientes.

Variables: OPENAI_API_KEY. Se apaga con ELIOT_FREDDY_VOICE=off. Sin clave, Freddy sigue funcionando solo por escrito.
"""
import os

import httpx

STT_MODEL = os.getenv('ELIOT_FREDDY_STT_MODEL') or 'whisper-1'
TTS_MODEL = 'gpt-4o-mini-tts'
MAX_SECONDS = 120            # notas de voz de hasta dos minutos
MAX_BYTES = 4 * 1024 * 1024
MAX_SPOKEN_PER_DAY = 12      # audios urgentes al día; por encima, solo texto


def enabled():
    return bool(os.getenv('OPENAI_API_KEY')) and os.getenv('ELIOT_FREDDY_VOICE') != 'off'


def _auth():
    return {'Authorization': 'Bearer ' + os.environ['OPENAI_API_KEY']}


def transcribe(token, file_id):
    """Texto de una nota de voz de Telegram, o None si no se pudo. Nunca lanza."""
    try:
        with httpx.Client(timeout=httpx.Timeout(40.0, connect=5.0), follow_redirects=False) as client:
            r = client.post(f'https://api.telegram.org/bot{token}/getFile', json={'file_id': file_id})
            info = r.json().get('result') if r.status_code == 200 else None
            path = info.get('file_path') if isinstance(info, dict) else None
            if not isinstance(path, str) or '..' in path or int(info.get('file_size') or 0) > MAX_BYTES:
                return None
            audio = client.get(f'https://api.telegram.org/file/bot{token}/{path}')
            if audio.status_code != 200 or not audio.content or len(audio.content) > MAX_BYTES:
                return None
            r = client.post('https://api.openai.com/v1/audio/transcriptions', headers=_auth(),
                            data={'model': STT_MODEL, 'language': 'es', 'response_format': 'json'},
                            files={'file': ('nota.ogg', audio.content, 'audio/ogg')})
        text = r.json().get('text') if r.status_code == 200 else None
        return text.strip()[:1000] if isinstance(text, str) and text.strip() else None
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return None


def speak(text, *, max_chars=600, instructions=None):
    """Audio (ogg/opus, el formato de las notas de voz de Telegram) con ese texto, o None."""
    if not isinstance(text, str) or not text.strip():
        return None
    style = instructions or (
        'Habla en español de España, con tono sereno y claro, como un director que avisa de algo urgente.'
    )
    limit = max(80, min(int(max_chars or 600), 4000))
    try:
        with httpx.Client(timeout=httpx.Timeout(60.0, connect=5.0), follow_redirects=False) as client:
            r = client.post('https://api.openai.com/v1/audio/speech', headers=_auth(),
                            json={'model': TTS_MODEL, 'voice': 'alloy', 'input': text.strip()[:limit],
                                  'response_format': 'opus', 'instructions': style[:500]})
        return r.content if r.status_code == 200 and r.content and len(r.content) <= MAX_BYTES else None
    except httpx.HTTPError:
        return None


def send_voice_bytes(token, chat, audio, filename='freddy.ogg'):
    """Sube un ogg/opus a Telegram como nota de voz. True si llegó."""
    if not audio:
        return False
    try:
        with httpx.Client(timeout=httpx.Timeout(30.0, connect=5.0), follow_redirects=False) as client:
            r = client.post(f'https://api.telegram.org/bot{token}/sendVoice', data={'chat_id': chat},
                            files={'voice': (filename, audio, 'audio/ogg')})
        return r.status_code == 200
    except httpx.HTTPError:
        return False


def voice_sender(token, chat):
    """Devuelve una función que dice un texto en el chat del jefe como nota de voz. True si se envió."""
    state = {'day': None, 'count': 0}

    def say(text, day):
        if not enabled():
            return False
        if state['day'] != day:
            state['day'], state['count'] = day, 0
        if state['count'] >= MAX_SPOKEN_PER_DAY:
            return False
        audio = speak(text)
        ok = send_voice_bytes(token, chat, audio, 'aviso.ogg')
        state['count'] += 1 if ok else 0
        if not ok:
            print('notifier: no se pudo enviar el audio urgente', flush=True)
        return ok
    return say

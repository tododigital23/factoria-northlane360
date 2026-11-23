"""Chat con un agente de la oficina: solo sus datos verificados, en primera persona, sin inventar y sin quedarse mudo."""
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, patch
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import eliot_agent_chat as ac
from app.organizations_api import router

W = '22222222-2222-4222-8222-222222222222'
OTRO = '99999999-9999-4999-8999-999999999999'
worker = {'id': W, 'department_id': 'd1', 'name': 'Analista SEO', 'specialty': 'SEO', 'state': 'idle'}
tasks = [{'id': 't1', 'assignee': W, 'title': 'Revisar títulos', 'status': 'blocked'}, {'id': 't2', 'assignee': W, 'title': 'Informe de octubre', 'status': 'completed'},
         {'id': 't3', 'assignee': OTRO, 'title': 'Secreto de otro agente', 'status': 'pending'}, {'id': 't4', 'assignee': None, 'title': 'Sin dueño', 'status': 'pending'}]


@pytest.fixture(autouse=True)
def limpio(monkeypatch):
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    ac._used.clear(); ac._history.clear()


def claude(texto='Tengo una tarea bloqueada: «Revisar títulos».', stop='end_turn'):
    c = MagicMock(); c.beta.messages.create.return_value = NS(stop_reason=stop, content=[NS(type='text', text=texto)]); return c


def test_sin_ia_contesta_con_sus_datos_y_solo_los_suyos():
    texto, modo = ac.answer('u', 'Tienda', worker, 'SEO y Contenidos', tasks, '¿qué tienes?')
    assert modo == 'verified_data' and 'Soy Analista SEO' in texto and 'Revisar títulos (bloqueada)' in texto and 'Te necesito en 1' in texto
    assert 'Secreto' not in texto and 'Sin dueño' not in texto
    libre, _ = ac.answer('u', 'Tienda', {**worker, 'id': 'x', 'state': 'inactive'}, None, tasks, 'hola')
    assert 'inactivo' in libre and 'No tengo ninguna tarea abierta' in libre and 'Pedir una tarea' in libre


def test_con_ia_solo_ve_los_datos_del_agente_y_recuerda_la_conversacion():
    c = claude()
    texto, modo = ac.answer('u', 'Tienda', worker, 'SEO y Contenidos', tasks, '¿en qué me necesitas?', client=c)
    assert modo == 'grounded_ai' and 'Revisar títulos' in texto
    k = c.beta.messages.create.call_args.kwargs
    assert k['model'] == ac.MODEL and 'Revisar títulos' in k['system'] and 'Secreto' not in k['system'] and 'Sin dueño' not in k['system'] and 'no inventes' in k['system']
    ac.answer('u', 'Tienda', worker, 'SEO y Contenidos', tasks, '¿y qué más?', client=c)
    assert [m['role'] for m in c.beta.messages.create.call_args.kwargs['messages']] == ['user', 'assistant', 'user']
    ac.answer('otro', 'Tienda', worker, 'SEO y Contenidos', tasks, 'hola', client=c)
    assert len(c.beta.messages.create.call_args.kwargs['messages']) == 1                       # otra persona: otra conversación


def test_si_la_ia_falla_se_niega_o_se_pasa_del_tope_contesta_el_texto_fijo():
    roto = MagicMock(); roto.beta.messages.create.side_effect = RuntimeError('caído')
    for c in (roto, claude(stop='refusal'), claude(texto='  ')):
        assert ac.answer('u', 'Tienda', worker, 'SEO', tasks, 'hola', client=c)[1] == 'verified_data'
    assert ac.answer('u', 'Tienda', worker, 'SEO', tasks, 'hola', use_ai=False, client=claude())[1] == 'verified_data'
    ac._used.clear(); c = claude()
    modos = [ac.answer('u', 'Tienda', worker, 'SEO', tasks, 'hola', client=c, now=1000.0)[1] for _ in range(ac.PER_HOUR + 3)]
    assert modos.count('grounded_ai') == ac.PER_HOUR and modos[-1] == 'verified_data'
    assert ac.answer('u', 'Tienda', worker, 'SEO', tasks, 'hola', client=c, now=1000.0 + 3700)[1] == 'grounded_ai'   # pasada la hora, vuelve


ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
D = '11111111-1111-4111-8111-111111111111'


def conexion(rol='owner'):
    connection = MagicMock(); cur = connection.__enter__.return_value.cursor.return_value.__enter__.return_value
    cur.fetchall.side_effect = [[(UUID(ORG), 'Tienda', rol)], [(UUID(D), 'SEO y Contenidos')], [(UUID(W), UUID(D), 'Analista SEO', 'SEO', 'idle')],
                                [(UUID('33333333-3333-4333-8333-333333333333'), UUID(D), UUID(W), 'Revisar títulos', 'blocked', None)], []]
    return connection


def test_la_ruta_contesta_como_el_agente_y_rechaza_uno_que_no_es_de_la_empresa():
    app = FastAPI(); app.include_router(router); client = TestClient(app)
    url = f'/v1/me/organizations/{ORG}/eliot/chat'
    with patch('app.organizations_api.verified_identity', return_value='u|1'), patch('app.organizations_api.db_params', return_value={}), \
         patch('app.organizations_api.psycopg.connect', return_value=conexion()):
        r = client.post(url, headers={'Authorization': 'Bearer x'}, json={'question': '¿qué tienes?', 'worker_id': W})
    assert r.status_code == 200 and r.json()['worker_id'] == W and r.json()['mode'] == 'verified_data' and 'Revisar títulos' in r.json()['answer'] and 'speech_grant' not in r.json()
    with patch('app.organizations_api.verified_identity', return_value='u|1'), patch('app.organizations_api.db_params', return_value={}), \
         patch('app.organizations_api.psycopg.connect', return_value=conexion()):
        assert client.post(url, headers={'Authorization': 'Bearer x'}, json={'question': 'hola', 'worker_id': OTRO}).status_code == 404
        assert client.post(url, headers={'Authorization': 'Bearer x'}, json={'question': 'hola', 'worker_id': 'no-es-un-id'}).status_code == 422


def propone(encargo, entregable='Un informe con los cambios', texto=''):
    c = MagicMock()
    bloques = ([NS(type='text', text=texto)] if texto else []) + [NS(type='tool_use', name='proponer_encargo', input={'encargo': encargo, 'entregable': entregable})]
    c.beta.messages.create.return_value = NS(stop_reason='tool_use', content=bloques)
    return c


def test_el_agente_sabe_lo_que_hace_su_departamento_y_puede_proponer_un_encargo():
    c = propone('Revisar los títulos y descripciones de las 10 páginas con más visitas y proponer cambios.')
    text, mode, proposal = ac.converse('jefe', 'Tienda', worker, 'SEO y Contenidos', tasks, 'revísame los títulos de las páginas más vistas', client=c)
    assert mode == 'grounded_ai' and 'confírmalo' in text and 'no se crea nada' in text
    assert proposal == {'request': 'Revisar los títulos y descripciones de las 10 páginas con más visitas y proponer cambios.', 'deliverable': 'Un informe con los cambios'}
    kw = c.beta.messages.create.call_args.kwargs
    assert kw['tools'][0]['name'] == 'proponer_encargo' and kw['tools'][0]['strict'] is True and 'tool_choice' not in kw
    assert 'Lo que sabes hacer: Revisar títulos y descripciones' in kw['system'] and 'Tus límites' in kw['system']
    # lo que se recuerda es texto, nunca la llamada a la herramienta
    assert all(isinstance(m['content'], str) for m in ac._history[('jefe', W)]) and 'Encargo propuesto' in ac._history[('jefe', W)][-1]['content']
    assert ac.answer('jefe', 'Tienda', worker, 'SEO', tasks, 'hola', client=claude()) == ('Tengo una tarea bloqueada: «Revisar títulos».', 'grounded_ai')


def test_una_propuesta_mal_formada_no_llega_y_el_observador_no_recibe_ninguna():
    for malo in ('corto', 'x' * 700, 42, None):
        ac._history.clear()
        _text, _mode, proposal = ac.converse('jefe', 'Tienda', worker, 'SEO', tasks, 'hazme algo', client=propone(malo, texto='Vale.'))
        assert proposal is None
    c = propone('Revisar los títulos de las páginas más vistas y proponer cambios.', texto='Te lo preparo.')
    text, _mode, proposal = ac.converse('jefe', 'Tienda', worker, 'SEO', tasks, 'hazme algo', client=c, propose=False)
    assert proposal is None and 'tools' not in c.beta.messages.create.call_args.kwargs and text == 'Te lo preparo.'
    assert ac.clean_proposal({'encargo': 'Revisar\x00 los títulos de la web', 'entregable': None}) == {'request': 'Revisar los títulos de la web', 'deliverable': None}
    assert ac.skills('Atención y Email').startswith('Preparar borradores') and ac.skills(None) == ac.DEFAULT_SKILL
    assert 'Lo que puedo hacer por ti' in ac.fallback({**worker, 'id': OTRO + 'x'}, 'Pedidos', [])

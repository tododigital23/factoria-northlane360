from contextlib import contextmanager
from copy import deepcopy
from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import eliot_objective_planning_api as api

ORG = UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
KEY = UUID('11111111-1111-4111-8111-111111111111')
SOURCE = {'owner': 'Nova', 'repo': 'project', 'ref': 'ci', 'prefix': 'docs/'}
app = FastAPI(); app.include_router(api.router); client = TestClient(app)
BASE = f'/v1/me/organizations/{ORG}/execution/objective-planning'


def payload():
    return {'objective': 'Mejorar la documentación del proyecto', 'request_key': str(KEY),
            'confirm_save': True, 'steps': [
                {'title': title, 'department_id': str(KEY), 'worker_id': str(KEY),
                 'deliverable': 'Informe con hallazgos y referencias',
                 'acceptance': 'Cada hallazgo cita evidencia verificable',
                 'repository': 'Nova/project', 'path': 'docs/CI.md', 'ref': 'ci', 'sha': 'a' * 40}
                for title in ('Diagnóstico documental', 'Recomendaciones documentales')]}


@pytest.mark.parametrize('method', ['get', 'post'])
def test_authentication_and_ownership_precede_storage(method):
    with patch.object(api, '_cursor') as db:
        result = getattr(client, method)(BASE, **({'json': payload()} if method == 'post' else {}))
        assert result.status_code == 401
        db.assert_not_called()
    with patch.object(api, '_owner', side_effect=HTTPException(403, 'Owner only')), patch.object(api, '_cursor') as db:
        result = getattr(client, method)(BASE, **({'json': payload()} if method == 'post' else {}))
        assert result.status_code == 403
        db.assert_not_called()


@pytest.mark.parametrize('change', ['consent', 'actor', 'count', 'duplicate', 'blank', 'whitespace', 'numeric_consent'])
def test_invalid_breakdowns_never_open_storage(change):
    body = payload()
    if change == 'consent': body['confirm_save'] = False
    if change == 'numeric_consent': body['confirm_save'] = 1
    if change == 'actor': body['created_by'] = str(KEY)
    if change == 'count': body['steps'] = body['steps'][:1]
    if change == 'duplicate': body['steps'][1]['title'] = body['steps'][0]['title'].upper()
    if change == 'blank': body['steps'][0]['acceptance'] = ' ' * 10
    if change == 'whitespace': body['steps'][0]['deliverable'] = ' x ' * 3
    with patch.object(api, '_cursor') as db:
        assert client.post(BASE, json=body).status_code == 422
        db.assert_not_called()


@pytest.mark.parametrize('field,value', [('repository', 'Other/private'), ('ref', 'other'), ('path', 'docs/../private.md'), ('path', 'docs/%2e%2e/file.md'), ('path', 'docs/file.py')])
def test_every_source_is_checked_before_any_write(field, value):
    body = payload(); body['steps'][1][field] = value
    with patch.object(api, '_owner', return_value='verified'), patch.object(api, 'sources_for', return_value=[SOURCE]), patch.object(api, '_cursor') as db:
        assert client.post(BASE, json=body).status_code in (409, 422)
        db.assert_not_called()


def test_save_reuses_scoped_functions_and_stable_keys_without_dispatch():
    cur = MagicMock(); ids = [uuid4() for _ in range(5)]
    body = api.ObjectiveBreakdown(**payload())
    cur.fetchone.side_effect = [(i,) for i in ids]
    result = api.save_in_transaction(cur, ORG, body)
    calls = list(cur.execute.call_args_list)
    assert result['mission_id'] == str(ids[-1]) and result['atomic_save'] is True
    assert result['provider_called'] is result['source_fetched'] is result['execution_started'] is False
    assert result['permissions_granted'] is result['budget_reserved'] is False
    assert [c.args[0].split('eliot.')[1].split('(')[0] for c in calls] == [
        'create_task_for_owner', 'owner_create_document_plan', 'create_task_for_owner',
        'owner_create_document_plan', 'owner_create_document_mission']
    assert all(c.args[1][0] == ORG for c in calls)
    assert 'Criterio de revisión:' in calls[1].args[1][3]
    assert calls[-1].args[1][2] == [ids[1], ids[3]]
    cur.fetchone.side_effect = [(i,) for i in ids]
    api.save_in_transaction(cur, ORG, body)
    assert cur.execute.call_args_list[5:] == calls


def test_response_waits_for_commit_and_commit_error_is_not_success():
    cur = MagicMock(); committed = []
    @contextmanager
    def transaction(_):
        yield cur
        committed.append(True)
    with patch.object(api, '_owner', return_value='verified') as owner, patch.object(api, 'sources_for', return_value=[SOURCE]), patch.object(api, '_cursor', transaction), patch.object(api, 'ready', return_value=True), patch.object(api, 'save_in_transaction', return_value={'saved': True}):
        result = client.post(BASE, json=payload())
    assert result.status_code == 201 and committed == [True]
    owner.assert_called_once_with(ORG, None, write=True)
    @contextmanager
    def failed_commit(_):
        yield cur
        raise HTTPException(503, 'Unconfirmed commit')
    with patch.object(api, '_owner', return_value='verified'), patch.object(api, 'sources_for', return_value=[SOURCE]), patch.object(api, '_cursor', failed_commit), patch.object(api, 'ready', return_value=True), patch.object(api, 'save_in_transaction', return_value={'saved': True}):
        assert client.post(BASE, json=payload()).status_code == 503


def test_capability_unavailable_does_not_present_a_working_save():
    @contextmanager
    def cursor(_): yield MagicMock()
    with patch.object(api, '_owner', return_value='verified'), patch.object(api, '_cursor', cursor), patch.object(api, 'ready', return_value=False), patch.object(api, 'sources_for', return_value=[SOURCE]):
        result = client.get(BASE).json()
        assert result['enabled'] is False and result['proposal_mode'] == 'guided_documentary'
        assert not result['provider_called']
        assert client.post(BASE, json=payload()).status_code == 503

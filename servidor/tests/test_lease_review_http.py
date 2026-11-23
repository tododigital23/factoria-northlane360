from datetime import datetime, timezone
from uuid import uuid4
from unittest.mock import patch
import psycopg
import pytest
from fastapi import HTTPException
from test_tool_control_http import environment,client,BASE,ORG,TASK,WORKER,LEASE,KEY

BODY={'worker_id':str(WORKER),'previous_lease_id':str(LEASE),
      'reason':'Previous outcome confirmed; request a fresh reservation','request_key':str(KEY)}

def test_review_binds_owner_task_previous_lease_worker_reason_and_key():
    new=uuid4()
    with environment() as (cur,_,_,_,_):
        cur.fetchone.return_value=(new,)
        result=client.post(BASE+'/lease/review',json=BODY)
        assert cur.execute.call_args.args[1]==(ORG,TASK,LEASE,WORKER,BODY['reason'],KEY)
    assert result.status_code==201
    assert result.json()['lease_id']==str(new)
    assert result.json()['execution_started'] is False
    assert result.json()['requires_fresh_tool_approval'] is True
    assert 'usable' not in result.json()

@pytest.mark.parametrize('change',[{'reason':'short'},{'previous_lease_id':'invalid'},{'organization_id':str(uuid4())}])
def test_invalid_review_never_reaches_storage(change):
    with environment() as (_,db,_,_,_):
        result=client.post(BASE+'/lease/review',json={**BODY,**change})
        db.assert_not_called()
    assert result.status_code==422

def test_review_denies_anonymous_and_missing_scope():
    with patch('app.organizations_api.psycopg.connect') as db:
        assert client.post(BASE+'/lease/review',json=BODY).status_code==401
        db.assert_not_called()
    with environment() as (_,db,_,_,scope):
        scope.side_effect=HTTPException(403,'scope')
        assert client.post(BASE+'/lease/review',json=BODY).status_code==403
        db.assert_not_called()

def test_unconfirmed_outcome_conflict_is_sanitized():
    with environment() as (cur,_,_,_,_):
        cur.execute.side_effect=[None,psycopg.errors.ObjectNotInPrerequisiteState('private details')]
        result=client.post(BASE+'/lease/review',json=BODY)
    assert result.status_code==409 and 'private details' not in result.text

def test_missing_migration_reports_unavailable_without_leaking_sql():
    with environment() as (cur,_,_,_,_):
        cur.execute.side_effect=[None,psycopg.errors.UndefinedFunction('private SQL')]
        result=client.post(BASE+'/lease/review',json=BODY)
    assert result.status_code==503 and 'private SQL' not in result.text

def test_review_history_owner_scope_and_exact_lease_generations():
    review,new=uuid4(),uuid4()
    with environment() as (cur,_,_,_,_):
        cur.fetchall.return_value=[(review,LEASE,new,BODY['reason'],datetime.now(timezone.utc))]
        result=client.get(BASE+'/lease/reviews')
        assert cur.execute.call_args.args[1]==(ORG,TASK)
    assert result.status_code==200
    assert result.json()[0]['previous_lease_id']==str(LEASE)
    assert result.json()[0]['new_lease_id']==str(new)

def test_missing_review_functions_do_not_disable_existing_read_capability():
    with environment() as (cur,_,_,_,_):
        cur.fetchone.side_effect=[(True,),(False,)]
        with patch('app.eliot_github_dispatch.enabled_for',return_value=True),patch('app.eliot_github_reader.configured',return_value=True):
            result=client.get(f'/v1/me/organizations/{ORG}/execution/github-tool-capability')
    assert result.status_code==200
    assert result.json()['enabled'] is True
    assert result.json()['lease_review_ready'] is False

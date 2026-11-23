from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import psycopg
import pytest
from fastapi import HTTPException
from app.eliot_tool_recovery import review_tool_state
from test_tool_control_http import environment,client,BASE,ORG,TASK,WORKER,LEASE

NOW=datetime.now(timezone.utc)
def lease(state='held',expired=False):
    return {'state':state,'expires_at':(NOW+timedelta(seconds=-1 if expired else 60)).isoformat()}
def invocation(status='claimed'):
    return {'invocation_id':'attempt','status':status}

@pytest.mark.parametrize('l,attempts,state,review,suspend',[
    (None,[],'no_lease',False,False),
    (lease(),[],'lease_held',False,False),
    (lease(),[invocation('completed')],'attempts_recorded',False,False),
    (lease(),[invocation('failed')],'attempts_recorded',False,False),
    (lease(),[invocation()],'in_progress_or_unconfirmed',False,True),
    (lease(expired=True),[invocation()],'outcome_unconfirmed',True,True),
    (None,[invocation()],'outcome_unconfirmed',True,True),
    (lease('released'),[],'released_requires_review',True,True),
    (lease(expired=True),[],'expired_requires_review',True,True),
    (lease('released'),[invocation('completed')],'released_requires_review',True,True),
    (lease(),[invocation('completed'),invocation()],'in_progress_or_unconfirmed',False,True),
])
def test_review_never_claims_success_or_automatically_retries(l,attempts,state,review,suspend):
    result=review_tool_state(l,attempts,now=NOW)
    assert result['state']==state and result['review_required'] is review
    assert result['suspend_new_actions'] is suspend
    assert result['automatic_recovery'] is result['retry_execution'] is result['task_completed'] is False
    assert result['advisory_only'] is True

def test_owner_review_reads_consistent_snapshot_without_mutations_or_network():
    with environment() as (cur,_,_,_,_):
        cur.fetchone.return_value=(LEASE,WORKER,'held',NOW,NOW+timedelta(minutes=1))
        cur.fetchall.return_value=[('attempt','claimed')]
        result=client.get(BASE+'/github-read-review')
        queries=[x.args[0] for x in cur.execute.call_args_list]
    assert result.status_code==200
    assert result.json()['organization_id']==str(ORG) and result.json()['task_id']==str(TASK)
    assert result.json()['state']=='in_progress_or_unconfirmed'
    assert queries[0]=='SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    assert all(q.startswith(('SELECT','SET TRANSACTION')) for q in queries)

def test_review_denies_anonymous_before_database():
    with patch('app.organizations_api.psycopg.connect') as db:
        assert client.get(BASE+'/github-read-review').status_code==401
        db.assert_not_called()

def test_review_owner_gate_precedes_storage():
    with environment() as (_,db,_,owner,_):
        owner.side_effect=HTTPException(403,'denied')
        assert client.get(BASE+'/github-read-review').status_code==403
        db.assert_not_called()

def test_review_storage_failure_exposes_no_details():
    with environment() as (_,db,_,_,_):
        db.side_effect=psycopg.OperationalError('secret connection detail')
        result=client.get(BASE+'/github-read-review')
    assert result.status_code==503 and 'secret' not in result.text

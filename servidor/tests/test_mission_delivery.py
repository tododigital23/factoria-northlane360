from copy import deepcopy
from uuid import uuid4,UUID
from unittest.mock import patch
from contextlib import contextmanager
from tests.test_document_missions import api,client,cur,item,ORG,URL,cursor
from app.eliot_mission_delivery import compile_delivery
import pytest

def fixture():
 raw=item();reports={};reviews={}
 for s in raw['steps']:
  rid=str(uuid4());s.update(job_state='completed',job_id=str(uuid4()),run_id=rid,review_decision='accepted',dependency_satisfied=True)
  reports[rid]=[(UUID(rid),'completed','Exact accepted report',s['repository'],s['path'],s['ref'],s['sha'],'2026-11-08T10:00:00Z','2026-11-08T10:01:00Z')]
  reviews[rid]=(UUID(rid),uuid4(),'accepted','Owner accepted this exact report','2026-11-08T10:02:00Z')
 return raw,api.present(raw),reports,reviews

def test_complete_delivery_retains_exact_reports_without_claiming_global_success():
 raw,m,reports,reviews=fixture();r=compile_delivery(ORG,m,reports,reviews)
 assert len(r['reports'])==2 and r['accepted_steps']==2 and not r['global_objective_verified'] and not r['provider_called'] and not r['task_completed']
 assert [v['run_id'] for v in r['reports']]==[s['run_id'] for s in m['steps']]
 assert r['reports'][0]['report']=='Exact accepted report' and 'request_key' not in r['reports'][0]['review']

@pytest.mark.parametrize('bad',['incomplete','missing_run','wrong_source','empty_report','oversized','no_review','wrong_run_review','changes','chronology','no_timezone','duplicate_run'])
def test_delivery_fails_closed_on_missing_or_inconsistent_evidence(bad):
 _,m,rs,vs=fixture();rid=m['steps'][0]['run_id'];r=list(rs[rid][0]);v=list(vs[rid])
 if bad=='incomplete':m['state']='awaiting_review'
 if bad=='missing_run':rs[rid]=[]
 if bad=='wrong_source':r[6]='b'*40
 if bad=='empty_report':r[2]=' '
 if bad=='oversized':r[2]='x'*6001
 if bad=='no_review':v[1]=None
 if bad=='wrong_run_review':v[0]=uuid4()
 if bad=='changes':v[2]='changes_requested'
 if bad=='chronology':v[4]='2026-11-08T09:00:00Z'
 if bad=='no_timezone':r[7]='2026-11-08T10:00:00'
 if bad=='duplicate_run':m['steps'][1]['run_id']=rid
 if bad!='missing_run':rs[rid]=[tuple(r)]
 vs[rid]=tuple(v)
 with pytest.raises(ValueError):compile_delivery(ORG,m,rs,vs)

def test_delivery_owner_boundary_precedes_storage():
 with patch.object(api,'_cursor') as db:assert client.get(URL+'/'+str(uuid4())+'/delivery').status_code==401
 db.assert_not_called()

def test_delivery_reads_only_exact_accepted_runs_and_reviews():
 raw,m,rs,vs=fixture();cur.reset_mock();cur.fetchall.side_effect=[[(raw,)],*rs.values()];cur.fetchone.side_effect=list(vs.values())
 with patch.object(api,'_owner',return_value='verified') as auth,patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True):r=client.get(URL+'/'+m['id']+'/delivery')
 assert r.status_code==200;auth.assert_called_once_with(ORG,None,write=False)
 calls=cur.execute.call_args_list;assert len(calls)==5 and all(c.args[0].startswith('SELECT') for c in calls)
 cur.fetchall.side_effect=None;cur.fetchone.side_effect=None

def test_delivery_does_not_fetch_reports_before_all_exact_acceptances():
 raw=item();cur.reset_mock();cur.fetchall.side_effect=None;cur.fetchall.return_value=[(raw,)]
 with patch.object(api,'_owner',return_value='verified'),patch.object(api,'_cursor',cursor),patch.object(api,'ready',return_value=True):r=client.get(URL+'/'+raw['id']+'/delivery')
 assert r.status_code==409 and cur.execute.call_count==1

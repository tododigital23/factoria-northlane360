"""Disposable PG18: exact accepted mission delivery uses existing read functions."""
from pathlib import Path
exec(Path('tests/pg/document_missions.py').read_text().split('\ntasks,plans=new_plans(3)')[0])
from app.eliot_mission_state import present
from app.eliot_mission_delivery import compile_delivery

ts,ps=new_plans();mid,_=mission(ps)
for t,p in zip(ts,ps):
 j,_=enqueue(t,p);rid=finish_fixture(j)
 owner('SELECT eliot.owner_review_document_work(%s,%s,%s,%s,%s,%s)',(ORG,t,rid,'accepted','Accepted exact disposable CI report only',uuid4()))
m=present(next(r[0] for r in owner(READ_M,(ORG,)) if r[0]['id']==str(mid)))
reports={};reviews={};before=query('SELECT count(*) FROM eliot.ai_document_jobs')[0][0]
for s in m['steps']:
 reports[s['run_id']]=owner('SELECT run_id,run_status,run_result,source_repo,source_path,source_ref,source_sha,started_at,finished_at FROM eliot.my_document_runs(%s,%s)',(ORG,UUID(s['task_id'])))
 reviews[s['run_id']]=owner('SELECT run_id,review_id,decision,reason,reviewed_at FROM eliot.my_document_work_review(%s,%s,%s)',(ORG,UUID(s['task_id']),UUID(s['run_id'])))[0]
r=compile_delivery(ORG,m,reports,reviews)
assert r['accepted_steps']==2 and not r['global_objective_verified'] and not r['provider_called']
assert r['reports'][0]['report']=='Disposable CI documentary report'
assert query('SELECT count(*) FROM eliot.ai_document_jobs')[0][0]==before
# No substitution when the exact accepted report is outside a bounded history.
from copy import deepcopy
missing=deepcopy(reports);missing[m['steps'][0]['run_id']]=[]
try:compile_delivery(ORG,m,missing,reviews)
except ValueError:pass
else:raise AssertionError('Missing exact run must block delivery')
print('PG18 delivery: exact original reports, source SHA, accepted reviews, no writes or external calls passed')

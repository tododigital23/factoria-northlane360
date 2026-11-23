"""Read-only office projection. Recorded job phases are never worker heartbeats."""
from collections import Counter
from datetime import datetime,timedelta,timezone
from uuid import UUID
MAX_TASKS=20
MAX_WORKERS=120
MAX_DEPARTMENTS=40
JOBS={'queued','claimed','source_verified','provider_started','completed','failed','cancelled','needs_review'}
ACTIVE={'queued','claimed','source_verified','provider_started','needs_review'}

def identifier(v):
 UUID(str(v));return str(v)
def date(v):
 if not isinstance(v,datetime) or v.tzinfo is None:raise ValueError('Invalid timestamp')
 return v

def summarize(org,departments,workers,tasks,histories,leases,reviews,now=None):
 now=date(now or datetime.now(timezone.utc));depts=[];people=[];seen=set();assigned=Counter();signals={};recent=[];counts=Counter();unattributed=0
 for row in departments[:MAX_DEPARTMENTS]:
  did,name=row
  if not isinstance(name,str) or identifier(did) in seen:raise ValueError('Invalid department')
  seen.add(identifier(did));depts.append({'id':str(did),'name':name})
 seen=set()
 for row in workers[:MAX_WORKERS]:
  wid,did,name,specialty,state=row
  if identifier(wid) in seen or not isinstance(name,str) or not isinstance(specialty,str) or state not in {'idle','working','blocked','inactive'}:raise ValueError('Invalid worker')
  seen.add(str(wid));people.append({'id':str(wid),'department_id':identifier(did),'name':name,'specialty':specialty,'recorded_state':state})
 by_worker={w['id']:w for w in people};seen_tasks=set();seen_jobs=set()
 for task in tasks[:MAX_TASKS]:
  tid,did,wid,title,status,created=task;tid=identifier(tid);identifier(did);date(created)
  if tid in seen_tasks or not isinstance(title,str) or status not in {'pending','queued','running','blocked','completed','failed','cancelled'}:raise ValueError('Invalid task')
  seen_tasks.add(tid)
  if wid is not None:assigned[identifier(wid)]+=1
  rows=histories.get(tid,[])
  if len(rows)>20:raise ValueError('Unbounded jobs')
  jobs=[]
  for row in rows:
   jid,rid,lid,state,started,until,cancel,attention,error=row
   if state not in JOBS or type(cancel) is not bool or type(attention) is not bool:raise ValueError('Invalid job state')
   jid=identifier(jid);identifier(rid);identifier(lid);date(started);date(until)
   if jid in seen_jobs or started>now+timedelta(seconds=5):raise ValueError('Invalid job')
   seen_jobs.add(jid);counts[state]+=1
   jobs.append({'id':jid,'run_id':str(rid),'lease_id':str(lid),'state':state,'created_at':started,'until':until,'cancel':cancel,'attention':attention})
  jobs.sort(key=lambda j:(j['created_at'],j['id']),reverse=True)
  if not jobs:continue
  active=[j for j in jobs if j['state'] in ACTIVE];j=active[0] if active else jobs[0]
  lease=leases.get(tid);bound=None
  if lease is not None:
   lid,lwid,lstate,acquired,expires=lease;identifier(lid);identifier(lwid);date(acquired);date(expires)
   if lstate not in {'held','released','expired'}:raise ValueError('Invalid lease')
   w=by_worker.get(str(lwid))
   if str(lid)==j['lease_id'] and w is not None and str(wid)==str(lwid) and str(did)==w['department_id']:bound=w
  decision=reviews.get(tid) if j['state']=='completed' and not active else None
  if decision not in {None,'accepted','changes_requested','unavailable'}:raise ValueError('Invalid review state')
  review='pending' if j['state']=='completed' and decision is None else decision
  attention=j['attention'] or j['cancel'] or j['state'] in {'needs_review','failed'} or review in {'pending','changes_requested','unavailable'} or len(active)>1
  phase=None;animation_until=None
  if j['state'] in ACTIVE:
   eligible=(status=='pending' and bound is not None and lease[2]=='held' and lease[4]>now and j['until']>now and bound['recorded_state'] not in {'inactive','blocked'})
   if attention or not eligible:phase='attention';attention=True
   else:
    phase={'queued':'queued','claimed':'preparing','source_verified':'reading','provider_started':'analyzing'}[j['state']]
    if phase in {'preparing','reading','analyzing'}:animation_until=min(lease[4],j['until'],now+timedelta(seconds=30)).isoformat()
  elif review=='pending':phase='awaiting_review'
  elif attention:phase='attention'
  if bound is not None and phase:signals.setdefault(bound['id'],[]).append((phase,animation_until,j['id'],tid,title))
  elif phase:unattributed+=1
  recent.append({'id':j['id'],'run_id':j['run_id'],'task_id':tid,'task_title':title,'state':j['state'],'worker_id':bound['id'] if bound else None,'created_at':j['created_at'].isoformat(),'review_state':review,'needs_attention':attention})
 priority={'attention':7,'awaiting_review':6,'analyzing':5,'reading':4,'preparing':3,'queued':2}
 for w in people:
  items=signals.get(w['id'],[]);running=[i for i in items if i[0] in {'preparing','reading','analyzing'}]
  chosen=max(items,key=lambda i:priority[i[0]]) if items else None
  phase=chosen[0] if chosen else {'idle':'available','inactive':'inactive','blocked':'blocked','working':'unconfirmed'}[w['recorded_state']]
  if len(running)>1:phase='attention'
  w.update(phase=phase,assigned_tasks_in_sample=assigned[w['id']],animation_until=chosen[1] if chosen and phase in {'preparing','reading','analyzing'} else None,
   job_id=chosen[2] if chosen else None,task_id=chosen[3] if chosen else None,task_title=chosen[4] if chosen else None)
 recent.sort(key=lambda j:(j['created_at'],j['id']),reverse=True)
 return {'organization_id':str(org),'read_only':True,'provider_called':False,'source_fetched':False,'worker_online_verified':False,'observed_at':now.isoformat(),'fresh_for_seconds':30,
  'sample':{'task_limit':MAX_TASKS,'tasks_scanned':min(len(tasks),MAX_TASKS),'jobs_per_task_limit':20,'worker_limit':MAX_WORKERS,'department_limit':MAX_DEPARTMENTS,
   'tasks_truncated':len(tasks)>MAX_TASKS,'workers_truncated':len(workers)>MAX_WORKERS,'departments_truncated':len(departments)>MAX_DEPARTMENTS,'not_full_company_census':True,'unattributed_job_records':unattributed},
  'departments':depts,'workers':people,'task_counts_in_sample':dict(Counter(t[4] for t in tasks[:MAX_TASKS])),
  'job_counts_in_sample':{k:counts[k] for k in sorted(JOBS)},'attention_records_in_sample':sum(j['needs_attention'] for j in recent),
  'recent_jobs':recent[:12],'recent_tasks':[{'id':str(t[0]),'title':t[3],'status':t[4]} for t in tasks[:10]]}

"""Validate and project exact persisted mission state without web dependencies."""
from uuid import UUID
from datetime import datetime

def present(raw):
 if not isinstance(raw,dict):raise ValueError('Invalid mission')
 UUID(raw['id']);date=datetime.fromisoformat(raw['created_at'].replace('Z','+00:00'))
 if not date.tzinfo or not isinstance(raw['objective'],str) or not 10<=len(raw['objective'].strip())<=1000 or type(raw['owner_is_creator']) is not bool:raise ValueError('Invalid mission metadata')
 available=raw.get('mission_control_available',False);control=raw.get('mission_control_state','active');revision=raw.get('mission_control_revision',0);last=raw.get('last_control')
 if type(available) is not bool or control not in {'active','paused','cancelled'} or type(revision) is not int or not 0<=revision<=2147483647 or (not available and (control!='active' or revision!=0 or last is not None)):raise ValueError('Invalid mission control')
 if available and ((revision==0)!=(last is None) or revision==0 and control!='active'):raise ValueError('Missing control history')
 if last is not None:
  if not isinstance(last,dict) or last.get('action') not in {'pause','resume','cancel'} or {'pause':'paused','resume':'active','cancel':'cancelled'}[last['action']]!=control or not isinstance(last.get('reason'),str) or not 10<=len(last['reason'].strip())<=500 or not datetime.fromisoformat(last['created_at'].replace('Z','+00:00')).tzinfo:raise ValueError('Invalid control history')
  last={k:last[k] for k in ('action','reason','created_at')}
 mission_control=control
 steps=raw['steps']
 if not isinstance(steps,list) or not 2<=len(steps)<=5 or type(raw['max_jobs']) is not int or raw['max_jobs']!=len(steps) or type(raw['estimated_token_units']) is not int or raw['estimated_token_units']!=len(steps)*2500:raise ValueError('Invalid mission bounds')
 seen=set();tasks=set();out=[];previous=True
 for pos,s in enumerate(steps,1):
  if type(s.get('position')) is not int or s['position']!=pos:raise ValueError('Invalid step order')
  for k in ('plan_id','task_id','worker_id'):UUID(s[k])
  if s['plan_id'] in seen or s['task_id'] in tasks:raise ValueError('Duplicate mission step')
  seen.add(s['plan_id']);tasks.add(s['task_id'])
  for k in ('task_title','objective','repository','path','ref','sha'):
   if not isinstance(s.get(k),str):raise ValueError('Invalid step metadata')
  if len(s['sha'])!=40 or any(c not in '0123456789abcdef' for c in s['sha']):raise ValueError('Invalid source SHA')
  if type(s.get('scope_current')) is not bool or type(s.get('dependency_satisfied')) is not bool or s['dependency_satisfied']!=previous:raise ValueError('Invalid dependency evidence')
  job=s.get('job_state');decision=s.get('review_decision');control=s.get('control_state')
  if control not in {'active','paused','cancelled'}:raise ValueError('Invalid plan control')
  if job is None:
   if s.get('job_id') is not None or s.get('run_id') is not None or decision is not None:raise ValueError('Invalid unsent plan')
   state='cancelled' if mission_control=='cancelled' or control=='cancelled' else 'paused' if mission_control=='paused' or control=='paused' else 'outdated' if not s['scope_current'] else 'ready' if previous else 'waiting'
  else:
   UUID(s['job_id']);UUID(s['run_id'])
   if job not in {'queued','claimed','source_verified','provider_started','completed','failed','cancelled','needs_review'} or control!='active':raise ValueError('Invalid job')
   if decision not in {None,'accepted','changes_requested'} or decision is not None and job!='completed':raise ValueError('Invalid review')
   if not previous:raise ValueError('Job violated dependency')
   state=(decision or 'awaiting_review') if job=='completed' else job
  previous=previous and job=='completed' and decision=='accepted'
  out.append({k:s[k] for k in ('position','plan_id','task_id','task_title','worker_id','objective','repository','path','ref','sha','job_id','run_id','job_state','review_decision','control_state','scope_current','dependency_satisfied')}|{'state':state,'can_prepare':state=='ready' and raw['owner_is_creator'] and mission_control=='active'})
 states={s['state'] for s in out}
 state='accepted' if previous else 'needs_attention' if states&{'failed','cancelled','needs_review','changes_requested','outdated'} else 'awaiting_review' if 'awaiting_review' in states else 'in_progress' if states&{'queued','claimed','source_verified','provider_started'} else 'paused' if 'paused' in states else 'prepared'
 work_state=state
 if mission_control!='active':state=mission_control
 return {k:raw[k] for k in ('id','objective','created_at','owner_is_creator','max_jobs','estimated_token_units')}|{'state':state,'steps':out,'accepted_steps':sum(s['state']=='accepted' for s in out),'work_state':work_state,'mission_control_available':available,'mission_control_state':mission_control,'mission_control_revision':revision,'last_control':last,'can_control':available and raw['owner_is_creator'] and mission_control!='cancelled' and any(s['job_id'] is None for s in out)}


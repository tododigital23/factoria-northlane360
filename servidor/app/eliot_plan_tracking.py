"""Bounded read model for persisted documentary plans; never drives execution."""
from collections import Counter
from datetime import datetime,timezone
from uuid import UUID
import re
MAX_TASKS=40
MAX_PLANS_PER_TASK=20
MAX_VISIBLE_PLANS=100
JOB_STATES={'queued','claimed','source_verified','provider_started','completed','failed','cancelled','needs_review'}
PLAN_STATES={'paused','prepared','outdated','queued','claimed','source_verified','provider_started','awaiting_review','accepted','changes_requested','failed','cancelled','needs_review'}

def _uuid(value):
 if not isinstance(value,str):raise ValueError('Invalid identifier')
 UUID(value)
 return value

def _date(value):
 if not isinstance(value,str):raise ValueError('Invalid timestamp')
 parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
 if parsed.tzinfo is None:raise ValueError('Timezone required')
 return parsed

def progression(plan):
 job=plan['job_state'];verified=plan['source_verified_at'] is not None;decision=plan['review_decision']
 if job is None:
  state=plan.get('control_state') if plan.get('control_state') in {'paused','cancelled'} else 'prepared' if plan['scope_current'] else 'outdated'
  steps=['cancelled','blocked','blocked'] if state=='cancelled' else ['pending','waiting','waiting']
 elif job in {'failed','cancelled','needs_review'}:
  state=job
  steps=['completed' if verified else ('uncertain' if job=='needs_review' else job),
         ('uncertain' if job=='needs_review' else job) if verified else 'blocked','blocked']
 else:
  state=job
  steps=['completed' if verified else 'in_progress' if job=='claimed' else 'queued','waiting','waiting']
  if job=='source_verified':steps[1]='ready'
  if job=='provider_started':steps[1]='in_progress'
  if job=='completed':
   steps[1]='completed';steps[2]=decision or 'awaiting_review';state=decision or 'awaiting_review'
 return state,[{'id':key,'responsible':responsible,'state':value} for key,responsible,value in zip(
  ['verify_source','analyze_document','review_result'],['worker','worker','owner'],steps)]

def _entry(task,plan,workers,departments):
 if not isinstance(plan,dict) or plan.get('task_id')!=str(task[0]):raise ValueError('Wrong task scope')
 for k in ('id','task_id','worker_id'):_uuid(plan.get(k))
 if plan.get('version')!='document_plan_v1' or type(plan.get('max_jobs')) is not int or plan.get('max_jobs')!=1 or type(plan.get('estimated_token_units')) is not int or plan.get('estimated_token_units')!=2500:raise ValueError('Unsupported plan')
 expected=[{'id':'verify_source','responsible':'worker','depends_on':[]},{'id':'analyze_document','responsible':'worker','depends_on':['verify_source']},{'id':'review_result','responsible':'owner','depends_on':['analyze_document']}]
 if plan.get('steps')!=expected:raise ValueError('Unsupported dependencies')
 for k in ('objective','repository','path','ref','sha','task_status'):
  if not isinstance(plan.get(k),str) or not plan[k]:raise ValueError('Incomplete metadata')
 if len(plan['objective'])>1000 or not re.fullmatch('[0-9a-f]{40}',plan['sha']):raise ValueError('Invalid plan source')
 created=_date(plan.get('created_at'))
 if type(plan.get('scope_current')) is not bool:raise ValueError('Missing current scope')
 job=plan.get('job_state');job_id=plan.get('job_id');run_id=plan.get('run_id')
 if job is None:
  if job_id is not None or run_id is not None or plan.get('source_verified_at') is not None:raise ValueError('Invalid saved plan')
 else:
  if job not in JOB_STATES:raise ValueError('Unknown job state')
  _uuid(job_id);_uuid(run_id)
 verified=plan.get('source_verified_at')
 if verified is not None:_date(verified)
 if job in {'source_verified','provider_started','completed'} and verified is None:raise ValueError('Missing verification record')
 decision=plan.get('review_decision')
 if decision not in {None,'accepted','changes_requested'} or (decision is not None and job!='completed'):raise ValueError('Inconsistent review')
 available=plan.get('control_available',False);control_state=plan.get('control_state','active');revision=plan.get('control_revision',0)
 if type(available) is not bool or control_state not in {'active','paused','cancelled'} or type(revision) is not int or revision<0:raise ValueError('Invalid control metadata')
 if (not available and (control_state!='active' or revision!=0)) or (job is not None and control_state!='active'):raise ValueError('Inconsistent plan control')
 mode=plan.get('analysis_mode','standard_v1' if job is not None else None);approved=plan.get('objective_snapshot')
 if mode not in {None,'standard_v1','objective_v1'} or (job is None and mode is not None):raise ValueError('Invalid analysis mode')
 if mode=='objective_v1':
  if plan.get('objective_plan_id')!=plan['id'] or not isinstance(approved,str) or not 10<=len(approved.strip())<=1000:raise ValueError('Missing objective snapshot')
 elif approved is not None:raise ValueError('Unexpected objective snapshot')
 mission_id=plan.get('mission_id');mission_position=plan.get('mission_position');dependency=plan.get('mission_dependency_satisfied',True)
 if type(dependency) is not bool:raise ValueError('Invalid mission dependency')
 if mission_id is not None:
  _uuid(mission_id)
  if type(mission_position) is not int or not 1<=mission_position<=5:raise ValueError('Invalid mission position')
 elif mission_position is not None or not dependency:raise ValueError('Invalid mission scope')
 mission_control=plan.get('mission_control_state');mission_revision=plan.get('mission_control_revision')
 if mission_control is not None and (mission_id is None or mission_control not in {'active','paused','cancelled'} or type(mission_revision) is not int or mission_revision<0 or mission_control!='active' and dependency):raise ValueError('Invalid mission control')
 if mission_control is None and mission_revision is not None:raise ValueError('Unexpected mission revision')
 state,steps=progression(plan)
 return {'plan_id':plan['id'],'task_id':str(task[0]),'task_title':task[3],
  'department_id':str(task[1]),'department_name':departments.get(str(task[1])),
  'worker_id':plan['worker_id'],'worker_name':workers.get(plan['worker_id']),
  'objective':plan['objective'],'repository':plan['repository'],'path':plan['path'],'ref':plan['ref'],'sha':plan['sha'],
  'mission_control_state':mission_control,'mission_control_revision':mission_revision,'mission_id':mission_id,'mission_position':mission_position,'mission_dependency_satisfied':dependency,
  'created_at':created.isoformat(),'state':state,'steps':steps,'analysis_mode':mode,'approved_objective':approved,
  'control_available':available,'control_state':control_state,'control_revision':revision,
  'can_control':available and plan.get('owner_is_creator') is True and job_id is None and control_state!='cancelled',
  'job_id':job_id,'run_id':run_id,'job_state':job,'review_decision':decision,
  'task_status':plan['task_status'],'scope_current':plan['scope_current'],
  'needs_attention':state in {'outdated','failed','needs_review','changes_requested','awaiting_review'}}

def summarize(org,tasks,histories,workers=None,departments=None):
 entries=[];seen=set()
 for task in tasks[:MAX_TASKS]:
  rows=histories.get(str(task[0]),[])
  if len(rows)>MAX_PLANS_PER_TASK:raise ValueError('Unbounded task history')
  for plan in rows:
   e=_entry(task,plan,workers or {},departments or {})
   if e['plan_id'] in seen:raise ValueError('Duplicate plan')
   seen.add(e['plan_id']);entries.append(e)
 entries.sort(key=lambda e:(_date(e['created_at']),e['plan_id']),reverse=True)
 visible=entries[:MAX_VISIBLE_PLANS]
 counts={state:0 for state in sorted(PLAN_STATES)};counts.update(Counter(e['state'] for e in visible))
 return {'organization_id':str(org),'enabled':True,'read_only':True,'provider_called':False,'source_fetched':False,'task_completed':False,
  'observed_at':datetime.now(timezone.utc).isoformat(),'progress_basis':'persisted_plan_job_and_review',
  'sample':{'tasks_scanned':min(len(tasks),MAX_TASKS),'tasks_available_in_bounded_reader':len(tasks),
   'task_limit':MAX_TASKS,'plans_per_task_limit':MAX_PLANS_PER_TASK,'visible_plan_limit':MAX_VISIBLE_PLANS,
   'plans_in_task_sample':len(entries),'plans_truncated':len(entries)>MAX_VISIBLE_PLANS,
   'tasks_truncated':len(tasks)>MAX_TASKS,'not_full_company_census':True},
  'counts_in_visible_sample':counts,'attention_in_visible_sample':sum(e['needs_attention'] for e in visible),'plans':visible}

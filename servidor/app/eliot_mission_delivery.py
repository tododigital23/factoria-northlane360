"""Compile exact accepted reports; never infer that the global objective is achieved."""
from datetime import datetime,timezone
from uuid import UUID

def stamp(value):
 if isinstance(value,str):value=datetime.fromisoformat(value.replace('Z','+00:00'))
 if not isinstance(value,datetime) or not value.tzinfo:raise ValueError('Timestamp unavailable')
 return value

def compile_delivery(org,mission,reports,reviews):
 if mission['state']!='accepted' or mission['accepted_steps']!=mission['max_jobs'] or not 2<=len(mission['steps'])<=5 or mission.get('mission_control_state','active')!='active':raise ValueError('Every step requires exact acceptance')
 if set(reports)!=set(s['run_id'] for s in mission['steps']) or set(reviews)!=set(reports):raise ValueError('Incomplete delivery')
 if len({s['run_id'] for s in mission['steps']})!=len(mission['steps']) or len({s['job_id'] for s in mission['steps']})!=len(mission['steps']):raise ValueError('Duplicate execution')
 result=[]
 for s in mission['steps']:
  rid=s['run_id'];rows=reports[rid];matches=[r for r in rows if str(r[0])==rid]
  if len(rows)>20 or len(matches)!=1:raise ValueError('Exact report outside history window')
  r=matches[0];v=reviews[rid]
  if s['state']!='accepted' or s['job_state']!='completed' or s['review_decision']!='accepted' or r[1]!='completed' or not isinstance(r[2],str) or not 1<=len(r[2].strip())<=6000 or len(r[2])>6000:raise ValueError('Completed report unavailable')
  if tuple(r[3:7])!=tuple(s[k] for k in ('repository','path','ref','sha')):raise ValueError('Source mismatch')
  if not v or str(v[0])!=rid or v[1] is None or v[2]!='accepted' or not isinstance(v[3],str) or not 10<=len(v[3].strip())<=1000:raise ValueError('Exact accepted review unavailable')
  UUID(str(v[1]));started=stamp(r[7]);finished=stamp(r[8]);reviewed=stamp(v[4])
  if finished<started or reviewed<finished:raise ValueError('Invalid report/review chronology')
  result.append({k:s[k] for k in ('position','plan_id','task_id','task_title','worker_id','objective','job_id','run_id','repository','path','ref','sha')}|{'report':r[2],'started_at':started.isoformat(),'finished_at':finished.isoformat(),'review':{'id':str(v[1]),'decision':'accepted','reason':v[3],'reviewed_at':reviewed.isoformat()}})
 return {'organization_id':str(org),'mission_id':mission['id'],'objective':mission['objective'],'delivery_kind':'accepted_step_reports_v1','global_objective_verified':False,'read_only':True,'provider_called':False,'source_fetched':False,'task_completed':False,'observed_at':datetime.now(timezone.utc).isoformat(),'history_limits':{'missions':20,'runs_per_task':20,'not_full_company_census':True},'accepted_steps':len(result),'reports':result}

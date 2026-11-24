import {useEffect,useRef,useState} from 'react';
import {useAuth0} from "./auth";
import {SavedPlanDispatch} from './SavedPlanDispatch';
import {MissionDelivery} from './MissionDelivery';
import {DocumentMissionControl} from './DocumentMissionControl';
import {StoredReport} from './StoredReport';
import {MissionAutopilot} from './MissionAutopilot';
import {API_ROOT} from "./holdingApi";
type Candidate={plan_id:string;task_id:string;task_title:string;objective:string;path:string;worker_name:string|null;state:string;can_control?:boolean;mission_id?:string|null};
type Step={position:number;plan_id:string;task_id:string;task_title:string;worker_id:string;objective:string;repository:string;path:string;ref:string;sha:string;job_id:string|null;run_id:string|null;job_state:string|null;review_decision:string|null;state:string;can_prepare:boolean};
type Mission={id:string;objective:string;created_at:string;owner_is_creator:boolean;max_jobs:number;estimated_token_units:number;state:string;steps:Step[];accepted_steps:number;mission_control_available?:boolean;mission_control_state?:'active'|'paused'|'cancelled';mission_control_revision?:number;last_control?:{action:string;reason:string;created_at:string}|null;can_control?:boolean};
type Result={organization_id:string;enabled:boolean;mission_controls_available?:boolean;read_only:true;provider_called:false;execution_started:false;limit:20;not_full_company_census:true;missions:Mission[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const labels:Record<string,string>={prepared:'Guardado',ready:'Preparado para autorizar',waiting:'Espera aceptación de los anteriores',paused:'Pausado',outdated:'Contexto cambiado',queued:'En cola',claimed:'Preparando documento',source_verified:'Fuente verificada',provider_started:'Análisis iniciado',awaiting_review:'Informe disponible · revisión pendiente',accepted:'Aceptado',changes_requested:'Correcciones solicitadas',failed:'Fallido',cancelled:'Cancelado',needs_review:'Resultado sin confirmar',needs_attention:'Requiere atención',in_progress:'En curso'};
function validControl(m:Mission,enabled:boolean){
 if(!m)return false;
 if(m.mission_control_available!==true)return !enabled&&(m.mission_control_available===undefined||m.mission_control_available===false)&&(m.mission_control_state===undefined||m.mission_control_state==='active')&&(m.mission_control_revision===undefined||m.mission_control_revision===0)&&m.last_control==null&&!m.can_control;
 const state=m.mission_control_state,revision=m.mission_control_revision,last=m.last_control;
 if(!enabled||!['active','paused','cancelled'].includes(state||'')||!Number.isInteger(revision)||revision!<0||revision!>2147483647||typeof m.can_control!=='boolean'||state!=='active'&&(m.state!==state||m.steps?.some(s=>s.can_prepare)))return false;
 if((revision===0)!=(last===null)||revision===0&&state!=='active')return false;
 if(last&&(!['pause','resume','cancel'].includes(last.action)||({pause:'paused',resume:'active',cancel:'cancelled'}[last.action as 'pause'|'resume'|'cancel'])!==state||typeof last.reason!=='string'||last.reason.trim().length<10||last.reason.length>500||!Number.isFinite(Date.parse(last.created_at))))return false;
 return m.can_control===(m.owner_is_creator&&state!=='cancelled'&&m.steps?.some(s=>s.job_id===null));
}
export function validMissions(raw:unknown,org:string):raw is Result{
 if(!raw||typeof raw!=='object')return false;const r=raw as Result;
 if(r.mission_controls_available!==undefined&&typeof r.mission_controls_available!=='boolean')return false;
 if(r.organization_id!==org||typeof r.enabled!=='boolean'||r.read_only!==true||r.provider_called!==false||r.execution_started!==false||r.limit!==20||r.not_full_company_census!==true||!Array.isArray(r.missions)||r.missions.length>20||!r.enabled&&r.missions.length>0)return false;
 return new Set(r.missions.map(m=>m.id)).size===r.missions.length&&r.missions.every(m=>validControl(m,r.mission_controls_available===true)&&m&&uuid.test(m.id)&&typeof m.objective==='string'&&m.objective.length<=1000&&typeof m.owner_is_creator==='boolean'&&Number.isFinite(Date.parse(m.created_at))&&Object.hasOwn(labels,m.state)&&Array.isArray(m.steps)&&m.steps.length>=2&&m.steps.length<=5&&m.max_jobs===m.steps.length&&m.estimated_token_units===m.steps.length*2500&&m.accepted_steps===m.steps.filter(s=>s.state==='accepted').length&&new Set(m.steps.map(s=>s.plan_id)).size===m.steps.length&&new Set(m.steps.map(s=>s.task_id)).size===m.steps.length&&m.steps.every((s,i)=>s&&s.position===i+1&&uuid.test(s.plan_id)&&uuid.test(s.task_id)&&uuid.test(s.worker_id)&&typeof s.task_title==='string'&&typeof s.objective==='string'&&typeof s.repository==='string'&&typeof s.path==='string'&&typeof s.ref==='string'&&/^[0-9a-f]{40}$/.test(s.sha)&&(s.job_id===null||uuid.test(s.job_id))&&(s.run_id===null||uuid.test(s.run_id))&&(s.job_id===null?(s.run_id===null&&s.job_state===null&&s.review_decision===null&&['ready','waiting','paused','cancelled','outdated'].includes(s.state)):(s.run_id!==null&&['queued','claimed','source_verified','provider_started','completed','failed','cancelled','needs_review'].includes(s.job_state||'')&&m.steps.slice(0,i).every(p=>p.state==='accepted')))&&(!['accepted','changes_requested','awaiting_review'].includes(s.state)||(s.job_state==='completed'&&s.review_decision===(s.state==='awaiting_review'?null:s.state)))&&typeof s.can_prepare==='boolean'&&Object.hasOwn(labels,s.state)&&(!s.can_prepare||((m.mission_control_state===undefined||m.mission_control_state==='active')&&m.owner_is_creator&&s.state==='ready'&&s.job_id===null&&m.steps.slice(0,i).every(p=>p.state==='accepted')))));
}
export function DocumentMissions({companyId,plans,onQueued}:{companyId:string;plans:Candidate[];onQueued:()=>void}){
 const {getAccessTokenSilently}=useAuth0();const [data,setData]=useState<Result|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[controlPending,setControlPending]=useState(false);
 const [objective,setObjective]=useState(''),[selected,setSelected]=useState(['','']),[confirm,setConfirm]=useState(false),[attempted,setAttempted]=useState(false),[opened,setOpened]=useState(''),[report,setReport]=useState(''),[delivery,setDelivery]=useState('');
 const controller=useRef<AbortController|null>(null),lock=useRef(false),key=useRef(crypto.randomUUID());
 const url=API_ROOT+'/v1/me/organizations/'+encodeURIComponent(companyId)+'/execution/document-missions';
 async function request(signal:AbortSignal,body?:object){
  const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:body?'read:tasks create:tasks':'read:tasks'}});if(signal.aborted)throw Error('Aborted');
  const r=await fetch(url,{method:body?'POST':'GET',signal,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('Unavailable');return r.json();
 }
 async function read(signal:AbortSignal){const r=await request(signal);if(!validMissions(r,companyId))throw Error('Invalid missions');if(!signal.aborted){setData(r);setControlPending(false);}return r;}
 useEffect(()=>{const a=new AbortController();controller.current=a;void read(a.signal).catch(()=>{if(!a.signal.aborted)setError('No se pudieron consultar los planes de varios trabajos.');});return()=>{a.abort();controller.current?.abort();};},[companyId,getAccessTokenSilently]);
 const current=data?.organization_id===companyId?data:null;
 async function verifyControl(id:string,state:string,revision:number,signal:AbortSignal){setOpened('');const r=await read(signal);const m=r.missions.find(m=>m.id===id);if(!m||m.mission_control_state!==state||m.mission_control_revision!==revision)throw Error('Unconfirmed control readback');}
 const occupied=new Set(current?.missions.flatMap(m=>m.steps.map(s=>s.plan_id))||[]);
 const candidates=plans.filter(p=>p.can_control&&p.state==='prepared'&&!p.mission_id&&!occupied.has(p.plan_id));
 const validChoice=selected.length>=2&&selected.length<=5&&selected.every(id=>candidates.some(p=>p.plan_id===id))&&new Set(selected).size===selected.length&&new Set(selected.map(id=>candidates.find(p=>p.plan_id===id)?.task_id)).size===selected.length;
 async function operation(save=false){
  if(lock.current||(save&&(!current?.enabled||attempted||!confirm||!validChoice||objective.trim().length<10||Array.from(objective.trim()).length>1000)))return;
  lock.current=true;setBusy(true);setError('');setMessage('');setOpened('');setReport('');setDelivery('');controller.current?.abort();const a=new AbortController();controller.current=a;
  if(save){setAttempted(true);setConfirm(false);}
  try{
   let savedId='';
   if(save){const ack=await request(a.signal,{objective:objective.trim(),plan_ids:selected,request_key:key.current});if(ack.organization_id!==companyId||!uuid.test(ack.mission_id)||ack.provider_called!==false||ack.execution_started!==false||ack.task_completed!==false)throw Error('Unconfirmed mission');savedId=ack.mission_id;}
   const r=await read(a.signal);if(a.signal.aborted)return;
   if(save){const m=r.missions.find(m=>m.id===savedId);if(!m||m.objective!==objective.trim()||JSON.stringify(m.steps.map(s=>s.plan_id))!==JSON.stringify(selected))throw Error('Unconfirmed readback');setMessage('Plan de varios trabajos guardado y recuperado. No se ha enviado ningún trabajo ni autorizado OpenAI.');}
  }catch{if(!a.signal.aborted)setError(save?'El guardado no quedó confirmado. Consulta el estado antes de actuar; no se reenviará automáticamente.':'No se pudieron verificar estos planes.');}
  finally{if(!a.signal.aborted){lock.current=false;setBusy(false);}}
 }
 return <section className="persistent-document-plan" aria-label="Planes de varios trabajos">
  <h2>Planes de varios trabajos</h2>
  <p>Ordena de dos a cinco planes documentales de tareas distintas. Cada paso necesita su permiso y envío, y solo se habilita tras aceptar los informes anteriores. El objetivo global se guarda como referencia; los objetivos de cada paso son los de sus planes. No inicia actividad automáticamente.</p>
  <button type="button" disabled={busy} onClick={()=>void operation()}>Actualizar planes de varios trabajos</button>
  {controlPending&&<p role="status">Control global pendiente de verificar. Actualiza los planes antes de preparar más pasos.</p>}{error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
  {current&&!current.enabled&&<p>La planificación de varios trabajos requiere la actualización administrativa 030. Los planes individuales siguen disponibles.</p>}
  {current?.enabled&&<>
   {!current.mission_controls_available&&<p>El control global de próximos envíos requiere la actualización administrativa 031. Los controles individuales siguen disponibles.</p>}
   <p>Cuando estén aceptados todos los pasos, podrás consultar un expediente conjunto con sus informes originales y revisiones humanas.</p>
   <p>Últimos {current.missions.length} planes de varios trabajos, máximo 20; consulta parcial, no censo de la empresa.</p>
   <details><summary>Preparar un plan de varios trabajos</summary>
    <p>Solo se pueden agrupar planes propios, activos y sin envío, con una tarea distinta por paso. PostgreSQL comprobará el alcance completo.</p>
    {candidates.length<2&&<p>Necesitas al menos dos planes documentales disponibles de tareas distintas. Puedes guardarlos desde Director virtual.</p>}
    <label>Objetivo global<textarea value={objective} maxLength={2000} disabled={busy||attempted} onChange={e=>{setObjective(e.target.value);setConfirm(false);}}/></label>
    {selected.map((id,i)=><label key={i}>Paso {i+1}<select value={id} disabled={busy||attempted} onChange={e=>{setSelected(v=>v.map((old,n)=>n===i?e.target.value:old));setConfirm(false);}}><option value="">Seleccionar plan guardado</option>{candidates.map(p=><option key={p.plan_id} value={p.plan_id} disabled={selected.some((other,n)=>n!==i&&(other===p.plan_id||candidates.find(p=>p.plan_id===other)?.task_id===p.task_id))}>{p.task_title} · {p.objective} · {p.worker_name||'Trabajador'} · {p.path}</option>)}</select></label>)}
    <button type="button" disabled={busy||attempted||selected.length>=5} onClick={()=>{setSelected(v=>[...v,'']);setConfirm(false);}}>Añadir paso</button>
    <button type="button" disabled={busy||attempted||selected.length<=2} onClick={()=>{setSelected(v=>v.slice(0,-1));setConfirm(false);}}>Quitar último paso</button>
    <p>Máximo {selected.length} trabajos y {selected.length*2500} unidades estimadas en total; no reserva presupuesto ni garantiza coste final.</p>
    <label><input type="checkbox" checked={confirm} disabled={busy||attempted} onChange={e=>setConfirm(e.target.checked)}/>Confirmo guardar estos planes en el orden mostrado, sin enviarlos ni autorizar llamadas al modelo.</label>
    <button type="button" disabled={busy||attempted||!confirm||!validChoice||objective.trim().length<10||Array.from(objective.trim()).length>1000} onClick={()=>void operation(true)}>Guardar plan de varios trabajos</button>
   </details>
   {current.missions.map(m=><article key={m.id} className="plan-tracking-entry">
    <h3>{m.objective}</h3><p>{labels[m.state]} · {m.accepted_steps}/{m.max_jobs} pasos aceptados · Referencia {m.id}</p>
    {m.mission_control_available&&<p>Control global: {({active:'Próximos envíos habilitados con sus comprobaciones',paused:'Próximos envíos pausados',cancelled:'Próximos envíos cancelados'})[m.mission_control_state!]} · Revisión {m.mission_control_revision}. Los trabajos enviados conservan su estado.</p>}
    {m.last_control&&<p>Último control: {m.last_control.reason} · {new Date(m.last_control.created_at).toLocaleString('es-ES')}</p>}
    {m.can_control&&<details><summary>Controlar próximos envíos del plan completo</summary><DocumentMissionControl key={companyId+':'+m.id+':'+m.mission_control_revision} companyId={companyId} missionId={m.id} state={m.mission_control_state as 'active'|'paused'} revision={m.mission_control_revision!} disabled={busy||!!error||controlPending} onAttempted={()=>{setControlPending(true);setOpened('');}} verifyRecorded={(state,revision,signal)=>verifyControl(m.id,state,revision,signal)}/></details>}
    {m.steps.some(s=>s.repository.startsWith('company-db/')||s.path.startsWith('docs/ops/')||s.path.startsWith('ops/'))
     ?<p role="status">Misión de <strong>operación de tienda</strong> (base de datos). No uses piloto automático de análisis GitHub/OpenAI: abre cada paso con «Preparar» y sigue hacia Operación tienda.</p>
     :<MissionAutopilot key={companyId+':'+m.id} companyId={companyId} mission={m} onChanged={()=>{void operation();onQueued();}}/>}
    {m.state==='accepted'&&!error&&!busy&&<><button type="button" aria-expanded={delivery===m.id} onClick={()=>setDelivery(delivery===m.id?'':m.id)}>Ver expediente de pasos aceptados</button>{delivery===m.id&&<MissionDelivery key={companyId+':'+m.id} companyId={companyId} mission={m}/>}</>}
    <ol>{m.steps.map(s=><li key={s.plan_id}><strong>{s.task_title}</strong> · {labels[s.state]}<p>{s.objective} · {s.path} · SHA {s.sha.slice(0,12)}…</p>
     {s.can_prepare&&!error&&!busy&&!controlPending&&<><button type="button" aria-expanded={opened===s.plan_id} onClick={()=>setOpened(opened===s.plan_id?'':s.plan_id)}>Preparar paso {s.position}</button>{opened===s.plan_id&&<SavedPlanDispatch planId={s.plan_id} objective={s.objective} evidence={{organization_id:companyId,task_id:s.task_id,worker_id:s.worker_id,repository:s.repository,path:s.path,ref:s.ref,sha:s.sha}} onQueued={onQueued}/>}</>}
     {s.job_state==='completed'&&s.run_id&&<><button type="button" aria-expanded={report===s.plan_id} onClick={()=>setReport(report===s.plan_id?'':s.plan_id)}>Ver informe del paso {s.position}</button>{report===s.plan_id&&<StoredReport companyId={companyId} event={{id:s.run_id,task_id:s.task_id,task_title:s.task_title,kind:'document_analysis',repository:s.repository,path:s.path,ref:s.ref,sha:s.sha}}/>}</>}
    </li>)}</ol>
   </article>)}
  </>}
 </section>;
}

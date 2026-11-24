import {useEffect,useMemo,useState} from "react";
import {useAuth0} from "./auth";
import {DocumentMissions} from "./DocumentMissions";
import {ObjectivePlanning} from "./ObjectivePlanning";
import {SavedPlanDispatch} from "./SavedPlanDispatch";
import {DocumentPlanControl} from "./DocumentPlanControl";
import {StoredReport} from "./StoredReport";
import {API_ROOT} from "./holdingApi";
type Company={id:string;name:string;role:string};
type Props={companyId:string;companies:Company[];onSelectCompany:(id:string)=>void;onLoadCompanies:()=>void};
type Step={id:string;responsible:string;state:string};
type Plan={mission_control_state?:string|null;mission_id?:string|null;mission_position?:number|null;mission_dependency_satisfied?:boolean;analysis_mode?:string|null;approved_objective?:string|null;control_available?:boolean;control_state?:"active"|"paused"|"cancelled";control_revision?:number;can_control?:boolean;plan_id:string;task_id:string;task_title:string;department_id:string;department_name:string|null;worker_id:string;worker_name:string|null;objective:string;repository:string;path:string;ref:string;sha:string;created_at:string;state:string;steps:Step[];job_id:string|null;run_id:string|null;job_state:string|null;review_decision:string|null;task_status:string;scope_current:boolean;needs_attention:boolean};
type Overview={plan_objective_supported?:boolean;plan_controls_available?:boolean;organization_id:string;enabled:boolean;read_only:true;provider_called:false;source_fetched:false;task_completed:false;progress_basis?:string;sample?:{tasks_scanned:number;task_limit:number;plans_per_task_limit:number;visible_plan_limit:number;plans_in_task_sample:number;plans_truncated:boolean;tasks_truncated:boolean;not_full_company_census:true};counts_in_visible_sample?:Record<string,number>;attention_in_visible_sample?:number;plans:Plan[]};
const labels:Record<string,string>={paused:"Plan pausado",prepared:"Guardado · sin envío",outdated:"Alcance no disponible",queued:"En cola",claimed:"Preparando documento",source_verified:"Fuente verificada",provider_started:"Análisis iniciado",awaiting_review:"Informe disponible · revisión pendiente",accepted:"Aceptado",changes_requested:"Correcciones solicitadas",failed:"Fallido",cancelled:"Cancelado",needs_review:"Resultado sin confirmar"};
const stepLabels:Record<string,string>={pending:"Pendiente",waiting:"En espera",queued:"En cola",in_progress:"En curso",ready:"Preparado",completed:"Registrado",awaiting_review:"Revisión pendiente",accepted:"Aceptado",changes_requested:"Correcciones solicitadas",failed:"Fallido",cancelled:"Cancelado",uncertain:"Sin confirmar",blocked:"Detenido"};
const stepNames={verify_source:"Verificar fuente",analyze_document:"Analizar documento",review_result:"Revisar resultado"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nullable=(x:unknown)=>x===null||typeof x==="string";
function valid(raw:unknown,org:string):raw is Overview{
 if(!raw||typeof raw!=="object")return false;const x=raw as Overview;
 if(x.organization_id!==org||typeof x.enabled!=="boolean"||x.read_only!==true||x.provider_called!==false||x.source_fetched!==false||x.task_completed!==false||!Array.isArray(x.plans))return false;
 if(!x.enabled)return x.plans.length===0;
 if(x.progress_basis!=="persisted_plan_job_and_review"||x.sample?.not_full_company_census!==true||x.sample.task_limit!==40||x.sample.plans_per_task_limit!==20||x.sample.visible_plan_limit!==100||
  !Number.isInteger(x.sample.tasks_scanned)||x.sample.tasks_scanned<0||x.sample.tasks_scanned>40||typeof x.sample.plans_truncated!=="boolean"||typeof x.sample.tasks_truncated!=="boolean"||x.plans.length>100||
  !x.counts_in_visible_sample||typeof x.attention_in_visible_sample!=="number"||
  !Object.keys(labels).every(k=>Number.isInteger(x.counts_in_visible_sample![k]??(k==="paused"?0:undefined))&&(x.counts_in_visible_sample![k]??0)>=0)||
  Object.values(x.counts_in_visible_sample).reduce((a,b)=>a+b,0)!==x.plans.length)return false;
 return new Set(x.plans.map(p=>p.plan_id)).size===x.plans.length&&x.plans.every(p=>p&&uuid.test(p.plan_id)&&uuid.test(p.task_id)&&uuid.test(p.worker_id)&&typeof p.task_title==="string"&&typeof p.objective==="string"&&typeof p.department_id==="string"&&nullable(p.department_name)&&nullable(p.worker_name)&&
  typeof p.repository==="string"&&typeof p.path==="string"&&typeof p.ref==="string"&&typeof p.sha==="string"&&/^[0-9a-f]{40}$/.test(p.sha)&&typeof p.created_at==="string"&&Number.isFinite(Date.parse(p.created_at))&&Object.hasOwn(labels,p.state)&&typeof p.needs_attention==="boolean"&&typeof p.scope_current==="boolean"&&typeof p.task_status==="string"&&
  (p.job_id===null||uuid.test(p.job_id))&&(p.run_id===null||uuid.test(p.run_id))&&nullable(p.job_state)&&nullable(p.review_decision)&&
  (p.control_available===undefined||(typeof p.control_available==="boolean"&&["active","paused","cancelled"].includes(p.control_state||"")&&Number.isInteger(p.control_revision)&&p.control_revision!>=0&&typeof p.can_control==="boolean"&&(!p.can_control||(p.control_available&&p.job_id===null&&p.control_state!=="cancelled"))&&(!p.job_id||p.control_state==="active")))&&
  Array.isArray(p.steps)&&p.steps.length===3&&p.steps.every((s,i)=>s&&s.id===["verify_source","analyze_document","review_result"][i]&&s.responsible===(i===2?"owner":"worker")&&Object.hasOwn(stepLabels,s.state))&&
  (!["accepted","changes_requested","awaiting_review"].includes(p.state)||(p.job_state==="completed"&&p.run_id!==null&&p.steps[0].state==="completed"&&p.steps[1].state==="completed"&&p.steps[2].state===p.state&&p.review_decision===(p.state==="awaiting_review"?null:p.state))));
}
export function PlanTrackingOverview({companyId,companies,onSelectCompany,onLoadCompanies}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [data,setData]=useState<Overview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [dispatch,setDispatch]=useState("");
 const [refresh,setRefresh]=useState(0),[filter,setFilter]=useState("all"),[search,setSearch]=useState(""),[opened,setOpened]=useState("");
 const owner=companies.find(c=>c.id===companyId)?.role==="owner";
 useEffect(()=>{
  const abort=new AbortController();let active=true;setData(null);setError("");setOpened("");setDispatch("");setBusy(false);
  if(!companyId||!owner)return ()=>{active=false;abort.abort();};setBusy(true);
  (async()=>{try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});if(abort.signal.aborted)return;
   const response=await fetch(API_ROOT+"/v1/me/organizations/"+encodeURIComponent(companyId)+"/execution/document-plans-overview",{headers:{Authorization:"Bearer "+token},signal:abort.signal});
   if(!response.ok)throw Error("Unavailable");const raw:unknown=await response.json();if(!valid(raw,companyId))throw Error("Invalid overview");if(active)setData(raw);
  }catch{if(active)setError("No se pudo verificar el seguimiento de planes de esta empresa.");}finally{if(active)setBusy(false);}})();
  return ()=>{active=false;abort.abort();};
 },[companyId,owner,refresh,getAccessTokenSilently]);
 const current=owner&&data?.organization_id===companyId?data:null;
 const shown=useMemo(()=>{const term=search.trim().toLocaleLowerCase("es-ES");return (current?.plans||[]).filter(p=>(filter==="all"||p.state===filter||(filter==="attention"&&p.needs_attention))&&(!term||[p.task_title,p.objective,p.path,p.worker_name||""].some(s=>s.toLocaleLowerCase("es-ES").includes(term))));},[current,filter,search]);
 return <div className="plan-tracking-overview">
  <div className="work-overview-controls">
   <label>Empresa<select value={companyId} onChange={e=>onSelectCompany(e.target.value)}><option value="">Seleccionar empresa</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
   <button type="button" className="button-outline" onClick={onLoadCompanies}>Actualizar empresas</button>
   <button type="button" disabled={busy||!companyId||!owner} onClick={()=>setRefresh(n=>n+1)}>{busy?"Consultando planes…":"Actualizar seguimiento"}</button>
  </div>
  {!companyId&&<p>Selecciona una empresa para recuperar sus planes guardados.</p>}
  {companyId&&!owner&&<p role="status">El seguimiento está reservado al propietario autorizado.</p>}
  {error&&<p role="alert">{error}</p>}
  <ObjectivePlanning companyId={companyId} role={owner?'owner':''} onSaved={()=>setRefresh(n=>n+1)}/>
  {current&&!current.enabled&&<p role="status">El almacenamiento de planes no está disponible para consulta. No se presentan totales de actividad.</p>}
  {current?.enabled&&<>
   <p>Consulta de solo lectura de {current.sample!.tasks_scanned} tareas recientes, máximo 40; hasta 20 planes por tarea y 100 planes visibles. Los totales corresponden a esta muestra, no a toda la empresa.</p>
   {(current.sample!.tasks_truncated||current.sample!.plans_truncated)&&<p role="status">Hay más registros que los visibles. La consulta es parcial.</p>}
   <p><strong>{current.plans.length} planes en la muestra visible</strong> · {current.attention_in_visible_sample} requieren atención o revisión.</p>
   <p role="status">{current.plan_controls_available===true?"Control previo al envío disponible: pausar, reanudar y cancelar planes sin trabajo vinculado.":"No se ha confirmado la disponibilidad del control previo al envío."}</p>
   <p>{current.plan_objective_supported===true?"Informe orientado al objetivo disponible con autorización expresa del envío.":"Informe orientado al objetivo pendiente de activar mediante la migración 029. El análisis estándar sigue disponible."}</p>
   <p>Los pasos se derivan de los registros del plan, trabajo y revisión. Guardar un plan no significa que el trabajador haya empezado.</p>
   <div className="work-overview-filters">
    <label>Estado del plan<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Todos</option><option value="attention">Requieren atención o revisión</option>{Object.entries(labels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
    <label>Buscar plan, tarea o responsable<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
   </div>
   <DocumentMissions key={companyId} companyId={companyId} plans={current.plans} onQueued={()=>setRefresh(n=>n+1)}/>
   {shown.length===0&&<p>No hay planes con estos filtros en la muestra consultada. Puedes guardar un plan documental desde Director virtual al preparar una tarea y su documento.</p>}
   {shown.map(p=><article className="plan-tracking-entry" key={p.plan_id}>
    <div className="work-overview-entry-head"><strong>{p.objective}</strong><span>{labels[p.state]}</span></div>
    <p>Tarea: {p.task_title} · Estado actual: {p.task_status}</p>
    <p>Departamento: {p.department_name||"Sin nombre disponible"} · Responsable: {p.worker_name||"Sin nombre disponible"}</p>
    {p.analysis_mode==="objective_v1"&&<p>Modo registrado: orientado al objetivo aprobado. Objetivo autorizado para este trabajo: {p.approved_objective}</p>}
    {p.analysis_mode==="standard_v1"&&<p>Modo registrado: análisis documental estándar; el objetivo del plan no se incluyó.</p>}
    <ol className="plan-tracking-steps">{p.steps.map(s=><li key={s.id}><strong>{stepNames[s.id as keyof typeof stepNames]}</strong> · {s.responsible==="owner"?"Propietario":"Trabajador"}: {stepLabels[s.state]}</li>)}</ol>
    <details><summary>Documento y referencias del plan</summary><p>{p.repository} / {p.path} · Ref: {p.ref}</p><p>SHA: <code>{p.sha}</code></p><p>Plan: {p.plan_id} · Guardado: {new Date(p.created_at).toLocaleString("es-ES")}</p>{p.job_id&&<p>Trabajo: {p.job_id}</p>}</details>
    {p.job_id===null&&!p.control_available&&<p>El control de planes requiere la actualización administrativa 028. No se muestran acciones disponibles.</p>}
    {p.can_control&&p.control_available&&p.control_state!=="cancelled"&&<DocumentPlanControl key={companyId+":"+p.plan_id+":"+p.control_revision} companyId={companyId} taskId={p.task_id} planId={p.plan_id} state={p.control_state as "active"|"paused"} revision={p.control_revision!} scopeCurrent={p.scope_current} onRecorded={()=>setRefresh(n=>n+1)}/>}
    {current.plan_controls_available===true&&p.can_control&&p.state==="prepared"&&p.mission_dependency_satisfied!==false&&<>
     <button type="button" className="button-outline" aria-expanded={dispatch===p.plan_id} onClick={()=>setDispatch(dispatch===p.plan_id?"":p.plan_id)}>{dispatch===p.plan_id?"Cerrar preparación del envío":"Preparar envío de este plan"}</button>
     {dispatch===p.plan_id&&<SavedPlanDispatch planId={p.plan_id} objective={p.objective} evidence={{organization_id:companyId,task_id:p.task_id,worker_id:p.worker_id,repository:p.repository,path:p.path,ref:p.ref,sha:p.sha}} onQueued={()=>setRefresh(n=>n+1)}/>}
    </>}
    {p.mission_id&&<p>Paso {p.mission_position} del plan de varios trabajos {p.mission_id}.{p.mission_dependency_satisfied===false?" El envío espera el permiso del plan global y la aceptación de los informes anteriores.":""}</p>}
    {p.state==="outdated"&&<p>El contexto de la tarea o la disponibilidad del responsable ya no coincide. Esta consulta no inicia ni corrige el plan.</p>}
    {p.state==="needs_review"&&<p>La ejecución tiene resultado sin confirmar. Requiere revisión; no se reiniciará desde este monitor.</p>}
    {p.run_id&&p.job_state==="completed"&&<>
     <button type="button" className="button-outline" aria-expanded={opened===p.plan_id} onClick={()=>setOpened(opened===p.plan_id?"":p.plan_id)}>{opened===p.plan_id?"Cerrar informe del plan":"Ver informe y revisión del plan"}</button>
     {opened===p.plan_id&&<StoredReport key={companyId+":"+p.task_id+":"+p.run_id} companyId={companyId} event={{id:p.run_id,task_id:p.task_id,task_title:p.task_title,kind:"document_analysis",repository:p.repository,path:p.path,ref:p.ref,sha:p.sha}}/>}
    </>}
   </article>)}
  </>}
 </div>;
}

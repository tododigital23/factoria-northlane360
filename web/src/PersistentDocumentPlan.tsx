import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {FailedPlanRecovery} from "./FailedPlanRecovery";
type Evidence={organization_id:string;task_id:string;worker_id:string;repository:string;path:string;ref:string;sha:string};
type Plan={control_available?:boolean;control_state?:"active"|"paused"|"cancelled";control_revision?:number;id:string;task_id:string;worker_id:string;objective:string;request_key:string;repository:string;path:string;ref:string;sha:string;version:string;max_jobs:number;estimated_token_units:number;steps:{id:string;responsible:string;depends_on:string[]}[];created_at:string;owner_is_creator:boolean;scope_current:boolean;job_id:string|null;run_id:string|null;job_state:string|null;source_verified_at:string|null;review_decision:string|null;task_status:string;mission_id?:string|null};
type Props={evidence:Evidence;selectedPlanId?:string;onSelectPlan:(id:string|undefined)=>void};
const root="https://api.tu-factoria.example/v1/me/organizations/";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function PersistentDocumentPlan(props:Props){return <PlanPanel key={Object.values(props.evidence).join("|")} {...props}/>;}
function PlanPanel({evidence:e,selectedPlanId,onSelectPlan}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [plans,setPlans]=useState<Plan[]>([]),[enabled,setEnabled]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [objective,setObjective]=useState(""),[confirm,setConfirm]=useState(false),[attempted,setAttempted]=useState(false),[message,setMessage]=useState("");
 const locked=useRef(false),controller=useRef<AbortController|null>(null),requestKey=useRef(crypto.randomUUID());
 const url=root+encodeURIComponent(e.organization_id)+"/tasks/"+encodeURIComponent(e.task_id)+"/execution/document-plans";
 useEffect(()=>{onSelectPlan(undefined);return()=>{controller.current?.abort();};},[onSelectPlan]);
 const matches=(p:Plan)=>p.worker_id===e.worker_id&&p.repository===e.repository&&p.path===e.path&&p.ref===e.ref&&p.sha===e.sha;
 const usable=(p:Plan)=>matches(p)&&p.owner_is_creator&&p.scope_current&&p.job_id===null&&(p.control_state===undefined||p.control_state==="active");
 async function request(signal:AbortSignal,body?:object){
  const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:body?"read:tasks create:tasks":"read:tasks"}});
  if(signal.aborted)throw Error("Aborted");
  const response=await fetch(url,{method:body?"POST":"GET",signal,headers:{Authorization:"Bearer "+token,...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error("Unavailable");return response.json();
 }
 async function read(signal:AbortSignal){
  const raw=await request(signal);
  if(!raw||raw.organization_id!==e.organization_id||raw.task_id!==e.task_id||typeof raw.enabled!=="boolean"||raw.provider_called!==false||raw.execution_started!==false||!Array.isArray(raw.plans)||raw.plans.length>20||
   (!raw.enabled&&raw.plans.length!==0)||!raw.plans.every((p:Plan)=>p&&uuid.test(p.id)&&p.task_id===e.task_id&&typeof p.worker_id==="string"&&typeof p.objective==="string"&&uuid.test(p.request_key)&&typeof p.repository==="string"&&typeof p.path==="string"&&typeof p.ref==="string"&&/^[0-9a-f]{40}$/.test(p.sha)&&p.version==="document_plan_v1"&&p.max_jobs===1&&p.estimated_token_units===2500&&
    Array.isArray(p.steps)&&JSON.stringify(p.steps.map(s=>[s.id,s.responsible,s.depends_on]))===JSON.stringify([["verify_source","worker",[]],["analyze_document","worker",["verify_source"]],["review_result","owner",["analyze_document"]]])&&
    (p.control_state===undefined||(["active","paused","cancelled"].includes(p.control_state)&&p.control_available===true&&Number.isInteger(p.control_revision)&&p.control_revision!>=0))&&
    typeof p.scope_current==="boolean"&&typeof p.owner_is_creator==="boolean"&&typeof p.created_at==="string"&&Number.isFinite(Date.parse(p.created_at))&&
    ((p.job_id===null&&p.run_id===null&&p.job_state===null)||(typeof p.job_id==="string"&&uuid.test(p.job_id)&&typeof p.run_id==="string"&&uuid.test(p.run_id)&&typeof p.job_state==="string"))&&
    (p.source_verified_at===null||typeof p.source_verified_at==="string")&&(p.review_decision===null||["accepted","changes_requested"].includes(p.review_decision))&&typeof p.task_status==="string")||
   new Set(raw.plans.map((p:Plan)=>p.id)).size!==raw.plans.length)throw Error("Invalid plans");
  if(signal.aborted)return [];
  setEnabled(raw.enabled);setPlans(raw.plans);onSelectPlan(undefined);
  return raw.plans as Plan[];
 }
 async function operation(save=false){
  if(locked.current)return;
  if(save&&(!enabled||attempted||!confirm||objective.trim().length<10||Array.from(objective.trim()).length>1000))return;
  locked.current=true;setBusy(true);setError("");setMessage("");const abort=new AbortController();controller.current=abort;
  if(save){setAttempted(true);setConfirm(false);}
  try{
   if(save){
    const raw=await request(abort.signal,{worker_id:e.worker_id,objective:objective.trim(),repository:e.repository,path:e.path,ref:e.ref,sha:e.sha,request_key:requestKey.current});
    if(!raw||raw.organization_id!==e.organization_id||raw.task_id!==e.task_id||typeof raw.plan_id!=="string"||!uuid.test(raw.plan_id)||raw.provider_called!==false||raw.execution_started!==false||raw.source_verified!==false)throw Error("Unconfirmed plan");
    const list=await read(abort.signal);if(abort.signal.aborted)return;
    const saved=list.find(p=>p.id===raw.plan_id&&p.request_key===requestKey.current&&matches(p)&&p.objective===objective.trim());
    if(!saved)throw Error("Unconfirmed readback");
    if(usable(saved))onSelectPlan(saved.id);
    setMessage("Plan guardado y recuperado de PostgreSQL. No se ha creado un permiso ni encolado un trabajo.");
   }else{await read(abort.signal);}
  }catch{
   if(!abort.signal.aborted)setError(save?"El guardado no quedó confirmado. Consulta los planes guardados; no se reenviará la solicitud.":"No se pudieron verificar los planes de esta tarea.");
  }finally{if(!abort.signal.aborted){locked.current=false;setBusy(false);}}
 }
 return <section className="persistent-document-plan" aria-label="Plan documental persistente">
  <h3>Guardar el plan de este documento</h3>
  <p>Objetivo, responsable, fuente y tres pasos dependientes. Una ejecución como máximo; 2500 unidades estimadas, sujetas al presupuesto diario. Guardar no autoriza OpenAI.</p>
  <button type="button" className="button-outline" disabled={busy} onClick={()=>void operation()}>{busy?"Consultando planes…":"Consultar planes guardados"}</button>
  {enabled===false&&<p>Los planes persistentes requieren la actualización administrativa 027. El recorrido documental actual sigue disponible.</p>}
  {enabled&&<>
   <label>Objetivo del plan<textarea value={objective} maxLength={2000} disabled={busy||attempted} onChange={v=>{setObjective(v.target.value);setConfirm(false);}}/></label>
   <label><input type="checkbox" checked={confirm} disabled={busy||attempted} onChange={v=>setConfirm(v.target.checked)}/>Confirmo que quiero guardar este objetivo para el trabajador y documento/SHA mostrados. No iniciar una ejecución.</label>
   <button type="button" className="button-outline" disabled={busy||attempted||!confirm||objective.trim().length<10||Array.from(objective.trim()).length>1000} onClick={()=>void operation(true)}>Guardar plan sin ejecutar</button>
   <p>Últimos {plans.length} planes disponibles, máximo 20.</p>
   <label>Plan para vincular al próximo envío
    <select value={selectedPlanId||""} disabled={busy} onChange={v=>{const p=plans.find(p=>p.id===v.target.value);onSelectPlan(p&&usable(p)?p.id:undefined);}}>
     <option value="">Recorrido actual sin plan persistente seleccionado</option>
     {plans.map(p=><option key={p.id} value={p.id} disabled={!usable(p)}>{p.objective} · {p.path} · SHA {p.sha.slice(0,12)}…{p.job_id?" · Trabajo vinculado":!usable(p)?" · No disponible para envío":""}</option>)}
    </select>
   </label>
   {plans.map(p=><article key={p.id}><p><strong>{p.objective}</strong> · Plan {p.id}</p><p>{p.path} · SHA {p.sha} · Responsable: {p.worker_id}</p>
    <ol><li>Verificar fuente · trabajador</li><li>Analizar documento · depende de verificar fuente</li><li>Revisar resultado · propietario · depende del informe</li></ol>
    <p>{p.job_id?"Trabajo vinculado: "+p.job_id+" · Estado registrado: "+p.job_state:"Sin trabajo vinculado; guardar el plan no inicia actividad."}</p>
    <FailedPlanRecovery companyId={e.organization_id} plan={p} onRecovered={()=>void operation()}/>
    {p.control_state&&p.control_state!=="active"&&<p>{p.control_state==="paused"?"Plan pausado":"Plan cancelado"} · No disponible para envío. Controla el plan desde Planes IA.</p>}
    {p.review_decision&&<p>Decisión registrada: {p.review_decision}</p>}
   </article>)}
  </>}
  {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}

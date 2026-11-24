import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {GitHubToolReadControl} from "./GitHubToolReadControl";
import {DurableDocumentControl} from "./DurableDocumentControl";
import {API_ROOT} from "./holdingApi";
type Evidence={organization_id:string;task_id:string;worker_id:string;repository:string;path:string;ref:string;sha:string};
type Props={evidence:Evidence;planId:string;objective:string;onQueued:()=>void};
type Approval={id:string;worker_id:string;state:string;repository:string;path:string;ref:string;sha:string;expires_at:string};
const root=API_ROOT+"/v1/me/organizations/";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function SavedPlanDispatch(p:Props){return <DispatchPanel key={[...Object.values(p.evidence),p.planId].join('|')} {...p}/>;}
function DispatchPanel({evidence:e,planId,objective,onQueued}:Props){
 const {getAccessTokenSilently}=useAuth0();const [ready,setReady]=useState(false),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[attempted,setAttempted]=useState(false),[error,setError]=useState(''),[approval,setApproval]=useState<Approval|null>(null);
 const [objectiveSupported,setObjectiveSupported]=useState(false),[includeObjective,setIncludeObjective]=useState(false);
 const controller=useRef<AbortController|null>(null),locked=useRef(false),key=useRef(crypto.randomUUID());
 const org=root+encodeURIComponent(e.organization_id),base=org+'/tasks/'+encodeURIComponent(e.task_id)+'/execution';
 useEffect(()=>()=>controller.current?.abort(),[]);
 const matches=(p:Record<string,unknown>)=>p.worker_id===e.worker_id&&p.repository===e.repository&&p.path===e.path&&p.ref===e.ref&&p.sha===e.sha;
 async function request(url:string,signal:AbortSignal,body?:object){
  const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:body?'read:tasks create:tasks':'read:tasks'}});if(signal.aborted)throw Error('Aborted');
  const r=await fetch(url,{method:body?'POST':'GET',signal,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(!r.ok)throw Error('Unavailable');return r.json();
 }
 async function checkPlan(signal:AbortSignal){
  const raw=await request(base+'/document-plans',signal);
  if(raw.organization_id!==e.organization_id||raw.task_id!==e.task_id||raw.enabled!==true||raw.provider_called!==false||raw.execution_started!==false||!Array.isArray(raw.plans)||raw.plans.length>20)throw Error('Unconfirmed plan');
  const plans=raw.plans.filter((p:Record<string,unknown>)=>p.id===planId);const p=plans[0];
  if(plans.length!==1||p.task_id!==e.task_id||!matches(p)||p.objective!==objective||p.version!=='document_plan_v1'||p.max_jobs!==1||p.estimated_token_units!==2500||p.owner_is_creator!==true||p.scope_current!==true||p.control_available!==true||p.control_state!=='active'||p.job_id!==null||p.run_id!==null||p.job_state!==null||(p.mission_id!=null&&p.mission_dependency_satisfied!==true))throw Error('Plan unavailable');
 }
 async function readApprovals(signal:AbortSignal){
  const raw=await request(base+'/document-approvals',signal);
  if(!Array.isArray(raw)||raw.length>20||!raw.every(p=>p&&uuid.test(p.id)&&uuid.test(p.worker_id)&&typeof p.state==='string'&&typeof p.repository==='string'&&typeof p.path==='string'&&typeof p.ref==='string'&&typeof p.sha==='string'&&Number.isFinite(Date.parse(p.expires_at))))throw Error('Invalid approvals');
  return raw.filter(p=>matches(p)&&p.state==='approved'&&Date.parse(p.expires_at)>Date.now()) as Approval[];
 }
 async function operate(authorize=false){
  if(locked.current||(authorize&&(!ready||!confirm||attempted)))return;locked.current=true;setBusy(true);setError('');setReady(false);setApproval(null);setConfirm(false);const abort=new AbortController();controller.current=abort;
  if(authorize)setAttempted(true);
  try{
   await checkPlan(abort.signal);
   const cap=await request(org+'/execution/documentary-capability',abort.signal);
   if(cap.organization_id!==e.organization_id||cap.enabled!==true||cap.capability!=='document_analysis_v1'||cap.source_scope!=='one_github_file_exact_sha'||cap.requires_fresh_document_approval!==true||cap.external_tools_enabled!==false||cap.store_at_provider!==false)throw Error('Unavailable capability');
   const engine=await request(org+'/execution/durable-document-capability',abort.signal);
   if(engine.organization_id!==e.organization_id||engine.capability!=='durable_document_analysis_v1'||engine.provider_called!==false)throw Error('Invalid durable capability');
   if(!abort.signal.aborted)setObjectiveSupported(engine.plan_objective_supported===true);
   let savedId:string|undefined;
   if(authorize){
    const ack=await request(base+'/document-approvals',abort.signal,{worker_id:e.worker_id,repository:e.repository,path:e.path,expected_sha:e.sha,request_key:key.current});
    if(ack.organization_id!==e.organization_id||ack.task_id!==e.task_id||!matches(ack)||!uuid.test(ack.approval_id)||ack.state!=='approved'||ack.provider_called!==false)throw Error('Unconfirmed approval');savedId=ack.approval_id;
   }
   const approvals=await readApprovals(abort.signal);if(savedId&&!approvals.some(a=>a.id===savedId))throw Error('Approval not recovered');
   // Recheck after authorization, before exposing the queue control. SQL checks again on enqueue.
   await checkPlan(abort.signal);if(abort.signal.aborted)return;setApproval(approvals.find(a=>!savedId||a.id===savedId)||null);setReady(true);
  }catch{if(!abort.signal.aborted)setError('No se pudo confirmar el plan o su permiso. Actualiza el estado antes de actuar; no se repetirá ninguna solicitud automáticamente.');}
  finally{if(!abort.signal.aborted){setBusy(false);locked.current=false;}}
 }
 return <section aria-label="Preparar envío del plan guardado">
  <h3>Preparar este plan para el trabajador</h3>
  <p>{objective} · {e.path} · SHA <code>{e.sha}</code></p>
  <p>El informe puede orientarse al objetivo guardado cuando esa capacidad esté disponible y lo autorices. El alcance sigue limitado a este archivo; todavía no descompone objetivos en varios trabajos.</p>
  <button type="button" disabled={busy} onClick={()=>void operate()}>Comprobar plan y permisos actuales</button>
  {error&&<p role="alert">{error}</p>}
  {ready&&<>
   <p>Plan activo, sin envío y con alcance vigente según la última consulta. La cola volverá a comprobarlo.</p>
   <GitHubToolReadControl key={planId} evidence={e}/>
   {!approval&&<>
    <p>Autorizar comprueba el archivo en GitHub y prepara un permiso de 15 minutos para UN posible informe en OpenAI. No lo envía ni crea un trabajo. El envío posterior requiere otra confirmación y puede consumir tokens de pago.</p>
    <label><input type="checkbox" checked={confirm} disabled={busy||attempted} onChange={v=>setConfirm(v.target.checked)}/>Autorizo preparar el permiso para este documento y SHA.</label>
    <button type="button" disabled={busy||attempted||!confirm} onClick={()=>void operate(true)}>Autorizar documento del plan</button>
   </>}
   {approval&&<p>Permiso recuperado hasta {new Date(approval.expires_at).toLocaleString('es-ES')}. Aún debes confirmar el envío.</p>}
   {objectiveSupported?<label><input type="checkbox" checked={includeObjective} onChange={v=>setIncludeObjective(v.target.checked)}/>Incluir el objetivo guardado para orientar el informe. Se enviará a OpenAI junto con el documento al confirmar la cola.</label>:<p>Objetivo como referencia de seguimiento: el modo orientado requiere la actualización administrativa 029. El análisis estándar sigue disponible.</p>}
   <p>{includeObjective?"Modo elegido: informe orientado al objetivo aprobado.":"Modo elegido: informe documental estándar; no se enviará el objetivo del plan."}</p>
   <DurableDocumentControl includePlanObjective={includeObjective} planId={planId} evidence={e} approvalId={approval?.id} onQueued={()=>{setReady(false);setApproval(null);onQueued();}}/>
  </>}
 </section>;
}

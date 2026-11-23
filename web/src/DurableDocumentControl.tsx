import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
type Evidence={organization_id:string;task_id:string;worker_id:string;repository:string;path:string;ref:string;sha:string};
type Props={includePlanObjective?:boolean;planId?:string;evidence:Evidence;approvalId?:string;onQueued:()=>void};
type Lease={lease_id:string;worker_id:string;state:string;usable:boolean;expires_at:string};
type Job={job_id:string;run_id:string;lease_id:string;state:string;created_at:string;valid_until:string;cancel_requested:boolean;attention_required:boolean;error_code:string|null};
const root="https://api.tu-factoria.example/v1/me/organizations/";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const labels:Record<string,string>={queued:"En cola",claimed:"Reclamada por el trabajador",source_verified:"Documento verificado",provider_started:"Paso de IA iniciado",completed:"Informe guardado",failed:"Finalizada con error",cancelled:"Cancelada",needs_review:"Resultado sin confirmar"};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object";

export function DurableDocumentControl(props:Props){
 const e=props.evidence;
 const key=[e.organization_id,e.task_id,e.worker_id,e.repository,e.path,e.ref,e.sha,props.planId||"",String(props.includePlanObjective===true)].join("|");
 return <DurableDocumentPanel key={key} {...props}/>;
}
function DurableDocumentPanel({evidence:e,approvalId,planId,includePlanObjective=false,onQueued}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [enabled,setEnabled]=useState<boolean|null>(null);
 const [objectiveSupported,setObjectiveSupported]=useState(false);
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false);
 const [lease,setLease]=useState<Lease|null>(null),[jobs,setJobs]=useState<Job[]>([]);
 const [confirm,setConfirm]=useState(false),[message,setMessage]=useState("");
 const [attemptedApproval,setAttemptedApproval]=useState("");
 const lock=useRef(false),controller=useRef<AbortController|null>(null);
 const key=useRef(crypto.randomUUID());
 const keyApproval=useRef("");
 const org=root+encodeURIComponent(e.organization_id);
 const base=org+"/tasks/"+encodeURIComponent(e.task_id)+"/execution";
 useEffect(()=>()=>controller.current?.abort(),[]);
 async function request(url:string,signal:AbortSignal,body?:object){
  const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:body?"read:tasks create:tasks":"read:tasks"}});
  if(signal.aborted)throw Error("Aborted");
  const response=await fetch(url,{method:body?"POST":"GET",signal,
   headers:{Authorization:"Bearer "+token,...(body?{"Content-Type":"application/json"}:{})},
   ...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok)throw Error("Request unconfirmed");
  return response.json() as Promise<unknown>;
 }
 async function operation(action:(signal:AbortSignal)=>Promise<void>){
  if(lock.current)return;
  lock.current=true;setBusy(true);setMessage("");
  const abort=new AbortController();controller.current=abort;
  try{await action(abort.signal);}catch{
   if(!abort.signal.aborted){setReady(false);setConfirm(false);setMessage("No se confirmó la operación. Consulta el estado antes de actuar; no se repetirá ninguna ejecución automáticamente.");}
  }finally{if(!abort.signal.aborted){lock.current=false;setBusy(false);}}
 }
 async function refresh(signal:AbortSignal){
  setReady(false);setConfirm(false);setLease(null);
  const cap=await request(org+"/execution/durable-document-capability",signal);
  if(!object(cap)||cap.organization_id!==e.organization_id||
   cap.capability!=="durable_document_analysis_v1"||typeof cap.enabled!=="boolean"||
   cap.requires_document_approval!==true||cap.requires_live_lease!==true||
   cap.provider_called!==false||cap.worker_online_verified!==false)throw Error("Invalid capability");
  if(signal.aborted)return;
  setEnabled(cap.enabled);setObjectiveSupported(cap.plan_objective_supported===true);
  if(!cap.enabled){setJobs([]);return;}
  const [rawLease,rawJobs]=await Promise.all([
   request(base+"/lease",signal),request(base+"/document-jobs",signal)]);
  if(!object(rawLease)||rawLease.organization_id!==e.organization_id||
    rawLease.task_id!==e.task_id||!Array.isArray(rawJobs))throw Error("Invalid state");
  const l=rawLease.lease;
  if(l!==null&&(!object(l)||typeof l.lease_id!=="string"||!uuid.test(l.lease_id)||
   typeof l.worker_id!=="string"||typeof l.state!=="string"||typeof l.usable!=="boolean"||
   typeof l.expires_at!=="string"||!Number.isFinite(Date.parse(l.expires_at))))throw Error("Invalid lease");
  if(!rawJobs.every(j=>object(j)&&typeof j.job_id==="string"&&uuid.test(j.job_id)&&
   typeof j.run_id==="string"&&uuid.test(j.run_id)&&typeof j.lease_id==="string"&&uuid.test(j.lease_id)&&
   typeof j.state==="string"&&Object.prototype.hasOwnProperty.call(labels,j.state)&&
   typeof j.created_at==="string"&&Number.isFinite(Date.parse(j.created_at))&&
   typeof j.valid_until==="string"&&Number.isFinite(Date.parse(j.valid_until))&&
   typeof j.cancel_requested==="boolean"&&typeof j.attention_required==="boolean"&&
   (j.error_code===null||typeof j.error_code==="string")))throw Error("Invalid jobs");
  if(signal.aborted)return;
  setLease(l as Lease|null);setJobs(rawJobs as Job[]);setReady(true);
 }
 const active=jobs.some(j=>["queued","claimed","source_verified","provider_started","needs_review"].includes(j.state));
 const liveLease=lease?.worker_id===e.worker_id&&lease.state==="held"&&lease.usable&&Date.parse(lease.expires_at)>Date.now();
 const canQueue=ready&&enabled&&(!includePlanObjective||!!planId&&objectiveSupported)&&liveLease&&!!approvalId&&attemptedApproval!==approvalId&&!active;
 async function enqueue(signal:AbortSignal){
  if(!canQueue||!confirm||!lease||!approvalId||Date.parse(lease.expires_at)<=Date.now())return;
  setAttemptedApproval(approvalId);setConfirm(false);setReady(false);
  if(keyApproval.current!==approvalId){key.current=crypto.randomUUID();keyApproval.current=approvalId;}
  const response=await request(base+"/document-jobs",signal,{
   worker_id:e.worker_id,lease_id:lease.lease_id,approval_id:approvalId,request_key:key.current,...(includePlanObjective?{include_plan_objective:true}:{}),...(planId?{plan_id:planId}:{})});
  if(!object(response)||typeof response.job_id!=="string"||!uuid.test(response.job_id)||
    response.provider_called!==false||response.task_completed!==false||response.consult_state!==true)throw Error("Invalid enqueue");
  if(signal.aborted)return;
  onQueued();key.current=crypto.randomUUID();
  await refresh(signal);
  if(!signal.aborted)setMessage("Solicitud encolada. El trabajador independiente puede continuar aunque cierres esta pestaña. Consulta el historial para confirmar el resultado.");
 }
 async function cancel(job:Job,signal:AbortSignal){
  setReady(false);
  const response=await request(org+"/execution/document-jobs/"+encodeURIComponent(job.job_id)+"/cancel",signal,{});
  if(!object(response)||response.job_id!==job.job_id||typeof response.state!=="string"||
   !["cancelled","cancellation_requested","completed","failed","needs_review"].includes(response.state)||
   response.provider_called!==false||typeof response.in_flight_request_may_continue!=="boolean")throw Error("Invalid cancellation");
  await refresh(signal);
  if(!signal.aborted)setMessage("Estado de cancelación consultado. Una solicitud que ya se haya enviado al proveedor puede finalizar y conservar su resultado.");
 }
 return <section className="document-ai-confirm" aria-label="Ejecución documental en segundo plano">
  <h3>Ejecución documental en segundo plano</h3>
  {planId&&<p>Este envío se vinculará al plan guardado <code>{planId}</code>. El servidor comprobará que su alcance sigue vigente.</p>}
  {includePlanObjective&&<p>El envío incluirá también el objetivo guardado de este plan para orientar el informe. No amplía el acceso a otros archivos ni herramientas.</p>}
  {ready&&includePlanObjective&&!objectiveSupported&&<p role="status">La ejecución con objetivo requiere activar la migración 029. No se enviará como análisis estándar si falta esta capacidad.</p>}
  <p>Una lectura y un informe para {e.path}, con SHA {e.sha.slice(0,12)}…. La tarea requiere revisión humana al terminar.</p>
  <button type="button" className="button-outline" disabled={busy}
   onClick={()=>void operation(refresh)}>{busy?"Consultando ejecución…":"Consultar ejecución en segundo plano"}</button>
  {enabled===false&&<p role="status">El motor en segundo plano todavía no está habilitado para esta empresa.</p>}
  {ready&&enabled&&<>
   <p>La disponibilidad de la cola no confirma que el trabajador esté conectado. Solo el historial confirma sus pasos.</p>
   {!approvalId&&!active&&<p>Prepara primero un permiso documental para este archivo y SHA.</p>}
   {!liveLease&&!active&&<p>Se necesita una reserva vigente del trabajador. Consulta o revisa la reserva en el control de lectura.</p>}
   {canQueue&&!confirm&&<button type="button" disabled={busy} onClick={()=>setConfirm(true)}>Preparar ejecución en segundo plano</button>}
   {canQueue&&confirm&&<div>
    <p>Al confirmar se consume el permiso documental.{includePlanObjective?" Autorizas enviar también el objetivo guardado del plan a OpenAI.":""} El trabajador podrá leer este archivo y enviarlo a OpenAI para UN informe antes de caducar la reserva; puede consumir tokens de pago. Puede comenzar aunque cierres el navegador.</p>
    <button type="button" disabled={busy} onClick={()=>void operation(enqueue)}>Confirmar y encolar informe</button>
    <button type="button" disabled={busy} onClick={()=>setConfirm(false)}>Volver</button>
   </div>}
  </>}
  {jobs.length>0&&<><h4>Historial de esta tarea</h4>
  <p>Puede incluir otros documentos y revisiones. Consulta Informes IA para el archivo y SHA de cada resultado.</p>
  <ul>{jobs.map(j=><li key={j.job_id}>
   <strong>{labels[j.state]}</strong> · {new Date(j.created_at).toLocaleString("es-ES")} · Referencia: {j.job_id}
   {j.attention_required&&<p>Requiere revisión. No se repetirá automáticamente.</p>}
   {j.cancel_requested&&<p>Parada solicitada; un envío en curso puede finalizar.</p>}
   {ready&&["queued","claimed","source_verified","provider_started"].includes(j.state)&&!j.cancel_requested&&
    <button type="button" disabled={busy} onClick={()=>void operation(s=>cancel(j,s))}>Solicitar parada</button>}
  </li>)}</ul></>}
  {message&&<p role="status">{message}</p>}
 </section>;
}


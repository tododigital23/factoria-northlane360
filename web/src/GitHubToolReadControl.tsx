import "./GitHubToolReadControl.css";
import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";

type Evidence={organization_id:string;task_id:string;worker_id:string;repository:string;path:string;sha:string};
type Lease={lease_id:string;worker_id:string;state:string;expires_at:string;usable:boolean};
type Grant={grant_id:string;lease_id:string;repository:string;path:string;sha:string;state:string;expires_at:string;unexpired_approval:boolean};
type Invocation={invocation_id:string;status:string;size_bytes:number|null;claimed_at:string;error_code:string|null};
type Capability={organization_id:string;enabled:boolean;storage_ready:boolean;source_configured:boolean;lease_review_ready?:boolean};
type Review={organization_id:string;task_id:string;state:string;message:string;suspend_new_actions:boolean;review_required:boolean;advisory_only:boolean};
type Props={evidence:Evidence};
const api=API_ROOT+"/v1/me/organizations/";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=(x:unknown):x is Record<string,unknown>=>typeof x==="object"&&x!==null;
class RequestError extends Error {constructor(public status:number){super("Request failed");}}

export function GitHubToolReadControl({evidence:e}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [cap,setCap]=useState<Capability|null>(null);
 const [lease,setLease]=useState<Lease|null>(null);
 const [grant,setGrant]=useState<Grant|null>(null);
 const [history,setHistory]=useState<Invocation[]>([]);
 const [review,setReview]=useState<Review|null>(null);
 const [content,setContent]=useState<string|null>(null);
 const [message,setMessage]=useState("");
 const [busy,setBusy]=useState(false);
 const [attempted,setAttempted]=useState(false);
 const [reason,setReason]=useState("");
 const [acknowledged,setAcknowledged]=useState(false);
 const [now,setNow]=useState(Date.now());
 const lock=useRef(false);
 const controller=useRef<AbortController|null>(null);
 const keys=useRef({lease:crypto.randomUUID(),grant:crypto.randomUUID(),read:crypto.randomUUID(),review:crypto.randomUUID()});
 const root=api+encodeURIComponent(e.organization_id);
 const base=root+"/tasks/"+encodeURIComponent(e.task_id)+"/execution";
 useEffect(()=>{const clock=window.setInterval(()=>setNow(Date.now()),1000);return()=>{
   controller.current?.abort();window.clearInterval(clock);
 };},[]);
 const liveLease=!!lease&&lease.worker_id===e.worker_id&&lease.state==="held"&&lease.usable&&Date.parse(lease.expires_at)>now;
 const ready=cap?.enabled===true&&review!==null;
 const scoped=!!grant&&grant.lease_id===lease?.lease_id&&grant.repository===e.repository&&grant.path===e.path&&grant.sha===e.sha;

 async function request(url:string,signal:AbortSignal,body?:object):Promise<unknown>{
  const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:body?"read:tasks create:tasks":"read:tasks"}});
  if(signal.aborted)throw new DOMException("Aborted","AbortError");
  const res=await fetch(url,{method:body?"POST":"GET",signal,
   headers:{Authorization:"Bearer "+token,...(body?{"Content-Type":"application/json"}:{})},
   ...(body?{body:JSON.stringify(body)}:{})});
  if(!res.ok)throw new RequestError(res.status);
  return res.json();
 }
 async function run(job:(signal:AbortSignal)=>Promise<void>){
  if(lock.current)return;
  lock.current=true;setBusy(true);setMessage("");
  const current=new AbortController();controller.current=current;
  try{await job(current.signal);}catch{
   if(!current.signal.aborted)setMessage("No se pudo confirmar la operación. Consulta el historial y actualiza el estado antes de actuar. No se reintentará ninguna lectura automáticamente.");
  }finally{if(!current.signal.aborted){setBusy(false);lock.current=false;}}
 }
 async function loadState(signal:AbortSignal){
  setReview(null);
  const raw=await request(root+"/execution/github-tool-capability",signal);
  if(!object(raw)||raw.organization_id!==e.organization_id||typeof raw.enabled!=="boolean"||typeof raw.storage_ready!=="boolean"||typeof raw.source_configured!=="boolean")throw Error("Invalid capability");
  const next=raw as unknown as Capability;
  if(signal.aborted)return;
  setCap(next);
  if(!next.storage_ready){setMessage("El registro de lecturas todavía no está disponible.");return;}
  const [l,g,h,r]=await Promise.all([request(base+"/lease",signal),request(base+"/github-read-grants",signal),request(base+"/github-reads",signal),request(base+"/github-read-review",signal)]);
  if(!object(r)||r.organization_id!==e.organization_id||r.task_id!==e.task_id||typeof r.state!=="string"||typeof r.message!=="string"||typeof r.suspend_new_actions!=="boolean"||typeof r.review_required!=="boolean"||r.advisory_only!==true)throw Error("Invalid review");
  if(!object(l)||l.organization_id!==e.organization_id||l.task_id!==e.task_id||!Array.isArray(g)||!Array.isArray(h))throw Error("Invalid state");
  const parsed=l.lease;
  if(parsed!==null&&(!object(parsed)||typeof parsed.lease_id!=="string"||!uuid.test(parsed.lease_id)||typeof parsed.worker_id!=="string"||typeof parsed.expires_at!=="string"||!Number.isFinite(Date.parse(parsed.expires_at))||typeof parsed.state!=="string"||typeof parsed.usable!=="boolean"))throw Error("Invalid lease");
  if(!g.every(x=>object(x)&&typeof x.grant_id==="string"&&uuid.test(x.grant_id)&&typeof x.lease_id==="string"&&typeof x.repository==="string"&&typeof x.path==="string"&&typeof x.sha==="string"&&typeof x.state==="string"&&typeof x.expires_at==="string"&&Number.isFinite(Date.parse(x.expires_at))&&typeof x.unexpired_approval==="boolean")||
   !h.every(x=>object(x)&&typeof x.invocation_id==="string"&&uuid.test(x.invocation_id)&&typeof x.status==="string"&&typeof x.claimed_at==="string"&&(x.size_bytes===null||typeof x.size_bytes==="number")))throw Error("Invalid journal");
  if(signal.aborted)return;
  setLease(parsed as Lease|null);
  setGrant((g as Grant[]).find(x=>x.lease_id===(parsed as Lease|null)?.lease_id&&x.repository===e.repository&&x.path===e.path&&x.sha===e.sha&&x.state==="approved"&&x.unexpired_approval)??null);
  setHistory(h as Invocation[]);
  setReview(r as unknown as Review);
 }
 function reserve(){if(review?.suspend_new_actions!==false)return;void run(async signal=>{
  const raw=await request(base+"/lease",signal,{worker_id:e.worker_id,request_key:keys.current.lease});
  if(!object(raw)||raw.organization_id!==e.organization_id||raw.task_id!==e.task_id||!object(raw.lease)||raw.lease.worker_id!==e.worker_id)throw Error("Invalid lease");
  await loadState(signal);
 });}
 function approve(){if(!liveLease||!lease||review?.suspend_new_actions!==false)return;void run(async signal=>{
  const raw=await request(base+"/github-read-grants",signal,{worker_id:e.worker_id,lease_id:lease.lease_id,request_key:keys.current.grant,repository:e.repository,path:e.path,expected_sha:e.sha});
  if(!object(raw)||raw.organization_id!==e.organization_id||raw.task_id!==e.task_id||typeof raw.grant_id!=="string"||!uuid.test(raw.grant_id)||raw.read_only!==true||raw.single_use!==true)throw Error("Invalid approval");
  await loadState(signal);
 });}
 function read(){if(!liveLease||!lease||!grant||!scoped||attempted||review?.suspend_new_actions!==false)return;setAttempted(true);void run(async signal=>{
  setContent(null);
  const raw=await request(base+"/github-reads",signal,{worker_id:e.worker_id,lease_id:lease.lease_id,grant_id:grant.grant_id,request_key:keys.current.read,repository:e.repository,path:e.path,expected_sha:e.sha});
  if(!object(raw)||typeof raw.invocation_id!=="string"||!uuid.test(raw.invocation_id))throw Error("Invalid invocation");
  if(raw.replayed===true){setMessage("La solicitud ya figura en el registro. No se ha repetido la lectura.");await loadState(signal);return;}
  const doc=raw.document;
  if(raw.status!=="completed"||raw.sent_to_model!==false||!object(doc)||doc.repository!==e.repository||doc.path!==e.path||doc.sha!==e.sha||doc.source_verified!==true||doc.read_only!==true||typeof doc.content!=="string"||new TextEncoder().encode(doc.content).length>16384)throw Error("Invalid document");
  if(signal.aborted)return;
  setContent(doc.content);setGrant(null);
  await loadState(signal);
  if(!signal.aborted)setMessage("Lectura verificada y registrada. La tarea sigue pendiente.");
 });}
 function renewAfterReview(){
  if(!lease||!cap?.lease_review_ready||!acknowledged||reason.trim().length<10||reason.trim().length>1000||!review||!["released_requires_review","expired_requires_review"].includes(review.state))return;
  void run(async signal=>{
   const raw=await request(base+"/lease/review",signal,{previous_lease_id:lease.lease_id,worker_id:e.worker_id,reason:reason.trim(),request_key:keys.current.review});
   if(!object(raw)||raw.organization_id!==e.organization_id||raw.task_id!==e.task_id||raw.previous_lease_id!==lease.lease_id||typeof raw.lease_id!=="string"||!uuid.test(raw.lease_id)||raw.execution_started!==false||raw.requires_fresh_tool_approval!==true)throw Error("Invalid review result");
   if(signal.aborted)return;
   keys.current={lease:crypto.randomUUID(),grant:crypto.randomUUID(),read:crypto.randomUUID(),review:crypto.randomUUID()};
   setAttempted(false);setContent(null);setGrant(null);setReason("");setAcknowledged(false);
   await loadState(signal);
   if(!signal.aborted)setMessage("Revisión registrada. La nueva reserva necesita una autorización de lectura nueva; no se ha ejecutado ningún trabajo.");
  });
 }
 function release(){if(!lease||review?.suspend_new_actions!==false)return;void run(async signal=>{
  const raw=await request(base+"/lease/release",signal,{lease_id:lease.lease_id});
  if(!object(raw)||raw.lease_id!==lease.lease_id||raw.state!=="released")throw Error("Invalid release");
  await loadState(signal);
 });}
 return <section className="github-tool-control" aria-label="Lectura autorizada del trabajador">
  <h3>Lectura autorizada del trabajador</h3>
  <p>Documento: <strong>{e.path}</strong> · {e.repository}</p>
  <p>El trabajador puede leer esta revisión una sola vez. El contenido no se envía a la IA y la tarea permanece pendiente.</p>
  <button type="button" disabled={busy} onClick={()=>void run(loadState)}>{busy?"Comprobando…":"Actualizar estado e historial"}</button>
  {cap&&!cap.enabled&&<p role="status">La lectura todavía no está habilitada para esta empresa.</p>}
  {review&&<aside className="github-tool-review" role="status"><strong>Revisión de la reserva</strong><p>{review.message}</p><small>Diagnóstico de solo lectura sobre los últimos 20 intentos. No renueva reservas ni repite solicitudes.</small></aside>}
  {ready&&!review?.suspend_new_actions&&<div className="github-tool-actions">
   {!lease&&<button type="button" disabled={busy} onClick={reserve}>1. Reservar tarea para el trabajador</button>}
   {lease&&!liveLease&&<p role="status">La reserva no está disponible. Un bloqueo liberado o vencido requiere revisión antes de una nueva ejecución.</p>}
   {liveLease&&<><p>Reserva activa hasta {new Date(lease!.expires_at).toLocaleTimeString("es-ES")}</p>
    {!grant&&!attempted&&<button type="button" disabled={busy} onClick={approve}>2. Autorizar lectura única de este documento</button>}
    {grant&&scoped&&!attempted&&<button type="button" disabled={busy||!grant.unexpired_approval||Date.parse(grant.expires_at)<=now} onClick={read}>3. Ejecutar lectura autorizada</button>}
    <button type="button" className="button-outline" disabled={busy} onClick={release}>Liberar reserva</button>
   </>}
  </div>}
  {cap?.lease_review_ready&&lease&&review&&["released_requires_review","expired_requires_review"].includes(review.state)&&<fieldset className="github-tool-renew" disabled={busy}>
   <legend>Revisar y solicitar una nueva reserva</legend>
   <p>Se conservará la reserva anterior y su historial. Los permisos pendientes de esa reserva quedarán revocados. Esta acción no ejecuta la lectura.</p>
   <label>Motivo de la revisión (10–1000 caracteres)<textarea value={reason} maxLength={1000} rows={3} onChange={event=>setReason(event.target.value)}/></label>
   <label><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/> He revisado el historial y autorizo una nueva reserva.</label>
   <button type="button" disabled={busy||!acknowledged||reason.trim().length<10} onClick={renewAfterReview}>Registrar revisión y crear nueva reserva</button>
  </fieldset>}
  {attempted&&content===null&&<p>Se ha enviado una solicitud. Consulta el historial para confirmar el resultado; no se repetirá automáticamente.</p>}
  {content!==null&&<details open><summary>Documento verificado</summary><pre className="github-tool-content">{content}</pre></details>}
  {history.length>0&&<div><h4>Historial de lecturas</h4><ul>{history.map(h=><li key={h.invocation_id}>
   {h.status==="completed"?"Completada":h.status==="failed"?"Fallida":"Resultado pendiente de confirmar"} · {new Date(h.claimed_at).toLocaleString("es-ES")}{h.size_bytes!==null?" · "+h.size_bytes+" bytes":""}<br/><small>Referencia: {h.invocation_id}</small>
  </li>)}</ul></div>}
  {message&&<p role="status">{message}</p>}
 </section>;
}

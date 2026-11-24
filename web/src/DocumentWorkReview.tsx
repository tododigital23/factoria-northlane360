import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";
type Decision="accepted"|"changes_requested";
type Review={id:string;decision:Decision;reason:string;reviewed_at:string;task_status_after:string;request_key:string};
type Context={organization_id:string;task_id:string;run_id:string;enabled:boolean;eligible:boolean;task_status?:string;unavailable_reason?:string|null;review:Review|null;provider_called:false};
const prefix=API_ROOT+"/v1/me/organizations/";
const reasons:Record<string,string>={task_not_pending:"La tarea ya no está pendiente.",task_changed:"La tarea o su asignación cambiaron después de iniciar este informe.",unconfirmed_execution:"Hay ejecuciones pendientes o con resultado sin confirmar.",newer_attempt:"Hay un intento posterior; este informe ha quedado desactualizado.",report_unavailable:"El informe no está completado o no está disponible.",already_reviewed:"La decisión sobre este informe ya está registrada."};
export function DocumentWorkReview({companyId,taskId,runId}:{companyId:string;taskId:string;runId:string}){
 const {getAccessTokenSilently}=useAuth0();
 const [context,setContext]=useState<Context|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const [decision,setDecision]=useState<Decision>("changes_requested"),[reason,setReason]=useState("");
 const [confirmed,setConfirmed]=useState(false),[uncertain,setUncertain]=useState(false);
 const locked=useRef(false),generation=useRef(0);
 const pending=useRef<{decision:Decision;reason:string;request_key:string}|null>(null);
 const scope=companyId+":"+taskId+":"+runId;
 const currentScope=useRef(scope);currentScope.current=scope;
 const url=prefix+encodeURIComponent(companyId)+"/tasks/"+encodeURIComponent(taskId)+"/execution/document-runs/"+encodeURIComponent(runId)+"/review";
 function valid(raw:unknown):raw is Context{
  if(!raw||typeof raw!=="object")return false;
  const x=raw as Context;
  if(x.organization_id!==companyId||x.task_id!==taskId||x.run_id!==runId||x.provider_called!==false||typeof x.enabled!=="boolean"||typeof x.eligible!=="boolean")return false;
  if(!x.enabled)return x.eligible===false&&x.review===null;
  if(typeof x.task_status!=="string")return false;
  if(x.review===null)return true;
  const r=x.review;
  return !!r&&typeof r.id==="string"&&typeof r.request_key==="string"&&typeof r.reason==="string"&&typeof r.reviewed_at==="string"&&Number.isFinite(Date.parse(r.reviewed_at))&&
   ((r.decision==="accepted"&&r.task_status_after==="completed")||(r.decision==="changes_requested"&&r.task_status_after==="blocked"))&&x.eligible===false;
 }
 async function request(write=false,body?:unknown,signal?:AbortSignal){
  const version=generation.current;
  const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:write?"read:tasks create:tasks":"read:tasks"}});
  if(signal?.aborted||version!==generation.current||currentScope.current!==scope)throw Error("Stale scope");
  const response=await fetch(url,{method:write?"POST":"GET",headers:{Authorization:"Bearer "+token,...(write?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),signal});
  if(!response.ok)throw Error("Unavailable");
  const raw:unknown=await response.json();
  if(!valid(raw))throw Error("Invalid review context");
  return raw;
 }
 useEffect(()=>{
  const controller=new AbortController(),version=++generation.current;
  locked.current=false;pending.current=null;
  setContext(null);setError("");setBusy(true);setReason("");setConfirmed(false);setUncertain(false);setDecision("changes_requested");
  request(false,undefined,controller.signal).then(raw=>{if(version===generation.current)setContext(raw);}).catch(()=>{if(!controller.signal.aborted&&version===generation.current)setError("No se pudo consultar la revisión de este informe.");}).finally(()=>{if(version===generation.current)setBusy(false);});
  return ()=>{controller.abort();generation.current++;};
 },[companyId,taskId,runId,getAccessTokenSilently]);
 async function refresh(){
  if(locked.current)return;
  locked.current=true;setBusy(true);setError("");const version=generation.current;
  try{const raw=await request();if(version===generation.current)setContext(raw);}
  catch{if(version===generation.current)setError("No se pudo confirmar el estado guardado. No se enviará otra decisión automáticamente.");}
  finally{if(version===generation.current){locked.current=false;setBusy(false);}}
 }
 async function submit(){
  if(locked.current||uncertain||!context?.enabled||!context.eligible||context.review||!confirmed||Array.from(reason.trim()).length<10||Array.from(reason.trim()).length>1000)return;
  locked.current=true;setBusy(true);setError("");const version=generation.current;
  const body={decision,reason:reason.trim(),request_key:crypto.randomUUID()};pending.current=body;
  try{
   const raw=await request(true,body);
   if(!raw.review||raw.review.request_key!==body.request_key||raw.review.decision!==body.decision||raw.review.reason!==body.reason)throw Error("Unconfirmed decision");
   if(version===generation.current){setContext(raw);setConfirmed(false);}
  }catch{
   if(version!==generation.current)return;
   setUncertain(true);setConfirmed(false);
   setError("El envío no quedó confirmado. Consulta el estado guardado antes de cualquier otra acción; no se reenviará la decisión.");
   // Read after an ambiguous write; never resend or manufacture a new key.
   try{const raw=await request();if(version===generation.current)setContext(raw);}catch{/* Keep the uncertain state and explicit GET available. */}
  }finally{if(version===generation.current){locked.current=false;setBusy(false);}}
 }
 return <section className="document-work-review" aria-label="Revisión del trabajo">
  <h4>Revisión y decisión del propietario</h4>
  <button type="button" disabled={busy} onClick={refresh}>{busy?"Consultando revisión…":"Consultar revisión guardada"}</button>
  {error&&<p role="alert">{error}</p>}
  {context&&!context.enabled&&<p>La revisión formal requiere instalar la actualización administrativa 026. Puedes seguir consultando el informe.</p>}
  {context?.enabled&&<>
   <p>Estado actual de la tarea: <strong>{context.task_status}</strong></p>
   {context.review?<>
    <p role="status"><strong>{context.review.decision==="accepted"?"Informe aceptado":"Correcciones solicitadas"}</strong></p>
    <p>Estado tras la revisión: <strong>{context.review.task_status_after}</strong></p>
    <p>Motivo registrado: {context.review.reason}</p>
    <p>Fecha: {new Date(context.review.reviewed_at).toLocaleString("es-ES")} · Revisión: <code>{context.review.id}</code></p>
    {pending.current&&pending.current.request_key!==context.review.request_key&&<p>La decisión guardada corresponde a otra solicitud. Tu envío no se presenta como confirmado.</p>}
   </>:!context.eligible?<p role="status">{reasons[context.unavailable_reason||""]||"Este informe no reúne las condiciones para cerrar o devolver el trabajo."}</p>:<>
    <p>Esta decisión se aplica exclusivamente al informe mostrado. No genera otra ejecución ni consume tokens.</p>
    <label>Decisión
     <select value={decision} disabled={busy||uncertain} onChange={e=>{setDecision(e.target.value as Decision);setConfirmed(false);}}>
      <option value="changes_requested">Solicitar correcciones y bloquear tarea</option>
      <option value="accepted">Aceptar informe y completar tarea</option>
     </select>
    </label>
    <label>Motivo de la revisión (10 a 1000 caracteres)
     <textarea value={reason} maxLength={2000} disabled={busy||uncertain} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}/>
    </label>
    <label><input type="checkbox" checked={confirmed} disabled={busy||uncertain} onChange={e=>setConfirmed(e.target.checked)}/>
     {decision==="accepted"?"He revisado el informe y su evidencia. Confirmo que este resultado satisface la tarea y autorizo cerrarla.":"He revisado el informe. Confirmo que requiere las correcciones indicadas y autorizo bloquear la tarea."}
    </label>
    <button type="button" disabled={busy||uncertain||!confirmed||Array.from(reason.trim()).length<10||Array.from(reason.trim()).length>1000} onClick={submit}>
     {decision==="accepted"?"Confirmar aceptación y cerrar tarea":"Confirmar correcciones y bloquear tarea"}
    </button>
   </>}
  </>}
 </section>;
}

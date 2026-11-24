import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";
export type AutopilotMission={id:string;owner_is_creator:boolean;mission_control_state?:"active"|"paused"|"cancelled";steps:{position:number;plan_id:string;job_state:string|null;review_decision:string|null}[]};
type Props={companyId:string;mission:AutopilotMission;onChanged:()=>void};
type Dispatch={seq:number;position:number;plan_id:string;job_id:string;kind:"dispatch"|"retry";created_at:string};
type Autopilot={autopilot_id:string;state:"active"|"revoked"|"expired";max_jobs:number;jobs_dispatched:number;estimated_token_units:number;objective_consent:boolean;auto_retry:boolean;expires_at:string;created_at:string;revoked_at:string|null;granted_by_me:boolean;dispatches:Dispatch[]};
type Advance={stopped:string;stopped_at_position:number|null;dispatched:{position:number;plan_id:string;job_id:string;kind:"dispatch"|"retry"}[];jobs_dispatched?:number;max_jobs?:number};
type Frozen={body:string;key:string};
type Op="grant"|"advance"|"revoke";
const root=API_ROOT+"/v1/me/organizations/";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNITS=2500;
export const stopText:Record<string,string>={
 job_in_progress:"Trabajo en curso: Freddy espera a que termine.",
 awaiting_owner_review:"Esperando tu revisión del informe.",
 changes_requested:"Pediste cambios en un informe: Freddy se detiene.",
 needs_human_investigation:"Resultado incierto: requiere investigación humana.",
 step_failed_not_retryable:"Un paso falló y no se puede reintentar automáticamente.",
 retry_limit_reached:"Se alcanzó el límite de reintentos de un paso.",
 budget_exhausted:"Presupuesto agotado: se usaron todos los trabajos autorizados.",
 step_not_eligible:"Un control rechazó el paso.",
 mission_paused:"La misión está pausada.",
 mission_cancelled:"La misión está cancelada.",
 autopilot_expired:"La autorización del piloto automático ha caducado.",
 no_active_autopilot:"No hay una autorización activa del piloto automático.",
 mission_complete:"Misión completa."
};
export const UNCONFIRMED="Resultado no confirmado, consulta el seguimiento antes de otra acción.";
const thousands=(n:number)=>String(n).replace(/\B(?=(\d{3})+(?!\d))/g,".");
const isInt=(n:unknown,min:number,max:number)=>Number.isInteger(n)&&(n as number)>=min&&(n as number)<=max;
const date=(s:unknown)=>typeof s==="string"&&Number.isFinite(Date.parse(s));
const errors:Record<Op,Record<number,string>>={
 grant:{409:"El servidor no concedió el piloto automático: el número de trabajos debe estar dentro de los límites de la misión, la misión debe estar activa y sin otra autorización activa.",403:"No tienes autorización para conceder el piloto automático en esta misión.",422:"El servidor rechazó los términos por no ser válidos. Revísalos y vuelve a confirmar."},
 advance:{409:"El servidor no permitió continuar: la misión o la autorización ya no están activas. Actualiza los planes.",403:"No tienes autorización para hacer continuar a Freddy en esta misión.",422:"El servidor rechazó la solicitud por no ser válida."},
 revoke:{409:"El servidor no revocó la autorización: ya no está activa. Actualiza los planes.",403:"No tienes autorización para revocar el piloto automático de esta misión.",422:"El servidor rechazó el motivo. Debe tener entre 10 y 500 caracteres."}
};
const unavailable="El piloto automático aún no está disponible o confirmado en el servidor (actualización 033). No se ha hecho nada.";
function validAdvance(a:unknown,m:AutopilotMission,maxJobs?:number):a is Advance{
 if(!a||typeof a!=="object")return false;const x=a as Advance;const n=m.steps.length;
 if(typeof x.stopped!=="string"||!Object.hasOwn(stopText,x.stopped)||!(x.stopped_at_position===null||isInt(x.stopped_at_position,1,n))||!Array.isArray(x.dispatched)||x.dispatched.length>10)return false;
 if(x.max_jobs!==undefined&&(!isInt(x.max_jobs,1,10)||(maxJobs!==undefined&&x.max_jobs!==maxJobs)))return false;
 if(x.jobs_dispatched!==undefined&&!isInt(x.jobs_dispatched,0,x.max_jobs??maxJobs??10))return false;
 return new Set(x.dispatched.map(d=>d?.job_id)).size===x.dispatched.length&&x.dispatched.every(d=>d&&isInt(d.position,1,n)&&d.plan_id===m.steps[d.position-1].plan_id&&uuid.test(d.job_id||"")&&(d.kind==="dispatch"||d.kind==="retry"));
}
function validList(raw:unknown,m:AutopilotMission):raw is {enabled:boolean;autopilots:Autopilot[]}{
 if(!raw||typeof raw!=="object")return false;const x=raw as {enabled:unknown;autopilots:unknown;token_units_per_job:unknown;provider_called:unknown};
 if(typeof x.enabled!=="boolean"||x.provider_called!==false||x.token_units_per_job!==UNITS||!Array.isArray(x.autopilots)||x.autopilots.length>20||(!x.enabled&&x.autopilots.length!==0))return false;
 const list=x.autopilots as Autopilot[],n=m.steps.length;
 return list.filter(a=>a?.state==="active").length<=1&&new Set(list.map(a=>a?.autopilot_id)).size===list.length&&list.every(a=>a&&uuid.test(a.autopilot_id||"")&&["active","revoked","expired"].includes(a.state)&&isInt(a.max_jobs,1,10)&&isInt(a.jobs_dispatched,0,a.max_jobs)&&a.estimated_token_units===a.max_jobs*UNITS&&typeof a.objective_consent==="boolean"&&typeof a.auto_retry==="boolean"&&date(a.expires_at)&&date(a.created_at)&&(a.revoked_at===null||date(a.revoked_at))&&typeof a.granted_by_me==="boolean"&&
  Array.isArray(a.dispatches)&&a.dispatches.length<=a.max_jobs&&a.dispatches.every(d=>d&&Number.isInteger(d.seq)&&isInt(d.position,1,n)&&d.plan_id===m.steps[d.position-1].plan_id&&uuid.test(d.job_id||"")&&(d.kind==="dispatch"||d.kind==="retry")&&date(d.created_at)));
}
export function MissionAutopilot({companyId,mission:m,onChanged}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const n=m.steps.length,minJobs=n,maxAllowed=Math.min(10,n*3);
 const [list,setList]=useState<{enabled:boolean;autopilots:Autopilot[]}|null>(null),[listError,setListError]=useState(false),[tick,setTick]=useState(0);
 const [maxJobs,setMaxJobs]=useState(String(Math.min(Math.max(n+1,minJobs),maxAllowed))),[hours,setHours]=useState("24"),[objectiveConsent,setObjectiveConsent]=useState(false),[autoRetry,setAutoRetry]=useState(true),[costConsent,setCostConsent]=useState(false);
 const [reason,setReason]=useState(""),[revokeConfirm,setRevokeConfirm]=useState(false);
 const [busy,setBusy]=useState<Op|null>(null),[retry,setRetry]=useState<Op|null>(null),[error,setError]=useState(""),[message,setMessage]=useState(""),[last,setLast]=useState<Advance|null>(null);
 const controller=useRef(new AbortController()),guard=useRef(false),frozen=useRef<Frozen|null>(null),revokeBody=useRef<string|null>(null);
 const base=root+encodeURIComponent(companyId)+"/execution/document-missions/"+encodeURIComponent(m.id)+"/autopilot";
 useEffect(()=>{const c=new AbortController();controller.current=c;return()=>c.abort();},[companyId,m.id]);
 useEffect(()=>{
  const abort=new AbortController();setListError(false);
  (async()=>{try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});if(abort.signal.aborted)return;
   const r=await fetch(base,{headers:{Authorization:"Bearer "+token},signal:abort.signal});if(!r.ok)throw Error("Unavailable");
   const raw:unknown=await r.json();if(!validList(raw,m))throw Error("Invalid autopilot");if(!abort.signal.aborted)setList({enabled:raw.enabled,autopilots:raw.autopilots});
  }catch{if(!abort.signal.aborted){setList(null);setListError(true);}}})();
  return()=>abort.abort();
  // The mission steps are part of the validation; re-read when they change.
 },[base,tick,JSON.stringify(m.steps.map(s=>s.plan_id)),getAccessTokenSilently]);
 const active=list?.autopilots.find(a=>a.state==="active")||null;
 const owner=m.owner_is_creator&&m.mission_control_state==="active";
 const jobs=Number(maxJobs),hrs=Number(hours);
 const termsValid=/^\d+$/.test(maxJobs)&&/^\d+$/.test(hours)&&isInt(jobs,minJobs,maxAllowed)&&isInt(hrs,1,168);
 const canGrant=list?.enabled===true&&owner&&!active&&!busy&&(retry==="grant"?frozen.current!==null:termsValid&&costConsent);
 const reasonOk=Array.from(reason.trim()).length>=10&&Array.from(reason.trim()).length<=500;
 function terms<T>(set:(v:T)=>void){return (v:T)=>{set(v);setCostConsent(false);frozen.current=null;if(retry==="grant")setRetry(null);};}
 async function call(op:Op,signal:AbortSignal,body?:string){
  const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}});if(signal.aborted)return null;
  return fetch(base+(op==="grant"?"":"/"+op),{method:"POST",signal,headers:{Authorization:"Bearer "+token,...(body!==undefined?{"Content-Type":"application/json"}:{})},...(body!==undefined?{body}:{})});
 }
 async function run(op:Op){
  if(guard.current||busy)return;
  let body:string|undefined;
  if(op==="grant"){
   if(!canGrant)return;
   if(retry!=="grant"||!frozen.current){const key=crypto.randomUUID();frozen.current={key,body:JSON.stringify({max_jobs:jobs,objective_consent:objectiveConsent,auto_retry:autoRetry,hours:hrs,cost_consent:true,request_key:key})};}
   body=frozen.current.body;setCostConsent(false);
  }else if(op==="revoke"){
   if(!active||!m.owner_is_creator)return;
   if(retry!=="revoke"||!revokeBody.current){if(!reasonOk||!revokeConfirm)return;revokeBody.current=JSON.stringify({reason:reason.trim()});}
   body=revokeBody.current;setRevokeConfirm(false);
  }else if(!active||!m.owner_is_creator)return;
  guard.current=true;setBusy(op);setError("");setMessage("");const signal=controller.current.signal;
  const uncertain=()=>{setRetry(op);setError(UNCONFIRMED);};
  try{
   let r:Response|null;
   try{r=await call(op,signal,body);}catch{if(!signal.aborted)uncertain();return;}
   if(!r||signal.aborted)return;
   if(r.status===503||errors[op][r.status]){setRetry(null);if(op==="grant")frozen.current=null;if(op==="revoke")revokeBody.current=null;setError(r.status===503?unavailable:errors[op][r.status]);return;}
   if(!r.ok){uncertain();return;}
   let raw:Record<string,unknown>;try{raw=await r.json();}catch{if(!signal.aborted)uncertain();return;}
   if(signal.aborted)return;
   if(!raw||typeof raw!=="object"||(raw.provider_called!==undefined&&raw.provider_called!==false)||(raw.task_completed!==undefined&&raw.task_completed!==false)){uncertain();return;}
   if(op==="grant"){
    const sent=JSON.parse(body!);
    if(!uuid.test(String(raw.autopilot_id))||typeof raw.replayed!=="boolean"||raw.max_jobs!==sent.max_jobs||raw.estimated_token_units!==sent.max_jobs*UNITS||raw.provider_called!==false||raw.task_completed!==false||!validAdvance(raw.advance,m,sent.max_jobs)){uncertain();return;}
    frozen.current=null;setLast(raw.advance as Advance);setMessage("Piloto automático concedido"+(raw.replayed?" (solicitud ya registrada)":"")+". "+dispatchedText(raw.advance as Advance));
   }else if(op==="advance"){
    if(!validAdvance(raw.advance,m,active!.max_jobs)){uncertain();return;}
    setLast(raw.advance as Advance);setMessage(dispatchedText(raw.advance as Advance));
   }else{
    if(typeof raw.revoked!=="boolean"||raw.queued_jobs_aborted!==false){uncertain();return;}
    revokeBody.current=null;setReason("");setLast(null);setMessage(raw.revoked?"Autorización revocada. Los trabajos ya en cola no se han cancelado.":"No había una autorización activa que revocar.");
   }
   setRetry(null);setTick(t=>t+1);onChanged();
  }catch{if(!signal.aborted)uncertain();}
  finally{if(!signal.aborted){guard.current=false;setBusy(null);}}
 }
 const estimate=termsValid?jobs:0;
 return <section className="mission-autopilot" aria-label="Piloto automático de Freddy">
  <h4>Piloto automático de Freddy</h4>
  <p>Freddy envía los pasos de esta misión por orden, dentro del presupuesto que autorices. Se detiene para que revises cada informe; aceptar o pedir cambios sigue siendo tu decisión.</p>
  {list===null&&!listError&&<p>Consultando el piloto automático…</p>}
  {listError&&<p role="status">No se pudo verificar el piloto automático de esta misión. No se muestran acciones.</p>}
  {list?.enabled===false&&<p role="status">El piloto automático no está disponible aún en el servidor. Los controles manuales siguen disponibles.</p>}
  {list?.enabled&&active&&<div className="mission-autopilot-active">
   <p><strong>Autorización activa</strong> · {active.granted_by_me?"concedida por ti":"concedida por otra persona"} · caduca {new Date(active.expires_at).toLocaleString("es-ES")}</p>
   <label>Presupuesto usado<progress value={active.jobs_dispatched} max={active.max_jobs}/></label>
   <p>{active.jobs_dispatched}/{active.max_jobs} trabajos enviados · hasta {thousands(active.estimated_token_units)} unidades de cuota · {active.auto_retry?"reintento automático de fallos conocidos":"sin reintento automático"} · {active.objective_consent?"incluye el objetivo del plan":"sin el objetivo del plan"}</p>
   {last&&<p>Última parada: {stopText[last.stopped]}{last.stopped_at_position?" (paso "+last.stopped_at_position+")":""}</p>}
   {m.owner_is_creator&&<button type="button" disabled={!!busy} onClick={()=>void run("advance")}>{busy==="advance"?"Freddy está comprobando…":"Freddy, continúa"}</button>}
   {m.owner_is_creator&&<details><summary>Revocar piloto automático</summary>
    <p>Revocar impide nuevos envíos automáticos. Los trabajos ya en cola NO se cancelan y pueden terminar.</p>
    <label>Motivo de la revocación<textarea value={reason} maxLength={1000} disabled={!!busy} onChange={e=>{setReason(e.target.value);setRevokeConfirm(false);revokeBody.current=null;if(retry==="revoke")setRetry(null);}}/></label>
    <label><input type="checkbox" checked={revokeConfirm} disabled={!!busy||retry==="revoke"} onChange={e=>setRevokeConfirm(e.target.checked)}/>Confirmo revocar el piloto automático. Los trabajos en cola no se cancelan.</label>
    <button type="button" disabled={!!busy||(retry==="revoke"?!revokeBody.current:!reasonOk||!revokeConfirm)} onClick={()=>void run("revoke")}>{busy==="revoke"?"Revocando…":retry==="revoke"?"Reintentar la revocación":"Revocar piloto automático"}</button>
   </details>}
  </div>}
  {list?.enabled&&!active&&!owner&&<p>Solo quien creó la misión puede conceder el piloto automático, y únicamente con la misión activa.</p>}
  {list?.enabled&&!active&&owner&&<details><summary>Conceder piloto automático</summary>
   <label>Máximo de trabajos ({minJobs}–{maxAllowed})<input type="number" min={minJobs} max={maxAllowed} step={1} value={maxJobs} disabled={!!busy} onChange={e=>terms(setMaxJobs)(e.target.value)}/></label>
   <label>Duración en horas (1–168)<input type="number" min={1} max={168} step={1} value={hours} disabled={!!busy} onChange={e=>terms(setHours)(e.target.value)}/></label>
   <label><input type="checkbox" checked={objectiveConsent} disabled={!!busy} onChange={e=>terms(setObjectiveConsent)(e.target.checked)}/>Incluir el objetivo de cada plan: su texto se enviará al proveedor de IA junto con el documento.</label>
   <label><input type="checkbox" checked={autoRetry} disabled={!!busy} onChange={e=>terms(setAutoRetry)(e.target.checked)}/>Reintentar automáticamente solo fallos conocidos, nunca resultados inciertos; máximo 2 reintentos por plan.</label>
   <label><input type="checkbox" checked={costConsent} disabled={!!busy||!termsValid||retry==="grant"} onChange={e=>setCostConsent(e.target.checked)}/>Acepto el coste: hasta {estimate} trabajos ≈ {estimate}×2.500 = {thousands(estimate*UNITS)} unidades de cuota. La aceptación de cada informe sigue siendo mía.</label>
   {!termsValid&&<p>Revisa los términos: entre {minJobs} y {maxAllowed} trabajos y entre 1 y 168 horas.</p>}
   <button type="button" disabled={!canGrant} onClick={()=>void run("grant")}>{busy==="grant"?"Concediendo…":retry==="grant"?"Reintentar la misma concesión":"Conceder piloto automático"}</button>
  </details>}
  {list?.enabled&&list.autopilots.some(a=>a.dispatches.length>0)&&<details><summary>Historial de envíos de Freddy</summary><ol>{list.autopilots.flatMap(a=>a.dispatches.map(d=><li key={a.autopilot_id+":"+d.seq}>Paso {d.position} · {d.kind==="retry"?"reintento":"envío"} · trabajo {d.job_id} · {new Date(d.created_at).toLocaleString("es-ES")}</li>))}</ol></details>}
  {message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
function dispatchedText(a:Advance){
 const sent=a.dispatched.length?"Freddy envió "+a.dispatched.map(d=>"paso "+d.position+(d.kind==="retry"?" (reintento)":"")).join(", ")+". ":"Freddy no envió ningún trabajo. ";
 return sent+"Se detiene: "+stopText[a.stopped]+(a.jobs_dispatched!==undefined&&a.max_jobs!==undefined?" Presupuesto: "+a.jobs_dispatched+"/"+a.max_jobs+" trabajos.":"");
}

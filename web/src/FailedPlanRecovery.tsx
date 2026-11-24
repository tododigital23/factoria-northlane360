import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";
export type RecoverablePlan={id:string;task_id:string;job_id:string|null;job_state:string|null;control_state?:"active"|"paused"|"cancelled";owner_is_creator:boolean;mission_id?:string|null};
type Props={companyId:string;plan:RecoverablePlan;onRecovered:()=>void};
type Attempt={plan_id:string;attempt:1|2;failed_job_id:string;failed_run_id:string|null;failed_error_code:string|null;reason:string;reopened_at:string;reopened_by_me:boolean};
type Result={attempt:1|2;replayed:boolean};
type Frozen={body:string;key:string};
const root=API_ROOT+"/v1/me/organizations/";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nextSteps=["review_previous_lease","approve_document_analysis","dispatch_plan"];
const stepText:Record<string,string>={
 review_previous_lease:"Revisar la reserva del trabajo anterior y comprobar que ya no está activa.",
 approve_document_analysis:"Crear una nueva autorización de un solo uso para el análisis documental, con su propio consentimiento de coste.",
 dispatch_plan:"Enviar el plan con los controles de envío existentes."
};
const reasonLength=(r:string)=>Array.from(r.trim()).length;
const validReason=(r:string)=>reasonLength(r)>=10&&reasonLength(r)<=500;
export const UNCONFIRMED="Resultado no confirmado, consulta el seguimiento. Si reintentas se reenviará exactamente la misma solicitud; el servidor no la duplicará.";
const final:Record<number,string>={
 403:"No tienes autorización para reabrir este plan. No se ha modificado nada.",
 409:"Este plan no se puede reabrir: el trabajo ya no figura como fallido, su resultado es incierto, la fuente ha cambiado, el plan o su misión están pausados o cancelados, se alcanzó el límite de 2 reaperturas o la tarea ya no está pendiente. Actualiza el seguimiento.",
 503:"La recuperación tras fallo aún no está disponible o confirmada en el servidor (actualización 032). No se ha reabierto nada.",
 422:"El servidor rechazó la solicitud por no ser válida. Revisa el motivo (entre 10 y 500 caracteres) y vuelve a confirmar."
};
function validAttempts(raw:unknown,planId:string):raw is {enabled:boolean;attempts:Attempt[]}{
 if(!raw||typeof raw!=="object")return false;const x=raw as {enabled:unknown;attempts:unknown;provider_called:unknown};
 if(typeof x.enabled!=="boolean"||x.provider_called!==false||!Array.isArray(x.attempts)||x.attempts.length>2||(!x.enabled&&x.attempts.length!==0))return false;
 return (x.attempts as Attempt[]).every(a=>a&&a.plan_id===planId&&(a.attempt===1||a.attempt===2)&&uuid.test(a.failed_job_id||"")&&(a.failed_run_id===null||uuid.test(a.failed_run_id||""))&&(a.failed_error_code===null||typeof a.failed_error_code==="string")&&typeof a.reason==="string"&&typeof a.reopened_at==="string"&&Number.isFinite(Date.parse(a.reopened_at))&&typeof a.reopened_by_me==="boolean");
}
export function FailedPlanRecovery({companyId,plan,onRecovered}:Props){
 // Kept here so the confirmation survives the parent reload, even if the plan then stops reading as failed.
 const [done,setDone]=useState<{company:string;plan:string;result:Result}|null>(null);
 // A request in flight (or unconfirmed) stays mounted with its frozen failed job, even if a reload already shows job_id null.
 const [pending,setPending]=useState<{company:string;plan:string;job:string}|null>(null);
 const onDone=(result:Result)=>{setDone({company:companyId,plan:plan.id,result});setPending(null);onRecovered();};
 const onPending=(job:string|null)=>setPending(job?{company:companyId,plan:plan.id,job}:null);
 if(done&&done.company===companyId&&done.plan===plan.id)return <section className="failed-plan-recovery" aria-label="Reabrir plan tras fallo"><div role="status"><p>Plan reabierto · intento {done.result.attempt} de 2{done.result.replayed?" (solicitud ya registrada)":""}. No se ha ejecutado nada ni consumido cuota.</p><p>Próximos pasos:</p><ol>{nextSteps.map(s=><li key={s}>{stepText[s]}</li>)}</ol></div></section>;
 if(pending&&pending.company===companyId&&pending.plan===plan.id&&(plan.job_state!=="failed"||plan.job_id!==pending.job))return <RecoveryPanel key={companyId+":"+plan.id+":"+pending.job} companyId={companyId} plan={{...plan,job_id:pending.job,job_state:"failed"}} onRecovered={onDone} onPending={onPending}/>;
 if(plan.job_state==="needs_review")return <p className="failed-plan-recovery">Resultado incierto: no se sabe si el análisis llegó a ejecutarse. Requiere investigación humana; este plan no se puede reabrir desde aquí.</p>;
 if(plan.job_state!=="failed")return null;
 if(!plan.owner_is_creator||plan.control_state!=="active"||!plan.job_id||!uuid.test(plan.job_id))return <p className="failed-plan-recovery">Trabajo fallido. Solo quien creó el plan puede reabrirlo, y únicamente mientras el plan esté activo.</p>;
 return <RecoveryPanel key={companyId+":"+plan.id+":"+plan.job_id} companyId={companyId} plan={plan} onRecovered={onDone} onPending={onPending}/>;
}
function RecoveryPanel({companyId,plan,onRecovered,onPending}:{companyId:string;plan:RecoverablePlan;onRecovered:(r:Result)=>void;onPending:(job:string|null)=>void}){
 const {getAccessTokenSilently}=useAuth0();
 const [reason,setReason]=useState(""),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[locked,setLocked]=useState(false),[retry,setRetry]=useState(false),[error,setError]=useState("");
 const [history,setHistory]=useState<{enabled:boolean;attempts:Attempt[]}|null>(null),[historyError,setHistoryError]=useState(false);
 const controller=useRef(new AbortController()),guard=useRef(false),frozen=useRef<Frozen|null>(null),failedJob=useRef(plan.job_id as string).current;
 const base=root+encodeURIComponent(companyId)+"/tasks/"+encodeURIComponent(plan.task_id)+"/execution/document-plans/"+encodeURIComponent(plan.id);
 useEffect(()=>{const c=new AbortController();controller.current=c;return()=>c.abort();},[companyId,plan.id]);
 useEffect(()=>{
  const abort=new AbortController();setHistoryError(false);
  (async()=>{try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});if(abort.signal.aborted)return;
   const r=await fetch(base+"/attempts",{headers:{Authorization:"Bearer "+token},signal:abort.signal});if(!r.ok)throw Error("Unavailable");
   const raw:unknown=await r.json();if(!validAttempts(raw,plan.id))throw Error("Invalid attempts");if(!abort.signal.aborted)setHistory({enabled:raw.enabled,attempts:raw.attempts});
  }catch{if(!abort.signal.aborted){setHistory(null);setHistoryError(true);}}})();
  return()=>abort.abort();
 },[base,plan.id,getAccessTokenSilently]);
 const reopenedThisFailure=history?.attempts.find(a=>a.failed_job_id===failedJob);
 const available=history?.enabled===true&&history.attempts.length<2&&!reopenedThisFailure;
 const canSubmit=available&&!busy&&!locked&&(retry?frozen.current!==null:confirmed&&validReason(reason));
 function edit(value:string){setReason(value);setConfirmed(false);frozen.current=null;setRetry(false);setError("");}
 async function submit(){
  if(guard.current||!canSubmit)return;
  if(!retry||!frozen.current){if(!confirmed||!validReason(reason))return;const key=crypto.randomUUID();frozen.current={key,body:JSON.stringify({failed_job_id:failedJob,reason:reason.trim(),request_key:key})};}
  const sent=frozen.current;onPending(failedJob);guard.current=true;setBusy(true);setConfirmed(false);setError("");const signal=controller.current.signal;
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}});if(signal.aborted)return;
   let r:Response;
   try{r=await fetch(base+"/reopen",{method:"POST",signal,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:sent.body});}
   catch{if(!signal.aborted){setRetry(true);setError(UNCONFIRMED);}return;}
   if(signal.aborted)return;
   if(final[r.status]){onPending(null);setRetry(false);frozen.current=null;if(r.status!==422)setLocked(true);setError(final[r.status]);return;}
   if(!r.ok){setRetry(true);setError(UNCONFIRMED);return;}
   let raw:Record<string,unknown>;try{raw=await r.json();}catch{if(!signal.aborted){setRetry(true);setError(UNCONFIRMED);}return;}
   if(signal.aborted)return;
   if(!raw||raw.organization_id!==companyId||raw.task_id!==plan.task_id||raw.plan_id!==plan.id||raw.failed_job_id!==failedJob||(raw.attempt!==1&&raw.attempt!==2)||typeof raw.replayed!=="boolean"||raw.provider_called!==false||raw.execution_started!==false||raw.approval_created!==false||raw.task_completed!==false||!Array.isArray(raw.next_steps)||JSON.stringify(raw.next_steps)!==JSON.stringify(nextSteps)){setRetry(true);setError(UNCONFIRMED);return;}
   guard.current=false;onRecovered({attempt:raw.attempt as 1|2,replayed:raw.replayed as boolean});return;
  }catch{if(!signal.aborted){setRetry(true);setError(UNCONFIRMED);}}
  finally{if(!signal.aborted){guard.current=false;setBusy(false);}}
 }
 return <section className="failed-plan-recovery" aria-label="Reabrir plan tras fallo">
  <p>Trabajo fallido. Reabrir deja el plan listo para un nuevo intento, pero no ejecuta nada: después deberás revisar el trabajo anterior, crear una nueva autorización con su propio coste y enviar el plan.</p>
  {history===null&&!historyError&&<p>Consultando reaperturas anteriores…</p>}
  {historyError&&<p role="status">No se pudo verificar el historial de reaperturas. La reapertura no está disponible hasta confirmarlo.</p>}
  {history?.enabled===false&&<p role="status">La recuperación tras fallo aún no está disponible en el servidor. No se muestran acciones.</p>}
  {history?.enabled&&history.attempts.length>0&&<ul className="failed-plan-attempts" aria-label="Reaperturas anteriores">{history.attempts.map(a=><li key={a.attempt}>Intento {a.attempt} · Error: {a.failed_error_code||"sin código"} · {a.reason} · {new Date(a.reopened_at).toLocaleString("es-ES")}{a.reopened_by_me?" · por ti":""}</li>)}</ul>}
  {history?.enabled&&history.attempts.length>=2&&<p>Se alcanzó el límite de 2 reaperturas para este plan.</p>}
  {history?.enabled&&reopenedThisFailure&&<p>Este fallo ya se reabrió (intento {reopenedThisFailure.attempt}). Continúa con la revisión, la nueva autorización y el envío.</p>}
  {available&&<>
   <label>Motivo de la reapertura<textarea value={reason} maxLength={1000} disabled={busy||locked} onChange={e=>edit(e.target.value)}/></label>
   <p>{reasonLength(reason)}/500 caracteres · mínimo 10.</p>
   <label><input type="checkbox" checked={confirmed} disabled={busy||locked||retry} onChange={e=>setConfirmed(e.target.checked)}/>Confirmo que reabrir no ejecuta nada ni consume cuota, y que después necesitaré una nueva autorización con su propio coste.</label>
   <button type="button" disabled={!canSubmit} onClick={()=>void submit()}>{busy?"Reabriendo…":retry?"Reintentar la misma solicitud":"Reabrir tras fallo"}</button>
  </>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}

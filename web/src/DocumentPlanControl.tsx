import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";
type Props={companyId:string;taskId:string;planId:string;state:"active"|"paused";revision:number;scopeCurrent:boolean;onRecorded:()=>void};
const names={pause:"Pausar plan",resume:"Reanudar plan",cancel:"Cancelar plan"};
export function DocumentPlanControl(p:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [action,setAction]=useState<"pause"|"resume"|"cancel">(p.state==="paused"?"resume":"pause"),[reason,setReason]=useState(""),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[attempted,setAttempted]=useState(false),[error,setError]=useState("");
 const controller=useRef(new AbortController()),locked=useRef(false),key=useRef(crypto.randomUUID());
 useEffect(()=>{const c=new AbortController();controller.current=c;return()=>c.abort();},[]);
 async function submit(){
  if(locked.current||attempted||!confirmed||reason.trim().length<10||Array.from(reason.trim()).length>500||(action==="resume"&&!p.scopeCurrent))return;
  locked.current=true;setBusy(true);setAttempted(true);setConfirmed(false);setError("");const signal=controller.current.signal;
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}});if(signal.aborted)return;
   const r=await fetch(API_ROOT+"/v1/me/organizations/"+encodeURIComponent(p.companyId)+"/tasks/"+encodeURIComponent(p.taskId)+"/execution/document-plans/"+encodeURIComponent(p.planId)+"/control",{method:"POST",signal,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({action,reason:reason.trim(),expected_revision:p.revision,request_key:key.current})});
   if(!r.ok)throw Error("Unconfirmed");const raw=await r.json();
   if(raw.organization_id!==p.companyId||raw.task_id!==p.taskId||raw.plan_id!==p.planId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.action_id||"")||raw.recorded_state!==({pause:"paused",resume:"active",cancel:"cancelled"}[action])||raw.recorded_revision!==p.revision+1||raw.provider_called!==false||raw.execution_started!==false||raw.task_completed!==false)throw Error("Invalid acknowledgement");
   if(!signal.aborted)p.onRecorded();
  }catch{if(!signal.aborted)setError("El cambio no quedó confirmado. Actualiza el seguimiento para comprobar el estado antes de otra acción. No se reenviará automáticamente.");}
  finally{if(!signal.aborted)setBusy(false);}
 }
 return <section aria-label="Control del plan sin envío">
  <p>Puedes controlar este plan mientras no tenga un trabajo vinculado. Reanudar no lo envía. Cancelar es definitivo para este plan y conserva su historial; la tarea permanece disponible.</p>
  <label>Acción del plan<select value={action} disabled={busy||attempted} onChange={e=>{setAction(e.target.value as typeof action);setConfirmed(false);}}>
   {p.state==="active"?<option value="pause">Pausar plan</option>:<option value="resume" disabled={!p.scopeCurrent}>Reanudar plan</option>}<option value="cancel">Cancelar plan</option>
  </select></label>
  {p.state==="paused"&&!p.scopeCurrent&&<p>El contexto ha cambiado. No se puede reanudar este plan; puedes cancelarlo y preparar uno nuevo.</p>}
  <label>Motivo del cambio<textarea value={reason} maxLength={1000} disabled={busy||attempted} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}/></label>
  <label><input type="checkbox" checked={confirmed} disabled={busy||attempted} onChange={e=>setConfirmed(e.target.checked)}/>Confirmo: {names[action]} para este objetivo y documento. No iniciar una ejecución.</label>
  <button type="button" disabled={busy||attempted||!confirmed||reason.trim().length<10||Array.from(reason.trim()).length>500||(action==="resume"&&!p.scopeCurrent)} onClick={()=>void submit()}>{busy?"Registrando cambio…":names[action]}</button>
  {error&&<p role="alert">{error}</p>}
 </section>;
}

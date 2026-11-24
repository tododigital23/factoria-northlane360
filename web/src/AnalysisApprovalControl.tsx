import {useEffect,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";

type Approval={
 id:string;worker_id:string;state:string;created_at:string;
 expires_at:string;capability:string;
};
type Props={
 organizationId:string;taskId:string;workerId:string|null;
 workerState:string|null;taskStatus:string;
};
const api=API_ROOT+"/v1/me";

export function AnalysisApprovalControl({
 organizationId,taskId,workerId,workerState,taskStatus
}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [approvalList,setApprovalList]=useState<Approval[]|null>(null);
 const [confirming,setConfirming]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [requestKey,setRequestKey]=useState("");
 const [revokeKeys,setRevokeKeys]=useState<Record<string,string>>({});
 const [lastSuccess,setLastSuccess]=useState("");
 const endpoint=api+"/organizations/"+encodeURIComponent(organizationId)+
   "/tasks/"+encodeURIComponent(taskId)+"/execution/analysis-approvals";
 const eligible=taskStatus==="pending"&&!!workerId&&workerState==="idle";
 function isLive(a:Approval){
  return a.state==="approved"&&new Date(a.expires_at).getTime()>Date.now();
 }
 const active=approvalList?.find(isLive);

 async function getToken(write:boolean){
  return getAccessTokenSilently({authorizationParams:{
   audience:"https://api.eliot.internal",scope:write?"read:tasks create:tasks":"read:tasks"
  }});
 }
 async function refresh(opts?:{keepSuccess?:boolean;clearError?:boolean}):Promise<Approval[]|null>{
  setBusy(true);if(opts?.clearError!==false)setError("");
  try{
   const token=await getToken(false);
   const resp=await fetch(endpoint,{headers:{Authorization:"Bearer "+token}});
   if(!resp.ok)throw Error("HTTP "+resp.status);
   const data:unknown=await resp.json();
   if(!Array.isArray(data)||!data.every(item=>item&&typeof item==="object"&&
     typeof (item as Approval).id==="string"&&
     typeof (item as Approval).worker_id==="string"&&
     typeof (item as Approval).state==="string"&&
     typeof (item as Approval).expires_at==="string"))throw Error("Historial inválido");
   const list=data as Approval[];
   setApprovalList(list);
   if(!opts?.keepSuccess)setLastSuccess("");
   return list;
  }catch{setError("No se pudieron consultar las autorizaciones de la empresa.");return null;}
  finally{setBusy(false);}
 }
 useEffect(()=>{void refresh({keepSuccess:true});},[organizationId,taskId]);
 async function approve(){
  if(!eligible||!workerId||busy)return;
  const key=requestKey||crypto.randomUUID();
  setRequestKey(key);setBusy(true);setError("");setLastSuccess("");
  try{
   const token=await getToken(true);
   const resp=await fetch(endpoint,{
    method:"POST",
    headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
    body:JSON.stringify({worker_id:workerId,request_key:key})
   });
   if(!resp.ok){
    let detail="";
    try{const body:unknown=await resp.json();if(body&&typeof body==="object"&&typeof (body as {detail?:unknown}).detail==="string")detail=(body as {detail:string}).detail;}catch{/* ignore */}
    const list=await refresh({keepSuccess:true,clearError:false});
    const live=list?.find(isLive);
    if(resp.status===409){
     setConfirming(false);setRequestKey("");
     setError(live
      ?"Ya hay una autorización vigente. Úsala en «Primer análisis IA» o revócala abajo."
      :"Ese conflicto ya no tiene autorización usable. Pulsa otra vez «Preparar autorización» y confirma (las de abajo están caducadas).");
     return;
    }
    setError("La autorización no se confirmó (HTTP "+resp.status+"). "+(detail||"Puedes reintentar con la misma solicitud."));
    return;
   }
   const data:unknown=await resp.json();
   if(!data||typeof data!=="object")throw Error("Confirmación inválida");
   const saved=data as {approval_id:string;organization_id:string;task_id:string;worker_id:string;capability:string;execution_started:boolean};
   if(typeof saved.approval_id!=="string"||saved.organization_id!==organizationId||
      saved.task_id!==taskId||saved.worker_id!==workerId||
      saved.capability!=="analysis_draft_v1"||saved.execution_started!==false)throw Error("Confirmación inválida");
   setRequestKey("");setConfirming(false);
   setLastSuccess("Autorización registrada por 15 minutos. No se ha ejecutado ninguna tarea.");
   await refresh({keepSuccess:true});
  }catch{setError("No recibimos confirmación válida; reintenta sin cambiar los datos.");}
  finally{setBusy(false);}
 }
 async function revoke(approvalId:string){
  if(busy)return;
  const key=revokeKeys[approvalId]||crypto.randomUUID();
  setRevokeKeys(prev=>({...prev,[approvalId]:key}));
  setBusy(true);setError("");setLastSuccess("");
  try{
   const token=await getToken(true);
   const resp=await fetch(endpoint+"/"+encodeURIComponent(approvalId)+"/revoke",{
    method:"POST",
    headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
    body:JSON.stringify({request_key:key})
   });
   if(!resp.ok){setError("No se confirmó la revocación (HTTP "+resp.status+"). Reintenta.");return;}
   const data:unknown=await resp.json();
   if(!data||typeof data!=="object"||!(["revoked","expired"].includes((data as {state:string}).state))||
      (data as {execution_started:boolean}).execution_started!==false)throw Error("Respuesta inválida");
   setRevokeKeys(prev=>{const next={...prev};delete next[approvalId];return next});
   setApprovalList(null);
   setLastSuccess("Autorización revocada o caducada. No se ha ejecutado ninguna tarea.");
  }catch{setError("No se pudo verificar la revocación. Reintenta con la misma solicitud.");}
  finally{setBusy(false);}
 }
 return <section className="analysis-approval-panel">
  <div className="analysis-approval-title">
   <strong>Autorizaciones del análisis IA</strong>
   <span>Duración máxima: 15 minutos</span>
  </div>
  <p>Autorizar un borrador NO inicia al agente ni le permite acceder a GitHub, archivos, herramientas o servicios. La ejecución requerirá un motor controlado adicional.</p>
  {active&&<p role="status">Hay una autorización vigente hasta {new Date(active.expires_at).toLocaleString("es-ES")}. Pasa a «Primer análisis IA» (no hace falta confirmar otra).</p>}
  {eligible&&!active&&!lastSuccess&&!confirming&&<button type="button" disabled={busy} onClick={()=>{setConfirming(true);setError("");}}>Preparar autorización</button>}
  {!eligible&&<p role="status">Requiere tarea pendiente y trabajador asignado en estado disponible (idle).</p>}
  {confirming&&!active&&<div className="analysis-approval-confirm">
   <p>¿Aprobar una única elaboración futura de un borrador de análisis para esta tarea y este trabajador, sin ejecución inmediata?</p>
   <button type="button" disabled={busy||!eligible} onClick={()=>void approve()}>{busy?"Guardando…":"Confirmar autorización"}</button>
   <button type="button" className="button-outline" disabled={busy} onClick={()=>{setConfirming(false);setRequestKey("");}}>Cancelar</button>
  </div>}
  <button type="button" className="button-outline" disabled={busy} onClick={()=>void refresh()}>{busy?"Comprobando…":"Consultar autorizaciones"}</button>
  {lastSuccess&&<p role="status">{lastSuccess}</p>}
  {error&&<p role="alert">{error}</p>}
  {approvalList!==null&&<div className="analysis-approval-history">
   {approvalList.length===0?<p>Sin autorizaciones para esta tarea.</p>:approvalList.map(a=><div key={a.id}>
    <span>{isLive(a)?"approved":(a.state==="approved"?"expired":a.state)} · Hasta {new Date(a.expires_at).toLocaleString("es-ES")}</span>
    {(isLive(a)||a.state==="approved"||a.state==="expired")&&
     <button type="button" className="button-outline" disabled={busy} onClick={()=>void revoke(a.id)}>{isLive(a)?"Revocar autorización":"Limpiar"}</button>}
   </div>)}
  </div>}
 </section>;
}

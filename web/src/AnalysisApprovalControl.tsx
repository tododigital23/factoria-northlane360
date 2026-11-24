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
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
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

 async function authorizeNow(){
  if(!eligible||!workerId||busy||active)return;
  const key=crypto.randomUUID();
  setBusy(true);setError("");setLastSuccess("");
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
    if(resp.status===409&&live){
     setError("Ya hay una autorización vigente. Baja a «Primer análisis IA» → Comprobar ejecutor.");
     return;
    }
    setError("No se creó la autorización (HTTP "+resp.status+")"+(detail?": "+detail:"")+". Reintenta.");
    return;
   }
   const data:unknown=await resp.json();
   if(!data||typeof data!=="object")throw Error("Confirmación inválida");
   const saved=data as {approval_id:string;organization_id:string;task_id:string;worker_id:string;capability:string;execution_started:boolean};
   if(typeof saved.approval_id!=="string"||saved.organization_id!==organizationId||
      saved.task_id!==taskId||saved.worker_id!==workerId||
      saved.capability!=="analysis_draft_v1"||saved.execution_started!==false)throw Error("Confirmación inválida");
   setLastSuccess("Autorización creada (15 min). Ahora baja a «Primer análisis IA» → Comprobar ejecutor → Preparar ejecución → Confirmar y generar borrador.");
   await refresh({keepSuccess:true});
  }catch{setError("No recibimos confirmación válida; reintenta.");}
  finally{setBusy(false);}
 }

 async function revoke(approvalId:string, row?:Approval){
  if(busy)return;
  if(row&&!isLive(row)){
   setError("");
   setLastSuccess("Esa entrada ya estaba caducada. Usa el botón verde de autorizar.");
   return;
  }
  setBusy(true);setError("");setLastSuccess("");
  try{
   const token=await getToken(true);
   const key=crypto.randomUUID();
   const resp=await fetch(endpoint+"/"+encodeURIComponent(approvalId)+"/revoke",{
    method:"POST",
    headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
    body:JSON.stringify({request_key:key})
   });
   if(!resp.ok){
    setError(resp.status===409
     ?"No se pudo revocar (conflicto). Prueba autorizar de nuevo."
     :"No se confirmó la revocación (HTTP "+resp.status+").");
    return;
   }
   setLastSuccess("Autorización revocada. Puedes crear una nueva.");
   await refresh({keepSuccess:true});
  }catch{setError("No se pudo verificar la revocación.");}
  finally{setBusy(false);}
 }

 return <section className="analysis-approval-panel">
  <div className="analysis-approval-title">
   <strong>Autorizaciones del análisis IA</strong>
   <span>Duración máxima: 15 minutos</span>
  </div>
  <p>Esto solo permite generar un borrador a partir del título. No abre GitHub ni ejecuta el motor grande.</p>
  {active&&<p role="status">Autorización vigente hasta {new Date(active.expires_at).toLocaleString("es-ES")}. Baja a «Primer análisis IA» y pulsa «Comprobar ejecutor».</p>}
  {eligible&&!active&&<button type="button" disabled={busy} onClick={()=>void authorizeNow()}>
   {busy?"Creando autorización…":"Crear autorización ahora (15 min)"}
  </button>}
  {!eligible&&<p role="status">Requiere tarea pendiente y Programador IA en estado idle (disponible).</p>}
  <button type="button" className="button-outline" disabled={busy} onClick={()=>void refresh()}>{busy?"Comprobando…":"Actualizar lista"}</button>
  {lastSuccess&&<p role="status">{lastSuccess}</p>}
  {error&&<p role="alert">{error}</p>}
  {approvalList!==null&&<div className="analysis-approval-history">
   {approvalList.length===0?<p>Sin autorizaciones previas.</p>:approvalList.map(a=><div key={a.id}>
    <span>{isLive(a)?"approved":(a.state==="approved"?"expired":a.state)} · Hasta {new Date(a.expires_at).toLocaleString("es-ES")}</span>
    {isLive(a)&&<button type="button" className="button-outline" disabled={busy} onClick={()=>void revoke(a.id,a)}>Revocar</button>}
   </div>)}
  </div>}
 </section>;
}

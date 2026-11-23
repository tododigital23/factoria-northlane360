import {useState} from "react";
import {useAuth0} from "./auth";

type AvailabilityEvent={
 id:string;previous_state:string;state:string;created_at:string;
};
type Props={
 organizationId:string;workerId:string;state:string;onChanged:()=>void;
};
const api="https://api.tu-factoria.example/v1/me/organizations/";

export function WorkerAvailabilityControl({organizationId,workerId,state,onChanged}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [confirming,setConfirming]=useState(false);
 const [busy,setBusy]=useState(false);
 const [feedback,setFeedback]=useState("");
 const [key,setKey]=useState("");
 const [history,setHistory]=useState<AvailabilityEvent[]|null>(null);
 const [historyLoading,setHistoryLoading]=useState(false);
 if(state!=="inactive"&&state!=="idle")return null;
 const target=state==="inactive"?"idle":"inactive";
 const targetLabel=target==="idle"?"Marcar disponible":"Marcar inactivo";
 const endpoint=api+encodeURIComponent(organizationId)+"/workers/"+encodeURIComponent(workerId)+"/availability";
 async function submit(){
  if(busy||!confirming)return;
  setBusy(true);setFeedback("");
  const requestKey=key||crypto.randomUUID();
  setKey(requestKey);
  try{
   const token=await getAccessTokenSilently({authorizationParams:{
    audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"
   }});
   const response=await fetch(endpoint,{
    method:"POST",
    headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
    body:JSON.stringify({state:target,request_key:requestKey})
   });
   if(!response.ok){setFeedback("No se confirmó el cambio (HTTP "+response.status+"). Puedes reintentar sin modificar la solicitud.");return;}
   const data:unknown=await response.json();
   if(!data||typeof data!=="object")throw Error("Respuesta inválida");
   const result=data as {worker_id:string;state:string;execution_started:boolean;tools_granted:boolean};
   if(result.worker_id!==workerId||result.state!==target||
      result.execution_started!==false||result.tools_granted!==false)throw Error("Confirmación inesperada");
   setKey("");setConfirming(false);setHistory(null);
   setFeedback("Disponibilidad guardada y auditada. No se ha iniciado ningún agente.");
   onChanged();
  }catch{
   setFeedback("No recibimos una confirmación fiable. Reintenta sin cambiar la petición.");
  }finally{setBusy(false);}
 }
 async function showHistory(){
  if(history!==null){setHistory(null);return;}
  setHistoryLoading(true);setFeedback("");
  try{
   const token=await getAccessTokenSilently({authorizationParams:{
    audience:"https://api.eliot.internal",scope:"read:tasks"
   }});
   const res=await fetch(endpoint+"/events",{headers:{Authorization:"Bearer "+token}});
   if(!res.ok)throw Error("HTTP "+res.status);
   const raw:unknown=await res.json();
   if(!Array.isArray(raw)||!raw.every(x=>x&&typeof x==="object"&&
     typeof (x as AvailabilityEvent).id==="string"&&typeof (x as AvailabilityEvent).state==="string"&&
     typeof (x as AvailabilityEvent).previous_state==="string"&&
     typeof (x as AvailabilityEvent).created_at==="string"))throw Error("Historial inválido");
   setHistory(raw as AvailabilityEvent[]);
  }catch{setFeedback("No se pudo consultar el historial autorizado.");}
  finally{setHistoryLoading(false);}
 }
 return <section className="worker-availability">
  {!confirming&&<button type="button" className="button-outline" disabled={busy} onClick={()=>{setConfirming(true);setFeedback("");setKey("");}}>
   {targetLabel}
  </button>}
  {confirming&&<div className="worker-availability-approval">
   <p><strong>{targetLabel}.</strong> Es un cambio administrativo. Un trabajador disponible NO recibe herramientas ni ejecuta tareas automáticamente.</p>
   <button type="button" disabled={busy} onClick={()=>void submit()}>{busy?"Guardando…":"Confirmar cambio"}</button>
   <button type="button" className="button-outline" disabled={busy} onClick={()=>{setConfirming(false);setKey("");setFeedback("");}}>Cancelar</button>
  </div>}
  <button type="button" className="button-outline" disabled={historyLoading} onClick={()=>void showHistory()}>
   {historyLoading?"Consultando…":history===null?"Historial de disponibilidad":"Ocultar historial"}
  </button>
  {feedback&&<p role="status">{feedback}</p>}
  {history!==null&&<div className="worker-availability-history">
   {history.length===0?<p>Sin cambios de disponibilidad registrados.</p>:history.map(item=><p key={item.id}>
    {item.previous_state} → {item.state} · {new Date(item.created_at).toLocaleString("es-ES")}
   </p>)}
  </div>}
 </section>;
}

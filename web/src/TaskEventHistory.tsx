import {useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";

type TaskEvent = {id:string;type:string;message:string;created_at:string};
type Props={organizationId:string;taskId:string};

const eventNames:Record<string,string>={
 created:"Creación",assigned:"Asignación",started:"Inicio",
 progress:"Progreso",blocked:"Bloqueo",completed:"Finalización",
 failed:"Error",cancelled:"Cancelación",reported:"Informe"
};

export function TaskEventHistory({organizationId,taskId}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [visible,setVisible]=useState(false);
 const [events,setEvents]=useState<TaskEvent[]>([]);
 const [loading,setLoading]=useState(false);
 const [feedback,setFeedback]=useState("");

 async function toggleHistory(){
  if(visible){setVisible(false);return;}
  setLoading(true);setFeedback("");setEvents([]);
  try{
   const token=await getAccessTokenSilently({authorizationParams:{
     audience:"https://api.eliot.internal",scope:"read:tasks"
   }});
   const endpoint=API_ROOT+"/v1/me/organizations/"
      +encodeURIComponent(organizationId)+"/tasks/"+encodeURIComponent(taskId)+"/events";
   const response=await fetch(endpoint,{headers:{Authorization:"Bearer "+token}});
   if(!response.ok){setFeedback("No se pudo consultar el historial (HTTP "+response.status+").");return;}
   const payload:unknown=await response.json();
   if(!Array.isArray(payload)||!payload.every((event:unknown)=>{
     if(typeof event!=="object"||event===null)return false;
     const v=event as TaskEvent;
     return typeof v.id==="string"&&typeof v.type==="string"&&
       typeof v.message==="string"&&typeof v.created_at==="string";
   }))throw Error("Unexpected event response");
   setEvents(payload as TaskEvent[]);
   setVisible(true);
  }catch{setFeedback("Error al consultar el historial autenticado.");}
  finally{setLoading(false);}
 }
 return <section className="task-history">
  <button className="button-outline" disabled={loading} onClick={toggleHistory}>
   {loading?"Consultando…":visible?"Ocultar historial":"Ver historial"}
  </button>
  {feedback&&<p role="status">{feedback}</p>}
  {visible&&<div className="task-history-list">
   {events.length===0?<p>No hay eventos registrados para esta tarea.</p>:
   events.map(event=><div key={event.id} className="task-event">
     <strong>{(event.type==="reported"&&event.message.startsWith("Owner returned task to pending")?"Devolución a pendiente":eventNames[event.type]||event.type)}</strong>
     <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString("es-ES")}</time>
     {event.message&&<p>{event.message}</p>}
   </div>)}
  </div>}
 </section>
}

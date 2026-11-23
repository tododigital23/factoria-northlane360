import {useState} from "react";
import {useAuth0} from "./auth";

type Action = "block" | "resume" | "cancel";
type Props = {
 organizationId:string; taskId:string; status:string;
 onChanged:()=>void;
};
export function TaskStatusControls({organizationId,taskId,status,onChanged}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [action,setAction]=useState<Action|null>(null);
 const [reason,setReason]=useState("");
 const [requestKey,setRequestKey]=useState("");
 const [busy,setBusy]=useState(false);
 const [feedback,setFeedback]=useState("");
 const options:Action[]=status==="pending"?["block","cancel"]:status==="blocked"?["resume","cancel"]:[];
 const labels:Record<Action,string>={block:"Bloquear",resume:"Devolver a pendiente",cancel:"Cancelar"};
 async function applyAction(){
  if(!action)return;
  const key=requestKey||crypto.randomUUID();
  setRequestKey(key);setBusy(true);setFeedback("");
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}});
   const url="https://api.tu-factoria.example/v1/me/organizations/"
      +encodeURIComponent(organizationId)+"/tasks/"+encodeURIComponent(taskId)+"/status";
   const response=await fetch(url,{
    method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
    body:JSON.stringify({action,reason:reason.trim(),request_key:key})
   });
   if(!response.ok){
    setFeedback("No se confirmó el cambio (HTTP "+response.status+"). Se mantiene la clave para reintentar sin duplicados.");
    return;
   }
   setFeedback("Estado actualizado y evento registrado.");
   setRequestKey("");setAction(null);setReason("");onChanged();
  }catch{
   setFeedback("No se pudo completar la operación. Reintenta sin cambiar los datos.");
  }finally{setBusy(false);}
 }
 if(options.length===0)return null;
 return <div className="task-control">
   <div className="task-control-actions">{options.map(a=><button type="button" key={a} className={action===a?"selected-action":"button-outline"} disabled={busy}
    onClick={()=>{setAction(a);setReason("");setRequestKey("");setFeedback("")}}>{labels[a]}</button>)}</div>
   {action&&<div className="task-control-confirm">
     <label>Motivo (opcional) <input value={reason} maxLength={1000} onChange={e=>{setReason(e.target.value);setRequestKey("")}} placeholder="Explica el cambio de estado"/></label>
     <p>Confirmar: {labels[action].toLowerCase()}. No se ejecutará ningún agente IA.</p>
     <button type="button" disabled={busy} onClick={applyAction}>{busy?"Guardando…":"Confirmar cambio"}</button>
     <button type="button" className="button-outline" disabled={busy} onClick={()=>{setAction(null);setRequestKey("");setReason("")}}>Volver</button>
   </div>}
   {feedback&&<p role="status">{feedback}</p>}
 </div>
}

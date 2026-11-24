import {useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";

type Worker={id:string;department_id:string;name:string;state:string};
type Props={
 organizationId:string;taskId:string;departmentId:string;
 assigneeWorkerId:string|null;workers:Worker[];status:string;
 onAssigned:()=>void;
};
export function TaskAssignmentControl({
 organizationId,taskId,departmentId,assigneeWorkerId,workers,status,onAssigned,
}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [editing,setEditing]=useState(false);
 const [selected,setSelected]=useState(assigneeWorkerId||"");
 const [busy,setBusy]=useState(false);
 const [feedback,setFeedback]=useState("");
 const [requestKey,setRequestKey]=useState("");
 const localWorkers=workers.filter(w=>w.department_id===departmentId);
 const allowed=status==="pending"||status==="blocked";
 const current=localWorkers.find(w=>w.id===assigneeWorkerId);
 function select(value:string){setSelected(value);setRequestKey("");setFeedback("");}
 async function save(){
  if(!allowed||busy||selected===(assigneeWorkerId||"")||
     (selected!==""&&!localWorkers.some(w=>w.id===selected)))return;
  setBusy(true);setFeedback("");
  const key=requestKey||crypto.randomUUID();
  setRequestKey(key);
  try{
   const token=await getAccessTokenSilently({authorizationParams:{
    audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"
   }});
   const url=API_ROOT+"/v1/me/organizations/"+
      encodeURIComponent(organizationId)+"/tasks/"+encodeURIComponent(taskId)+"/assign";
   const response=await fetch(url,{
    method:"POST",
    headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
    body:JSON.stringify({worker_id:selected||null,request_key:key})
   });
   if(!response.ok){
    setFeedback("El cambio no se ha confirmado (HTTP "+response.status+"). Conserva este borrador para reintentar.");
    return;
   }
   const result:unknown=await response.json();
   if(!result||typeof result!=="object")throw Error("Malformed reply");
   const saved=result as {id:string;assignee_worker_id:string|null;execution_started:boolean};
   if(saved.id!==taskId||saved.assignee_worker_id!==(selected||null)||saved.execution_started!==false)
    throw Error("Unexpected confirmation");
   setRequestKey("");setEditing(false);setFeedback("Responsable actualizado y registrado en el historial.");
   onAssigned();
  }catch{setFeedback("No llegó una confirmación válida. Reintenta sin cambiar la selección para evitar duplicados.");}
  finally{setBusy(false);}
 }
 if(!allowed)return null;
 return <div className="task-assignee-control">
  {!editing&&<button type="button" className="button-outline" onClick={()=>{setSelected(assigneeWorkerId||"");setEditing(true);setFeedback("");}}>
   {current?"Cambiar responsable":"Asignar trabajador IA"}
  </button>}
  {editing&&<div className="task-assignee-form">
    <label>Responsable de esta tarea
     <select value={selected} onChange={e=>select(e.target.value)} disabled={busy}>
      <option value="">Sin asignar</option>
      {localWorkers.map(w=><option key={w.id} value={w.id}>{w.name} · {w.state==="inactive"?"Inactivo":w.state}</option>)}
     </select>
    </label>
    <p>Solo puedes elegir trabajadores del mismo departamento. La asignación no activa ni ejecuta ningún agente IA.</p>
    <div className="task-assignee-buttons">
     <button disabled={busy||selected===(assigneeWorkerId||"")} onClick={()=>void save()}> {busy?"Guardando…":"Confirmar asignación"} </button>
     <button type="button" className="button-outline" disabled={busy} onClick={()=>{setEditing(false);setFeedback("");setRequestKey("");}}>Cerrar</button>
    </div>
   </div>}
  {feedback&&<p role="status">{feedback}</p>}
 </div>;
}

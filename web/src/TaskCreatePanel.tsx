import {useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";
type Department={id:string;name:string};
type Worker={id:string;department_id:string;name:string;state:string};
export function TaskCreatePanel({organizationId,onCreated}:{organizationId:string;onCreated:()=>void}){
 const {getAccessTokenSilently}=useAuth0();
 const [departments,setDepartments]=useState<Department[]>([]);
 const [workers,setWorkers]=useState<Worker[]>([]);
 const [title,setTitle]=useState("");
 const [department,setDepartment]=useState("");
 const [worker,setWorker]=useState("");
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const [requestKey,setRequestKey]=useState("");
 const base=API_ROOT+"/v1/me/organizations/"+encodeURIComponent(organizationId);
 async function loadOptions(){
  setBusy(true);setMessage("");
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
   const headers={Authorization:"Bearer "+token};
   const [d,w]=await Promise.all([fetch(base+"/departments",{headers}),fetch(base+"/workers",{headers})]);
   if(!d.ok||!w.ok)throw Error("No se pudieron recuperar las opciones");
   setDepartments(await d.json());setWorkers(await w.json());
  }catch{setMessage("No se pudieron cargar departamentos y trabajadores.")}
  finally{setBusy(false)}
 }
 async function submit(){
  if(!department||title.trim().length<3)return;
  setBusy(true);setMessage("");
  const idempotency=requestKey||crypto.randomUUID();
  setRequestKey(idempotency);
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}});
   const response=await fetch(base+"/tasks",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({title:title.trim(),department_id:department,assignee_worker_id:worker||null,request_key:idempotency})});
   if(!response.ok){setMessage("La API rechazó el alta ("+response.status+"). Si reintentas, se conserva la misma solicitud.");return;}
   setTitle("");setDepartment("");setWorker("");setRequestKey("");setMessage("Tarea creada en estado pendiente.");onCreated();
  }catch{setMessage("Error de conexión. Puedes reintentar sin duplicar la tarea.")}
  finally{setBusy(false)}
 }
 return <div className="info"><h2>Nueva tarea</h2><p>Se crea pendiente. Ningún trabajador comienza a ejecutarla.</p><button disabled={busy} onClick={loadOptions}>Cargar departamentos y trabajadores</button><p><label>Título <input value={title} maxLength={200} onChange={e=>{setTitle(e.target.value);setRequestKey("")}} /></label></p><p><label>Departamento <select value={department} onChange={e=>{setDepartment(e.target.value);setWorker("");setRequestKey("")}}><option value="">Selecciona</option>{departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label></p><p><label>Trabajador opcional <select value={worker} onChange={e=>{setWorker(e.target.value);setRequestKey("")}}><option value="">Sin asignar</option>{workers.filter(w=>w.department_id===department).map(w=><option key={w.id} value={w.id}>{w.name} ({w.state})</option>)}</select></label></p><button disabled={busy||title.trim().length<3||!department} onClick={submit}>Crear tarea pendiente</button><p role="status">{message}</p></div>
}

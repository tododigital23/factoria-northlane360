import {useEffect,useState} from "react";
import {useAuth0} from "./auth";

type Department={id:string;name:string};
type Worker={id:string;department_id:string;name:string;state:string};
type Props={
 companyId:string; companyName:string; initialText:string;
 onClose:()=>void; onCreated:(taskId:string)=>void;
};
const base="https://api.tu-factoria.example/v1/me/organizations/";

export function EliotTaskDraft({companyId,companyName,initialText,onClose,onCreated}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [departments,setDepartments]=useState<Department[]>([]);
 const [workers,setWorkers]=useState<Worker[]>([]);
 const [title,setTitle]=useState(initialText.slice(0,200));
 const [department,setDepartment]=useState("");
 const [worker,setWorker]=useState("");
 const [busy,setBusy]=useState(false);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 const [requestKey,setRequestKey]=useState("");
 const [ready,setReady]=useState(false);
 useEffect(()=>{setTitle(initialText.slice(0,200));setRequestKey("");},[initialText]);

 async function loadOptions(){
  setLoading(true);setReady(false);setError("");setDepartments([]);setWorkers([]);
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
   const headers={Authorization:"Bearer "+token};
   const url=base+encodeURIComponent(companyId);
   const [d,w]=await Promise.all([fetch(url+"/departments",{headers}),fetch(url+"/workers",{headers})]);
   if(!d.ok||!w.ok)throw Error("No se pudieron consultar los datos de la empresa");
   const [dv,wv]:unknown[]=await Promise.all([d.json(),w.json()]);
   if(!Array.isArray(dv)||!dv.every(x=>x&&typeof x.id==="string"&&typeof x.name==="string")
      ||!Array.isArray(wv)||!wv.every(x=>x&&typeof x.id==="string"&&typeof x.department_id==="string"&&typeof x.name==="string"&&typeof x.state==="string"))
    throw Error("Los datos autorizados no tienen el formato esperado");
   setDepartments(dv);setWorkers(wv);setReady(true);
  }catch{setError("No se pudieron cargar los departamentos y trabajadores autorizados. No se ha creado ninguna tarea.");}
  finally{setLoading(false);}
 }
 function changeTitle(value:string){setTitle(value);setRequestKey("");setError("");}
 function changeDepartment(value:string){setDepartment(value);setWorker("");setRequestKey("");setError("");}
 function changeWorker(value:string){setWorker(value);setRequestKey("");setError("");}
 async function confirm(){
  if(busy||!ready||!department||title.trim().length<3||!departments.some(d=>d.id===department))return;
  if(worker&&!workers.some(w=>w.id===worker&&w.department_id===department))return;
  setBusy(true);setError("");
  const key=requestKey||crypto.randomUUID();
  setRequestKey(key);
  try{
   const token=await getAccessTokenSilently({authorizationParams:{
    audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"
   }});
   const response=await fetch(base+encodeURIComponent(companyId)+"/tasks",{
    method:"POST",
    headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
    body:JSON.stringify({
     department_id:department,assignee_worker_id:worker||null,
     title:title.trim(),request_key:key
    })
   });
   if(!response.ok){
    setError("La API no confirmó la tarea (HTTP "+response.status+"). Puedes reintentar con el mismo borrador y clave.");
    return;
   }
   const result:unknown=await response.json();
   if(!result||typeof result!=="object"||typeof (result as {id?:unknown}).id!=="string")
    throw Error("La tarea podría haberse creado pero faltó la confirmación");
   setRequestKey("");onCreated((result as {id:string}).id);
  }catch{
   setError("No recibí una confirmación completa. Mantén los campos y reintenta; la clave evita crear duplicados.");
  }finally{setBusy(false);}
 }
 return <section className="eliot-task-draft" aria-label="Propuesta de tarea pendiente de aprobación">
  <div className="eliot-task-draft-head"><div>
   <span>PROPUESTA · REQUIERE APROBACIÓN</span><h3>Preparar tarea con Freddy</h3>
  </div><button type="button" onClick={onClose} disabled={busy} className="button-outline">Descartar</button></div>
  <p>Freddy ha interpretado que quieres preparar una tarea. <strong>No se ha creado nada.</strong> Revisa y confirma todos los campos.</p>
  <div className="eliot-task-draft-grid">
   <div><span>Empresa autorizada</span><strong>{companyName}</strong></div>
   <div><span>Estado al crear</span><strong>Pendiente · sin ejecutar agentes</strong></div>
  </div>
  {!ready&&<button type="button" onClick={()=>void loadOptions()} disabled={loading||busy}>{loading?"Cargando…":"Cargar departamentos y trabajadores"}</button>}
  {ready&&<div className="eliot-task-draft-form">
   <label>Título de la tarea <input value={title} maxLength={200} onChange={e=>changeTitle(e.target.value)} placeholder="Qué debe hacerse"/></label>
   <label>Departamento de destino <select value={department} onChange={e=>changeDepartment(e.target.value)}>
     <option value="">Selecciona el departamento</option>
     {departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
   </select></label>
   <label>Trabajador IA (opcional) <select value={worker} onChange={e=>changeWorker(e.target.value)} disabled={!department}>
     <option value="">Sin asignar</option>
     {workers.filter(w=>w.department_id===department).map(w=><option key={w.id} value={w.id}>{w.name} · {w.state==="inactive"?"inactivo":w.state}</option>)}
   </select></label>
   <p>La tarea se registrará en PostgreSQL y generará un evento de creación. Los agentes IA seguirán inactivos.</p>
   <button type="button" className="eliot-task-confirm" disabled={busy||!department||title.trim().length<3} onClick={()=>void confirm()}>
    {busy?"Guardando…":"Confirmar y crear tarea pendiente"}
   </button>
  </div>}
  {error&&<p role="alert" className="eliot-error">{error}</p>}
 </section>;
}

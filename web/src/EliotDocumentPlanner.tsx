import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {DocumentEvidencePreflight} from "./DocumentEvidencePreflight";
import {StoredReport} from "./StoredReport";
import type {ReportEvent} from "./StoredReport";
import {API_ROOT} from "./holdingApi";

type Task={id:string;title:string;status:string;department_id:string;assignee_worker_id:string|null};
type Department={id:string;name:string};
type Worker={id:string;name:string;state:string;department_id:string};
type Snapshot={companyId:string;tasks:Task[];departments:Department[];workers:Worker[]};
type Run=ReportEvent&{state:string;started_at:string};
const api=API_ROOT+"/v1/me/organizations/";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses:Record<string,string>={pending:"Pendiente",blocked:"Bloqueada",completed:"Completada",cancelled:"Cancelada",running:"En ejecución",queued:"En cola",failed:"Fallida"};
const isObject=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object";
function idsUnique(rows:{id:string}[]){return new Set(rows.map(r=>r.id)).size===rows.length;}
export function EliotDocumentPlanner({companyId,companyName,role,onClose}:{companyId:string;companyName:string;role:string;onClose:()=>void}){
 const {getAccessTokenSilently}=useAuth0();
 const [data,setData]=useState<Snapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [refresh,setRefresh]=useState(0),[taskId,setTaskId]=useState(""),[preparing,setPreparing]=useState(false);
 const generation=useRef(0);
 useEffect(()=>{
  const controller=new AbortController(),version=++generation.current;
  setData(null);setTaskId("");setPreparing(false);setError("");setBusy(false);
  if(role!=="owner"||!uuid.test(companyId))return ()=>{controller.abort();generation.current++;};
  setBusy(true);
  (async()=>{
   try{
    const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
    if(controller.signal.aborted)return;
    const paths=["tasks","departments","workers"];
    const replies=await Promise.all(paths.map(path=>fetch(api+encodeURIComponent(companyId)+"/"+path,{headers:{Authorization:"Bearer "+token},signal:controller.signal})));
    if(replies.some(r=>!r.ok))throw Error("Incomplete context");
    const [tasks,departments,workers]:unknown[]=await Promise.all(replies.map(r=>r.json()));
    if(!Array.isArray(tasks)||tasks.length>100||!tasks.every(t=>isObject(t)&&typeof t.id==="string"&&uuid.test(t.id)&&typeof t.title==="string"&&typeof t.status==="string"&&Object.hasOwn(statuses,t.status)&&typeof t.department_id==="string"&&(t.assignee_worker_id===null||typeof t.assignee_worker_id==="string"))||
     !Array.isArray(departments)||!departments.every(d=>isObject(d)&&typeof d.id==="string"&&typeof d.name==="string")||
     !Array.isArray(workers)||!workers.every(w=>isObject(w)&&typeof w.id==="string"&&typeof w.name==="string"&&typeof w.state==="string"&&typeof w.department_id==="string")||
     !idsUnique(tasks)||!idsUnique(departments)||!idsUnique(workers))throw Error("Invalid context");
    if(version===generation.current)setData({companyId,tasks,departments,workers});
   }catch{if(version===generation.current&&!controller.signal.aborted)setError("No se pudo comprobar el contexto completo de la empresa. No se ha preparado ni ejecutado trabajo.");}
   finally{if(version===generation.current)setBusy(false);}
  })();
  return ()=>{controller.abort();generation.current++;};
 },[companyId,role,refresh,getAccessTokenSilently]);
 const snapshot=data?.companyId===companyId&&role==="owner"?data:null;
 const task=snapshot?.tasks.find(t=>t.id===taskId);
 const worker=snapshot?.workers.find(w=>w.id===task?.assignee_worker_id);
 const department=snapshot?.departments.find(d=>d.id===task?.department_id);
 const eligible=!!task&&task.status==="pending"&&!!department&&!!worker&&worker.state==="idle"&&worker.department_id===task.department_id;
 return <section className="eliot-document-planner" aria-label="Plan documental de Freddy">
  <div className="task-evidence-head"><h3>Plan documental con Freddy · {companyName}</h3><button type="button" className="button-outline" onClick={onClose}>Cerrar plan documental</button></div>
  <p>Un recorrido guiado para una tarea y un documento autorizado. El plan se prepara en esta pantalla; los permisos, la cola, los informes y las decisiones se guardan al confirmar cada paso.</p>
  {role!=="owner"?<p role="status">Solo el propietario puede preparar este trabajo.</p>:<>
   <button type="button" className="button-outline" disabled={busy} onClick={()=>setRefresh(n=>n+1)}>{busy?"Consultando tareas…":"Actualizar tareas y responsables"}</button>
   {error&&<p role="alert">{error}</p>}
   {snapshot&&<>
    <p>Hasta 100 tareas recientes de esta empresa. Elige una tarea concreta; no se delega trabajo automáticamente.</p>
    <label>Tarea para revisar
     <select value={taskId} onChange={e=>{setTaskId(e.target.value);setPreparing(false);}}>
      <option value="">Seleccionar tarea real</option>
      {snapshot.tasks.map(t=><option key={t.id} value={t.id}>{t.title} · {statuses[t.status]}</option>)}
     </select>
    </label>
    {snapshot.tasks.length===0&&<p>No hay tareas en la consulta autorizada. Puedes preparar una con «Crea una tarea».</p>}
    {task&&<div key={companyId+":"+task.id+":"+refresh}>
     <p>Departamento: <strong>{department?.name||"No verificado"}</strong> · Responsable: <strong>{worker?.name||"Sin responsable verificado"}</strong> · Estado de tarea: {statuses[task.status]}</p>
     <ol className="eliot-document-steps">
      <li>Elegir un documento de las fuentes autorizadas y comprobar su revisión SHA.</li>
      <li>Consultar la reserva exclusiva y autorizar solo el documento y SHA elegidos. Una reserva anterior puede requerir revisión.</li>
      <li>Confirmar el envío a OpenAI y encolar una única ejecución documental. El trabajador continúa aunque cierres esta pantalla.</li>
      <li>Consultar el informe guardado, revisar su evidencia y decidir si aceptarlo o pedir correcciones.</li>
     </ol>
     <p>Pasos previstos, no progreso ejecutado. Los permisos, reserva y presupuesto se vuelven a comprobar en el servidor antes de actuar.</p>
     {!eligible&&<p role="status">Para preparar otra ejecución necesita tarea pendiente, departamento verificado y trabajador disponible del mismo departamento. Puedes consultar los informes existentes.</p>}
     {eligible&&<button type="button" className="button-outline" onClick={()=>setPreparing(x=>!x)}>{preparing?"Ocultar elección de documento":"Elegir documento para este plan"}</button>}
     {eligible&&preparing&&<DocumentEvidencePreflight key={companyId+":"+task.id+":"+worker!.id} organizationId={companyId} taskId={task.id} taskStatus={task.status} workerId={worker!.id} workerState={worker!.state}/>}
     <TaskDocumentResults key={companyId+":"+task.id} companyId={companyId} task={task}/>
    </div>}
   </>}
  </>}
 </section>;
}

function TaskDocumentResults({companyId,task}:{companyId:string;task:Task}){
 const {getAccessTokenSilently}=useAuth0();
 const [runs,setRuns]=useState<Run[]|null>(null),[selected,setSelected]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const active=useRef(true),locked=useRef(false);
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 async function load(){
  if(locked.current)return;locked.current=true;setBusy(true);setError("");setRuns(null);setSelected("");
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
   if(!active.current)return;
   const response=await fetch(api+encodeURIComponent(companyId)+"/tasks/"+encodeURIComponent(task.id)+"/execution/document-runs",{headers:{Authorization:"Bearer "+token}});
   if(!response.ok)throw Error("Unavailable");const raw:unknown=await response.json();
   if(!Array.isArray(raw)||raw.length>20||!raw.every(r=>isObject(r)&&typeof r.id==="string"&&uuid.test(r.id)&&typeof r.state==="string"&&["completed","failed","running"].includes(r.state)&&typeof r.repository==="string"&&typeof r.path==="string"&&typeof r.ref==="string"&&typeof r.sha==="string"&&/^[0-9a-f]{40}$/.test(r.sha)&&typeof r.started_at==="string"&&Number.isFinite(Date.parse(r.started_at)))||!idsUnique(raw))throw Error("Invalid history");
   if(active.current)setRuns(raw.map(r=>({...r,kind:"document_analysis",task_id:task.id,task_title:task.title})));
  }catch{if(active.current)setError("No se pudo verificar el historial documental de esta tarea.");}
  finally{if(active.current){locked.current=false;setBusy(false);}}
 }
 const chosen=runs?.find(r=>r.id===selected&&r.state==="completed");
 return <section aria-label="Resultados de la tarea">
  <h4>Informes y revisión de esta tarea</h4>
  <button type="button" className="button-outline" disabled={busy} onClick={load}>{busy?"Consultando informes…":"Consultar informes de esta tarea"}</button>
  {error&&<p role="alert">{error}</p>}
  {runs&&<>
   <p>Últimos {runs.length} intentos disponibles, máximo 20. Esta consulta no genera otro informe.</p>
   {runs.some(r=>r.state!=="completed")&&<p>Hay intentos fallidos o sin finalizar en esta ventana. El servidor comprobará todo el historial antes de aceptar un resultado.</p>}
   <label>Informe documental guardado
    <select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Seleccionar informe completado</option>
     {runs.filter(r=>r.state==="completed").map(r=><option key={r.id} value={r.id}>{r.path} · {new Date(r.started_at).toLocaleString("es-ES")} · SHA {r.sha?.slice(0,12)}…</option>)}
    </select>
   </label>
   {!runs.some(r=>r.state==="completed")&&<p>No hay informes documentales completados en esta ventana.</p>}
   {chosen&&<StoredReport key={companyId+":"+task.id+":"+chosen.id} companyId={companyId} event={chosen}/>}
  </>}
 </section>;
}

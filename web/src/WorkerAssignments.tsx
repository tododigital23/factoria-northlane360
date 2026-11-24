import {useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";

type Company={id:string;name:string;role:string};
type Department={id:string;name:string};
type Worker={id:string;department_id:string;name:string;specialty:string;state:string};
type Task={id:string;department_id:string;assignee_worker_id:string|null;title:string;status:string;created_at:string};
type Snapshot={departments:Department[];workers:Worker[];tasks:Task[];capturedAt:string};
type Props={companies:Company[];selectedCompany:string;onSelectCompany:(id:string)=>void;onLoadCompanies:()=>void};

const api=API_ROOT+"/v1/me/organizations/";
const statuses:Record<string,string>={
 inactive:"Inactivo",idle:"Disponible",working:"Trabajando",blocked:"Bloqueado",
 pending:"Pendiente",queued:"En cola",running:"En ejecución",
 completed:"Completada",failed:"Fallida",cancelled:"Cancelada"
};
function validList<T>(value:unknown,check:(v:Record<string,unknown>)=>boolean):T[]{
 if(!Array.isArray(value)||!value.every(x=>x!==null&&typeof x==="object"&&check(x as Record<string,unknown>)))
  throw Error("Respuesta inválida");
 return value as T[];
}
export function WorkerAssignments({companies,selectedCompany,onSelectCompany,onLoadCompanies}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
 const [loading,setLoading]=useState(false);
 const [error,setError]=useState("");
 const [departmentFilter,setDepartmentFilter]=useState("");
 const company=companies.find(c=>c.id===selectedCompany);
 async function load(){
  if(!selectedCompany){setError("Selecciona una empresa.");return;}
  setLoading(true);setSnapshot(null);setError("");setDepartmentFilter("");
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
   const prefix=api+encodeURIComponent(selectedCompany)+"/";
   const headers={Authorization:"Bearer "+token};
   const responses=await Promise.all(["departments","workers","tasks"].map(path=>fetch(prefix+path,{headers})));
   if(responses.some(r=>!r.ok)){setError("No se pudieron cargar todas las asignaciones autorizadas. No mostramos datos parciales.");return;}
   const [rawDepartments,rawWorkers,rawTasks]:unknown[]=await Promise.all(responses.map(r=>r.json()));
   const departments=validList<Department>(rawDepartments,x=>typeof x.id==="string"&&typeof x.name==="string");
   const workers=validList<Worker>(rawWorkers,x=>typeof x.id==="string"&&typeof x.department_id==="string"&&typeof x.name==="string"&&typeof x.state==="string"&&typeof x.specialty==="string");
   const tasks=validList<Task>(rawTasks,x=>typeof x.id==="string"&&typeof x.department_id==="string"&&typeof x.title==="string"&&typeof x.status==="string"&&(typeof x.assignee_worker_id==="string"||x.assignee_worker_id===null));
   const validDepartments=new Set(departments.map(d=>d.id));
   const validWorkers=new Map(workers.map(w=>[w.id,w]));
   if(tasks.some(t=>!validDepartments.has(t.department_id)||
       (t.assignee_worker_id&&(!validWorkers.has(t.assignee_worker_id)||
         validWorkers.get(t.assignee_worker_id)?.department_id!==t.department_id)))){
    throw Error("Inconsistent response");
   }
   setSnapshot({departments,workers,tasks,capturedAt:new Date().toISOString()});
  }catch{setError("No se ha podido consultar de forma segura el reparto de tareas de la empresa.");}
  finally{setLoading(false);}
 }
 const departments=snapshot?.departments||[];
 const workers=snapshot?.workers||[];
 const tasks=snapshot?.tasks||[];
 const filteredDepartments=departmentFilter?departments.filter(d=>d.id===departmentFilter):departments;
 const unassigned=tasks.filter(t=>t.assignee_worker_id===null);
 const assigned=tasks.filter(t=>t.assignee_worker_id!==null);
 return <section className="assignment-overview">
  <div className="assignment-head"><div><span className="ai-overline">OPERACIONES · ASIGNACIONES</span><h2>Reparto real de tareas</h2>
    <p>Asociaciones verificadas entre empresa, departamento y trabajador IA. Una tarea asignada no implica ejecución.</p></div>
   <div className="assignment-actions"><button onClick={onLoadCompanies} type="button" disabled={loading}>Actualizar empresas</button>
    <button onClick={load} type="button" disabled={loading||!selectedCompany}>{loading?"Consultando…":"Actualizar asignaciones"}</button></div>
  </div>
  <label className="assignment-picker">Empresa autorizada <select value={selectedCompany} disabled={loading} onChange={e=>{onSelectCompany(e.target.value);setSnapshot(null);setError("");setDepartmentFilter("");}}>
    <option value="">Selecciona una empresa</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
   </select></label>
  {error&&<p role="alert" className="assignment-error">{error}</p>}
  {!snapshot&&<p className="assignment-hint">Consulta los trabajadores de {company?.name||"la empresa seleccionada"} para ver a quién se han asignado tareas.</p>}
  {snapshot&&<div className="assignment-content">
   <div className="assignment-meta"><strong>{company?.name}</strong><span>Consulta de {new Date(snapshot.capturedAt).toLocaleString("es-ES")}</span></div>
   <div className="assignment-stats">
    <div><strong>{workers.length}</strong><span>Trabajadores IA</span></div>
    <div><strong>{tasks.length}</strong><span>Tareas consultadas</span></div>
    <div><strong>{assigned.length}</strong><span>Con responsable</span></div>
    <div><strong>{unassigned.length}</strong><span>Sin asignar</span></div>
   </div>
   <label className="assignment-picker">Filtrar por departamento
    <select value={departmentFilter} onChange={e=>setDepartmentFilter(e.target.value)}>
     <option value="">Todos</option>{departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
   </label>
   <div className="assignment-department-grid">{filteredDepartments.map(dept=>{
    const people=workers.filter(w=>w.department_id===dept.id);
    const unassignedDept=unassigned.filter(t=>t.department_id===dept.id);
    return <article className="assignment-department" key={dept.id}>
     <div className="assignment-dept-title"><strong>{dept.name}</strong><span>{people.length} trabajadores</span></div>
     {people.length===0&&<p>No hay trabajadores IA registrados en este departamento.</p>}
     {people.map(w=>{
      const assignedTasks=assigned.filter(t=>t.assignee_worker_id===w.id);
      return <div className="assignment-worker" key={w.id}>
       <div className="assignment-worker-header"><div><strong>{w.name}</strong><small>{w.specialty}</small></div><span className={w.state==="inactive"?"assignment-inactive":"assignment-worker-state"}>{statuses[w.state]||w.state}</span></div>
       <p>{assignedTasks.length} tarea(s) asignada(s)</p>
       {assignedTasks.map(t=><div className="assignment-task" key={t.id}><span>{t.title}</span><small>{statuses[t.status]||t.status}</small></div>)}
      </div>;
     })}
     {unassignedDept.length>0&&<div className="assignment-unassigned">
      <strong>Sin trabajador asignado</strong>
      {unassignedDept.map(t=><div className="assignment-task" key={t.id}><span>{t.title}</span><small>{statuses[t.status]||t.status}</small></div>)}
     </div>}
    </article>;
   })}</div>
   <p className="assignment-disclaimer">Los trabajadores inactivos permanecen inactivos aunque reciban tareas. Se muestran como máximo 100 tareas consultadas. El Centro de Mando aún no ejecuta agentes ni intercambia mensajes automáticamente.</p>
  </div>}
 </section>;
}

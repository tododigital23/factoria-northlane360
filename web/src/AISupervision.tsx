import {useState} from "react";
import {useAuth0} from "./auth";

type Company={id:string;name:string;role:string};
type Department={id:string;name:string};
type Worker={id:string;department_id:string;name:string;specialty:string;state:string};
type Task={id:string;department_id:string;assignee_worker_id:string|null;title:string;status:string;created_at:string};
type Activity={id:string;task_id:string;task_title:string;department_id:string;department_name:string;type:string;message:string;created_at:string};
type Snapshot={departments:Department[];workers:Worker[];tasks:Task[];events:Activity[];capturedAt:string};
type Props={companies:Company[];selectedCompany:string;onSelect:(id:string)=>void;onRefreshCompanies:()=>void};
const apiBase="https://api.tu-factoria.example/v1/me/organizations/";
const statusText:Record<string,string>={inactive:"Inactivo",idle:"Disponible",working:"Trabajando",blocked:"Bloqueado",pending:"Pendiente",queued:"En cola",running:"En ejecución",completed:"Completada",failed:"Fallida",cancelled:"Cancelada"};
const eventText:Record<string,string>={created:"Creación",assigned:"Asignación",started:"Inicio",progress:"Progreso",blocked:"Bloqueo",completed:"Finalización",failed:"Error",cancelled:"Cancelación",reported:"Informe"};
function validCollection<T>(data:unknown,check:(v:Record<string,unknown>)=>boolean):T[]{
 if(!Array.isArray(data)||!data.every(x=>typeof x==="object"&&x!==null&&check(x as Record<string,unknown>)))throw Error("Formato de respuesta inesperado");
 return data as T[];
}
export function AISupervision({companies,selectedCompany,onSelect,onRefreshCompanies}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [filter,setFilter]=useState("");
 const company=companies.find(c=>c.id===selectedCompany);
 async function load(){
  if(!selectedCompany){setError("Selecciona una empresa autorizada.");return;}
  setBusy(true);setError("");setSnapshot(null);setFilter("");
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
   const headers={Authorization:"Bearer "+token};
   const prefix=apiBase+encodeURIComponent(selectedCompany)+"/";
   const endpoints=["departments","workers","tasks","activity?limit=50"];
   const responses=await Promise.all(endpoints.map(path=>fetch(prefix+path,{headers})));
   const failed=responses.find(r=>!r.ok);
   if(failed){setError("Una consulta de supervisión ha fallado (HTTP "+failed.status+"). No se muestra un resumen parcial.");return;}
   const [d,w,t,e]=await Promise.all(responses.map(r=>r.json())) as unknown[];
   const departments=validCollection<Department>(d,x=>typeof x.id==="string"&&typeof x.name==="string");
   const workers=validCollection<Worker>(w,x=>typeof x.id==="string"&&typeof x.department_id==="string"&&typeof x.name==="string"&&typeof x.state==="string");
   const tasks=validCollection<Task>(t,x=>typeof x.id==="string"&&typeof x.department_id==="string"&&typeof x.title==="string"&&typeof x.status==="string");
   const events=validCollection<Activity>(e,x=>typeof x.id==="string"&&typeof x.department_id==="string"&&typeof x.task_title==="string"&&typeof x.type==="string"&&typeof x.created_at==="string");
   setSnapshot({departments,workers,tasks,events,capturedAt:new Date().toISOString()});
  }catch{setError("No se pudo consultar la información autenticada de esta empresa.");}
  finally{setBusy(false);}
 }
 const tasks=snapshot?.tasks||[];
 const workers=snapshot?.workers||[];
 const departments=snapshot?.departments||[];
 const events=snapshot?.events||[];
 const blocked=tasks.filter(t=>t.status==="blocked");
 const pending=tasks.filter(t=>t.status==="pending");
 const running=tasks.filter(t=>t.status==="running");
 const inactive=workers.filter(w=>w.state==="inactive");
 const activeWorkers=workers.filter(w=>w.state==="working");
 const shownEvents=filter?events.filter(e=>e.department_id===filter):events;
 return <section className="ai-supervision">
  <div className="ai-supervision-heading">
   <div><span className="ai-overline">DIRECCIÓN IA · SUPERVISIÓN</span><h2>Estado de la empresa</h2>
    <p>Datos auditados del Centro de Mando. La Dirección IA todavía no está ejecutándose.</p></div>
   <div className="ai-supervision-actions"><button type="button" onClick={onRefreshCompanies} disabled={busy}>Actualizar empresas</button><button type="button" onClick={load} disabled={!selectedCompany||busy}>{busy?"Consultando…":"Actualizar informe"}</button></div>
  </div>
  <label className="ai-company-picker">Empresa
   <select value={selectedCompany} onChange={e=>{onSelect(e.target.value);setSnapshot(null);setError("");setFilter("");}}>
    <option value="">Selecciona una empresa</option>
    {companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
   </select>
  </label>
  {!selectedCompany&&<p role="status">Selecciona o carga tus empresas para consultar su supervisión.</p>}
  {error&&<p role="alert" className="ai-error">{error}</p>}
  {snapshot&&<div className="ai-supervision-content">
   <div className="ai-snapshot-meta"><strong>{company?.name||"Empresa seleccionada"}</strong><span>Actualizado {new Date(snapshot.capturedAt).toLocaleString("es-ES")}</span></div>
   <div className="ai-kpis" aria-label="Indicadores de supervisión">
    <div><strong>{departments.length}</strong><span>Departamentos</span></div>
    <div><strong>{workers.length}</strong><span>Trabajadores registrados</span></div>
    <div><strong>{tasks.length}</strong><span>Tareas consultadas</span></div>
    <div><strong>{blocked.length}</strong><span>Tareas bloqueadas</span></div>
   </div>
   <div className="ai-summary-grid">
    <article className="ai-summary-card"><h3>Resumen para Dirección IA</h3>
     <p>Hay <strong>{pending.length} tareas pendientes</strong>, <strong>{blocked.length} bloqueadas</strong> y <strong>{running.length} en ejecución</strong> según los registros consultados.</p>
     <p>De los trabajadores registrados, <strong>{inactive.length} están inactivos</strong> y <strong>{activeWorkers.length} figuran trabajando</strong>.</p>
     {blocked.length>0?<p className="ai-blocker"><strong>Atención:</strong> {blocked.map(t=>t.title).slice(0,3).join("; ")}{blocked.length>3?" y otras.":"."}</p>:<p>No hay tareas bloqueadas entre las consultadas.</p>}
     <small>Resumen calculado a partir de registros. No constituye un informe generado por un agente IA.</small>
    </article>
    <article className="ai-summary-card"><h3>Estado de los departamentos</h3>
     <div className="ai-dept-grid">{departments.map(d=>{
      const dt=tasks.filter(t=>t.department_id===d.id);
      const dw=workers.filter(w=>w.department_id===d.id);
      return <div className="ai-dept-row" key={d.id}>
       <strong>{d.name}</strong><span>{dw.length} trabajadores · {dt.length} tareas</span>
       {dt.some(t=>t.status==="blocked")&&<em>Con bloqueo</em>}
      </div>;
     })}</div>
    </article>
   </div>
   <article className="ai-summary-card"><div className="ai-timeline-head"><h3>Última actividad auditada</h3><label>Departamento
     <select value={filter} onChange={e=>setFilter(e.target.value)}><option value="">Todos</option>{departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>
    </label></div>
    {shownEvents.length===0?<p>No hay eventos registrados para este filtro.</p>:
    <ol className="ai-supervision-timeline">{shownEvents.slice(0,10).map(ev=><li key={ev.id}>
     <div><strong>{ev.type==="reported"&&ev.message.startsWith("Owner returned task to pending")?"Devolución a pendiente":eventText[ev.type]||ev.type}</strong><time dateTime={ev.created_at}>{new Date(ev.created_at).toLocaleString("es-ES")}</time></div>
     <p>{ev.department_name} · {ev.task_title}</p>
    </li>)}</ol>}
    <small>Se muestran hasta 10 de los últimos 50 eventos consultados.</small>
   </article>
   <p className="ai-supervision-limit">La API devuelve como máximo 100 tareas y 50 eventos. Estas cifras son un resumen de los registros consultados, no un censo completo si la empresa supera esos límites. Sin streaming, ejecución autónoma ni comunicaciones simuladas.</p>
  </div>}
 </section>;
}

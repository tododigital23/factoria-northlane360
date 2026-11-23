import {StoredReport} from "./StoredReport";
import {useEffect, useMemo, useState} from "react";
import {useAuth0} from "./auth";

type Company={id:string;name:string;role:string};
type Counts={completed:number;failed:number;running:number};
type WorkEvent={
 id:string;task_id:string;task_title:string;
 kind:"title_draft"|"document_analysis";
 state:"completed"|"failed"|"running";
 started_at:string;finished_at:string|null;error_code:string|null;
 needs_attention:boolean;
 repository:string|null;path:string|null;ref:string|null;sha:string|null;
};
type Overview={
 organization_id:string;read_only:boolean;contains_report_text:boolean;
 sample:{
  tasks_scanned:number;tasks_available_in_bounded_reader:number;
  task_limit:number;run_limit_per_task_per_type:number;
  truncated:boolean;not_full_company_census:boolean;
 };
 counts:{title_draft:Counts;document_analysis:Counts};
 attention_count_in_sample:number;
 events:WorkEvent[];
};
type Props={
 companyId:string;companies:Company[];
 onSelectCompany:(id:string)=>void;
 onLoadCompanies:()=>void;
};
const api="https://api.tu-factoria.example/v1/me/organizations/";
const labels:Record<WorkEvent["state"],string>={
 completed:"Informe registrado",failed:"Fallido",running:"En ejecución",
};
const kinds:Record<WorkEvent["kind"],string>={
 title_draft:"Borrador por título",document_analysis:"Análisis documental",
};
function validCounts(value:unknown):value is Counts{
 if(!value||typeof value!=="object")return false;
 const x=value as Counts;
 return ["completed","failed","running"].every(k=>{
  const n=x[k as keyof Counts];
  return typeof n==="number"&&Number.isInteger(n)&&n>=0;
 });
}
function validOverview(raw:unknown,org:string):raw is Overview{
 if(!raw||typeof raw!=="object")return false;
 const x=raw as Overview;
 return x.organization_id===org&&x.read_only===true&&x.contains_report_text===false&&
  x.sample?.not_full_company_census===true&&
  typeof x.sample?.tasks_scanned==="number"&&
  typeof x.sample?.task_limit==="number"&&
  typeof x.sample?.truncated==="boolean"&&
  validCounts(x.counts?.title_draft)&&validCounts(x.counts?.document_analysis)&&
  typeof x.attention_count_in_sample==="number"&&Array.isArray(x.events)&&
  x.events.every(e=>e&&typeof e.id==="string"&&typeof e.task_id==="string"&&
   typeof e.task_title==="string"&&
   ["title_draft","document_analysis"].includes(e.kind)&&
   ["completed","failed","running"].includes(e.state)&&
   typeof e.started_at==="string"&&typeof e.needs_attention==="boolean"&&
   (e.sha===null||typeof e.sha==="string")&&
   (e.path===null||typeof e.path==="string"));
}

export function AgentWorkOverview({companyId,companies,onSelectCompany,onLoadCompanies}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [data,setData]=useState<Overview|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [refresh,setRefresh]=useState(0);
 const [kind,setKind]=useState("all");
 const [state,setState]=useState("all");
 const [search,setSearch]=useState("");
 const [opened,setOpened]=useState("");
 const company=companies.find(c=>c.id===companyId);
 const canView=!!companyId&&company?.role==="owner";

 useEffect(()=>{
  let cancelled=false;
  setData(null);setError("");setOpened("");setBusy(false);
  if(!canView)return;
  setBusy(true);
  (async()=>{
   try{
    const token=await getAccessTokenSilently({authorizationParams:{
     audience:"https://api.eliot.internal",scope:"read:tasks"
    }});
    const response=await fetch(api+encodeURIComponent(companyId)+"/execution/work-overview",{
     headers:{"Authorization":"Bearer "+token},
    });
    if(!response.ok)throw new Error("Overview not available");
    const raw:unknown=await response.json();
    if(!validOverview(raw,companyId))throw new Error("Invalid overview");
    if(!cancelled)setData(raw);
   }catch{
    if(!cancelled)setError("No se pudo consultar de forma autenticada el historial de esta empresa.");
   }finally{
    if(!cancelled)setBusy(false);
   }
  })();
  return ()=>{cancelled=true};
 },[companyId,canView,getAccessTokenSilently,refresh]);

 const shown=useMemo(()=>{
  const term=search.trim().toLocaleLowerCase("es-ES");
  return (data?.events||[]).filter(item=>
   (kind==="all"||item.kind===kind)&&
   (state==="all"||item.state===state||
    (state==="attention"&&item.needs_attention))&&
   (!term||[item.task_title,item.path||"",item.repository||""]
     .some(s=>s.toLocaleLowerCase("es-ES").includes(term)))
  );
 },[data,kind,state,search]);

 return <div className="work-overview">
  <div className="work-overview-controls">
   <label>Empresa
    <select value={companyId} onChange={e=>onSelectCompany(e.target.value)}>
     <option value="">Seleccionar empresa</option>
     {companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
   </label>
   <button type="button" className="button-outline" onClick={onLoadCompanies}>Actualizar empresas</button>
   <button type="button" disabled={busy||!canView} onClick={()=>setRefresh(n=>n+1)}>
    {busy?"Consultando…":"Actualizar informe"}
   </button>
  </div>
  {!companyId&&<p>Selecciona una empresa para consultar su historial real.</p>}
  {companyId&&!canView&&<p role="status">Este resumen está reservado al propietario autorizado de la empresa.</p>}
  {error&&<p role="alert">{error}</p>}
  {busy&&!data&&<p role="status">Consultando el historial auditado de la empresa…</p>}
  {data&&data.organization_id===companyId&&canView&&<>
   <p className="work-overview-scope">Consulta de solo lectura. Muestra de {data.sample.tasks_scanned} tareas recientes; máximo {data.sample.task_limit}. Hasta {data.sample.run_limit_per_task_per_type} intentos por tipo y tarea. No representa necesariamente todas las operaciones de la empresa.</p>
   {data.sample.truncated&&<p role="status">Existen más tareas que las incluidas en esta muestra. Los totales siguientes son parciales.</p>}
   <div className="work-overview-stats">
    <article><span>Borradores registrados</span><strong>{data.counts.title_draft.completed}</strong><small>Basados solo en título</small></article>
    <article><span>Análisis documentales registrados</span><strong>{data.counts.document_analysis.completed}</strong><small>Basados en un documento y SHA</small></article>
    <article><span>Intentos fallidos</span><strong>{data.counts.title_draft.failed+data.counts.document_analysis.failed}</strong><small>Sin reintentos automáticos</small></article>
    <article><span>Requieren atención</span><strong>{data.attention_count_in_sample}</strong><small>Fallos o ejecuciones demoradas</small></article>
   </div>
   <div className="work-overview-filters">
    <label>Tipo de informe
     <select value={kind} onChange={e=>setKind(e.target.value)}>
      <option value="all">Todos</option>
      <option value="title_draft">Borradores por título</option>
      <option value="document_analysis">Análisis documentales</option>
     </select>
    </label>
    <label>Estado
     <select value={state} onChange={e=>setState(e.target.value)}>
      <option value="all">Todos</option>
      <option value="completed">Registrados</option>
      <option value="failed">Fallidos</option>
      <option value="running">En ejecución</option>
      <option value="attention">Requieren atención</option>
     </select>
    </label>
    <label>Buscar tarea o documento
     <input type="search" value={search} onChange={e=>setSearch(e.target.value)}
      placeholder="Nombre de tarea o archivo"/>
    </label>
   </div>
   <div className="work-overview-events">
    <div className="work-overview-events-head"><strong>Actividad de agentes IA</strong><span>{shown.length} registros visibles · últimos {data.events.length} disponibles</span></div>
    {shown.length===0?<p>No se han encontrado registros con estos filtros en la muestra consultada.</p>:
     shown.map(item=><article key={item.id} className="work-overview-entry">
      <div className="work-overview-entry-head"><strong>{item.task_title}</strong>
       <span className={item.needs_attention?"work-overview-warning":"work-overview-normal"}>{item.needs_attention?"Requiere atención":labels[item.state]}</span>
      </div>
      <p><strong>{kinds[item.kind]}</strong> · {new Date(item.started_at).toLocaleString("es-ES")}</p>
      {item.kind==="document_analysis"&&<p className="work-overview-source">{item.repository} / {item.path} · SHA {item.sha?.slice(0,12)}…</p>}
      {item.error_code&&<p>Motivo registrado: {item.error_code}. No se ejecutará automáticamente otra vez.</p>}
      {item.state==="completed"&&<>
       <p>El informe está registrado. Abre el resultado para consultar su revisión.</p>
       <button type="button" aria-expanded={opened===item.kind+":"+item.id}
        onClick={()=>setOpened(opened===item.kind+":"+item.id?"":item.kind+":"+item.id)}>
        {opened===item.kind+":"+item.id?"Cerrar informe":"Ver informe completo"}
       </button>
       {opened===item.kind+":"+item.id&&<StoredReport key={companyId+":"+item.task_id+":"+item.kind+":"+item.id} companyId={companyId} event={item}/>}
      </>}
      {item.state==="running"&&item.needs_attention&&<p>Intento sin finalizar durante más de 15 minutos; requiere revisión administrativa. No se reinicia automáticamente.</p>}
     </article>)}
   </div>
  </>}
 </div>;
}


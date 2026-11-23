import {useState} from "react";
import {useAuth0} from "./auth";

type Activity={
 id:string;task_id:string;task_title:string;
 department_id:string;department_name:string;
 type:string;message:string;created_at:string;
};
const eventNames:Record<string,string>={
 created:"Creación",assigned:"Asignación",started:"Inicio",
 progress:"Progreso",blocked:"Bloqueo",completed:"Finalización",
 failed:"Error",cancelled:"Cancelación",reported:"Informe"
};
export function CompanyActivity({companyId,companyName,companies,onSelectCompany,onLoadCompanies}:{
 companyId:string;companyName:string;companies:{id:string;name:string}[];onSelectCompany:(id:string)=>void;onLoadCompanies:()=>void;
}){
 const {getAccessTokenSilently}=useAuth0();
 const [items,setItems]=useState<Activity[]>([]);
 const [busy,setBusy]=useState(false);
 const [hasLoaded,setHasLoaded]=useState(false);
 const [error,setError]=useState("");
 const [department,setDepartment]=useState("");
 async function refresh(){
  if(!companyId){onLoadCompanies();return;}
  setBusy(true);setError("");setItems([]);setHasLoaded(false);setDepartment("");
  try{
   const token=await getAccessTokenSilently({authorizationParams:{
      audience:"https://api.eliot.internal",scope:"read:tasks"
   }});
   const url="https://api.tu-factoria.example/v1/me/organizations/"
      +encodeURIComponent(companyId)+"/activity?limit=50";
   const response=await fetch(url,{headers:{Authorization:"Bearer "+token}});
   if(!response.ok){setError("No se pudo consultar la actividad (HTTP "+response.status+").");return;}
   const data:unknown=await response.json();
   if(!Array.isArray(data)||!data.every((e:unknown)=>{
      if(typeof e!=="object"||e===null)return false;
      const x=e as Activity;
      return typeof x.id==="string"&&typeof x.task_title==="string"&&
        typeof x.department_name==="string"&&typeof x.type==="string"&&
        typeof x.message==="string"&&typeof x.created_at==="string";
   }))throw Error("Formato de actividad desconocido");
   setItems(data as Activity[]);setHasLoaded(true);
  }catch{setError("No se pudo completar la consulta autorizada.");}
  finally{setBusy(false);}
 }
 const departments=Array.from(new Map(items.map(i=>[i.department_id,i.department_name])).entries());
 const shown=department?items.filter(x=>x.department_id===department):items;
 return <div className="activity-pane">
  <label>Empresa <select value={companyId} onChange={e=>onSelectCompany(e.target.value)}><option value="">Selecciona una empresa</option>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
  <p>Actividad auditada de <strong>{companyName||"la empresa seleccionada"}</strong>, sin simular trabajadores ni mensajes.</p>
  <div className="activity-actions"><button disabled={busy} onClick={onLoadCompanies}>Actualizar empresas</button><button disabled={busy||!companyId} onClick={refresh}>{busy?"Consultando…":"Actualizar actividad"}</button></div>
  {hasLoaded&&<p role="status">{items.length===0?"Todavía no hay actividad registrada en esta empresa.":"Eventos recuperados: "+items.length}</p>}
  {error&&<p role="alert">{error}</p>}
  {departments.length>1&&<label>Departamento
   <select value={department} onChange={e=>setDepartment(e.target.value)}>
    <option value="">Todos</option>
    {departments.map(([id,name])=><option key={id} value={id}>{name}</option>)}
   </select>
  </label>}
  <div className="activity-timeline" aria-label="Eventos reales de la empresa">
   {shown.map(e=><article key={e.id} className="activity-item">
     <div className="activity-item-head">
      <strong>{(e.type==="reported"&&e.message.startsWith("Owner returned task to pending")?"Devolución a pendiente":eventNames[e.type]||e.type)}</strong>
      <time dateTime={e.created_at}>{new Date(e.created_at).toLocaleString("es-ES")}</time>
     </div>
     <p><strong>{e.department_name}</strong> · {e.task_title}</p>
     {e.message&&<p>{e.message}</p>}
    </article>)}
  </div>
  {hasLoaded&&items.length>=50&&<p>Se muestran los 50 eventos más recientes. La paginación se incorporará en una próxima fase.</p>}
 </div>;
}

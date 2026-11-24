import {useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";

type Preview={
 organization_id:string;task_id:string;title:string;task_status:string;
 department_name:string|null;worker_name:string|null;worker_state:string|null;
 checks:Record<string,boolean>;eligible_for_execution:boolean;
 execution_available:boolean;reasons:string[];read_only:boolean;
};
export function TaskExecutionPreview({organizationId,taskId}:{
 organizationId:string;taskId:string;
}){
 const {getAccessTokenSilently}=useAuth0();
 const [busy,setBusy]=useState(false);
 const [result,setResult]=useState<Preview|null>(null);
 const [message,setMessage]=useState("");
 const [visible,setVisible]=useState(false);
 async function open(){
  if(visible){setVisible(false);return;}
  setBusy(true);setMessage("");setResult(null);
  try{
   const token=await getAccessTokenSilently({authorizationParams:{
    audience:"https://api.eliot.internal",scope:"read:tasks"
   }});
   const endpoint=API_ROOT+"/v1/me/organizations/"+
     encodeURIComponent(organizationId)+"/tasks/"+encodeURIComponent(taskId)+"/execution/preview";
   const response=await fetch(endpoint,{headers:{Authorization:"Bearer "+token}});
   if(!response.ok){setMessage("No se pudo verificar la preparación de ejecución (HTTP "+response.status+").");return;}
   const data:unknown=await response.json();
   if(!data||typeof data!=="object")throw Error("Invalid preview");
   const p=data as Preview;
   if(p.organization_id!==organizationId||p.task_id!==taskId||
    p.read_only!==true||p.execution_available!==false||!Array.isArray(p.reasons)||
    typeof p.task_status!=="string"||typeof p.checks!=="object")throw Error("Unexpected execution plan");
   setResult(p);setVisible(true);
  }catch{setMessage("No se pudo obtener una vista previa segura. No se ha ejecutado ninguna acción.");}
  finally{setBusy(false);}
 }
 const checks: Array<[string,boolean]> = result?[
  ["Empresa autorizada",result.checks.authorized_company],
  ["Tarea pendiente",result.checks.task_pending],
  ["Trabajador asignado",result.checks.worker_assigned],
  ["Trabajador en el mismo departamento",result.checks.worker_belongs_to_task_department],
  ["Trabajador activado",result.checks.worker_activated],
  ["Herramientas y permisos aprobados",result.checks.approved_tool_profile],
  ["Motor de ejecución auditado disponible",result.checks.audited_execution_runtime],
 ]:[];
 return <section className="execution-preview">
  <button type="button" className="button-outline" disabled={busy} onClick={open}>
   {busy?"Comprobando…":visible?"Ocultar preparación":"Preparar ejecución · solo consulta"}
  </button>
  {message&&<p role="status">{message}</p>}
  {visible&&result&&<div className="execution-preview-body">
   <strong>Diagnóstico de ejecución · Sin acciones realizadas</strong>
   <p>Departamento: <b>{result.department_name??"No disponible"}</b>. Trabajador: <b>{result.worker_name??"Sin asignar"}</b>{result.worker_state?" · "+result.worker_state:""}.</p>
   <ul>{checks.map(([label,ok])=><li key={label}><span aria-hidden="true">{ok?"✓":"○"}</span>{label}</li>)}</ul>
   <p><strong>Ejecución no disponible:</strong> {result.reasons.join(" ")}</p>
   <small>Este diagnóstico es una consulta autenticada. No inicia trabajadores, no cambia estados ni crea eventos.</small>
  </div>}
 </section>;
}

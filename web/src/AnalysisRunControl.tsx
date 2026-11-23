import {ReportMarkdown} from "./ReportMarkdown";
import {useState} from "react";
import {useAuth0} from "./auth";

type Capability={organization_id:string;enabled:boolean;capability:string;requires_fresh_approval:boolean;external_tools_enabled:boolean;source_scope:string};
type Approval={id:string;worker_id:string;state:string;expires_at:string};
type Run={id:string;state:string;report:string|null;error_code:string|null;started_at:string;finished_at:string|null;draft_from_title_only:boolean};
type Props={organizationId:string;taskId:string;taskStatus:string;workerId:string|null;workerState:string|null};
const prefix="https://api.tu-factoria.example/v1/me/organizations/";

export function AnalysisRunControl({organizationId,taskId,taskStatus,workerId,workerState}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [open,setOpen]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [status,setStatus]=useState("");
 const [cap,setCap]=useState<Capability|null>(null);
 const [approvals,setApprovals]=useState<Approval[]|null>(null);
 const [runs,setRuns]=useState<Run[]|null>(null);
 const [key,setKey]=useState("");
 const [confirm,setConfirm]=useState(false);
 const root=prefix+encodeURIComponent(organizationId)+"/";
 const url=root+"tasks/"+encodeURIComponent(taskId)+"/execution/";
 const eligible=taskStatus==="pending"&&!!workerId&&workerState==="idle";
 const approved=approvals?.find(a=>a.worker_id===workerId&&a.state==="approved"&&
   new Date(a.expires_at).getTime()>Date.now());
 const canExecute=!!cap?.enabled&&eligible&&!!approved&&!busy;

 async function token(write:boolean){
  return getAccessTokenSilently({authorizationParams:{
   audience:"https://api.eliot.internal",scope:write?"read:tasks create:tasks":"read:tasks"
  }});
 }
 async function load(){
  setBusy(true);setError("");setStatus("");
  try{
   const access=await token(false);
   const headers={Authorization:"Bearer "+access};
   const paths=[
    root+"execution/analysis-capability",
    url+"analysis-approvals",
    url+"analysis-runs"
   ];
   const replies=await Promise.all(paths.map(path=>fetch(path,{headers})));
   if(replies.some(r=>!r.ok))throw Error("Una consulta de permisos falló");
   const [rawCap,rawApprovals,rawRuns]:unknown[]=await Promise.all(replies.map(r=>r.json()));
   if(!rawCap||typeof rawCap!=="object"||
      (rawCap as Capability).organization_id!==organizationId||
      typeof (rawCap as Capability).enabled!=="boolean"||
      (rawCap as Capability).external_tools_enabled!==false||
      (rawCap as Capability).source_scope!=="task_title_only")throw Error("Estado inválido");
   if(!Array.isArray(rawApprovals)||!rawApprovals.every(a=>a&&typeof a==="object"&&
      typeof (a as Approval).id==="string"&&typeof (a as Approval).worker_id==="string"&&
      typeof (a as Approval).state==="string"&&typeof (a as Approval).expires_at==="string"))throw Error("Aprobaciones inválidas");
   if(!Array.isArray(rawRuns)||!rawRuns.every(r=>r&&typeof r==="object"&&
      typeof (r as Run).id==="string"&&typeof (r as Run).state==="string"&&
      (r as Run).draft_from_title_only===true&&
      ((r as Run).report===null||typeof (r as Run).report==="string")))throw Error("Resultados inválidos");
   setCap(rawCap as Capability);setApprovals(rawApprovals as Approval[]);
   setRuns(rawRuns as Run[]);setOpen(true);
  }catch{
   setError("No se pudo verificar de forma completa el estado del análisis. No se ejecutó ninguna acción.");
  }finally{setBusy(false);}
 }
 async function execute(){
  if(!confirm||!canExecute||!approved)return;
  const currentKey=key||crypto.randomUUID();
  setKey(currentKey);setBusy(true);setError("");setStatus("");
  try{
   const access=await token(true);
   const res=await fetch(url+"analysis-runs",{
    method:"POST",
    headers:{Authorization:"Bearer "+access,"Content-Type":"application/json"},
    body:JSON.stringify({approval_id:approved.id,request_key:currentKey})
   });
   if(!res.ok){
    setError("No se confirmó la ejecución (HTTP "+res.status+"). Consulta los resultados antes de reintentar.");
    return;
   }
   const raw:unknown=await res.json();
   if(!raw||typeof raw!=="object")throw Error("Respuesta inválida");
   const answer=raw as {run_id:string;status:string;already_claimed:boolean;provider_called:boolean;draft_from_title_only?:boolean;report?:string|null};
   if(typeof answer.run_id!=="string"||!["running","completed","failed"].includes(answer.status)||
      typeof answer.already_claimed!=="boolean")throw Error("Confirmación inválida");
   setKey("");setConfirm(false);setApprovals(null);
   setStatus(answer.status==="completed"?
      "Borrador generado y registrado. La tarea permanece pendiente para revisión humana.":
      answer.status==="failed"?
      "El intento falló y se registró. Consulta resultados; no se repetirá automáticamente.":
      "Ejecución registrada; consulta su estado antes de hacer nada más.");
   setRuns(null);
  }catch{
   setError("Respuesta de ejecución no verificable. No inicies otro intento: consulta el historial con la misma clave de solicitud.");
  }finally{setBusy(false);}
 }
 return <section className="analysis-run-panel">
  <div className="analysis-run-heading"><strong>Primer análisis IA · ejecución limitada</strong><span>Sin acceso documental</span></div>
  <p>El resultado será un borrador basado SOLO en el título de la tarea, nunca una revisión real de documentos. No se modifican archivos ni servicios.</p>
  <button type="button" className="button-outline" disabled={busy} onClick={()=>open?setOpen(false):void load()}>
   {open?"Ocultar ejecutor":busy?"Comprobando…":"Comprobar ejecutor y resultados"}
  </button>
  {open&&<div className="analysis-run-body">
   <p>Motor: <strong>{cap?.enabled?"Disponible para esta empresa":"Deshabilitado por seguridad"}</strong></p>
   {!eligible&&<p>Se requiere tarea pendiente y un trabajador asignado disponible.</p>}
   {eligible&&!approved&&<p>No hay autorización vigente. Prepara una nueva en «Autorizaciones del análisis IA» y actualiza este apartado. Una autorización revocada no sirve.</p>}
   {canExecute&&!confirm&&<button type="button" onClick={()=>setConfirm(true)}>Preparar ejecución única</button>}
   {confirm&&<div className="analysis-run-confirm">
    <p>Confirmas una llamada de pago a la API de IA para generar exclusivamente un borrador a partir del título. Se consumirá esta autorización y se registrará el intento, incluso si falla. No se leerán documentos.</p>
    <button type="button" disabled={!canExecute} onClick={()=>void execute()}>{busy?"Ejecutando…":"Confirmar y generar borrador"}</button>
    <button type="button" className="button-outline" disabled={busy} onClick={()=>{setConfirm(false);setKey("");}}>Cancelar</button>
   </div>}
   <div className="analysis-run-history">
    <strong>Resultados auditados</strong>
    {runs===null?<p>Pulsa «Consultar resultados» para actualizar el historial.</p>:
      runs.length===0?<p>Sin ejecuciones de análisis registradas.</p>:
      runs.map(r=><article key={r.id}>
       <div className="analysis-run-meta"><strong>{r.state}</strong><span>{new Date(r.started_at).toLocaleString("es-ES")}</span></div>
       {r.report&&<ReportMarkdown content={r.report}/>}
       {r.error_code&&<p>Motivo técnico: {r.error_code}. No se ha completado la tarea.</p>}
      </article>)}
    <button type="button" className="button-outline" disabled={busy} onClick={()=>void load()}>Consultar resultados</button>
   </div>
  </div>}
  {status&&<p role="status">{status}</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}

import {PersistentDocumentPlan} from "./PersistentDocumentPlan";
import {useState} from "react";
import {useAuth0} from "./auth";
import {ReportMarkdown} from "./ReportMarkdown";
import {DurableDocumentControl} from "./DurableDocumentControl";

type Evidence={
 organization_id:string;task_id:string;worker_id:string;
 repository:string;path:string;ref:string;sha:string;
 size_bytes:number;source_verified:boolean;
};
type Approval={
 id:string;worker_id:string;state:string;repository:string;
 path:string;ref:string;sha:string;expires_at:string;
};
type Run={
 id:string;state:string;report:string|null;error_code:string|null;
 repository:string;path:string;ref:string;sha:string;started_at:string;
};
type Capability={
 organization_id:string;enabled:boolean;capability:string;
 source_scope:string;requires_fresh_document_approval:boolean;
 external_tools_enabled:boolean;store_at_provider:boolean;
};
const api="https://api.tu-factoria.example/v1/me/organizations/";

export function DocumentaryAnalysisControl({evidence}: {evidence:Evidence}){
 const {getAccessTokenSilently}=useAuth0();
 const [selectedPlanId,setSelectedPlanId]=useState<string|undefined>();
 const [cap,setCap]=useState<Capability|null>(null);
 const [approvals,setApprovals]=useState<Approval[]>([]);
 const [runs,setRuns]=useState<Run[]>([]);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [message,setMessage]=useState("");
 const [confirmApproval,setConfirmApproval]=useState(false);
 const [confirmRun,setConfirmRun]=useState(false);
 const [approveKey,setApproveKey]=useState("");
 const [runKey,setRunKey]=useState("");
 const [latest,setLatest]=useState<Run|null>(null);
 const url=api+encodeURIComponent(evidence.organization_id)+"/tasks/"+
   encodeURIComponent(evidence.task_id)+"/execution";
 async function request(path:string, write=false, body?:object):Promise<unknown>{
  const access=await getAccessTokenSilently({authorizationParams:{
   audience:"https://api.eliot.internal",
   scope:write?"read:tasks create:tasks":"read:tasks"
  }});
  const response=await fetch(path,{
   method:body?"POST":"GET",
   headers:{Authorization:"Bearer "+access,...(body?{"Content-Type":"application/json"}:{})},
   ...(body?{body:JSON.stringify(body)}:{})
  });
  if(!response.ok)throw new Error("HTTP "+response.status);
  return response.json();
 }
 // Read back server state after mutations; never invent an approval expiry
 // or start a provider request as a consequence of refreshing the panel.
 async function refreshHistory(){
  setCap(null);setApprovals([]);
   const data=await request(api+encodeURIComponent(evidence.organization_id)+"/execution/documentary-capability");
   if(!data||typeof data!=="object")throw Error("Invalid capability");
   const capability=data as Capability;
   if(capability.organization_id!==evidence.organization_id||
     capability.capability!=="document_analysis_v1"||
     capability.source_scope!=="one_github_file_exact_sha"||
     capability.requires_fresh_document_approval!==true||
     capability.external_tools_enabled!==false||
     capability.store_at_provider!==false||
     typeof capability.enabled!=="boolean")throw Error("Unexpected capability");
   if(!capability.enabled){
    setCap(capability);setApprovals([]);setRuns([]);return;
   }
   const [rawApprovals,rawRuns]=await Promise.all([
    request(url+"/document-approvals"),request(url+"/document-runs")
   ]);
   if(!Array.isArray(rawApprovals)||!Array.isArray(rawRuns))throw Error("Invalid history");
   const approved=rawApprovals as Approval[];
   const saved=rawRuns as Run[];
   if(!approved.every(a=>a&&typeof a.id==="string"&&typeof a.worker_id==="string"&&
     typeof a.state==="string"&&typeof a.sha==="string"&&typeof a.expires_at==="string")||
     !saved.every(x=>x&&typeof x.id==="string"&&typeof x.sha==="string"&&
       typeof x.state==="string"&&(x.report===null||typeof x.report==="string")))
     throw Error("Invalid history content");
   setApprovals(approved);
   setRuns(saved);
   setCap(capability);
 }
 async function load(){
  if(busy)return;
  setBusy(true);setError("");setMessage("");
  setConfirmApproval(false);setConfirmRun(false);
  try{
   await refreshHistory();
  }catch{
   setError("No se ha podido validar la autorización documental ni el historial. No se ejecutó ninguna acción.");
  }finally{setBusy(false);}
 }
 const active=approvals.find(a=>a.worker_id===evidence.worker_id&&
   a.repository===evidence.repository&&a.path===evidence.path&&
   a.ref===evidence.ref&&a.sha===evidence.sha&&a.state==="approved"&&
   new Date(a.expires_at).getTime()>Date.now());
 async function approve(){
  if(!confirmApproval||!cap?.enabled||busy)return;
  const id=approveKey||crypto.randomUUID();setApproveKey(id);
  setBusy(true);setError("");setMessage("");
  try{
   const raw=await request(url+"/document-approvals",true,{
    worker_id:evidence.worker_id,repository:evidence.repository,path:evidence.path,
    expected_sha:evidence.sha,request_key:id
   });
   if(!raw||typeof raw!=="object")throw Error("Invalid approval");
   const approval=raw as {approval_id:string;capability:string;sha:string;provider_called:boolean};
   if(typeof approval.approval_id!=="string"||approval.capability!=="document_analysis_v1"||
     approval.sha!==evidence.sha||approval.provider_called!==false)throw Error("Wrong approval");
   setConfirmApproval(false);setApproveKey("");
   await refreshHistory();
   setMessage("Permiso documental registrado. No se ha enviado información al modelo; caduca en 15 minutos.");
  }catch{
   setError("No se pudo confirmar el estado del permiso. Puede haberse registrado: consulta el historial antes de realizar otra acción.");
  }finally{setBusy(false);}
 }
 async function run(){
  if(!confirmRun||!cap?.enabled||!active||busy)return;
  const key=runKey||crypto.randomUUID();setRunKey(key);
  setBusy(true);setError("");setMessage("");
  try{
   const raw=await request(url+"/document-runs",true,{
    approval_id:active.id,request_key:key
   });
   if(!raw||typeof raw!=="object")throw Error("Invalid run");
   const result=raw as {run_id:string;status:string;already_claimed:boolean;
    report?:string|null;error_code?:string|null;sha?:string};
   if(typeof result.run_id!=="string"||
     !["running","completed","failed"].includes(result.status)||
     typeof result.already_claimed!=="boolean")throw Error("Invalid run");
   if(result.sha&&result.sha!==evidence.sha)throw Error("SHA mismatch");
   if(result.status==="completed"&&typeof result.report==="string"){
     setLatest({id:result.run_id,state:"completed",report:result.report,
       error_code:null,repository:evidence.repository,path:evidence.path,ref:evidence.ref,
       sha:evidence.sha,started_at:new Date().toISOString()});
   }
   setConfirmRun(false);setRunKey("");setApprovals([]);
   setMessage(result.status==="completed"?
      "Informe documental generado y guardado. La tarea sigue pendiente de revisión humana.":
      "Intento registrado. Consulta el historial antes de realizar otra acción.");
  }catch{
   setError("No se confirmó el resultado. Consulta el historial: nunca repitas con otra clave si el estado es incierto.");
  }finally{setBusy(false);}
 }
 async function revoke(approvalId:string){
  if(busy)return;
  setBusy(true);setError("");setMessage("");
  try{
   const raw=await request(url+"/document-approvals/"+encodeURIComponent(approvalId)+"/revoke",
      true,{request_key:crypto.randomUUID()});
   if(!raw||typeof raw!=="object"||
      !["revoked","expired"].includes((raw as {state:string}).state))throw Error("Invalid revoke");
   setApprovals([]);setConfirmRun(false);
   setMessage("Permiso documental revocado o caducado.");
  }catch{setError("Revocación no confirmada. Consulta autorizaciones antes de reintentar.")}
  finally{setBusy(false);}
 }
 return <div className="document-ai-control">
  <strong>Análisis IA de este documento · consentimiento independiente</strong>
  <p>Archivo: {evidence.path} · SHA: {evidence.sha.slice(0,12)}…</p>
  <p>Solo si lo autorizas se enviará el contenido completo del archivo seleccionado a OpenAI. Puede generar costes por tokens. No se modifica GitHub ni la tarea.</p>
  <button type="button" className="button-outline" disabled={busy} onClick={()=>void load()}>
   {busy?"Verificando…":"Comprobar autorización documental"}
  </button>
  {cap&&!cap.enabled&&<p role="status">Motor documental deshabilitado: no se puede aprobar ni transmitir documentación a OpenAI.</p>}
  {cap?.enabled&&<>
   {!active&&!confirmApproval&&<button type="button" disabled={busy} onClick={()=>setConfirmApproval(true)}>
    Preparar permiso para este SHA
   </button>}
   {confirmApproval&&<div className="document-ai-confirm">
    <p>¿Autorizas exactamente este documento y SHA para UNA posible ejecución de IA durante 15 minutos? Autorizar no inicia el análisis ni envía el archivo.</p>
    <button type="button" disabled={busy} onClick={()=>void approve()}>Confirmar autorización</button>
    <button type="button" className="button-outline" disabled={busy} onClick={()=>setConfirmApproval(false)}>Cancelar</button>
   </div>}
   {active&&<div className="document-ai-confirm">
    <p>Permiso vigente para este documento hasta {new Date(active.expires_at).toLocaleString("es-ES")}.</p>
    {!confirmRun&&<button type="button" disabled={busy} onClick={()=>setConfirmRun(true)}>Preparar análisis documental</button>}
    {confirmRun&&<>
     <p>Última confirmación: enviar SOLO el contenido de {evidence.path} (SHA {evidence.sha}) a OpenAI para elaborar un informe con citas. Se consumen tokens de pago. Esta autorización se consume una sola vez, incluso si el intento falla.</p>
     <button type="button" disabled={busy} onClick={()=>void run()}>Confirmar envío y generar informe</button>
     <button type="button" className="button-outline" disabled={busy} onClick={()=>setConfirmRun(false)}>Cancelar</button>
    </>}
    <button type="button" className="button-outline" disabled={busy} onClick={()=>void revoke(active.id)}>Revocar permiso</button>
   </div>}
   <strong>Resultados auditados · documento y revisión</strong>
   {(latest?[latest,...runs.filter(x=>x.id!==latest.id)]:runs).map(item=><article key={item.id}>
    <p>{item.state} · {item.path} · SHA {item.sha.slice(0,12)}…</p>
    {item.report&&<ReportMarkdown content={item.report}/>}
    {item.error_code&&<p>Motivo registrado: {item.error_code}</p>}
   </article>)}
  </>}
  <PersistentDocumentPlan evidence={evidence} selectedPlanId={selectedPlanId} onSelectPlan={setSelectedPlanId}/>
  <DurableDocumentControl planId={selectedPlanId} evidence={evidence} approvalId={active?.id} onQueued={()=>{
   setApprovals([]);setConfirmRun(false);setConfirmApproval(false);
  }}/>
  {message&&<p role="status">{message}</p>}
  {error&&<p role="alert">{error}</p>}
 </div>;
}


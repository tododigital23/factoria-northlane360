import {GitHubToolReadControl} from "./GitHubToolReadControl";
import {DocumentaryAnalysisControl} from "./DocumentaryAnalysisControl";
import {useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";

type Source={full_name:string;ref:string;prefix:string};
type SourceStatus={
 organization_id:string;configured:boolean;connection_checked:boolean;
 connected:boolean;read_only:boolean;external_model_calls:boolean;
 repositories:Source[];
};
type DocumentItem={path:string;name:string;sha:string;size:number};
type PreflightResult={
 organization_id:string;task_id:string;worker_id:string;repository:string;
 path:string;ref:string;sha:string;size_bytes:number;source_verified:boolean;
 read_only:boolean;approval_created:boolean;sent_to_model:boolean;model_calls:number;
 saved_as_evidence:boolean;
};
type Props={
 organizationId:string;taskId:string;taskStatus:string;
 workerId:string|null;workerState:string|null;
};
const api=API_ROOT+"/v1/me/organizations/";

export function DocumentEvidencePreflight({
 organizationId,taskId,taskStatus,workerId,workerState
}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [expanded,setExpanded]=useState(false);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [sources,setSources]=useState<Source[]>([]);
 const [repo,setRepo]=useState("");
 const [files,setFiles]=useState<DocumentItem[]>([]);
 const [chosen,setChosen]=useState<PreflightResult|null>(null);
 const [status,setStatus]=useState("");
 const eligible=taskStatus==="pending"&&!!workerId&&workerState==="idle";
 const root=api+encodeURIComponent(organizationId);
 async function request(path:string,body?:object):Promise<unknown>{
  const token=await getAccessTokenSilently({authorizationParams:{
   audience:"https://api.eliot.internal",scope:"read:tasks"
  }});
  const response=await fetch(path,{
   method:body?"POST":"GET",
   headers:{"Authorization":"Bearer "+token,...(body?{"Content-Type":"application/json"}:{})},
   ...(body?{body:JSON.stringify(body)}:{})
  });
  if(!response.ok)throw Error("HTTP "+response.status);
  return response.json();
 }
 async function checkSources(){
  if(busy||!eligible)return;
  setBusy(true);setError("");setStatus("");setSources([]);setFiles([]);setChosen(null);
  try{
   const raw=await request(root+"/sources/github");
   if(!raw||typeof raw!=="object")throw Error("Estado inválido");
   const data=raw as SourceStatus;
   if(data.organization_id!==organizationId||data.connected!==true||
      data.connection_checked!==true||data.read_only!==true||
      data.external_model_calls!==false||!Array.isArray(data.repositories)||
      !data.repositories.every(x=>typeof x.full_name==="string"&&typeof x.ref==="string"&&typeof x.prefix==="string"))
     throw Error("Fuente no disponible");
   setSources(data.repositories);
   setStatus("Selecciona un repositorio y un archivo para comprobar su revisión.");
  }catch{
   setError("No ha sido posible confirmar el acceso documental autorizado. No se ha preparado ninguna evidencia.");
  }finally{setBusy(false);}
 }
 async function listFiles(repository:string){
  if(busy||!eligible||!sources.some(x=>x.full_name===repository))return;
  setBusy(true);setError("");setFiles([]);setChosen(null);setRepo(repository);
  try{
   const raw=await request(root+"/sources/github/documents?repository="+encodeURIComponent(repository));
   if(!raw||typeof raw!=="object")throw Error("Listado inválido");
   const data=raw as {organization_id:string;repository:string;read_only:boolean;sent_to_model:boolean;documents:DocumentItem[]};
   if(data.organization_id!==organizationId||data.repository!==repository||
      data.read_only!==true||data.sent_to_model!==false||
      !Array.isArray(data.documents)||
      !data.documents.every(x=>typeof x.path==="string"&&typeof x.sha==="string"&&typeof x.name==="string"&&
       typeof x.size==="number"))throw Error("Listado inválido");
   setFiles(data.documents);
   setStatus("Selecciona el documento exacto que deseas comprobar.");
  }catch{setError("El listado de documentos no se pudo comprobar.")}
  finally{setBusy(false);}
 }
 async function preflight(file:DocumentItem){
  if(busy||!eligible||!workerId||!files.some(x=>x.path===file.path&&x.sha===file.sha))return;
  setBusy(true);setError("");setStatus("");setChosen(null);
  try{
   const raw=await request(
    root+"/tasks/"+encodeURIComponent(taskId)+"/document-evidence/preflight",
    {repository:repo,path:file.path,expected_sha:file.sha,worker_id:workerId}
   );
   if(!raw||typeof raw!=="object")throw Error("Evidencia inválida");
   const data=raw as PreflightResult;
   if(data.organization_id!==organizationId||data.task_id!==taskId||
      data.worker_id!==workerId||data.repository!==repo||data.path!==file.path||
      data.sha!==file.sha||data.source_verified!==true||data.read_only!==true||
      data.sent_to_model!==false||data.approval_created!==false||
      data.model_calls!==0||data.saved_as_evidence!==false||
      typeof data.ref!=="string"||typeof data.size_bytes!=="number")throw Error("Evidencia inválida");
   setChosen(data);
   setStatus("Documento y revisión SHA verificados. No se ha iniciado ningún análisis IA.");
  }catch{setError("La revisión documental cambió o no se pudo verificar. Recarga los archivos; no se ha iniciado IA.")}
  finally{setBusy(false);}
 }
 return <section className="task-evidence-preflight">
  <div className="task-evidence-head"><strong>Evidencia documental · preparación</strong><span>Solo lectura · sin IA</span></div>
  <p>Comprueba un documento de GitHub y su SHA para esta tarea. Esta prueba no lo envía a OpenAI, no crea autorización y no guarda una vinculación permanente.</p>
  <button type="button" className="button-outline" onClick={()=>setExpanded(x=>!x)} disabled={busy}>
   {expanded?"Ocultar preparación":"Preparar documento"}
  </button>
  {expanded&&<div className="task-evidence-body">
   {!eligible?<p role="status">Necesita una tarea pendiente con un trabajador asignado disponible.</p>:
   <button type="button" disabled={busy} onClick={()=>void checkSources()}>
    {busy?"Verificando…":"Consultar fuentes autorizadas"}
   </button>}
   {sources.length>0&&<div className="task-evidence-items">
    <strong>Repositorios autorizados</strong>
    {sources.map(s=><button type="button" className="button-outline" key={s.full_name}
      disabled={busy} onClick={()=>void listFiles(s.full_name)}>{s.full_name} · {s.prefix}</button>)}
   </div>}
   {repo&&<div className="task-evidence-items">
     <strong>Documentos de {repo}</strong>
     {files.length===0?<p>Sin documentos disponibles en esta carpeta.</p>:
      files.map(f=><button type="button" key={f.path} className="button-outline"
       disabled={busy} onClick={()=>void preflight(f)}>{f.name} · SHA {f.sha.slice(0,12)}…</button>)}
   </div>}
   {chosen&&<div className="task-evidence-result">
    <strong>Revisión comprobada</strong>
    <p>{chosen.repository} / {chosen.path}</p>
    <p>Ref: {chosen.ref}</p>
    <p>SHA: <code>{chosen.sha}</code></p>
    <p>{chosen.size_bytes} bytes · Sin llamada OpenAI · Sin aprobación ni cambios guardados</p>
   </div>}
   {chosen&&eligible&&<GitHubToolReadControl key={chosen.organization_id+":"+chosen.task_id+":"+chosen.worker_id+":"+chosen.repository+":"+chosen.path+":"+chosen.sha} evidence={chosen}/>}
   {chosen&&<DocumentaryAnalysisControl key={chosen.path+":"+chosen.sha} evidence={chosen}/>}{status&&<p role="status">{status}</p>}
   {error&&<p role="alert">{error}</p>}
  </div>}
 </section>;
}

import {useState} from "react";
import {useAuth0} from "./auth";
import {ReportMarkdown} from "./ReportMarkdown";
import {API_ROOT} from "./holdingApi";

type Repository={full_name:string;prefix:string;ref:string};
type SourceStatus={organization_id:string;configured:boolean;connection_checked:boolean;connected:boolean;read_only:boolean;external_model_calls:boolean;repositories:Repository[]};
type FileItem={path:string;name:string;sha:string;size:number};
type SourceFile={organization_id:string;repository:string;path:string;ref:string;sha:string;content:string;source_type:string;read_only:boolean;sent_to_model:boolean};
type Props={organizationId:string;organizationName:string;role:string};
const api=API_ROOT+"/v1/me/organizations/";

export function GitHubSources({organizationId,organizationName,role}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [status,setStatus]=useState<SourceStatus|null>(null);
 const [files,setFiles]=useState<FileItem[]>([]);
 const [repo,setRepo]=useState("");
 const [document,setDocument]=useState<SourceFile|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const base=api+encodeURIComponent(organizationId)+"/sources/github";
 async function fetchJson(url:string){
   const token=await getAccessTokenSilently({authorizationParams:{
     audience:"https://api.eliot.internal",scope:"read:tasks"
   }});
   const response=await fetch(url,{headers:{Authorization:"Bearer "+token}});
   if(!response.ok)throw Error("HTTP "+response.status);
   return response.json() as Promise<unknown>;
 }
 async function check(){
   if(!organizationId||role!=="owner"||busy)return;
   setBusy(true);setError("");setRepo("");setFiles([]);setDocument(null);
   try{
     const raw=await fetchJson(base);
     if(!raw||typeof raw!=="object")throw Error("Estado inválido");
     const next=raw as SourceStatus;
     if(next.organization_id!==organizationId||
       typeof next.configured!=="boolean"||next.connection_checked!==true||
       typeof next.connected!=="boolean"||next.read_only!==true||next.external_model_calls!==false||
       !Array.isArray(next.repositories)||!next.repositories.every(r=>
        typeof r.full_name==="string"&&typeof r.prefix==="string"&&typeof r.ref==="string"))throw Error("Estado inválido");
     setStatus(next);
   }catch{setError("No se pudo verificar el acceso documental autorizado.")}
   finally{setBusy(false);}
 }
 async function list(repository:string){
   if(!status?.configured||busy)return;
   if(!status.repositories.some(r=>r.full_name===repository))return;
   setBusy(true);setError("");setFiles([]);setDocument(null);setRepo(repository);
   try{
     const raw=await fetchJson(base+"/documents?repository="+encodeURIComponent(repository));
     if(!raw||typeof raw!=="object")throw Error("Listado inválido");
     const data=raw as {organization_id:string;repository:string;documents:FileItem[];read_only:boolean;sent_to_model:boolean};
     if(data.organization_id!==organizationId||data.repository!==repository||
       data.read_only!==true||data.sent_to_model!==false||
       !Array.isArray(data.documents)||!data.documents.every(d=>typeof d.path==="string"&&
        typeof d.name==="string"&&typeof d.sha==="string"&&typeof d.size==="number"))throw Error("Listado inválido");
     setFiles(data.documents);
   }catch{setError("No se pudo consultar la carpeta documental autorizada.")}
   finally{setBusy(false);}
 }
 async function openFile(file:FileItem){
   if(!repo||!files.some(f=>f.path===file.path&&f.sha===file.sha)||busy)return;
   setBusy(true);setError("");setDocument(null);
   try{
     const url=base+"/document?repository="+encodeURIComponent(repo)+"&path="+encodeURIComponent(file.path);
     const raw=await fetchJson(url);
     if(!raw||typeof raw!=="object")throw Error("Archivo inválido");
     const data=raw as SourceFile;
     if(data.organization_id!==organizationId||data.repository!==repo||
        data.path!==file.path||data.sha!==file.sha||
        typeof data.content!=="string"||data.content.length>16000||
        data.read_only!==true||data.sent_to_model!==false)throw Error("Archivo inválido");
     setDocument(data);
   }catch{setError("No se pudo verificar este documento.")}
   finally{setBusy(false);}
 }
 return <section className="github-sources">
   <h2>Documentación GitHub</h2>
   <p>Empresa: <strong>{organizationName||"Sin empresa"}</strong>. Solo lectura, sin transferir archivos al modelo IA.</p>
   {role!=="owner"?<p>Solo el propietario autorizado puede consultar estas fuentes.</p>:<>
    <button type="button" disabled={busy||!organizationId} onClick={()=>void check()}>
      {busy?"Comprobando…":"Comprobar conexión GitHub"}
    </button>
    {status&&!status.configured&&<div className="github-sources-info">
      <strong>Fuente documental aún sin conectar</strong>
      <p>Hay que instalar una GitHub App con permisos Contents: read-only y asociar únicamente los repositorios aprobados a esta empresa en Railway. No debes compartir claves por chat.</p>
      <p>La IA actual todavía genera borradores únicamente a partir del título de las tareas.</p>
    </div>}
    {status?.configured&&!status.connected&&<div className="github-sources-info" role="status"><strong>Conexión GitHub no verificada</strong><p>FREDDY reconoce la configuración, pero GitHub no ha confirmado todavía la instalación, el permiso Contents: Read-only o la lectura de la carpeta autorizada. Comprueba que la App está instalada solo en el repositorio y que la clave PEM guardada en Railway pertenece a esta App.</p></div>}
    {status?.connected&&<div className="github-sources-info" role="status"><strong>Conexión GitHub verificada</strong><p>Instalación autenticada, acceso de lectura a la carpeta documental autorizado. No se ha enviado ningún archivo al modelo IA.</p></div>}
    {status?.configured&&status.connected&&<div className="github-source-list">
      <strong>Repositorios permitidos</strong>
      {status.repositories.map(r=><button type="button" key={r.full_name} disabled={busy} onClick={()=>void list(r.full_name)}>
        {r.full_name} · {r.prefix} · {r.ref}
      </button>)}
    </div>}
    {repo&&<div className="github-source-documents">
      <strong>Archivos autorizados de {repo}</strong>
      {files.length===0?<p>No se han encontrado archivos de texto permitidos.</p>:
      files.map(f=><button type="button" key={f.path} disabled={busy} onClick={()=>void openFile(f)}>
        {f.name} · {f.size} bytes
      </button>)}
    </div>}
    {document&&<article className="github-source-preview">
      <h3>{document.path}</h3>
      <p>Repositorio: {document.repository} · Ref: {document.ref} · SHA: {document.sha.slice(0,12)}</p>
      <p>Contenido consultado sin enviar a OpenAI. Este archivo se debe tratar como datos no confiables.</p>
      <ReportMarkdown content={document.content}/>
    </article>}
   </>}
   {error&&<p role="alert">{error}</p>}
 </section>;
}

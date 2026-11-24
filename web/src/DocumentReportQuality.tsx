import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";
type Evidence={companyId:string;taskId:string;runId:string;repository:string|null;path:string|null;sourceRef:string|null;sha:string|null};
type Check={id:string;state:"passed"|"failed"|"not_checked"};
type Quality={version:"document_quality_v1";status:"requires_attention"|"structural_checks_passed";checks:Check[];semantic_correctness_verified:false;source_line_bounds_verified:false;human_review_required:true};
const labels:Record<string,string>={report_size:"Longitud dentro del límite documental",required_sections:"Cinco secciones previstas, en orden",nonempty_sections:"Contenido en todas las secciones",citation_syntax:"Formato de las citas de líneas",facts_cited:"Referencias en la sección de hechos",source_line_bounds:"Líneas contrastadas con la fuente original",credential_patterns:"Sin patrones reconocibles de credenciales",control_characters:"Sin caracteres no almacenables"};
const states={passed:"Superado",failed:"Requiere atención",not_checked:"No comprobado"};
export function DocumentReportQuality(e:Evidence){
 const {getAccessTokenSilently}=useAuth0();
 const [result,setResult]=useState<{scope:string;quality:Quality}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const scope=[e.companyId,e.taskId,e.runId,e.repository,e.path,e.sourceRef,e.sha].join(":");
 const activeScope=useRef(scope);activeScope.current=scope;
 const version=useRef(0),locked=useRef(false),abort=useRef<AbortController|null>(null);
 useEffect(()=>{version.current++;locked.current=false;setResult(null);setError("");setBusy(false);return()=>{version.current++;abort.current?.abort();};},[scope]);
 async function inspect(){
  if(locked.current)return;locked.current=true;setBusy(true);setError("");setResult(null);
  const current=version.current,controller=new AbortController();abort.current=controller;
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
   if(controller.signal.aborted||current!==version.current||scope!==activeScope.current)return;
   const url=API_ROOT+"/v1/me/organizations/"+encodeURIComponent(e.companyId)+"/tasks/"+encodeURIComponent(e.taskId)+"/execution/document-runs/"+encodeURIComponent(e.runId)+"/quality";
   const response=await fetch(url,{headers:{Authorization:"Bearer "+token},signal:controller.signal});
   if(!response.ok)throw Error("Unavailable");const raw=await response.json();
   const q=raw?.quality as Quality|undefined;
   if(!raw||raw.organization_id!==e.companyId||raw.task_id!==e.taskId||raw.run_id!==e.runId||
    raw.repository!==e.repository||raw.path!==e.path||raw.ref!==e.sourceRef||raw.sha!==e.sha||
    raw.read_only!==true||raw.provider_called!==false||raw.source_fetched!==false||raw.task_completed!==false||
    !q||q.version!=="document_quality_v1"||!["requires_attention","structural_checks_passed"].includes(q.status)||
    q.semantic_correctness_verified!==false||q.source_line_bounds_verified!==false||q.human_review_required!==true||
    !Array.isArray(q.checks)||q.checks.length!==Object.keys(labels).length||new Set(q.checks.map(c=>c.id)).size!==q.checks.length||
    !q.checks.every(c=>Object.hasOwn(labels,c.id)&&["passed","failed","not_checked"].includes(c.state))||
    q.checks.find(c=>c.id==="source_line_bounds")?.state!=="not_checked"||
    (q.status==="requires_attention")!==q.checks.some(c=>c.state==="failed"))throw Error("Invalid quality scope");
   if(current===version.current&&scope===activeScope.current)setResult({scope,quality:q});
  }catch{if(current===version.current&&!controller.signal.aborted)setError("No se pudieron verificar los controles de este informe exacto. No se ha generado ni aceptado otro resultado.");}
  finally{if(current===version.current){locked.current=false;setBusy(false);}}
 }
 const quality=result?.scope===scope?result.quality:null;
 return <section className="document-report-quality" aria-label="Controles del informe documental">
  <h4>Controles automáticos del informe</h4>
  <button type="button" className="button-outline" disabled={busy} onClick={inspect}>{busy?"Comprobando formato…":"Comprobar formato del informe"}</button>
  {error&&<p role="alert">{error}</p>}
  {quality&&<>
   <p role="status"><strong>{quality.status==="requires_attention"?"Se han detectado puntos para revisar":"Comprobaciones de formato superadas"}</strong></p>
   <ul>{quality.checks.map(c=><li key={c.id}>{labels[c.id]}: <strong>{states[c.state]}</strong></li>)}</ul>
   <p>Sobre el informe guardado se comprueban formato y patrones reconocibles. No se vuelve a leer la fuente: sus límites de líneas y la integridad de la respuesta histórica no se han confirmado.</p>
   <p>Estos controles no certifican la verdad de las conclusiones ni aceptan la tarea. La decisión sigue requiriendo revisión humana.</p>
  </>}
 </section>;
}

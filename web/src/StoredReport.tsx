import {DocumentReportQuality} from "./DocumentReportQuality";
import {DocumentWorkReview} from "./DocumentWorkReview";
import {useEffect, useState} from "react";
import {useAuth0} from "./auth";
import {ReportMarkdown} from "./ReportMarkdown";

export type ReportEvent={
 id:string;task_id:string;task_title:string;kind:"title_draft"|"document_analysis";
 repository:string|null;path:string|null;ref:string|null;sha:string|null;
};
type Stored={report:string;started_at:string;finished_at:string};
const api="https://api.tu-factoria.example/v1/me/organizations/";

// Mounted only on explicit inspection. The parent keys this component by company,
// task, kind and run; cleanup aborts requests and ignores late authentication/results.
export function StoredReport({companyId,event}:{companyId:string;event:ReportEvent}){
 const {getAccessTokenSilently}=useAuth0();
 const [result,setResult]=useState<Stored|null>(null);
 const [error,setError]=useState("");
 useEffect(()=>{
  const controller=new AbortController();
  let active=true;
  setResult(null);setError("");
  (async()=>{
   try{
    const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
    if(!active)return;
    const suffix=event.kind==="document_analysis"?"document-runs":"analysis-runs";
    const response=await fetch(api+encodeURIComponent(companyId)+"/tasks/"+encodeURIComponent(event.task_id)+"/execution/"+suffix,{
     headers:{Authorization:"Bearer "+token},signal:controller.signal,
    });
    if(!response.ok)throw Error("Unavailable");
    const rows:unknown=await response.json();
    if(!Array.isArray(rows))throw Error("Invalid history");
    const matches=rows.filter(r=>r&&r.id===event.id);
    if(matches.length!==1)throw Error("Exact run missing");
    const r=matches[0];
    if(r.state!=="completed"||typeof r.report!=="string"||!r.report.trim()||Array.from(r.report).length>6000||
     typeof r.started_at!=="string"||!Number.isFinite(Date.parse(r.started_at))||
     typeof r.finished_at!=="string"||!Number.isFinite(Date.parse(r.finished_at)))throw Error("Invalid report");
    if(event.kind==="document_analysis"){
     if(!event.sha||!/^[0-9a-f]{40}$/.test(event.sha)||
      !event.repository||!event.path||!event.ref||
      ["repository","path","ref","sha"].some(k=>r[k]!==event[k as keyof ReportEvent]))throw Error("Source mismatch");
    }else if(r.draft_from_title_only!==true)throw Error("Wrong kind");
    if(active)setResult({report:r.report,started_at:r.started_at,finished_at:r.finished_at});
   }catch{
    if(active)setError("No se pudo recuperar y verificar este informe exacto. Puede haber quedado fuera de los últimos 20 intentos de la tarea. Cierra y vuelve a consultar; no se ha generado otro informe.");
   }
  })();
  return ()=>{active=false;controller.abort();};
 },[companyId,event.id,event.task_id,event.kind,event.repository,event.path,event.ref,event.sha,getAccessTokenSilently]);
 return <section className="stored-report" aria-label="Informe guardado">
  <h3>Informe guardado</h3>
  <p>Tarea: <strong>{event.task_title}</strong></p>
  <p>Identificador del informe: <code>{event.id}</code></p>
  {event.kind==="document_analysis"?<p className="work-overview-source">Documento: {event.repository} / {event.path}<br/>Referencia: {event.ref}<br/>SHA completo: <code>{event.sha}</code></p>:
   <p>Este borrador se basa solo en el título de la tarea. No acredita haber leído documentos.</p>}
  {error&&<p role="alert">{error}</p>}
  {!error&&!result&&<p role="status">Consultando el informe guardado…</p>}
  {result&&<>
   <p>Inicio: {new Date(result.started_at).toLocaleString("es-ES")} · Finalización: {new Date(result.finished_at).toLocaleString("es-ES")}</p>
   <ReportMarkdown content={result.report}/>
   {event.kind==="document_analysis"&&<DocumentReportQuality key={companyId+":"+event.task_id+":"+event.id+":quality"} companyId={companyId} taskId={event.task_id} runId={event.id} repository={event.repository} path={event.path} sourceRef={event.ref} sha={event.sha}/>}
   <p>Comprueba las conclusiones, la evidencia utilizada y los puntos pendientes. Abrir el informe no cambia el estado de la tarea.</p>
   {event.kind==="document_analysis"&&<DocumentWorkReview key={companyId+":"+event.task_id+":"+event.id} companyId={companyId} taskId={event.task_id} runId={event.id}/>}
  </>}
 </section>;
}

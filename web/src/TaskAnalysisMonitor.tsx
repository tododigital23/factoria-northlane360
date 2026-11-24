import {useEffect,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";
import {ReportMarkdown} from "./ReportMarkdown";

type Run={id:string;state:string;report:string|null;error_code:string|null;started_at:string;finished_at:string|null;draft_from_title_only:boolean};

/** Monitoreo del borrador automático tras asignar un encargo (sin botones de autorizar). */
export function TaskAnalysisMonitor({organizationId,taskId}:{organizationId:string;taskId:string}){
 const {getAccessTokenSilently}=useAuth0();
 const [runs,setRuns]=useState<Run[]|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const url=API_ROOT+"/v1/me/organizations/"+encodeURIComponent(organizationId)+
  "/tasks/"+encodeURIComponent(taskId)+"/execution/analysis-runs";

 async function load(){
  setBusy(true);setError("");
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
   const r=await fetch(url,{headers:{Authorization:"Bearer "+token}});
   if(!r.ok)throw Error("HTTP "+r.status);
   const data:unknown=await r.json();
   if(!Array.isArray(data))throw Error("bad");
   setRuns(data as Run[]);
  }catch{setError("No se pudo leer el estado del análisis.");setRuns(null);}
  finally{setBusy(false);}
 }
 useEffect(()=>{void load();},[organizationId,taskId]);

 return <section className="task-analysis-monitor">
  <div className="analysis-run-heading"><strong>Progreso del encargo</strong><span>Monitoreo</span></div>
  {busy&&runs===null&&<p>Cargando…</p>}
  {error&&<p role="alert">{error}</p>}
  {runs&&runs.length===0&&<p role="status">Aún no hay borrador. Si acabas de asignar, espera unos segundos y actualiza; si el motor IA está apagado, no se generará solo.</p>}
  {runs&&runs.map(r=><article key={r.id} className="task-analysis-run">
   <div className="analysis-run-meta"><strong>{r.state}</strong><span>{new Date(r.started_at).toLocaleString("es-ES")}</span></div>
   {r.report&&<ReportMarkdown content={r.report}/>}
   {r.error_code&&<p>Motivo: {r.error_code}</p>}
  </article>)}
  <button type="button" className="button-outline" disabled={busy} onClick={()=>void load()}>{busy?"Actualizando…":"Actualizar"}</button>
 </section>;
}

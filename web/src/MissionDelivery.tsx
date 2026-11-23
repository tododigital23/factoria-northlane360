import {useEffect,useState} from 'react';
import {useAuth0} from "./auth";
import {ReportMarkdown} from './ReportMarkdown';
type Step={position:number;plan_id:string;task_id:string;task_title:string;worker_id:string;objective:string;job_id:string|null;run_id:string|null;repository:string;path:string;ref:string;sha:string};
type Mission={id:string;objective:string;steps:Step[]};
type Entry=Step&{report:string;started_at:string;finished_at:string;review:{id:string;decision:'accepted';reason:string;reviewed_at:string}};
type Delivery={organization_id:string;mission_id:string;objective:string;delivery_kind:'accepted_step_reports_v1';global_objective_verified:false;read_only:true;provider_called:false;source_fetched:false;task_completed:false;observed_at:string;accepted_steps:number;history_limits:{missions:20;runs_per_task:20;not_full_company_census:true};reports:Entry[]};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validDelivery(raw:unknown,org:string,m:Mission):raw is Delivery{
 if(!raw||typeof raw!=='object')return false;const r=raw as Delivery;
 if(r.organization_id!==org||r.mission_id!==m.id||r.objective!==m.objective||r.delivery_kind!=='accepted_step_reports_v1'||r.global_objective_verified!==false||r.read_only!==true||r.provider_called!==false||r.source_fetched!==false||r.task_completed!==false||!Number.isFinite(Date.parse(r.observed_at))||r.history_limits?.missions!==20||r.history_limits?.runs_per_task!==20||r.history_limits?.not_full_company_census!==true||!Array.isArray(r.reports)||r.reports.length!==m.steps.length||r.reports.length<2||r.reports.length>5||r.accepted_steps!==r.reports.length||new Set(r.reports.map(v=>v.run_id)).size!==r.reports.length)return false;
 return r.reports.every((v,i)=>{
  const s=m.steps[i];if(!v||!s||!['position','plan_id','task_id','task_title','worker_id','objective','job_id','run_id','repository','path','ref','sha'].every(k=>v[k as keyof Step]===s[k as keyof Step])||!v.run_id||!uuid.test(v.run_id)||typeof v.report!=='string'||!v.report.trim()||Array.from(v.report).length>6000||!Number.isFinite(Date.parse(v.started_at))||!Number.isFinite(Date.parse(v.finished_at))||Date.parse(v.finished_at)<Date.parse(v.started_at))return false;
  return v.review&&uuid.test(v.review.id)&&v.review.decision==='accepted'&&typeof v.review.reason==='string'&&Array.from(v.review.reason.trim()).length>=10&&Array.from(v.review.reason).length<=1000&&Number.isFinite(Date.parse(v.review.reviewed_at))&&Date.parse(v.review.reviewed_at)>=Date.parse(v.finished_at);
 });
}
export function MissionDelivery({companyId,mission}:{companyId:string;mission:Mission}){
 const {getAccessTokenSilently}=useAuth0(),[data,setData]=useState<Delivery|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;const c=new AbortController();setData(null);setError('');const timer=window.setTimeout(()=>c.abort(),12000);
  (async()=>{try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:'read:tasks'}});if(c.signal.aborted)throw Error('Aborted');
   const response=await fetch('https://api.tu-factoria.example/v1/me/organizations/'+encodeURIComponent(companyId)+'/execution/document-missions/'+encodeURIComponent(mission.id)+'/delivery',{headers:{Authorization:'Bearer '+token},signal:c.signal});if(!response.ok)throw Error('Unavailable');const raw:unknown=await response.json();
   if(!validDelivery(raw,companyId,mission))throw Error('Invalid delivery');if(active&&!c.signal.aborted)setData(raw);
  }catch{if(active)setError('No se pudo verificar el expediente completo. La misión o un informe exacto puede estar fuera de los últimos 20 registros consultables. No se ha creado otro informe ni aceptado trabajo.');}finally{window.clearTimeout(timer);}})();
  return()=>{active=false;c.abort();window.clearTimeout(timer);};
 },[companyId,mission.id,mission.objective,getAccessTokenSilently]);
 return <section className="stored-report" aria-label="Expediente de pasos aceptados"><h3>Expediente de pasos aceptados</h3>
  <p>Reúne los informes originales y la revisión humana de cada paso. La aceptación de estos pasos no acredita por sí sola que se haya cumplido el objetivo global. No se ha generado una síntesis nueva ni iniciado ejecuciones.</p>
  {error&&<p role="alert">{error}</p>}{!data&&!error&&<p role="status">Verificando informes y aceptaciones exactos…</p>}
  {data&&<><p>Objetivo de referencia: {data.objective} · {data.accepted_steps} pasos aceptados · Consulta {new Date(data.observed_at).toLocaleString('es-ES')}</p>
   {data.reports.map(r=><article key={r.run_id}><h4>Paso {r.position}: {r.task_title}</h4><p>{r.objective}</p><p>Documento: {r.repository} / {r.path} · Referencia {r.ref}<br/>SHA: <code>{r.sha}</code><br/>Trabajo: <code>{r.job_id}</code> · Informe: <code>{r.run_id}</code></p><ReportMarkdown content={r.report}/><p>Aceptación humana: {r.review.reason}<br/>{new Date(r.review.reviewed_at).toLocaleString('es-ES')} · Revisión <code>{r.review.id}</code></p></article>)}
   <p>Expediente consultado en este momento, sin nuevo registro de entrega ni nueva decisión sobre el objetivo global. Límites: últimas 20 misiones y últimos 20 informes por tarea. Ningún informe se sustituye por uno más reciente.</p>
  </>}
 </section>;
}

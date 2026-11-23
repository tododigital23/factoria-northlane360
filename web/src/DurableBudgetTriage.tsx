import {useEffect,useState} from "react";
import {useAuth0} from "./auth";

type Budget={
 organization_id:string;enabled:boolean;source:"postgresql";scope:"single_company";
 provider_invoice:boolean;reservations_active:boolean;
 day_utc?:string;calls_reserved?:number;estimated_token_units_reserved?:number;
 reported_input_tokens?:number;reported_output_tokens?:number;
 max_calls_per_day?:number;max_estimated_token_units_per_day?:number;
 reservation_units_are_estimates?:boolean;failed_attempts_still_count?:boolean;
};
type Incident={
 run_id:string;task_id:string;task_title:string;kind:string;state:string;
 reason_code:string|null;started_at:string;priority:string;
 suggested_manual_check:string;severity:"high"|"normal";next_action:string;repository:string|null;path:string|null;sha:string|null;
 automated_retry_allowed:boolean;another_model_call_started:boolean;status_changed:boolean;
};
type Triage={
 organization_id:string;read_only:boolean;has_executed_action:boolean;
 untrusted_provider_outcome_for_stale_runs:boolean;requires_owner_review:boolean;
 incident_count_in_view:number;message:string;incidents:Incident[];
 sample:{not_full_company_census:boolean;tasks_scanned:number;task_limit:number};
};
const root="https://api.tu-factoria.example/v1/me/organizations/";
function number(n:number|undefined){return typeof n==="number"?n.toLocaleString("es-ES"):"—";}

export function DurableBudgetTriage({companyId,role}:{companyId:string;role:string}){
 const {getAccessTokenSilently}=useAuth0();
 const [budget,setBudget]=useState<Budget|null>(null);
 const [triage,setTriage]=useState<Triage|null>(null);
 const [error,setError]=useState("");
 const [loading,setLoading]=useState(false);
 const [reload,setReload]=useState(0);
 useEffect(()=>{
  let cancelled=false;setBudget(null);setTriage(null);setError("");
  if(!companyId||role!=="owner")return;
  setLoading(true);
  (async()=>{
   try{
    const token=await getAccessTokenSilently({authorizationParams:{
     audience:"https://api.eliot.internal",scope:"read:tasks"
    }});
    const base=root+encodeURIComponent(companyId)+"/execution/";
    const get=async(path:string):Promise<unknown>=>{
     const response=await fetch(base+path,{headers:{Authorization:"Bearer "+token}});
     if(!response.ok)throw Error("HTTP "+response.status);
     return response.json();
    };
    const [rawBudget,rawTriage]=await Promise.all([
     get("durable-model-budget"),get("recovery-triage")
    ]);
    if(!rawBudget||typeof rawBudget!=="object"||!rawTriage||typeof rawTriage!=="object")
     throw Error("Invalid data");
    const b=rawBudget as Budget,t=rawTriage as Triage;
    if(b.organization_id!==companyId||b.source!=="postgresql"||
       b.scope!=="single_company"||b.provider_invoice!==false||
       typeof b.enabled!=="boolean"||typeof b.reservations_active!=="boolean"||
       (b.enabled&&(
        b.reservations_active!==true||typeof b.calls_reserved!=="number"||
        typeof b.max_calls_per_day!=="number"||
        typeof b.estimated_token_units_reserved!=="number"||
        typeof b.max_estimated_token_units_per_day!=="number"||
        b.reservation_units_are_estimates!==true||
        b.failed_attempts_still_count!==true
       ))||
       t.organization_id!==companyId||t.read_only!==true||
       t.has_executed_action!==false||t.requires_owner_review!==true||
       t.untrusted_provider_outcome_for_stale_runs!==true||
       t.sample?.not_full_company_census!==true||
       !Array.isArray(t.incidents)||
       !t.incidents.every(x=>x&&typeof x.run_id==="string"&&
         typeof x.task_title==="string"&&typeof x.priority==="string"&&
         ["high","normal"].includes(x.severity)&&
         ["verify_provider_and_database","review_failure_and_approval"].includes(x.next_action)&&
         x.automated_retry_allowed===false&&x.another_model_call_started===false&&
         x.status_changed===false))
       throw Error("Unexpected data contract");
    if(!cancelled){setBudget(b);setTriage(t);}
   }catch{
    if(!cancelled)setError("No se ha podido consultar el presupuesto o el diagnóstico. No se ha ejecutado ninguna acción.");
   }finally{if(!cancelled)setLoading(false);}
  })();
  return ()=>{cancelled=true;};
 },[companyId,role,getAccessTokenSilently,reload]);

 if(!companyId||role!=="owner")return null;
 return <section className="durable-budget-panel">
  <div className="durable-budget-head">
   <div><strong>Presupuesto persistente y diagnóstico</strong>
    <p>Datos por empresa · PostgreSQL · sin acciones automáticas</p></div>
   <button type="button" className="button-outline" disabled={loading}
    onClick={()=>setReload(n=>n+1)}>{loading?"Consultando…":"Actualizar"}</button>
  </div>
  {error&&<p role="alert">{error}</p>}
  {budget&&!budget.enabled&&<p role="status">El presupuesto persistente todavía no está habilitado para esta API.</p>}
  {budget?.enabled&&<>
   <div className="durable-budget-stats">
    <article><span>Reservas de hoy</span><strong>{number(budget.calls_reserved)} / {number(budget.max_calls_per_day)}</strong><small>UTC {budget.day_utc}</small></article>
    <article><span>Unidades estimadas reservadas</span><strong>{number(budget.estimated_token_units_reserved)}</strong><small>Máximo diario: {number(budget.max_estimated_token_units_per_day)}</small></article>
    <article><span>Tokens comunicados por proveedor</span><strong>{number((budget.reported_input_tokens??0)+(budget.reported_output_tokens??0))}</strong><small>Entrada y salida reconciliadas, no importe económico</small></article>
   </div>
   <p>Las reservas son persistentes, por empresa y día UTC. Los intentos fallidos también consumen reserva. Estas unidades son estimaciones y <strong>no representan una factura ni garantizan un importe en euros.</strong></p>
  </>}
  {triage&&<div className="durable-budget-incidents">
   <strong>Incidencias para revisión · {triage.incident_count_in_view}</strong>
   <p>Consulta parcial de {triage.sample.tasks_scanned} tareas; no incluye necesariamente todas las ejecuciones de la empresa.</p>
   {triage.incidents.length===0?<p>Sin incidentes detectados en la muestra.</p>:
    triage.incidents.map(x=><article key={x.run_id}>
     <div className="incident-priority-title"><strong>{x.task_title}</strong><span className={x.severity==="high"?"incident-high":"incident-normal"}>{x.severity==="high"?"Prioridad alta":"Revisión normal"}</span></div>
     <p>{x.kind==="document_analysis"?"Análisis documental":"Borrador por título"} · {x.state} · {new Date(x.started_at).toLocaleString("es-ES")}</p>
     {x.path&&<p>{x.repository} / {x.path} · SHA {x.sha?.slice(0,12)}…</p>}
     {x.reason_code&&<p>Error: {x.reason_code}</p>}
     <p>{x.suggested_manual_check}</p>
     <small>Sin reintento automático ni llamada nueva a OpenAI.</small>
    </article>)}
  </div>}
 </section>;
}

import {useEffect,useState} from "react";
import {useAuth0} from "./auth";

type ModelUsage={
 organization_id:string;
 read_only:boolean;measurement:"current_api_process";
 provider_billing:boolean;organization_wide_quota:boolean;
 persistent_across_restart:boolean;cross_replica_total:boolean;note:string;
 limits:{max_requests_per_minute_per_process:number;max_requests_per_day_per_process:number};
 today_local:{request_reservations:number;reported_input_tokens:number;reported_output_tokens:number};
};

export function ModelUsageLocal({companyId,role}:{companyId:string;role:string}){
 const {getAccessTokenSilently}=useAuth0();
 const [usage,setUsage]=useState<ModelUsage|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let cancelled=false;
  setUsage(null);setError("");
  if(!companyId||role!=="owner")return;
  setBusy(true);
  (async()=>{
   try{
    const token=await getAccessTokenSilently({authorizationParams:{
     audience:"https://api.eliot.internal",scope:"read:tasks"
    }});
    const response=await fetch(
     "https://api.tu-factoria.example/v1/me/organizations/"+
       encodeURIComponent(companyId)+"/execution/local-model-usage",
     {headers:{Authorization:"Bearer "+token}}
    );
    if(!response.ok)throw Error("Cannot load usage");
    const data:unknown=await response.json();
    if(!data||typeof data!=="object")throw Error("Invalid metrics");
    const info=data as ModelUsage;
    if(info.organization_id!==companyId||info.read_only!==true||
      info.measurement!=="current_api_process"||
      info.provider_billing!==false||info.organization_wide_quota!==false||
      info.persistent_across_restart!==false||info.cross_replica_total!==false||
      typeof info.limits?.max_requests_per_minute_per_process!=="number"||
      typeof info.limits?.max_requests_per_day_per_process!=="number"||
      typeof info.today_local?.request_reservations!=="number"||
      typeof info.today_local?.reported_input_tokens!=="number"||
      typeof info.today_local?.reported_output_tokens!=="number")
      throw Error("Untrusted metric schema");
    if(!cancelled)setUsage(info);
   }catch{
    if(!cancelled)setError("No ha sido posible consultar los contadores locales de esta empresa.");
   }finally{
    if(!cancelled)setBusy(false);
   }
  })();
  return ()=>{cancelled=true;};
 },[companyId,role,getAccessTokenSilently,refresh]);

 if(!companyId||role!=="owner")return null;
 return <section className="model-usage-local">
  <div className="model-usage-local-head">
   <div>
    <strong>Consumo observado del motor IA</strong>
    <p>Medición de este proceso API · no es la factura de OpenAI</p>
   </div>
   <button type="button" className="button-outline" disabled={busy} onClick={()=>setRefresh(x=>x+1)}>
    {busy?"Actualizando…":"Actualizar consumo"}
   </button>
  </div>
  {usage&&<>
   <div className="model-usage-local-stats">
    <article><span>Solicitudes reservadas hoy</span><strong>{usage.today_local.request_reservations}</strong><small>Límite del proceso: {usage.limits.max_requests_per_day_per_process}/día</small></article>
    <article><span>Tokens de entrada comunicados</span><strong>{usage.today_local.reported_input_tokens.toLocaleString("es-ES")}</strong><small>Solo respuestas registradas aquí</small></article>
    <article><span>Tokens de salida comunicados</span><strong>{usage.today_local.reported_output_tokens.toLocaleString("es-ES")}</strong><small>No incluye otros procesos</small></article>
   </div>
   <p>Límite de peticiones por minuto y proceso: <strong>{usage.limits.max_requests_per_minute_per_process}</strong>. Estos contadores se reinician al reiniciar la API y pueden diferir de los totales de otros servidores.</p>
   <p><strong>Importante:</strong> los datos no son un presupuesto garantizado, ni un total por empresa, ni un cálculo económico. La facturación y los topes globales deben verificarse en el proveedor.</p>
  </>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}

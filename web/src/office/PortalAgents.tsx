import {useEffect,useRef,useState} from "react";
import {orgUrl} from "./officeApi";
import type {TokenGetter} from "./officeApi";
import {cleanNotices,noticeCopy} from "../fabrica/notices";

/** Agentes que trabajan en el portal propio de la empresa (su web), vistos desde Freddy.
 *  Solo estados y cifras: los datos de los clientes se quedan en el portal y aquí no se guarda nada.
 *  Si la empresa no tiene portal conectado, o el servidor aún no ofrece esta lectura, no se pinta nada. */
type Counter=number|null;
export type PortalAgent={id:string;name:string;state:string;capability:string;model?:string;
 last_24h?:Record<string,Counter>;month?:{month:string|null;spent_usd:Counter;cap_usd:Counter;replies:Counter};
 alerts?:{urgentes:Counter;importantes:Counter;informativas:Counter};last_activity?:string;
 /** Avisos con su clave y sus referencias de pedido. Se limpian en fabrica/notices.ts antes de mostrarse. */ notices?:unknown};
export type PortalSummary={organization_id:string;configured:boolean;available:boolean;reason:string|null;panel_url:string|null;agents:PortalAgent[];
 generated_at?:string|null;watch?:{counting_since:string|null;last_scheduled_run:string|null}};

const STATES:Record<string,{label:string;tone:"on"|"off"|"warn"|"bad"}>={
 activo:{label:"Activo",tone:"on"},ok:{label:"Sin incidencias",tone:"on"},apagado:{label:"Apagado",tone:"off"},
 frenado:{label:"Frenado por tope de gasto",tone:"warn"},aviso:{label:"Con avisos",tone:"warn"},alerta:{label:"Alerta urgente",tone:"bad"},error:{label:"No pudo revisar",tone:"bad"}};
const DEPARTMENT:Record<string,string>={email:"Atención y Email",orders:"Pedidos",monitoring:"Monitorización y Fallos",marketing:"Marketing",
 seo:"SEO y Contenidos",automation:"Automatizaciones",repository:"Desarrollo",website:"Desarrollo"};
const REASON:Record<string,string>={portal_unreachable:"No se ha podido contactar con el portal.",portal_rejected_key:"El portal ha rechazado la clave de Freddy.",
 portal_error:"El portal ha devuelto un error.",portal_response_invalid:"El portal ha respondido algo que Freddy no reconoce.",portal_response_too_large:"La respuesta del portal es demasiado grande."};
const isCounter=(v:unknown):v is Counter=>v===null||(typeof v==="number"&&Number.isFinite(v)&&v>=0);
const isText=(v:unknown,max:number):v is string=>typeof v==="string"&&v.length>0&&v.length<=max;
const isNullableText=(v:unknown):v is string|null=>v===null||isText(v,80);
const counters=(v:unknown)=>v===undefined||(!!v&&typeof v==="object"&&Object.values(v as object).every(isCounter));

export function validPortalAgent(a:unknown):a is PortalAgent{
 if(!a||typeof a!=="object")return false;const x=a as Record<string,unknown>;
 if(!isText(x.id,30)||!isText(x.name,60)||!isText(x.state,20)||!isText(x.capability,20))return false;
 if(x.model!==undefined&&!isText(x.model,60))return false;
 if(!counters(x.last_24h)||!counters(x.alerts))return false;
 if(x.month!==undefined){const m=x.month as Record<string,unknown>;if(!m||typeof m!=="object"||!isNullableText(m.month)||!isCounter(m.spent_usd)||!isCounter(m.cap_usd)||!isCounter(m.replies))return false;}
 return x.last_activity===undefined||isText(x.last_activity,40);
}
export function validPortalSummary(raw:unknown,org:string):raw is PortalSummary{
 if(!raw||typeof raw!=="object")return false;const x=raw as Record<string,unknown>;
 if(x.organization_id!==org||typeof x.configured!=="boolean"||typeof x.available!=="boolean")return false;
 if(!(x.reason===null||isText(x.reason,40)))return false;
 if(!(x.panel_url===null||(isText(x.panel_url,300)&&/^https:\/\//.test(x.panel_url as string))))return false;
 return Array.isArray(x.agents)&&x.agents.length<=30&&x.agents.every(validPortalAgent);
}
type Loaded={state:"loading"}|{state:"hidden"}|{state:"ready";data:PortalSummary};
export async function loadPortalAgents(org:string,token:TokenGetter,signal:AbortSignal):Promise<Loaded>{
 try{const t=await token();if(signal.aborted)return {state:"hidden"};
  const r=await fetch(orgUrl(org,"portal-agents"),{headers:{Authorization:"Bearer "+t},signal});
  if(r.status!==200)return {state:"hidden"};
  const body:unknown=await r.json();
  return validPortalSummary(body,org)&&body.configured?{state:"ready",data:body}:{state:"hidden"};
 }catch{return {state:"hidden"};}
}
const n=(v:Counter|undefined)=>v===null||v===undefined?"—":String(v);
const money=(v:Counter|undefined)=>v===null||v===undefined?"—":v.toLocaleString("es-ES",{minimumFractionDigits:2,maximumFractionDigits:2})+" $";
function ago(iso:string|undefined,now:number){
 if(!iso)return null;const t=Date.parse(iso);if(!Number.isFinite(t))return null;
 const m=Math.max(0,Math.round((now-t)/60000));return m<1?"ahora mismo":m<90?`hace ${m} min`:m<48*60?`hace ${Math.round(m/60)} h`:`hace ${Math.round(m/1440)} días`;
}
function Card({a,now}:{a:PortalAgent;now:number}){
 const st=STATES[a.state]??{label:a.state,tone:"off" as const};const last=ago(a.last_activity,now);
 return <li className={"portal-agent tone-"+st.tone}>
  <div className="portal-agent-head"><strong>{a.name}</strong><span className="portal-agent-state"><i aria-hidden="true"/>{st.label}</span></div>
  <small>{DEPARTMENT[a.capability]??a.capability}{a.model?" · "+a.model:""}</small>
  {a.last_24h&&<p>Últimas 24 h: <b>{n(a.last_24h.respuestas)}</b> respuestas · <b>{n(a.last_24h.pasadas_al_dueno)}</b> pasadas a ti{a.last_24h.graves?<> (<b>{a.last_24h.graves}</b> graves)</>:null}{a.last_24h.gestiones?<> · <b>{a.last_24h.gestiones}</b> gestiones</>:null}{a.last_24h.sin_respuesta?<> · <b>{a.last_24h.sin_respuesta}</b> sin respuesta</>:null}</p>}
  {a.month&&<p>Este mes: <b>{money(a.month.spent_usd)}</b> de {money(a.month.cap_usd)} · {n(a.month.replies)} respuestas</p>}
  {a.alerts&&<p>{(a.alerts.urgentes||0)+(a.alerts.importantes||0)===0?"Nada pendiente":<><b>{n(a.alerts.urgentes)}</b> urgentes · <b>{n(a.alerts.importantes)}</b> importantes</>}</p>}
  {cleanNotices(a.notices).map(x=>{const [title,proposal]=noticeCopy(x.code,x.count,x);return <div key={x.code} className={"portal-agent-notice lv-"+x.level}>
   <strong>{title}</strong>{x.refs.length>0&&<p className="notice-refs">{x.refs.map(r=><code key={r}>{r}</code>)}{x.count!==null&&x.count>x.refs.length&&<span> y {x.count-x.refs.length} más</span>}</p>}{proposal&&<p>{proposal}</p>}</div>;})}
  {last&&<small>Última respuesta {last}</small>}
 </li>;
}
export function PortalAgents({organizationId,token,now=Date.now(),onSummary}:{organizationId:string;token:TokenGetter;now?:number;/** Cada lectura del portal (o null si no hay), para sumar sus avisos a «Te toca». */ onSummary?:(s:PortalSummary|null)=>void}){
 const [loaded,setLoaded]=useState<Loaded>({state:"loading"});
 useEffect(()=>{const a=new AbortController();setLoaded({state:"loading"});
  const run=()=>{void loadPortalAgents(organizationId,token,a.signal).then(v=>{if(!a.signal.aborted)setLoaded(v);});};
  run();const timer=window.setInterval(()=>{if(document.visibilityState!=="hidden")run();},120000);
  return()=>{a.abort();window.clearInterval(timer);};
 },[organizationId,token]);
 const tell=useRef(onSummary);tell.current=onSummary;
 useEffect(()=>{tell.current?.(loaded.state==="ready"?loaded.data:null);},[loaded]);
 if(loaded.state!=="ready")return null;
 const d=loaded.data;const working=d.agents.filter(a=>a.state==="activo"||a.state==="ok"||a.state==="aviso"||a.state==="alerta").length;
 return <section className="portal-agents" aria-label="Agentes del portal">
  <div className="portal-agents-head">
   <div><h2>Agentes del portal</h2><p>Trabajan en la web de la empresa. Aquí solo llegan cifras: los datos de tus clientes se quedan en el portal.</p></div>
   {d.panel_url&&<a className="office-secondary" href={d.panel_url} target="_blank" rel="noopener noreferrer">Abrir el panel del portal ↗</a>}
  </div>
  {!d.available&&<p className="office-alert" role="alert">{REASON[d.reason??""]??"El portal no está disponible ahora mismo."} Se vuelve a intentar solo.</p>}
  {d.available&&d.agents.length===0&&<p className="office-empty" role="status">El portal no ha informado de ningún agente.</p>}
  {d.available&&d.agents.length>0&&<><p className="portal-agents-count" role="status">{working} de {d.agents.length} en marcha</p>
   <ul className="portal-agents-list">{d.agents.map(a=><Card key={a.id} a={a} now={now}/>)}</ul></>}
 </section>;
}

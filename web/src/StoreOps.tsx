import {useCallback,useEffect,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";
import type {HoldingCompany} from "./holdingApi";

const READ={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}};

type Connector={kind:string;label:string;status:string;host:string};
const isLocalHost=(h:string)=>/^(localhost|127\.0\.0\.1|::1)(:\d+)?$/i.test((h||"").trim());
type Agent={id:string;name:string;state:string;capability:string;notices?:{level:string;code:string;count:number|null;refs:string[]}[]};
type Portal={available:boolean;configured:boolean;reason?:string|null;agents:Agent[];queries:string[];company?:string};

const OPS=[
 {title:"Pedidos",text:"Detecta pedidos cobrados que no avanzan y cobros fallidos. Los urgentes te llegan al momento (campus y Telegram)."},
 {title:"Problemas",text:"Vigila fallos abiertos de la tienda. Tú priorizas; Freddy avisa y propone el siguiente paso."},
 {title:"Chats y atención",text:"Señala mensajes o tickets pendientes para que no se queden sin respuesta."},
 {title:"Mejora continua",text:"Freddy propone mejoras de sistema (settings, fichero FTP o tarea). Solo las aplica si respondes «sí» en Telegram. Escribe «mejora» al bot."},
 {title:"Reporte diario",text:"Cada noche (~21:00 Madrid) Telegram resume ventas del día e incidencias; si hay señal, puede proponer una mejora pendiente de «sí»."},
];

function validPortal(raw:unknown):raw is {available:boolean;configured:boolean;agents:unknown[];queries?:unknown[];company?:string;reason?:string|null}{
 return typeof raw==="object"&&raw!==null&&typeof (raw as {available?:unknown}).available==="boolean"
  &&typeof (raw as {configured?:unknown}).configured==="boolean"&&Array.isArray((raw as {agents?:unknown}).agents);
}

export function StoreOps({company,canEdit}:{company:HoldingCompany;canEdit:boolean}){
 const {getAccessTokenSilently}=useAuth0();
 const org=company.organization_id;
 const [connectors,setConnectors]=useState<Connector[]>([]);
 const [portal,setPortal]=useState<Portal|{state:"loading"|"unavailable"|"error"}>({state:"loading"});
 const [note,setNote]=useState("");

 const load=useCallback(async(signal?:AbortSignal)=>{
  const token=await getAccessTokenSilently(READ);
  const headers={Authorization:"Bearer "+token};
  const base=API_ROOT+"/v1/me/organizations/"+encodeURIComponent(org);
  try{
   const c=await fetch(base+"/connectors",{headers,signal});
   if(c.ok){
    const raw:unknown=await c.json();
    const list=typeof raw==="object"&&raw&&Array.isArray((raw as {connectors?:unknown}).connectors)?(raw as {connectors:Connector[]}).connectors:[];
    setConnectors(list.filter(x=>typeof x==="object"&&x&&typeof x.kind==="string"));
   }
  }catch{/* ignore */}
  try{
   const r=await fetch(base+"/portal-agents",{headers,signal});
   if(signal?.aborted)return;
   if(r.status===404||r.status===503){setPortal({state:"unavailable"});return;}
   if(!r.ok){setPortal({state:"error"});return;}
   const raw:unknown=await r.json();
   if(!validPortal(raw)){setPortal({state:"error"});return;}
   const agents=(raw.agents as unknown[]).filter((a):a is Agent=>typeof a==="object"&&!!a&&typeof (a as Agent).id==="string"&&typeof (a as Agent).name==="string");
   const queries=Array.isArray(raw.queries)?raw.queries.filter((q):q is string=>typeof q==="string"):[];
   setPortal({available:raw.available,configured:raw.configured,reason:raw.reason??null,agents,queries,company:typeof raw.company==="string"?raw.company:undefined});
   setNote(raw.configured&&!raw.available?"La base está enlazada pero la consulta ha fallado. Revisa tablas o el perfil de tienda.":"");
  }catch{if(!signal?.aborted)setPortal({state:"error"});}
 },[getAccessTokenSilently,org]);

 useEffect(()=>{const a=new AbortController();void load(a.signal);return()=>a.abort();},[load]);

 const hasDb=connectors.some(c=>["mysql","mariadb","postgresql","mssql","mongodb"].includes(c.kind)&&c.status==="configured");
 const hasFtp=connectors.some(c=>(c.kind==="ftp"||c.kind==="ftps")&&c.status==="configured");
 const dbLocal=connectors.some(c=>["mysql","mariadb","postgresql","mssql","mongodb"].includes(c.kind)&&c.status==="configured"&&isLocalHost(c.host));
 const caps=new Set(company.capabilities.filter(c=>c.state!=="disabled").map(c=>c.capability));
 const ready=hasDb&&!dbLocal&&(caps.has("orders")||caps.has("monitoring")||caps.has("email"));

 return <div className="store-ops">
  <p>Centro de mando de la tienda: pedidos, problemas, atención y el informe de cada día. GitHub es opcional; lo importante es la base de datos (y el FTP si quieres tocar archivos).</p>

  <div className="integration-form" style={{marginBottom:"1rem"}}>
   <p><strong>Estado</strong></p>
   <ul className="integration-list">
    <li>Base de datos: {hasDb?(dbLocal?"guardada con localhost (hay que corregir el host)":"conectada"):"falta conectar en «Hosting y bases»"}</li>
    <li>FTP/FTPS: {hasFtp?"conectado":"opcional"}</li>
    <li>Capacidades: {[...caps].filter(c=>["orders","monitoring","email","website"].includes(c)).join(", ")||"activa Pedidos, Fallos o Email en el perfil"}</li>
    <li>Vigilancia en vivo: {"available" in portal&&portal.available?"activa":("configured" in portal&&portal.configured?"enlazada, sin datos":"aún no lee la tienda")}</li>
   </ul>
   {dbLocal&&canEdit&&<p className="wizard-error">La base está guardada como <strong>localhost</strong>. En «Hosting y bases» pulsa <strong>Usar host del FTP</strong> en la fila MySQL, luego vuelve y Actualizar estado.</p>}
   {!ready&&!dbLocal&&canEdit&&<p className="wizard-error">Para arrancar: 1) guarda la base en Hosting y bases · 2) marca Pedidos (y si quieres Fallos / Email) en el perfil · 3) vuelve aquí y pulsa Actualizar.</p>}
   <button type="button" className="campus-ghost" onClick={()=>{setPortal({state:"loading"});void load();}}>Actualizar estado</button>
  </div>

  <h3>Qué gestiona Freddy</h3>
  <ul className="integration-list">{OPS.map(o=><li key={o.title}><b>{o.title}</b> — {o.text}</li>)}</ul>

  <h3>Avisos ahora</h3>
  {"state" in portal&&portal.state==="loading"&&<p>Consultando la tienda…</p>}
  {"state" in portal&&portal.state==="unavailable"&&<p>La vigilancia de tienda aún no está disponible en el servidor.</p>}
  {"state" in portal&&portal.state==="error"&&<p>No se ha podido leer el estado de la tienda. Comprueba el conector de base y pulsa Actualizar.</p>}
  {"available" in portal&&portal.available&&<>
   {portal.agents.length===0?<p>Sin agentes de vigilancia todavía. Suele ser perfil de tienda incorrecto (WooCommerce/HPOS) o consultas que no encajan con las tablas. Pulsa Actualizar tras un redeploy; si sigue vacío, revisa el host MySQL y que no sea solo localhost.</p>:
    <ul className="integration-list">{portal.agents.map(a=><li key={a.id}>
     <b>{a.name}</b> · {a.state} · {a.capability}
     {a.notices&&a.notices.length>0&&<ul>{a.notices.map(n=><li key={a.id+n.code}>{n.level}: {n.code}{n.count!=null?" · "+n.count:""}{n.refs.length?" · "+n.refs.join(", "):""}</li>)}</ul>}
    </li>)}</ul>}
   {portal.queries.includes("ventas")&&<p>Consulta de ventas del día lista para el <strong>reporte diario</strong> (Telegram a las 21:00 hora Madrid, si el bot está configurado).</p>}
  </>}

  <h3>Mejora cada día</h3>
  <ol className="integration-list">
   <li>En <b>Tareas recurrentes</b>, activa «Revisión diaria de pedidos», «Control diario de fallos» y «Clasificación diaria del email».</li>
   <li>En <b>La ciudad</b>, mira la campana de Freddy: ahí se administran los avisos (olvidar cuando esté resuelto).</li>
   <li>En Telegram (si está enlazado): <code>estado</code>, <code>avisos</code>, <code>mejora</code>, <code>pedido ab-ORD-123</code>.</li>
   <li>Cada noche llega el resumen; las mejoras solo se aplican si respondes <code>sí</code>.</li>
  </ol>
  {note&&<p role="status">{note}</p>}
 </div>;
}

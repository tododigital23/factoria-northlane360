/**
 * Arnés de previsualización SOLO para desarrollo (preview-campus.html).
 * No lo importa main.tsx ni index.html, así que no entra en el build de producción.
 * Simula la API del holding con datos de ejemplo claramente rotulados y no toca Auth0 real.
 */
import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {Auth0Context} from "@auth0/auth0-react";
import type {Auth0ContextInterface} from "@auth0/auth0-react";
import {LoginIntro} from "../intro/LoginIntro";
import {FreddyCampus} from "../FreddyCampus";
import App from "../App";
import {HOLDING_URL,departmentsFor} from "../holdingApi";
import type {Capability,HoldingCompany} from "../holdingApi";
import "../style.css";
import "../office/theme.css";
import "../office/system.css";
import {CompanyOffice} from "../office/CompanyOffice";
import {MOCK_ORG,mockMemory,mockOverview,mockRequests,mockTasks} from "./officeMock";

const params=new URLSearchParams(location.search);
const count=Math.max(0,Math.min(5,Number(params.get("n")??"3")));
const sample:HoldingCompany[]=[
 {organization_id:"org-1",name:"Tienda Aurora",slot:1,project_name:"Tienda online de cerámica",project_summary:"Comercio electrónico con pedidos, atención por email y SEO local.",repository:"nova/aurora-shop",website_url:"https://aurora.example.com",capabilities:[{capability:"repository",state:"enabled"},{capability:"website",state:"enabled"},{capability:"seo",state:"configured"},{capability:"orders",state:"planned"},{capability:"email",state:"planned"}],departments:9,workers:9,active_workers:5,tasks:{pending:7,blocked:1,completed:4,other:0},routines_active:2,missions:1,autopilots_active:1,created_at:"2026-10-01T10:00:00Z"},
 {organization_id:"org-2",name:"Clínica Norte",slot:2,project_name:"Web de citas",project_summary:"Web de reservas con control automático de fallos.",repository:null,website_url:"https://clinica.example.com",capabilities:[{capability:"website",state:"configured"},{capability:"monitoring",state:"planned"}],departments:7,workers:7,active_workers:0,tasks:{pending:2,blocked:0,completed:0,other:0},routines_active:0,missions:0,autopilots_active:0,created_at:"2026-10-05T10:00:00Z"},
 {organization_id:"org-3",name:"Estudio Faro",slot:4,project_name:"Marketing digital",project_summary:"Campañas, contenidos y automatizaciones para clientes.",repository:"nova/faro",website_url:null,capabilities:[{capability:"marketing",state:"enabled"},{capability:"automation",state:"configured"}],departments:7,workers:7,active_workers:3,tasks:{pending:3,blocked:0,completed:1,other:1},routines_active:1,missions:0,autopilots_active:0,created_at:"2026-10-09T10:00:00Z"},
 {organization_id:"org-4",name:"Logística Delta",slot:3,project_name:"Panel de pedidos",project_summary:"Seguimiento de pedidos y lectura de email de proveedores.",repository:"nova/delta",website_url:null,capabilities:[{capability:"orders",state:"enabled"},{capability:"email",state:"enabled"},{capability:"repository",state:"enabled"}],departments:8,workers:8,active_workers:8,tasks:{pending:0,blocked:0,completed:12,other:0},routines_active:3,missions:2,autopilots_active:0,created_at:"2026-10-12T10:00:00Z"},
 {organization_id:"org-5",name:"Academia Lumen",slot:5,project_name:"Cursos en línea",project_summary:"Plataforma de cursos con SEO y email.",repository:"nova/lumen",website_url:"https://lumen.example.com",capabilities:[{capability:"seo",state:"enabled"},{capability:"email",state:"configured"},{capability:"repository",state:"enabled"}],departments:8,workers:8,active_workers:2,tasks:{pending:5,blocked:2,completed:0,other:0},routines_active:0,missions:1,autopilots_active:1,created_at:"2026-10-15T10:00:00Z"}
];
// ?llc=1: nombra dos empresas como la matriz y el portal, para ver el logo con bandera.
if(params.get("llc")==="1"){sample[0].name="Nova Demo Portal";sample[1].name="Nova Demo LLC";sample[1].website_url=null;}
const holding={id:"holding-demo",name:"Nova Holding (demo)",max_companies:5,is_owner:true,companies:sample.slice(0,count)};
const storage={connected:params.get("almacen")==="conectado"};
const hired=new Set<string>();
const restDemo:{on:boolean;since:string|null}={on:params.get("descanso")==="1",since:params.get("descanso")==="1"?new Date().toISOString():null};
const viewersDemo={viewers:[{id:"v-1",label:"Gestor",since:"2026-11-18T10:00:00Z"}],invites:[] as {id:string;label:string;expires_at:string}[]};
let liveCalls=0,officeCalls=0,noticeCalls=0;
const realFetch=window.fetch.bind(window);
window.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
 const url=String(input instanceof Request?input.url:input);
 if(/\/v1\/me\/access$/.test(url))return params.get("acceso")==="caido"?new Response("{}",{status:503}):new Response(JSON.stringify({read_only:params.get("lector")==="1",allowed:params.get("acceso")!=="no"}),{status:200});
 if(/\/v1\/me\/organizations$/.test(url))return new Response(JSON.stringify([{id:MOCK_ORG,name:"Tienda Aurora",role:"owner"}]),{status:200});
 // Vista de la oficina: la empresa de ejemplo aún no tiene «Fallos» ni «Automatizaciones», para ver los agentes por crear.
 if(url===HOLDING_URL&&params.get("view")==="office")return new Response(JSON.stringify({enabled:true,holdings:[{id:"h-demo",name:"Holding de ejemplo",max_companies:5,is_owner:true,companies:[{organization_id:MOCK_ORG,name:"Tienda Aurora",slot:1,project_name:"Tienda online",project_summary:"Venta de cerámica con pedidos.",repository:null,website_url:null,
  capabilities:["seo","email","orders"].map(c=>({capability:c,state:"enabled"})),departments:9,workers:9,active_workers:5,tasks:{pending:2,blocked:1,completed:3,other:0},routines_active:0,missions:0,autopilots_active:0,created_at:"2026-10-01T10:00:00Z"}]}]}),{status:200});
 if(url===HOLDING_URL){
  if(params.get("mode")==="unavailable")return new Response("{}",{status:503});
  // ?live=1: cada consulta simula que una empresa recibe o termina un trabajo, para poder ver los drones sin un servidor real.
  if(params.get("live")==="1"&&holding.companies.length&&++liveCalls>1){const c=holding.companies[Math.floor(Math.random()*holding.companies.length)];
   if(Math.random()<.6)c.tasks.pending++;else if(c.tasks.pending>0){c.tasks.pending--;c.tasks.completed++;}}
  return new Response(JSON.stringify({enabled:true,holdings:[holding]}),{status:200});
 }
 // Almacén cifrado y nombre del holding (037), simulados: nunca se llama al servidor real desde la vista previa.
 const store=url.match(/\/v1\/me\/holding\/([^/]+)\/(storage(?:\/.*)?|name)$/);
 if(store){
  const j=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});const path=store[2],id=holding.id;
  if(params.get("almacen")==="off")return j({},503);
  if(path==="storage"&&(!init?.method||init.method==="GET"))return j({holding_id:id,provider:"google_drive",encrypted_before_upload:true,enabled:true,server_configured:params.get("almacen")!=="sinconfig",connected:storage.connected,connected_at:storage.connected?"2026-11-20T09:00:00Z":null,companies_with_storage:storage.connected?2:0});
  if(path==="storage/google/start")return j({holding_id:id,authorization_url:"https://accounts.google.com/o/oauth2/v2/auth?client_id=demo&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&state=demo"});
  if(path==="storage/test")return j({holding_id:id,ok:true,reason:null,uploaded:true,stored_unreadable:true,downloaded_and_verified:true,deleted:true});
  if(path==="storage/disconnect"){storage.connected=false;return j({holding_id:id,connected:false,removed:true});}
  if(path==="name"){const b=JSON.parse(String(init?.body));const used=b.name.toLowerCase()==="repetido";if(used)return j({},409);holding.name=b.name;return j({holding_id:id,name:b.name,renamed:true});}
 }
 const vw=url.match(/\/v1\/me\/holding\/[^/]+\/viewers(\/invites|\/([^/]+)\/revoke)?$/);
 if(vw){
  const j=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
  if(params.get("lector")==="1")return j({},403);
  if(!vw[1])return j({holding_id:holding.id,invite_hours:72,viewers:viewersDemo.viewers,invites:viewersDemo.invites});
  if(vw[1]==="/invites"){const b=JSON.parse(String(init?.body));const inv={id:"inv-"+Date.now(),label:b.label,expires_at:new Date(Date.now()+72*3600e3).toISOString()};viewersDemo.invites.push(inv);
   return j({holding_id:holding.id,invite_id:inv.id,label:inv.label,expires_at:inv.expires_at,token:"DEMOdemoDEMOdemoDEMOdemoDEMOdemoDEMOdemo123"},201);}
  viewersDemo.viewers=viewersDemo.viewers.filter(x=>x.id!==vw[2]);viewersDemo.invites=viewersDemo.invites.filter(x=>x.id!==vw[2]);return j({holding_id:holding.id,id:vw[2],kind:"viewer",revoked:true});
 }
 if(url.startsWith(HOLDING_URL+"/")&&init?.method==="POST"){
  const body=JSON.parse(String(init.body));const used=new Set(holding.companies.map(c=>c.slot));const slot=[1,2,3,4,5].find(s=>!used.has(s))!;
  const deps=departmentsFor(body.capabilities as Capability[]).map((name,i)=>({id:"dep-"+i,name}));
  holding.companies.push({organization_id:"org-new-"+slot,name:body.name,slot,project_name:body.project_name,project_summary:body.project_summary,repository:body.repository,website_url:body.website_url,capabilities:body.capabilities.map((c:Capability)=>({capability:c,state:"planned"})),departments:deps.length,workers:deps.length,active_workers:0,tasks:{pending:0,blocked:0,completed:0,other:0},routines_active:0,missions:0,autopilots_active:0,created_at:new Date().toISOString()});
  return new Response(JSON.stringify({holding_id:holding.id,organization_id:"org-new-"+slot,slot,replayed:false,departments:deps,workers_created:deps.length,provider_called:false}),{status:201});
 }
 const office=url.match(/\/v1\/me\/organizations\/([^/]+)\/(.+)$/);
 if(office&&decodeURIComponent(office[1])===MOCK_ORG){
  const path=office[2],json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
  const off=params.get("extras")==="off";
  const hireM=path.match(/^workers\/([^/]+)\/availability$/);
  if(hireM&&init?.method==="POST"){hired.add(decodeURIComponent(hireM[1]));return json({ok:true});}
  if(path==="execution/office-overview"&&(hired.size||params.get("paro"))){const o=mockOverview() as {workers:{id:string;recorded_state:string;phase:string}[]};
   const all=params.get("paro")==="todos";o.workers.forEach((w,i)=>{const off=(all||i%2===1||w.recorded_state==="inactive")&&!hired.has(w.id);if(off){Object.assign(w,{recorded_state:"inactive",phase:"inactive",job_id:null,task_id:null,task_title:null,animation_until:null});}else if(w.recorded_state==="inactive"){w.recorded_state="idle";w.phase="available";}});return json(o);}
  if(path==="break"){if(init?.method==="POST"){restDemo.on=JSON.parse(String(init.body)).on;restDemo.since=restDemo.on?new Date().toISOString():null;}
   return json({organization_id:MOCK_ORG,available:true,on_break:restDemo.on,since:restDemo.since,...(init?.method==="POST"?{changed:true}:{})});}
  if(path==="execution/office-overview")return json(mockOverview());
  if(path==="tasks"){const list=mockTasks() as {id:string;department_id:string;assignee_worker_id:string;title:string;status:string;created_at:string}[];
   // ?live=1: en cada consulta un agente recibe un encargo y, dos consultas después, lo termina (solo en esta vista previa).
   if(params.get("live")==="1"){officeCalls++;const who=list.filter(t=>t.assignee_worker_id);
    for(let k=1;k<officeCalls;k++){const w=who[(k*3)%who.length];list.push({id:"live-"+k,department_id:w.department_id,assignee_worker_id:w.assignee_worker_id,title:"Encargo de prueba "+k,status:officeCalls-k>=2?"completed":"pending",created_at:new Date().toISOString()});}}
   // Un par de cosas esperando al propietario, para ver los globos rojos y «Te toca».
   const quien=list.filter(t=>t.assignee_worker_id);if(quien.length>3){list.push({id:"need-1",department_id:quien[1].department_id,assignee_worker_id:quien[1].assignee_worker_id,title:"Decidir el presupuesto de la campaña",status:"blocked",created_at:new Date().toISOString()},
    {id:"need-2",department_id:quien[3].department_id,assignee_worker_id:quien[3].assignee_worker_id,title:"Confirmar el texto de la portada",status:"blocked",created_at:new Date().toISOString()});}
   return json(list);}
  if(path==="eliot/chat"&&init?.method==="POST"){const b=JSON.parse(String(init.body));return json({answer:"Ahora mismo tengo una tarea abierta y otra esperando tu decisión. En cuanto me confirmes el presupuesto, sigo.",mode:"verified_data",read_only:true,intents:[],context_intent:null,organization_id:MOCK_ORG,organization_name:"Tienda Aurora",worker_id:b.worker_id});}
  if(path==="task-requests")return off?json({},404):json(mockRequests());
  if(path==="portal-agents")return json({organization_id:MOCK_ORG,stored_in_freddy:false,configured:false,available:false,reason:"not_configured",panel_url:null,agents:[]});
  if(path==="memory")return off?json({},503):json(mockMemory);
  const mem=path.match(/^memory\/(.+)$/);if(mem&&init?.method==="POST"){const b=JSON.parse(String(init.body));const items=mockMemory.items.filter(i=>i.key!==mem[1]);items.push({key:mem[1],content:b.content,updated_at:new Date().toISOString()});mockMemory.items=items;return json({organization_id:MOCK_ORG,key:mem[1],updated:true});}
  const req=path.match(/^workers\/([^/]+)\/requests$/);if(req&&init?.method==="POST"){const b=JSON.parse(String(init.body));return json({organization_id:MOCK_ORG,worker_id:decodeURIComponent(req[1]),task_id:"ffffffff-0000-4000-8000-000000000001",department_id:"d",title:b.request.slice(0,60),status:"pending",replayed:false,execution_started:false},201);}
 }
 const org=url.match(/\/v1\/me\/organizations\/([^/]+)\/(.+)$/);
 if(org){
  if(params.get("mode")==="unavailable"||params.get("mgmt")==="off")return new Response("{}",{status:503});
  const [,id,path]=org;const c=holding.companies.find(x=>x.organization_id===decodeURIComponent(id));
  const deps=departmentsFor((c?.capabilities??[]).map(k=>k.capability)).map((name,i)=>({id:id+"-d"+i,name}));
  const workers=deps.map((d,i)=>({id:id+"-w"+i,department_id:d.id,name:"Agente de "+d.name,specialty:d.name,state:i<2?"idle":"inactive"}));
  const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
  if(path==="retire"&&init?.method==="POST"&&c){const b=JSON.parse(String(init.body));if(b.confirm_name!==c.name)return json({},409);holding.companies.splice(holding.companies.indexOf(c),1);return json({organization_id:c.organization_id,name:c.name,slot:c.slot,retired:true,routines_paused:0});}
  if(path==="name"&&init?.method==="POST"&&c){const b=JSON.parse(String(init.body));if(holding.companies.some(x=>x!==c&&x.name.toLowerCase()===b.name.toLowerCase()))return json({},409);c.name=b.name;return json({organization_id:c.organization_id,name:b.name,renamed:true});}
  // Avisos de los agentes del portal de la primera empresa; con ?avisos=resuelve, el urgente desaparece a la tercera consulta.
  if(path==="portal-agents"){const first=holding.companies[0]?.organization_id===decodeURIComponent(id);if(!first||params.get("avisos")==="no")return json({organization_id:decodeURIComponent(id),stored_in_freddy:false,configured:false,available:false,reason:"not_configured",panel_url:null,agents:[]});
   const solved=params.get("avisos")==="resuelve"&&++noticeCalls>2;
   return json({organization_id:decodeURIComponent(id),stored_in_freddy:false,configured:true,available:true,reason:null,panel_url:"https://portal.example.com/admin/clients.html",generated_at:new Date().toISOString(),agents:[
    {id:"cobros",name:"Vigilante de cobros",state:solved?"ok":"alerta",capability:"orders",alerts:{urgentes:solved?0:1,importantes:0,informativas:0},notices:solved?[]:[{level:"urgente",code:"parciales",count:3,refs:["ab-ORD-1370","ab-ORD-1373","ab-ORD-1378-C"]}]},
    {id:"sin_cobrar",name:"Vigilante de servicio sin cobrar",state:"aviso",capability:"monitoring",alerts:{urgentes:0,importantes:1,informativas:0},notices:[{level:"importante",code:"pruebas_vivas",count:1,refs:["free-ORD-1376"]}]},
    {id:"soporte",name:"Vigilante de soporte",state:"ok",capability:"email",alerts:{urgentes:0,importantes:0,informativas:1},notices:[{level:"info",code:"chat",count:2,refs:[]}]}]});}
  if(path==="departments")return json(deps);
  if(path==="workers")return json(workers);
  if(path==="routines"&&init?.method!=="POST")return json({enabled:true,routines:demoRoutines.filter(r=>r.org===id).map(({org:_o,...r})=>r)});
  if(path==="routines"){const b=JSON.parse(String(init!.body));const d=deps.find(x=>x.id===b.department_id)!,w=workers.find(x=>x.id===b.worker_id)!;demoRoutines.push({org:id,id:"r-"+demoRoutines.length,department_id:d.id,department:d.name,worker_id:w.id,worker:w.name,title:b.title,instructions:b.instructions,cadence:b.cadence,capability:b.capability,state:"active",created_at:new Date().toISOString(),last_period:null,runs:0});if(c)c.routines_active++;return json({organization_id:id,routine_id:"r-"+(demoRoutines.length-1),execution_started:false},201);}
  if(path==="routines/run-due")return json({organization_id:id,tasks_created:2,execution_started:false});
  const ctl=path.match(/^routines\/([^/]+)\/control$/);if(ctl){const r=demoRoutines.find(x=>x.id===ctl[1])!;r.state=JSON.parse(String(init!.body)).state;return json({organization_id:id,routine_id:r.id,state:r.state});}
  if(path==="profile"){const b=JSON.parse(String(init!.body));if(c)Object.assign(c,b);return json({organization_id:id,updated:true});}
  const cap=path.match(/^capabilities\/(.+)$/);if(cap&&c){const state=JSON.parse(String(init!.body)).state;const k=c.capabilities.find(x=>x.capability===cap[1]);if(k)k.state=state;else c.capabilities.push({capability:cap[1] as Capability,state});return json({organization_id:id,capability:cap[1],state,departments_created:k?0:state==="planned"?1:0,connector_enabled:false});}
  if(path==="agent-messages")return json({organization_id:id,enabled:true,same_company_only:true,messages:[
   {id:"m1",from_worker_id:id+"-w0",from_worker:"Agente de Dirección IA",to_worker_id:id+"-w1",to_worker:"Agente de Desarrollo",task_id:"t-17",body:"Revisa el informe del repositorio antes del viernes.\nPrioridad: media.",created_at:"2026-11-15T09:12:00Z"},
   {id:"m2",from_worker_id:id+"-w1",from_worker:"Agente de Desarrollo",to_worker_id:id+"-w0",to_worker:"Agente de Dirección IA",task_id:null,body:"Hecho. <b>Esto se muestra como texto</b>, no como HTML.",created_at:"2026-11-16T08:40:00Z"}]});
 }
 return realFetch(input,init);
};
type DemoRoutine={org:string;id:string;department_id:string;department:string;worker_id:string;worker:string;title:string;instructions:string;cadence:string;capability:string|null;state:string;created_at:string;last_period:string|null;runs:number};
var demoRoutines:DemoRoutine[]=[{org:"org-1",id:"r-a",department_id:"org-1-d6",department:"SEO y Contenidos",worker_id:"org-1-w6",worker:"Agente de SEO y Contenidos",title:"Revisión SEO semanal",instructions:"Revisa posiciones, títulos y descripciones de las páginas principales.",cadence:"weekly",capability:"seo",state:"active",created_at:"2026-11-02T10:00:00Z",last_period:"2026-W46",runs:3},
 {org:"org-1",id:"r-b",department_id:"org-1-d7",department:"Atención y Email",worker_id:"org-1-w7",worker:"Agente de Atención y Email",title:"Clasificación diaria del email",instructions:"Clasifica los correos recibidos por urgencia y tema.",cadence:"daily",capability:"email",state:"paused",created_at:"2026-11-03T10:00:00Z",last_period:"2026-11-14",runs:9}];
const auth={isAuthenticated:true,isLoading:false,user:{name:"Laura (demo)"},logout:()=>{},loginWithRedirect:async()=>{},getAccessTokenSilently:async()=>"demo-token"} as unknown as Auth0ContextInterface;
function Harness(){
 const [log,setLog]=useState("");
 const members=params.get("mode")==="unavailable"?[{id:"m1",name:"Nova Demo",role:"owner"},{id:"m2",name:"Proyecto Beta",role:"member"}]:[];
 // ?view=app: la aplicación completa (menú, cabecera y secciones), para revisar el móvil tal como se ve con sesión.
 if(params.get("view")==="app")return <App/>;
 if(params.get("view")==="intro")return <LoginIntro invited={params.get("invitado")==="1"} still={params.get("quieto")==="1"} freezeAt={params.get("t")?Number(params.get("t")):undefined} own={params.get("propio")==="1"?{login:async(e,pw)=>pw==="mal"?{ok:false as const,text:"Usuario o contraseña incorrectos."}:(setLog("Dentro como "+e),{ok:true as const}),signup:params.get("invitado")==="1"?async v=>(setLog("Cuenta creada para "+v.email),{ok:true as const}):undefined,reset:async()=>{}}:undefined} onLogin={h=>setLog("Entrar"+(h?" como "+h:""))} onSignup={()=>setLog("Crear cuenta")}/>;
 if(params.get("view")==="office")return <div className="workspace company-office-workspace"><main className="work-main">
  <div className="demo-banner" role="note">PREVISUALIZACIÓN DE DESARROLLO · datos de ejemplo simulados. {log}</div>
  <section className="panel"><CompanyOffice companyId={MOCK_ORG} companies={[{id:MOCK_ORG,name:"Tienda Aurora",role:"owner"}]} ownerName="Laura" webgl={params.get("webgl")==="0"?false:undefined} onSelectCompany={()=>{}} onLoadCompanies={()=>{}} onNavigate={s=>setLog("Ir a "+s)}/></section>
 </main></div>;
 return <div className="workspace campus-workspace"><main className="work-main">
  <div className="demo-banner" role="note">PREVISUALIZACIÓN DE DESARROLLO · datos de ejemplo simulados, no son empresas reales. {log}</div>
  <section className="panel"><FreddyCampus companies={members} webgl={params.get("webgl")==="0"?false:undefined} onEnterCompany={id=>setLog("Entrar en "+id)} onNavigate={(s,id)=>setLog("Ir a "+s+" · "+id)} onLoadCompanies={()=>{}}/></section>
 </main></div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Auth0Context.Provider value={auth}><Harness/></Auth0Context.Provider></React.StrictMode>);

import {CompanyId} from "./fabrica/CompanyId";
import {Component,useCallback,useEffect,useMemo,useRef,useState} from "react";
import type {ReactNode} from "react";
import {useAuth0} from "./auth";
import {FactoryScene} from "./fabrica/FactoryScene";
import type {FactoryEvent} from "./fabrica/FactoryScene";
import {CompanyLogo,companyBrand} from "./fabrica/CompanyLogo";
import {APP_NAME} from "./brand";
import {holdingChanges} from "./fabrica/liveFeed";
import {FreddyNotices} from "./fabrica/FreddyNotices";
import type {Notice} from "./fabrica/notices";
import type {FeedEntry} from "./fabrica/liveFeed";
import type {Preset} from "./fabrica/layout";
import {ProjectGuide} from "./ProjectGuide";
import {CreateCompanyWizard} from "./CreateCompanyWizard";
import {CompanyManagement} from "./CompanyManagement";
import {HoldingStorage} from "./HoldingStorage";
import {HoldingViewers} from "./HoldingViewers";
import {CAPABILITIES,CAPABILITY_INFO,HOLDING_URL,MAX_COMPANIES,STATE_LABEL,campusPlots,computeGuide,memberPlots,validHoldingResponse} from "./holdingApi";
import type {CampusPlot,GuideAction,Holding,HoldingCompany,HoldingResponse,ManageTab,MemberCompany} from "./holdingApi";
import "./FreddyCampus.css";

type Section="Documentos"|"Trabajadores IA"|"Tareas"|"Planes IA"|"Informes IA";
type Props={companies:MemberCompany[];onEnterCompany:(id:string)=>void;onNavigate:(section:Section,companyId:string)=>void;onLoadCompanies:()=>void;
 /** Solo para pruebas y la previsualización aislada: fuerza o anula la escena WebGL. */
 webgl?:boolean};
type Load={state:"loading"}|{state:"ready";data:HoldingResponse}|{state:"unavailable"}|{state:"error";message:string};
export {CAMPUS_CENTER,plotPosition,presetPose} from "./fabrica/layout";
/** Cada cuánto se vuelve a consultar el holding mientras la pestaña está a la vista. */
export const LIVE_INTERVAL_MS=8000;
const FEED_MAX=30;
export function detectWebGL():boolean{
 try{const c=document.createElement("canvas");return !!(c.getContext("webgl2")||c.getContext("webgl"));}catch{return false;}
}
export function plotLabel(p:CampusPlot){
 if(p.company){const c=p.company;return `Parcela ${p.slot}: ${c.name}. ${c.departments} departamentos, ${c.active_workers} de ${c.workers} trabajadores activos, ${c.tasks.pending} tareas pendientes y ${c.tasks.blocked} bloqueadas.`;}
 if(p.member)return `Parcela ${p.slot}: ${p.member.name}. Sin métricas del holding.`;
 return `Parcela ${p.slot}: espacio libre, crea tu empresa.`;
}

export function FreddyCampus({companies,onEnterCompany,onNavigate,onLoadCompanies,webgl}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [load,setLoad]=useState<Load>({state:"loading"}),[refreshing,setRefreshing]=useState(true),[tick,setTick]=useState(0),[holdingIndex,setHoldingIndex]=useState(0);
 const [selected,setSelected]=useState<number|null>(null),[manage,setManage]=useState<{org:string;tab:ManageTab}|null>(null),[hover,setHover]=useState<number|null>(null),[wizard,setWizard]=useState(false);
 const supported=useMemo(()=>webgl??detectWebGL(),[webgl]);
 const [mode,setMode]=useState<"3d"|"2d">(supported?"3d":"2d"),[sceneFailed,setSceneFailed]=useState(false);
 const [preset,setPresetRaw]=useState<Preset>("general"),[presetNonce,setPresetNonce]=useState(0),[motion,setMotion]=useState(true),[reduced,setReduced]=useState(false),[visible,setVisible]=useState(true);
 const [calmChoice,setCalmChoice]=useState(false),[fx,setFx]=useState(true),[bloom,setBloom]=useState(true),[events,setEvents]=useState<FactoryEvent[]>([]),[feed,setFeed]=useState<FeedEntry[]>([]),[liveOk,setLiveOk]=useState(true);
 const askedCompanies=useRef(false),lastHolding=useRef<Holding|null>(null),counter=useRef(0);
 const [urgentSlots,setUrgentSlots]=useState<number[]>([]);
 const token=useCallback(async()=>String(await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}})),[getAccessTokenSilently]);
 // Avisos de los agentes: un urgente nuevo enciende su edificio y queda en «En directo»; uno resuelto, también.
 const onNotices=useCallback((all:Notice[],fresh:Notice[],resolved:Notice[])=>{
  setUrgentSlots([...new Set(all.filter(n=>n.level==="urgente"&&n.slot!==null).map(n=>n.slot as number))]);
  if(!fresh.length&&!resolved.length)return;const at=Date.now();
  setFeed(f=>[...resolved.map(n=>({id:++counter.current,at,kind:"done" as const,company:n.company,text:`resuelto: ${n.title.toLowerCase()}.`})),...fresh.map(n=>({id:++counter.current,at,kind:"blocked" as const,company:n.company,text:`${n.agent} avisa: ${n.title.toLowerCase()}.`})),...f].slice(0,FEED_MAX));
  setEvents(e=>[...e,...fresh.filter(n=>n.slot!==null&&n.level!=="info").map(n=>({id:++counter.current,kind:"blocked" as const,slot:n.slot as number})),...resolved.filter(n=>n.slot!==null).map(n=>({id:++counter.current,kind:"done" as const,slot:n.slot as number}))].slice(-40));
 },[]);
 const setPreset=useCallback((p:Preset)=>{setPresetRaw(p);setPresetNonce(n=>n+1);},[]);
 useEffect(()=>{const q=window.matchMedia?.("(prefers-reduced-motion: reduce)");if(!q)return;const f=()=>setReduced(q.matches);f();q.addEventListener?.("change",f);return()=>q.removeEventListener?.("change",f);},[]);
 useEffect(()=>{const f=()=>setVisible(document.visibilityState!=="hidden");f();document.addEventListener("visibilitychange",f);return()=>document.removeEventListener("visibilitychange",f);},[]);
 useEffect(()=>{if(!companies.length&&!askedCompanies.current){askedCompanies.current=true;onLoadCompanies();}},[companies.length,onLoadCompanies]);
 useEffect(()=>{
  const abort=new AbortController();setRefreshing(true);
  // Al actualizar se conservan los datos ya validados: así el asistente abierto no se desmonta.
  setLoad(l=>l.state==="ready"?l:{state:"loading"});
  (async()=>{try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});if(abort.signal.aborted)return;
   const r=await fetch(HOLDING_URL,{headers:{Authorization:"Bearer "+token},signal:abort.signal});if(abort.signal.aborted)return;
   if(r.status===404||r.status===503){setLoad({state:"unavailable"});return;}
   if(!r.ok){setLoad({state:"error",message:`El servidor ha respondido con código ${r.status}.`});return;}
   const raw:unknown=await r.json();if(abort.signal.aborted)return;
   if(!validHoldingResponse(raw)){setLoad({state:"error",message:"La respuesta del holding no es coherente y no se muestra."});return;}
   setLoad(raw.enabled?{state:"ready",data:raw}:{state:"unavailable"});setLiveOk(true);
  }catch{if(!abort.signal.aborted)setLoad({state:"error",message:"No se ha podido consultar el holding. Comprueba la conexión y la sesión."});}
  finally{if(!abort.signal.aborted)setRefreshing(false);}})();
  return()=>abort.abort();
 },[tick,getAccessTokenSilently]);
 // En directo: mientras la pestaña está a la vista se vuelve a consultar en silencio. Un fallo no borra lo que ya se ve.
 const ready=load.state==="ready";
 useEffect(()=>{
  if(!ready)return;let active=true,busy=false;const abort=new AbortController();
  const poll=async()=>{if(busy||document.visibilityState==="hidden")return;busy=true;
   try{const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
    const r=await fetch(HOLDING_URL,{headers:{Authorization:"Bearer "+token},signal:abort.signal});if(!r.ok)throw Error("status");
    const raw:unknown=await r.json();if(!active)return;if(!validHoldingResponse(raw)||!raw.enabled)throw Error("invalid");
    setLoad({state:"ready",data:raw});setLiveOk(true);
   }catch{if(active)setLiveOk(false);}finally{busy=false;}};
  const timer=window.setInterval(()=>void poll(),LIVE_INTERVAL_MS);
  const onVisible=()=>{if(document.visibilityState!=="hidden")void poll();};document.addEventListener("visibilitychange",onVisible);
  return()=>{active=false;abort.abort();window.clearInterval(timer);document.removeEventListener("visibilitychange",onVisible);};
 },[ready,getAccessTokenSilently]);
 const holdings=load.state==="ready"?load.data.holdings:[];
 const holding:Holding|null=holdings[Math.min(holdingIndex,holdings.length-1)]??null;
 const fallback=!holding;
 // Solo se anima lo que cambia de verdad entre dos consultas del MISMO holding. La primera lectura no genera nada.
 useEffect(()=>{
  const prev=lastHolding.current;lastHolding.current=holding;
  if(!holding||!prev||prev.id!==holding.id)return;
  const changes=holdingChanges(prev.companies,holding.companies);if(!changes.length)return;
  const at=Date.now();
  setFeed(f=>[...changes.map(c=>({id:++counter.current,at,kind:c.kind,company:c.company,text:c.text})).reverse(),...f].slice(0,FEED_MAX));
  setEvents(e=>[...e,...changes.flatMap(c=>c.kind==="created"?[]:Array.from({length:Math.min(c.count,3)},()=>({id:++counter.current,kind:c.kind as FactoryEvent["kind"],slot:c.slot})))].slice(-40));
 },[holding]);
 const plots=useMemo(()=>holding?campusPlots(holding.companies):memberPlots(companies),[holding,companies]);
 const guide=useMemo(()=>computeGuide(holding),[holding]);
 // Un aviso urgente de sus agentes enciende la baliza del edificio igual que una tarea bloqueada.
 const scenePlots=useMemo(()=>plots.map(p=>p.company&&urgentSlots.includes(p.slot)&&p.company.tasks.blocked===0?{...p,company:{...p.company,tasks:{...p.company.tasks,blocked:1}}}:p),[plots,urgentSlots]);
 const brandOf=(p:CampusPlot)=>p.company?companyBrand(p.company,holding?.companies??[]):{website:null,flag:false};
 const canCreate=!!holding?.is_owner&&holding.companies.length<MAX_COMPANIES;
 const calm=reduced||calmChoice;
 const animate=motion&&!calm&&visible;
 const show3d=mode==="3d"&&supported&&!sceneFailed;
 const selectedPlot=selected?plots.find(p=>p.slot===selected)??null:null;
 // Al elegir una parcela, la cámara vuela hasta ella; «Vista general» la devuelve al conjunto.
 const select=useCallback((slot:number)=>{setSelected(slot);setPreset("empresa");},[setPreset]);
 function onAction(a:GuideAction){
  if(a.kind==="wizard"){if(canCreate)setWizard(true);}
  else if(a.kind==="select"){setSelected(a.slot);if(show3d)setPreset("empresa");document.getElementById("campus-plot-detail")?.focus();}
  else if(a.kind==="manage"){if(holding?.companies.some(c=>c.organization_id===a.companyId))setManage({org:a.companyId,tab:a.tab});}
  else if(a.kind==="section")onNavigate(a.section,a.companyId);
 }
 const serverNote=load.state==="unavailable"?"El holding aún no está disponible en el servidor. Te muestro las empresas a las que ya perteneces, sin métricas.":load.state==="error"?load.message:load.state==="ready"&&!holding?"Todavía no tienes ningún holding asignado en el servidor.":undefined;
 const membersBeyond=fallback&&companies.length>MAX_COMPANIES?companies.length-MAX_COMPANIES:0;
 return <div className="freddy-campus">
  <section className="campus-stage" aria-label={APP_NAME}>
   <div className="campus-toolbar">
    <div className="campus-title"><span className="guide-eyebrow">HOLDING · {holding?holding.name.toUpperCase():"NORTHLANE360"}</span>
     <h2>{APP_NAME}</h2>
     <p>{holding?`${holding.companies.length} de ${MAX_COMPANIES} empresas creadas · cada empresa es independiente y aislada`:load.state==="loading"?"Consultando el holding…":"Vista de tus empresas actuales"}</p>
     {holding&&holding.companies.length>0&&(()=>{const need=holding.companies.filter(c=>c.tasks.blocked>0),total=need.reduce((n,c)=>n+c.tasks.blocked,0),working=holding.companies.reduce((n,c)=>n+c.active_workers,0);
      return <p className="campus-greeting" role="status">{campusGreeting(new Date().getHours())}. {working===1?"1 agente activo":working+" agentes activos"} · {need.length===0?"ninguna empresa te necesita ahora":<><b className="need-badge">{total}</b> {need.length===1?"«"+need[0].name+"» te necesita":need.length+" empresas te necesitan"}</>}.</p>;})()}</div>
    <div className="campus-actions">
     {holdings.length>1&&<label className="campus-select">Holding<select value={holdingIndex} onChange={e=>{setHoldingIndex(Number(e.target.value));setSelected(null);}}>{holdings.map((h,i)=><option key={h.id} value={i}>{h.name}</option>)}</select></label>}
     {canCreate&&<button type="button" className="campus-primary" onClick={()=>setWizard(true)}>Crear empresa</button>}
     <button type="button" className="campus-ghost" onClick={()=>setTick(t=>t+1)} disabled={refreshing}>{refreshing?"Consultando…":"Actualizar datos"}</button>
     {holding?.is_owner&&holding.companies.length>0&&<FreddyNotices companies={holding.companies} token={token} onChange={onNotices} onSelect={slot=>{select(slot);document.getElementById("campus-plot-detail")?.scrollIntoView?.({block:"nearest"});}}/>}
    </div>
   </div>
   {serverNote&&<div className={load.state==="error"?"campus-banner warn":"campus-banner"} role="status">{serverNote}{fallback&&companies.length===0&&<> <button type="button" className="campus-ghost" onClick={onLoadCompanies}>Cargar mis empresas</button></>}</div>}
   {!supported&&<p className="campus-help">Este navegador no ofrece WebGL: se muestra el plano 2D equivalente.</p>}
   {sceneFailed&&<p className="campus-help" role="alert">La escena 3D no se pudo iniciar. Se muestra el plano 2D equivalente.</p>}
   {reduced&&<p className="campus-help">Movimiento reducido por preferencia del sistema: la escena queda quieta.</p>}
   {show3d?<div className="campus-canvas" role="group" aria-label="Escena 3D de la factoría. Usa los botones de parcela para seleccionar con el teclado.">
     <SceneBoundary onFail={()=>setSceneFailed(true)}>
      <FactoryScene plots={scenePlots} selected={selected} paused={!motion||!visible} calm={calm} fx={fx} preset={preset} presetNonce={presetNonce} events={events}
       onSelect={select} onFreddy={()=>setPreset("freddy")} onFail={()=>setSceneFailed(true)} onBloom={setBloom}/>
     </SceneBoundary>
     <div className="campus-overlay" aria-hidden="true"><strong>{holding?.name??APP_NAME}</strong><span>{fallback?"SIN MÉTRICAS DEL HOLDING":liveOk?"EN DIRECTO · DATOS REALES":"SIN CONEXIÓN · ÚLTIMOS DATOS"}</span></div>
     <p className="campus-hint" aria-hidden="true">Arrastra para girar · pellizca o usa la rueda para acercar · toca un edificio</p>
     {preset!=="general"&&<button type="button" className="campus-recenter" onClick={()=>setPreset("general")}>⌖ Vista general</button>}
    </div>
    :<CampusMap plots={plots} selected={selected} onSelect={select} animate={animate}/>}
   {show3d&&<div className="campus-plot-strip" role="group" aria-label="Parcelas del campus">{plots.map(p=><button key={p.slot} type="button" aria-pressed={selected===p.slot} aria-label={plotLabel(p)} className={"campus-chip"+(p.company||p.member?"":" empty")} onClick={()=>select(p.slot)} onMouseEnter={()=>setHover(p.slot)} onMouseLeave={()=>setHover(null)}>{p.company||p.member?<CompanyLogo name={(p.company?.name??p.member?.name)!} {...brandOf(p)}/>:<span>{p.slot}</span>}{p.company?.name??p.member?.name??"Espacio libre"}{!!p.company&&p.company.tasks.blocked>0&&<b className="need-badge" title="Tareas bloqueadas que te esperan">{p.company.tasks.blocked}</b>}</button>)}</div>}
   {membersBeyond>0&&<p className="campus-help">Perteneces a {membersBeyond} empresa(s) más; están disponibles en el selector de empresas.</p>}
   <PlotDetail plot={selectedPlot} brand={selectedPlot?brandOf(selectedPlot):undefined} canCreate={canCreate} fallback={fallback} onEnter={onEnterCompany} onCreate={()=>setWizard(true)} onNavigate={onNavigate} onManage={(org,tab)=>setManage({org,tab})}/>
   {!fallback&&<LiveFeed entries={feed} ok={liveOk}/>}
   <p className="campus-help">Los peatones, los coches, los edificios de alrededor y las obras de las parcelas libres son ambiente decorativo. Todo lo demás sale de los datos consultados: plantas = departamentos, ventanas encendidas = trabajadores activos, baliza ámbar = tareas bloqueadas. Un dron solo vuela cuando el servidor registra un trabajo nuevo (ámbar) o terminado (verde).</p>
  </section>
  {holding?.is_owner&&<HoldingStorage holding={holding} onChanged={()=>setTick(t=>t+1)}/>}
  {holding?.is_owner&&<HoldingViewers holding={holding}/>}
  <ProjectGuide guide={guide} onAction={onAction} serverNote={fallback?"La guía se completará cuando el servidor ofrezca el holding.":undefined}/>
  {manage&&holding&&(()=>{const c=holding.companies.find(x=>x.organization_id===manage.org);return c?<CompanyManagement company={c} canEdit={holding.is_owner} tab={manage.tab} onTab={tab=>setManage({org:manage.org,tab})} onClose={()=>setManage(null)} onChanged={()=>setTick(t=>t+1)}/>:null;})()}
  {wizard&&holding&&<CreateCompanyWizard holding={holding} onClose={()=>setWizard(false)} onCreated={ack=>{setSelected(ack.slot);setTick(t=>t+1);onLoadCompanies();}}/>}
 </div>;
}

class SceneBoundary extends Component<{onFail:()=>void;children:ReactNode},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}componentDidCatch(){this.props.onFail();}render(){return this.state.failed?null:this.props.children;}
}

function CapabilityList({company}:{company:HoldingCompany}){
 const byCap=new Map(company.capabilities.map(c=>[c.capability,c.state]));
 return <ul className="campus-caps" aria-label="Capacidades">{CAPABILITIES.map(c=>{const s=byCap.get(c);return <li key={c} className={"cap-"+(s??"none")}><span>{CAPABILITY_INFO[c].short}</span><small>{s?STATE_LABEL[s]:"No elegida"}</small></li>;})}</ul>;
}
function PlotDetail({plot,brand,canCreate,fallback,onEnter,onCreate,onNavigate,onManage}:{plot:CampusPlot|null;brand?:{website:string|null;flag:boolean};canCreate:boolean;fallback:boolean;onEnter:(id:string)=>void;onCreate:()=>void;onNavigate:Props["onNavigate"];onManage:(org:string,tab:ManageTab)=>void}){
 if(!plot)return <div className="campus-detail empty" id="campus-plot-detail" tabIndex={-1}><p>Selecciona un edificio o una parcela para ver su estado y entrar en su oficina.</p></div>;
 const c=plot.company;
 if(c)return <article className="campus-detail" id="campus-plot-detail" tabIndex={-1} aria-label={"Empresa "+c.name}>
  <div className="campus-detail-head"><CompanyLogo name={c.name} website={brand?.website??c.website_url} flag={brand?.flag} className="large"/><div><span className="guide-eyebrow">PARCELA {plot.slot}</span><h3>{c.name}</h3><p>{c.project_name||"Proyecto sin nombre"}{c.project_summary?" — "+c.project_summary:""}</p></div>
   <div className="campus-head-actions"><button type="button" className="campus-primary" onClick={()=>onEnter(c.organization_id)}>Entrar en la oficina</button><button type="button" className="campus-ghost" onClick={()=>onManage(c.organization_id,"profile")}>Gestión e integración</button></div></div>
  <dl className="campus-stats">
   <div><dt>Departamentos</dt><dd>{c.departments}</dd></div>
   <div><dt>Trabajadores activos</dt><dd>{c.active_workers}<small>/{c.workers}</small></dd></div>
   <div><dt>Tareas pendientes</dt><dd>{c.tasks.pending}</dd></div>
   <div className={c.tasks.blocked?"alert":""}><dt>Bloqueadas</dt><dd>{c.tasks.blocked}</dd></div>
   <div><dt>Completadas</dt><dd>{c.tasks.completed}</dd></div>
   <div><dt>Rutinas activas</dt><dd>{c.routines_active}</dd></div>
   <div><dt>Misiones</dt><dd>{c.missions}</dd></div>
   <div><dt>Pilotos activos</dt><dd>{c.autopilots_active}</dd></div>
  </dl>
  <CapabilityList company={c}/>
  <p className="campus-links">{c.repository?<>Repositorio: <a href={"https://github.com/"+c.repository} target="_blank" rel="noreferrer noopener">{c.repository}</a></>:"Sin repositorio"} · {c.website_url?<>Web: <a href={c.website_url} target="_blank" rel="noreferrer noopener">{c.website_url}</a></>:"Sin web"}</p>
  <CompanyId id={c.organization_id}/>
  <div className="campus-detail-links"><button type="button" className="campus-ghost manage-open" onClick={()=>onManage(c.organization_id,"profile")}>Gestionar empresa</button><button type="button" className="campus-ghost" onClick={()=>onManage(c.organization_id,"routines")}>Tareas recurrentes</button><button type="button" className="campus-ghost" onClick={()=>onManage(c.organization_id,"messages")}>Mensajes</button><button type="button" className="campus-ghost" onClick={()=>onManage(c.organization_id,"integration")}>Integración</button><button type="button" className="campus-ghost" onClick={()=>onManage(c.organization_id,"hosting")}>Hosting y bases</button><button type="button" className="campus-ghost" onClick={()=>onManage(c.organization_id,"tienda")}>Operación tienda</button><button type="button" className="campus-ghost" onClick={()=>onNavigate("Trabajadores IA",c.organization_id)}>Agentes</button><button type="button" className="campus-ghost" onClick={()=>onNavigate("Tareas",c.organization_id)}>Tareas</button><button type="button" className="campus-ghost" onClick={()=>onNavigate("Planes IA",c.organization_id)}>Misiones</button><button type="button" className="campus-ghost" onClick={()=>onNavigate("Informes IA",c.organization_id)}>Informes</button></div>
 </article>;
 if(plot.member)return <article className="campus-detail" id="campus-plot-detail" tabIndex={-1} aria-label={"Empresa "+plot.member.name}>
  <div className="campus-detail-head"><div><span className="guide-eyebrow">EMPRESA {plot.slot}</span><h3>{plot.member.name}</h3><p>Rol: {plot.member.role}. Sin métricas: el holding aún no está disponible en el servidor.</p></div>
   <button type="button" className="campus-primary" onClick={()=>onEnter(plot.member!.id)}>Entrar en la oficina</button></div>
 </article>;
 return <article className="campus-detail vacant" id="campus-plot-detail" tabIndex={-1} aria-label={"Parcela "+plot.slot+" libre"}>
  <span className="guide-eyebrow">PARCELA {plot.slot}</span><h3>Espacio libre · crea tu empresa</h3>
  <p>Aquí puede vivir uno de tus proyectos: una web, un repositorio, una tienda con pedidos… Freddy preparará sus departamentos.</p>
  {canCreate?<button type="button" className="campus-primary" onClick={onCreate}>Crear empresa en el campus</button>:<p>{fallback?"La creación de empresas estará disponible cuando el servidor ofrezca el holding.":"Solo quien es propietario del holding puede crear empresas."}</p>}
 </article>;
}

/** Plano 2D accesible: misma información que la escena 3D, sin WebGL. */
export function campusGreeting(hour:number){return hour<6?"Buenas noches":hour<13?"Buenos días":hour<21?"Buenas tardes":"Buenas noches";}
function CampusMap({plots,selected,onSelect,animate}:{plots:CampusPlot[];selected:number|null;onSelect:(s:number)=>void;animate:boolean}){
 return <div className={"campus-map"+(animate?" animated":"")} role="group" aria-label="Plano 2D del campus">
  <div className="campus-map-core" aria-hidden="true"><div className="campus-map-rings"/><img src="/freddy-views/front.png" alt=""/><span>FREDDY · DIRECCIÓN</span></div>
  {plots.map(p=>{const c=p.company;return <button key={p.slot} type="button" className={"campus-lot lot-"+p.slot+(c||p.member?" occupied":" empty")+(c&&c.tasks.blocked>0?" blocked":"")} aria-pressed={selected===p.slot} aria-label={plotLabel(p)} onClick={()=>onSelect(p.slot)}>
   <span className="lot-slot">PARCELA {p.slot}</span>{!!c&&c.tasks.blocked>0&&<b className="need-badge lot-need" aria-hidden="true">{c.tasks.blocked}</b>}
   {c?<><strong><CompanyLogo name={c.name} {...companyBrand(c,plots.flatMap(x=>x.company?[x.company]:[]))}/>{c.name}</strong><span className="lot-project">{c.project_name}</span>
    <span className="lot-floors" aria-hidden="true">{Array.from({length:Math.min(Math.max(c.departments,1),10)},(_,i)=><i key={i} className={i<Math.round(Math.min(Math.max(c.departments,1),10)*(c.workers?c.active_workers/c.workers:0))?"lit":""}/>)}</span>
    <span className="lot-metrics"><span>{c.departments} dep.</span><span>{c.active_workers}/{c.workers} activos</span><span>{c.tasks.pending} pend.</span>{c.tasks.blocked>0&&<span className="lot-alert">{c.tasks.blocked} bloq.</span>}</span>
    <span className="lot-caps" aria-hidden="true">{c.capabilities.map(k=><i key={k.capability} className={"cap-"+k.state} title={CAPABILITY_INFO[k.capability].short+" · "+STATE_LABEL[k.state]}>{CAPABILITY_INFO[k.capability].short}</i>)}</span></>
   :p.member?<><strong>{p.member.name}</strong><span className="lot-project">Sin métricas del holding</span></>
   :<><strong>Espacio libre</strong><span className="lot-project">Crea tu empresa</span></>}
  </button>;})}
 </div>;
}

/** «En directo»: los cambios reales que el servidor ha registrado desde que abriste la pantalla, en texto. */
function LiveFeed({entries,ok}:{entries:FeedEntry[];ok:boolean}){
 const hour=(at:number)=>new Date(at).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
 return <section className="campus-live" aria-label="En directo">
  <div className="campus-live-head"><h3>En directo</h3><span className={"campus-live-state"+(ok?" on":"")} role="status"><i aria-hidden="true"/>{ok?`Consultando cada ${LIVE_INTERVAL_MS/1000} segundos`:"Sin conexión: se muestran los últimos datos"}</span></div>
  <ol aria-live="polite" aria-label="Actividad en directo">{entries.map(e=><li key={e.id} className={"live-"+e.kind}><time>{hour(e.at)}</time><span><b>{e.company}</b> {e.text}</span></li>)}</ol>
  {!entries.length&&<p className="campus-help">Todavía no ha cambiado nada desde que abriste esta pantalla. Cuando un agente reciba o termine un trabajo, aparecerá aquí y lo verás en la escena.</p>}
 </section>;
}

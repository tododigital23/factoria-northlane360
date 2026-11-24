import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {useAuth0} from "../auth";
import {officeMotion,validOffice} from "../OperationsOffice";
import {detectWebGL} from "../FreddyCampus";
import {JOBS_KEY,LOUNGE_KEY,buildAgents,ghostAgents,ghostDepartments,greeting,inbox,isGhostId,needsCount,NEED_LABEL,realAgents,roomLayout,workingCount} from "./officeModel";
import type {BreakState,GhostSeat,MemoryItem,OfficeDepartment,OfficeTask,OverviewWorker,TaskRequest,TeamFilter} from "./officeModel";
import {CAPABILITIES,CAPABILITY_INFO,HOLDING_URL,validHoldingResponse} from "../holdingApi";
import {AgentChat} from "./AgentChat";
import {AgentBubble} from "./AgentBubble";
import {AgentAvatar} from "./TeamSidebar";
import {TOKEN_PARAMS,activateWorker,loadBreak,loadMemory,loadTaskRequests,orgUrl,setBreak} from "./officeApi";
import type {Optional} from "./officeApi";
import {OfficeScene} from "./OfficeScene";
import type {CameraApi} from "./OfficeScene";
import {OfficeList,OfficeMap2D} from "./OfficeMap2D";
import {TeamSidebar} from "./TeamSidebar";
import {AgentBar} from "./AgentBar";
import {RequestTaskModal} from "./RequestTaskModal";
import {SharedMemory} from "./SharedMemory";
import {PortalAgents} from "./PortalAgents";
import type {PortalSummary} from "./PortalAgents";
import {cleanNotices,noticeCopy} from "../fabrica/notices";
import "./theme.css";
import "./office.css";

type Company={id:string;name:string;role:string};
/** Cada cuánto se consulta la oficina mientras la pestaña está a la vista. */
export const LIVE_MS=8000;
const OPEN=new Set(["pending","queued","running","blocked"]),DONE=new Set(["completed","done"]);
type Snapshot={organization_id:string;observed_at:string;departments:OfficeDepartment[];workers:OverviewWorker[]};
export type OfficeSection="Campus"|"Asignaciones"|"Tareas"|"Resumen"|"Trabajadores IA";
type Props={companyId:string;companies:Company[];onSelectCompany:(id:string)=>void;onLoadCompanies:()=>void;onNavigate:(s:OfficeSection)=>void;
 /** Fuerza (true/false) la escena WebGL; por defecto se detecta. */ webgl?:boolean;ownerName?:string};

function validTasks(raw:unknown):raw is OfficeTask[]{
 return Array.isArray(raw)&&raw.every(t=>!!t&&typeof t==="object"&&typeof (t as OfficeTask).id==="string"&&typeof (t as OfficeTask).department_id==="string"&&typeof (t as OfficeTask).title==="string"&&typeof (t as OfficeTask).status==="string"&&typeof (t as OfficeTask).created_at==="string"&&((t as OfficeTask).assignee_worker_id===null||typeof (t as OfficeTask).assignee_worker_id==="string"));
}

export function CompanyOffice({companyId,companies,onSelectCompany,onLoadCompanies,onNavigate,webgl,ownerName}:Props){
 const {getAccessTokenSilently,user}=useAuth0();
 const token=useCallback(async()=>String(await getAccessTokenSilently(TOKEN_PARAMS)),[getAccessTokenSilently]);
 const company=companies.find(c=>c.id===companyId),owner=company?.role==="owner";
 const me=ownerName??(user?.given_name||user?.name||"Tú");
 const [snap,setSnap]=useState<{data:Snapshot;at:number}|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [tasks,setTasks]=useState<OfficeTask[]>([]),[requests,setRequests]=useState<Optional<TaskRequest[]>>({state:"loading"}),[memory,setMemory]=useState<Optional<MemoryItem[]>>({state:"loading"});
 const [selectedId,setSelectedId]=useState<string|null>(null),[focusKey,setFocusKey]=useState<string|null>(null),[filter,setFilter]=useState<TeamFilter>("all"),[query,setQuery]=useState("");
 const [view,setView]=useState<"office"|"list">("office"),[ambient,setAmbient]=useState(false),[paused,setPaused]=useState(false),[memoryOpen,setMemoryOpen]=useState(false),[requestOpen,setRequestOpen]=useState(false);
 const [zoom,setZoom]=useState(100),[visible,setVisible]=useState(typeof document==="undefined"||document.visibilityState!=="hidden"),[reduced,setReduced]=useState(false),[tick,setTick]=useState(()=>Date.now());
 const supported=useMemo(()=>webgl??detectWebGL(),[webgl]);const [sceneFailed,setSceneFailed]=useState(false);
 const cameraApi=useRef<CameraApi|null>(null),loadRef=useRef<(()=>Promise<void>)|null>(null),askedCompanies=useRef(false);

 useEffect(()=>{if(!companies.length&&!askedCompanies.current){askedCompanies.current=true;onLoadCompanies();}},[companies.length,onLoadCompanies]);
 useEffect(()=>{const q=window.matchMedia?.("(prefers-reduced-motion: reduce)");if(!q)return;const f=()=>setReduced(q.matches);f();q.addEventListener?.("change",f);return()=>q.removeEventListener?.("change",f);},[]);
 useEffect(()=>{const f=()=>{const v=document.visibilityState!=="hidden";setVisible(v);if(v)void loadRef.current?.();};document.addEventListener("visibilitychange",f);const t=window.setInterval(()=>setTick(Date.now()),5000);return()=>{document.removeEventListener("visibilitychange",f);window.clearInterval(t);};},[]);

 // Oficina en vivo (office-overview) + tareas: se refresca cada 8 s mientras la pestaña está visible.
 useEffect(()=>{
  let active=true,locked=false;let controller:AbortController|null=null;
  setSnap(null);setError("");setTasks([]);setSelectedId(null);setFocusKey(null);
  if(!companyId||!owner){loadRef.current=null;return;}
  async function load(){
   if(locked||!active)return;locked=true;setBusy(true);controller=new AbortController();const signal=controller.signal;const timeout=window.setTimeout(()=>controller?.abort(),12000);
   try{
    const t=await token();if(signal.aborted)throw Error("aborted");
    const [r,rt]=await Promise.all([fetch(orgUrl(companyId,"execution/office-overview"),{headers:{Authorization:"Bearer "+t},signal}),fetch(orgUrl(companyId,"tasks"),{headers:{Authorization:"Bearer "+t},signal}).catch(()=>null)]);
    if(!r.ok)throw Error("unavailable");const raw:unknown=await r.json();if(!validOffice(raw,companyId))throw Error("invalid");
    let nextTasks:OfficeTask[]=[];if(rt&&rt.ok){const rawTasks:unknown=await rt.json().catch(()=>null);if(validTasks(rawTasks))nextTasks=rawTasks;}
    if(active&&!signal.aborted){setSnap({data:raw as unknown as Snapshot,at:Date.now()});setTasks(nextTasks);setError("");}
   }catch{if(active)setError("No se pudo confirmar el estado de la oficina. Se conserva la última muestra válida y se detiene la animación.");}
   finally{window.clearTimeout(timeout);if(active){locked=false;setBusy(false);}}
  }
  loadRef.current=load;void load();
  const timer=window.setInterval(()=>{if(document.visibilityState!=="hidden")void load();},LIVE_MS);
  return()=>{active=false;controller?.abort();window.clearInterval(timer);loadRef.current=null;};
 },[companyId,owner,token]);
 // Recursos nuevos (encargos y memoria): si el servidor no los ofrece, la UI queda deshabilitada con nota neutral.
 const reloadExtras=useCallback((signal:AbortSignal)=>{
  if(!companyId||!owner){setRequests({state:"unavailable"});setMemory({state:"unavailable"});return;}
  void loadTaskRequests(companyId,token,signal).then(r=>{if(!signal.aborted)setRequests(r);});
  void loadMemory(companyId,token,signal).then(m=>{if(!signal.aborted)setMemory(m);});
 },[companyId,owner,token]);
 useEffect(()=>{const a=new AbortController();setRequests({state:"loading"});setMemory({state:"loading"});reloadExtras(a.signal);return()=>a.abort();},[reloadExtras]);

 // Agentes «por crear»: los departamentos que la empresa aún no tiene porque no ha elegido esa capacidad. Si el holding no contesta, no se enseña ninguno.
 const [ghosts,setGhosts]=useState<GhostSeat[]>([]);
 useEffect(()=>{
  const a=new AbortController();setGhosts([]);if(!companyId||!owner)return;
  (async()=>{try{
   const t=await token();const r=await fetch(HOLDING_URL,{headers:{Authorization:"Bearer "+t},signal:a.signal});if(!r.ok)return;
   const raw:unknown=await r.json();if(a.signal.aborted||!validHoldingResponse(raw)||!raw.enabled)return;
   const c=raw.holdings.flatMap(h=>h.companies).find(x=>x.organization_id===companyId);if(!c)return;
   const have=new Set(c.capabilities.filter(k=>k.state!=="disabled").map(k=>k.capability));
   setGhosts(CAPABILITIES.filter(k=>!have.has(k)&&CAPABILITY_INFO[k].department).map(k=>({capability:k,department:CAPABILITY_INFO[k].department as string,label:CAPABILITY_INFO[k].short})));
  }catch{/* sin holding no hay agentes por crear */}})();
  return()=>a.abort();
 },[companyId,owner,token]);
 const [chatOpen,setChatOpen]=useState(false),[inboxOpen,setInboxOpen]=useState(false);
 // Modo descanso: lo decide el propietario y lo confirma el servidor; se vuelve a consultar con cada refresco de la oficina.
 const [rest,setRest]=useState<BreakState|null>(null),[restAsk,setRestAsk]=useState(false),[restBusy,setRestBusy]=useState(false),[restNote,setRestNote]=useState("");
 useEffect(()=>{setRest(null);setRestAsk(false);setRestNote("");if(!companyId||!owner)return;const a=new AbortController();
  const read=()=>{void loadBreak(companyId,token,a.signal).then(b=>{if(!a.signal.aborted&&b)setRest(b);});};read();
  const timer=window.setInterval(()=>{if(document.visibilityState!=="hidden")read();},LIVE_MS*2);return()=>{a.abort();window.clearInterval(timer);};},[companyId,owner,token]);
 const onBreak=!!rest?.on_break;
 // Activar («contratar») a un agente inactivo desde su bocadillo: necesita el permiso de gestión.
 const [hiring,setHiring]=useState<string|null>(null);
 async function hire(id:string){
  if(hiring)return;setHiring(id);setRestNote("");
  const r=await activateWorker(companyId,id,async()=>String(await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}})));
  setHiring(null);
  if(r.ok){await loadRef.current?.();setSelectedId(null);focusRoom(null);return;}
  setRestNote(r.kind==="forbidden"?"Solo el propietario puede activar agentes.":r.kind==="conflict"?"Ese agente ya no está inactivo. Actualiza la oficina.":"No se pudo activar al agente. Inténtalo de nuevo.");
 }
 // Avisos de los agentes del portal: se suman a «Te toca» para tener en un solo sitio todo lo que espera al propietario.
 const [portalNeeds,setPortalNeeds]=useState<{key:string;agent:string;title:string;level:string;panel:string|null}[]>([]);
 useEffect(()=>{setPortalNeeds([]);},[companyId]);
 const onPortal=useCallback((s:PortalSummary|null)=>{
  setPortalNeeds(s&&s.available?s.agents.flatMap(ag=>cleanNotices(ag.notices).filter(n=>n.level!=="info").map(n=>({key:ag.id+":"+n.code,agent:ag.name,title:noticeCopy(n.code,n.count,n)[0],level:n.level,panel:s.panel_url}))):[]);},[]);
 async function toggleRest(on:boolean){
  if(restBusy)return;setRestBusy(true);setRestNote("");const r=await setBreak(companyId,on,token);setRestBusy(false);setRestAsk(false);
  if(r.ok){setRest(r.state);setSelectedId(null);setChatOpen(false);focusRoom(on?LOUNGE_KEY:null);return;}
  setRestNote(r.kind==="forbidden"?"Solo el propietario puede cambiar el modo descanso.":"No se pudo cambiar el modo descanso. Inténtalo de nuevo.");
 }

 // En directo: se comparan dos lecturas seguidas. Un encargo abierto nuevo marca a su agente como «recién llegado»;
 // uno que deja de estar abierto y consta como terminado, como «trabajo terminado».
 const [arrivals,setArrivals]=useState<Record<string,number>>({}),[completions,setCompletions]=useState<Record<string,number>>({}),[notice,setNotice]=useState(""),known=useRef<{org:string;open:Map<string,string|null>}|null>(null);
 useEffect(()=>{
  if(!snap)return;const open=new Map(tasks.filter(t=>OPEN.has(t.status)).map(t=>[t.id,t.assignee_worker_id])),prev=known.current;known.current={org:companyId,open};
  if(!prev||prev.org!==companyId){setArrivals({});setCompletions({});setNotice("");return;}
  const at=Date.now(),name=(id:string|null)=>snap.data.workers.find(w=>w.id===id)?.name;
  const fresh=tasks.filter(t=>OPEN.has(t.status)&&t.assignee_worker_id&&!prev.open.has(t.id));
  const done=tasks.filter(t=>DONE.has(t.status)&&prev.open.get(t.id));
  if(fresh.length)setArrivals(a=>({...a,...Object.fromEntries(fresh.map(t=>[t.assignee_worker_id as string,at]))}));
  if(done.length)setCompletions(c=>({...c,...Object.fromEntries(done.map(t=>[prev.open.get(t.id) as string,at]))}));
  if(!fresh.length&&!done.length)return;
  const who=[...new Set(fresh.map(t=>name(t.assignee_worker_id)).filter(Boolean))],whoDone=[...new Set(done.map(t=>name(prev.open.get(t.id)??null)).filter(Boolean))];
  setNotice(fresh.length?(who.length===1?`${who[0]} recibe un trabajo nuevo`:`${fresh.length} trabajos nuevos repartidos`):whoDone.length===1?`${whoDone[0]} termina un trabajo`:`${done.length} trabajos terminados`);
  const timer=window.setTimeout(()=>setNotice(""),6000);return()=>window.clearTimeout(timer);
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[snap,tasks]);
 const data=snap?.data;
 const fresh=!!snap&&!error&&visible&&tick-snap.at<30000;
 const live=fresh&&!paused&&!reduced;
 const motionKey=data?data.workers.map(w=>officeMotion(w,data.observed_at,tick-(snap?.at??0),live)?"1":"0").join(""):"";
 const reqList=useMemo(()=>requests.state==="ready"?requests.data:[],[requests]);
 // Solo se enseñan como «por crear» los departamentos que de verdad no existen todavía en la oficina.
 const missing=useMemo(()=>data?ghosts.filter(g=>!data.departments.some(d=>d.name.trim().toLowerCase()===g.department.toLowerCase())).slice(0,Math.max(0,12-data.departments.length)):[],[data,ghosts]);
 const agents=useMemo(()=>data?[...buildAgents(data.workers,data.departments,tasks,reqList,w=>officeMotion(w,data.observed_at,Date.now()-(snap?.at??0),live)),...ghostAgents(missing)]:[],
  [data,tasks,reqList,motionKey,missing]);
 const layout=useMemo(()=>roomLayout([...(data?.departments.slice(0,12)??[]),...ghostDepartments(missing)],true),[data,missing]);
 const pending=useMemo(()=>inbox(agents),[agents]),waitingForMe=needsCount(agents);
 const selected=agents.find(a=>a.id===selectedId)??null;
 // Al entrar se muestra en la barra inferior el primer agente con trabajo real (o el primero de la lista).
 const autoPicked=useRef(false);
 // En la escena 3D no se elige a nadie al entrar: primero se ve la oficina trabajando. En lista o plano sí, para que la ficha no salga vacía.
 useEffect(()=>{const real=realAgents(agents);if(autoPicked.current||!real.length||(view==="office"&&supported&&!sceneFailed))return;autoPicked.current=true;setSelectedId(s=>s??(real.find(a=>a.needs.length>0)??real.find(a=>a.status==="working")??real[0]).id);},[agents,view,supported,sceneFailed]);
 const working=workingCount(realAgents(agents)),inactiveCount=realAgents(agents).filter(a=>a.status==="inactive").length;
 const show3d=view==="office"&&supported&&!sceneFailed;
 function selectAgent(id:string,fly=false){setSelectedId(id);if(fly){const a=agents.find(x=>x.id===id);const room=layout.rooms.find(r=>onBreak&&!a?.ghost?r.key===LOUNGE_KEY:a?.status==="inactive"&&!a.ghost?r.key===JOBS_KEY:r.departmentId===a?.departmentId);if(room){setFocusKey(room.key);cameraApi.current?.focus(room.key);}}}
 function focusRoom(key:string|null){setFocusKey(key);cameraApi.current?.focus(key);}
 const requestsAvailable=requests.state==="ready";
 const companyName=company?.name??"Tu empresa";

 return <div className="company-office office-theme">
  <header className="office-topbar">
   <nav className="office-crumbs" aria-label="Migas de pan"><span className="office-logo" aria-hidden="true">✦</span><strong>Oficina</strong><span aria-hidden="true">›</span>
    {companies.length>1?<label><span className="sr-only">Empresa</span><select value={companyId} onChange={e=>onSelectCompany(e.target.value)}>{companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>:<span>{companyName}</span>}</nav>
   <div className="office-top-actions">
    <button type="button" className="office-ghost" aria-pressed={ambient} onClick={()=>setAmbient(!ambient)}>◇ Modo ambiente</button>
    <button type="button" className="office-primary" onClick={()=>onNavigate("Campus")}>✦ Campus del holding</button>
   </div>
  </header>
  {!companyId&&<p className="office-empty">Selecciona una empresa en el Campus para entrar en su oficina.</p>}
  {companyId&&!owner&&<p className="office-empty" role="status">La oficina en vivo está reservada al propietario de la empresa.</p>}
  {companyId&&owner&&<div className="office-grid">
   <TeamSidebar agents={agents} ownerName={me} selectedId={selectedId} filter={filter} query={query} onFilter={setFilter} onQuery={setQuery} onSelect={id=>selectAgent(id,true)}/>
   <section className="office-main" aria-label={"Oficina de "+companyName}>
    <div className="office-title-row">
     <div><h1>{companyName} · Oficina</h1><p className="office-greeting">{greeting(new Date(tick).getHours())}, {me}. {onBreak?"Equipo en descanso: agentes apagados":inactiveCount>0&&inactiveCount===realAgents(agents).length?"Todo el equipo espera en la Oficina de Empleo: actívalos para que trabajen":working===1?"1 agente trabajando":working+" agentes trabajando"} · {waitingForMe===0?"nadie te necesita ahora":waitingForMe===1?"1 te necesita":waitingForMe+" te necesitan"}.</p></div>
     <div className="office-title-actions"><span className={"office-working"+(working&&!onBreak?" on":"")} role="status"><i aria-hidden="true"/>{onBreak?"En descanso":working+" trabajando"}</span>
      <button type="button" className={"office-ghost te-toca"+(pending.length+portalNeeds.length?" on":"")} aria-expanded={inboxOpen} onClick={()=>setInboxOpen(!inboxOpen)}>👋 Te toca{pending.length+portalNeeds.length>0&&<b className="need-badge">{pending.length+portalNeeds.length>99?"99+":pending.length+portalNeeds.length}</b>}</button>
      {rest&&<button type="button" className={"office-ghost rest-toggle"+(onBreak?" on":"")} aria-pressed={onBreak} disabled={restBusy} onClick={()=>onBreak?void toggleRest(false):setRestAsk(true)}>{restBusy?"Cambiando…":onBreak?"▶ Volver al trabajo":"🪩 Modo descanso"}</button>}
      <button type="button" className="office-ghost" aria-pressed={view==="list"} onClick={()=>setView(view==="list"?"office":"list")}>{view==="list"?"▦ Oficina":"≡ Lista"}</button></div>
    </div>
    {restAsk&&!onBreak&&<div className="rest-confirm" role="alertdialog" aria-label="Activar modo descanso"><p><strong>¿Mandar a todo el equipo a la Sala de Descanso?</strong> Mientras dure, los agentes de {companyName} quedan <strong>apagados</strong>: no empiezan trabajos ni contestan con IA. Lo que ya esté en marcha termina. Vuelven cuando pulses «Volver al trabajo».</p>
     <div><button type="button" className="office-primary" disabled={restBusy} onClick={()=>void toggleRest(true)}>{restBusy?"Activando…":"Sí, a descansar"}</button><button type="button" className="office-ghost" onClick={()=>setRestAsk(false)}>No</button></div></div>}
    {restNote&&<p className="office-alert" role="alert">{restNote}</p>}
    {onBreak&&<p className="rest-banner" role="status">🪩 <strong>Modo descanso</strong> · todo el equipo está en la Sala de Descanso y los agentes están apagados por decisión tuya.<button type="button" className="office-secondary" disabled={restBusy} onClick={()=>void toggleRest(false)}>Volver al trabajo</button></p>}
    {inboxOpen&&<section className="te-toca-panel" aria-label="Te toca">
     <header><h2>Te toca <small>{pending.length+portalNeeds.length}</small></h2><button type="button" className="office-ghost" onClick={()=>setInboxOpen(false)}>Cerrar</button></header>
     {pending.length+portalNeeds.length===0?<p className="office-empty">Nada pendiente de ti. Cuando un agente se quede bloqueado, tenga un informe listo o el portal avise de algo, aparecerá aquí.</p>:
     <ul>{portalNeeds.slice(0,20).map(n=><li key={"portal:"+n.key} className={"portal lv-"+n.level}><span className="portal-mark" aria-hidden="true">{n.level==="urgente"?"🚨":"⚠️"}</span><span><strong>{n.title}</strong><small>{n.agent} · agente del portal · {n.level==="urgente"?"urgente":"importante"}</small></span>
      {n.panel?<a className="office-secondary" href={n.panel} target="_blank" rel="noopener noreferrer">Abrir panel ↗</a>:<button type="button" className="office-secondary" onClick={()=>{setInboxOpen(false);document.querySelector(".portal-agents")?.scrollIntoView?.({block:"start"});}}>Ver</button>}</li>)}
     {pending.slice(0,30).map(({agent:a,need:n})=><li key={a.id+n.id}><AgentAvatar agent={{...a,needs:[]}} size={34}/><span><strong>{n.title}</strong><small>{a.name} · {NEED_LABEL[n.kind]}</small></span>
      <button type="button" className="office-secondary" onClick={()=>{selectAgent(a.id,true);setInboxOpen(false);}}>Ver</button></li>)}</ul>}
    </section>}
    <div className="office-tabs" role="tablist" aria-label="Departamentos">
     <button type="button" role="tab" aria-selected={focusKey===null} onClick={()=>focusRoom(null)}>Toda la oficina</button>
     {layout.rooms.map(r=><button key={r.key} type="button" role="tab" aria-selected={focusKey===r.key} onClick={()=>focusRoom(r.key)}>{r.name}</button>)}
    </div>
    {error&&<p className="office-alert" role="alert">{error}</p>}
    {!data&&!error&&<p className="office-empty" role="status">{busy?"Consultando la oficina…":"Sin datos todavía."}</p>}
    {data&&view==="list"&&<OfficeList rooms={layout.rooms} agents={agents} selectedId={selectedId} focusKey={focusKey} onSelect={id=>selectAgent(id)}/>}
    {data&&view==="office"&&<div className="office-stage" data-near={zoom>=170?"true":undefined}>
     {show3d?<OfficeScene onBreak={onBreak} layout={layout} agents={agents} ownerName={me} selectedId={selectedId} focusKey={focusKey} arrivals={arrivals} completions={completions} paused={paused||reduced} ambient={ambient} memory={memoryOpen} visible={visible} cameraApi={cameraApi} onSelect={id=>selectAgent(id,true)} onRoom={k=>focusRoom(k)} onZoom={setZoom} onUnavailable={()=>setSceneFailed(true)}
       bubble={a=><AgentBubble agent={a} onActivate={()=>void hire(a.id)} activating={hiring===a.id} canRequest={owner} requestsAvailable={requestsAvailable} onRequest={()=>setRequestOpen(true)} onChat={()=>setChatOpen(true)} onOpenModule={()=>onNavigate("Tareas")} onSeeNeed={()=>onNavigate("Tareas")} onCreate={()=>onNavigate("Campus")} onClose={()=>{setSelectedId(null);focusRoom(null);}}/>}/>
      :<><OfficeMap2D rooms={layout.rooms} cols={layout.cols} agents={agents} ownerName={me} selectedId={selectedId} focusKey={focusKey} onSelect={id=>selectAgent(id)}/>
        <p className="office-help2d" role="note">{sceneFailed?"La escena 3D no se pudo iniciar: se muestra el plano 2D equivalente.":"Este navegador no ofrece WebGL: se muestra el plano 2D equivalente."}</p></>}
     {notice&&<span className="office-arrival-toast" role="status">{notice}</span>}
     {ambient&&<span className="office-ambient-badge" role="status">Modo ambiente · paseos decorativos, no es actividad real</span>}
     {memoryOpen&&<SharedMemory organizationId={companyId} memory={memory} canEdit={owner} token={token} onClose={()=>setMemoryOpen(false)} onSaved={(key,content)=>setMemory(m=>m.state==="ready"?{state:"ready",data:[...m.data.filter(i=>i.key!==key),{key,content,updated_at:new Date().toISOString()}]}:m)}/>}
     {show3d&&<p className="office-hint">Pulsa una mesa para hablar con el agente <span>Arrastra para explorar</span></p>}
     <div className="office-zoom" role="group" aria-label="Controles de la vista">
      {show3d&&focusKey!==null&&<button type="button" className="zoom-all" onClick={()=>{setSelectedId(null);focusRoom(null);}}>⤢ Toda la oficina</button>}
      {show3d&&<><button type="button" aria-label="Alejar" onClick={()=>cameraApi.current?.zoomBy(1/1.25)}>−</button><output aria-label="Zoom">{zoom}%</output><button type="button" aria-label="Acercar" onClick={()=>cameraApi.current?.zoomBy(1.25)}>+</button>
       <button type="button" aria-label="Recentrar" onClick={()=>focusRoom(null)}>⌖</button></>}
      <button type="button" aria-label={paused?"Reanudar animación":"Pausar animación"} aria-pressed={paused} onClick={()=>setPaused(!paused)}>{paused?"▶":"❚❚"}</button>
      <button type="button" aria-label="Memoria compartida" aria-pressed={memoryOpen} className="zoom-team" onClick={()=>setMemoryOpen(!memoryOpen)}>👥</button>
     </div>
    </div>}
    <PortalAgents organizationId={companyId} token={token} now={tick} onSummary={onPortal}/>
   </section>
   {/* Con la escena 3D las acciones salen en el bocadillo del agente; la ficha inferior queda para la lista y el plano */}
   {!show3d&&<AgentBar agent={selected} requestsAvailable={requestsAvailable} canRequest={owner} now={tick} onRequest={()=>setRequestOpen(true)} onOpenModule={()=>onNavigate("Tareas")}
    onChat={selected&&!selected.ghost?()=>setChatOpen(true):undefined} onSeeNeed={()=>onNavigate("Tareas")} onCreate={()=>onNavigate("Campus")}/>}
  </div>}
  {chatOpen&&selected&&!isGhostId(selected.id)&&<AgentChat key={selected.id} organizationId={companyId} agent={selected} token={token} canRequest={owner&&requestsAvailable} onCreated={()=>{const a=new AbortController();reloadExtras(a.signal);void loadRef.current?.();}} onClose={()=>setChatOpen(false)}/>}
  {requestOpen&&selected&&!selected.ghost&&<RequestTaskModal organizationId={companyId} agent={selected} available={requestsAvailable} canRequest={owner} token={token} onClose={()=>setRequestOpen(false)} onCreated={()=>{const a=new AbortController();reloadExtras(a.signal);void loadRef.current?.();}}/>}
 </div>;
}

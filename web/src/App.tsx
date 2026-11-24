import {OperationsOffice} from "./OperationsOffice";
import {FreddyCampus} from "./FreddyCampus";
import {CompanyOffice} from "./office/CompanyOffice";
import {PlanTrackingOverview} from "./PlanTrackingOverview";
import {DurableBudgetTriage} from "./DurableBudgetTriage";
import {ModelUsageLocal} from "./ModelUsageLocal";
import {AgentWorkOverview} from "./AgentWorkOverview";
import {DocumentEvidencePreflight} from "./DocumentEvidencePreflight";
import {GitHubSources} from "./GitHubSources";
import {AnalysisRunControl} from "./AnalysisRunControl";
import {AnalysisApprovalControl} from "./AnalysisApprovalControl";
import {WorkerAvailabilityControl} from "./WorkerAvailabilityControl";
import {TaskAssignmentControl} from "./TaskAssignmentControl";
import {TaskExecutionPreview} from "./TaskExecutionPreview";
import {WorkerAssignments} from "./WorkerAssignments";
import {Eliot3DOrg} from "./Eliot3DOrg";
import {EliotTextChat} from "./EliotTextChat";
import {AISupervision} from "./AISupervision";
import {CompanyActivity} from "./CompanyActivity";
import {TaskStatusControls} from "./TaskStatusControls";
import {TaskEventHistory} from "./TaskEventHistory";
import {TaskCreatePanel} from "./TaskCreatePanel";
import { useEffect, useRef, useState } from "react";
import {READ_ONLY_NOTE,installReadOnlyGuard,loadAccess} from "./readOnly";
import {redeemInvite,stashInviteFromUrl,takeStashedInvite} from "./viewersApi";
import {AccessGate} from "./intro/AccessGate";
import {hasStashedInvite} from "./viewersApi";
import {LoginIntro} from "./intro/LoginIntro";
import {loadAccessConfig,ownLogin,ownPasswordReset,ownSignup,useOwnSession} from "./auth";
import {peekStashedInvite} from "./viewersApi";
try{stashInviteFromUrl(window.location.href,window.sessionStorage,url=>window.history.replaceState(null,"",url));}catch{/* sin almacenamiento: el enlace no se podrá canjear */}
import { useAuth0 } from "./auth";
import {APP_NAME} from "./brand";
import {API_ROOT} from "./holdingApi";
type Company = {id:string;name:string;role:string};
type Department = {id:string;name:string};
type Task = {id:string;department_id:string;assignee_worker_id:string|null;title:string;status:string;created_at:string};
type Worker = {id:string;department_id:string;name:string;specialty:string;state:string};
type Section = "Campus"|"Resumen"|"Oficina 3D"|"Empresas"|"Departamentos"|"Trabajadores IA"|"Tareas"|"Documentos"|"Informes IA"|"Planes IA"|"Asignaciones"|"Actividad"|"Dirección IA"|"Director virtual"|"Organigrama"|"Configuración";
const sections: Section[]=["Campus","Resumen","Oficina 3D","Empresas","Departamentos","Trabajadores IA","Tareas","Documentos","Informes IA","Planes IA","Asignaciones","Actividad","Dirección IA","Director virtual","Organigrama","Configuración"];
/** Lo de todos los días va arriba; el resto queda recogido en «Más herramientas». Nada se ha quitado. */
export const MAIN_SECTIONS:Section[]=["Campus","Oficina 3D","Director virtual","Tareas","Trabajadores IA"];
export const NAV:Record<Section,{label:string;icon:string;hint:string}>={
 "Campus":{label:"La ciudad",icon:"🏙️",hint:"Todas tus empresas de un vistazo, con Freddy en el centro"},
 "Oficina 3D":{label:"Oficina",icon:"🏢",hint:"La oficina de la empresa elegida: sus agentes, lo que te toca y el chat con cada uno"},
 "Director virtual":{label:"Hablar con Freddy",icon:"💬",hint:"Pregúntale a Freddy por escrito o de viva voz"},
 "Tareas":{label:"Tareas",icon:"✅",hint:"Las tareas de la empresa: crearlas, aprobarlas, desbloquearlas y ver su historial"},
 "Trabajadores IA":{label:"Agentes",icon:"👥",hint:"Activar o desactivar cada agente"},
 "Resumen":{label:"Resumen",icon:"📊",hint:"La misma oficina en forma de tabla, sin 3D"},
 "Asignaciones":{label:"Asignaciones",icon:"📌",hint:"Qué tarea tiene cada agente y cuáles están sin asignar"},
 "Documentos":{label:"Documentos",icon:"📁",hint:"Los repositorios de GitHub que los agentes pueden leer"},
 "Informes IA":{label:"Informes",icon:"📝",hint:"Los informes que han escrito los agentes y su revisión"},
 "Planes IA":{label:"Misiones",icon:"🧭",hint:"Trabajos largos por pasos y su piloto automático"},
 "Actividad":{label:"Actividad",icon:"🕒",hint:"El registro de todo lo que ha pasado en la empresa"},
 "Dirección IA":{label:"Supervisión",icon:"🛡️",hint:"Comprobación del estado de cada empresa, para revisar que todo cuadra"},
 "Organigrama":{label:"Organigrama",icon:"🌳",hint:"El árbol de departamentos y agentes"},
 "Empresas":{label:"Empresas",icon:"🏷️",hint:"Lista simple de tus empresas (lo mismo que ves en La ciudad)"},
 "Departamentos":{label:"Departamentos",icon:"🗂️",hint:"Lista simple de departamentos (lo mismo que ves en la Oficina)"},
 "Configuración":{label:"Configuración",icon:"⚙️",hint:"Tu sesión y preferencias"}};
const stored=(k:string)=>{try{return localStorage.getItem(k)==="1";}catch{return false;}};
const store=(k:string,v:boolean)=>{try{localStorage.setItem(k,v?"1":"0");}catch{/* sin almacenamiento */}};
const examples:Record<Section,{title:string,subtitle:string,items:string[]}> = {
"Campus":{title:APP_NAME,subtitle:"Tus empresas, aisladas entre sí, con Freddy como director",items:[]},
"Resumen":{title:"Centro de operaciones",subtitle:"Estructura, tareas y fases documentales consultadas por empresa",items:[]},
"Oficina 3D":{title:"Oficina",subtitle:"Todos tus agentes. Cada encargo. Tu oficina.",items:[]},
"Empresas":{title:"Mis empresas",subtitle:"La separación multiempresa se conectará a PostgreSQL.",items:["Alta y selección de empresas","Miembros y permisos","Proyectos independientes"]},
"Departamentos":{title:"Departamentos",subtitle:"Cada empresa tendrá su propia organización.",items:["Desarrollo","Calidad","Marketing y comercial"]},
"Trabajadores IA":{title:"Trabajadores IA",subtitle:"Agentes especializados, todavía no ejecutándose.",items:["Analista","Desarrollador","Verificador QA"]},
"Tareas":{title:"Tareas",subtitle:"Tareas reales y eventos de actividad autorizados por empresa.",items:["Pendientes","En revisión","Finalizadas"]},
"Documentos":{title:"Fuentes documentales",subtitle:"Repositorios GitHub autorizados por empresa, en modo lectura y sin acceso del modelo",items:[]},
"Informes IA":{title:"Supervisión del trabajo IA",subtitle:"Historial auditable e informes guardados por empresa; ejecución documental autorizada en segundo plano",items:[]},
"Planes IA":{title:"Seguimiento de planes documentales",subtitle:"Planes guardados y pasos derivados del trabajo y la revisión registrados",items:[]},
"Asignaciones":{title:"Asignaciones de trabajadores IA",subtitle:"Tareas pendientes, responsables y estado real por departamento",items:[]},
"Actividad":{title:"Actividad de la empresa",subtitle:"Eventos registrados y auditables · sin acciones simuladas",items:[]},
"Dirección IA":{title:"Supervisión de Dirección IA",subtitle:"Estado verificado de departamentos, tareas y trabajadores de cada empresa",items:[]},
"Director virtual":{title:"Director virtual",subtitle:"Freddy responde a consultas escritas con datos reales de la empresa seleccionada.",items:[]},
"Organigrama":{title:"Organigrama de Freddy",subtitle:"Estructura real por empresa · actividad no simulada",items:[]},
"Configuración":{title:"Configuración",subtitle:"Gestión de perfil, empresas y preferencias.",items:["Autenticación Auth0","Roles por empresa","Marca y apariencia"]}};
export default function App(){
 const {isAuthenticated,isLoading,error,loginWithRedirect,logout,user,getAccessTokenSilently}=useAuth0();
 const [navMore,setNavMore]=useState(()=>stored("nl_nav_more")),[navSlim,setNavSlim]=useState(()=>stored("nl_nav_slim"));
 // ¿Se entra con nuestro formulario o por la página de Auth0? Lo dice el servidor; mientras no conteste, la página de Auth0.
 // Los registros nuevos están cerrados salvo que el servidor diga lo contrario: sin esa orden no se ofrece crear cuenta por ningún camino.
 const {setSession}=useOwnSession(),[ownAccess,setOwnAccess]=useState(false),[signupOpen,setSignupOpen]=useState(false);
 useEffect(()=>{if(isAuthenticated)return;const a=new AbortController();void loadAccessConfig(a.signal).then(v=>{if(!a.signal.aborted){setOwnAccess(v.own);setSignupOpen(v.signup);}});return()=>a.abort();},[isAuthenticated]);
 // Puerta de entrada: el servidor dice si esta cuenta tiene algo que ver aquí y si es de solo consulta. Una invitación pendiente
 // se canjea antes de preguntar. Después se vuelve a preguntar cada minuto y al volver a la pestaña: si te retiran el acceso, sales.
 const [gate,setGate]=useState<"checking"|"allowed"|"denied"|"error">("checking"),[readOnly,setReadOnly]=useState(false),[blocked,setBlocked]=useState(0),[gateTick,setGateTick]=useState(0);
 const [inviteNote,setInviteNote]=useState<{ok:boolean;text:string}|null>(null),redeemed=useRef(false),passed=useRef(false);
 useEffect(()=>{if(!isAuthenticated)return;const a=new AbortController();
  const tk=async()=>String(await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}}));
  const check=async()=>{
   if(!redeemed.current){redeemed.current=true;let invite:string|null=null;try{invite=takeStashedInvite(window.sessionStorage);}catch{invite=null;}
    if(invite){const r=await redeemInvite(invite,tk);if(a.signal.aborted)return;setInviteNote(r.ok?{ok:true,text:"Invitación activada: ya puedes ver «"+r.holding+"» en modo solo consulta."}:{ok:false,text:r.text});}}
   const r=await loadAccess(tk,a.signal);if(a.signal.aborted)return;
   if(r.gate==="allowed"){passed.current=true;setReadOnly(r.readOnly);setGate("allowed");}
   else if(r.gate==="denied"){passed.current=false;setGate("denied");}
   else if(!passed.current)setGate("error");          // un fallo pasajero no echa a quien ya estaba dentro
  };
  void check();
  const timer=window.setInterval(()=>{if(document.visibilityState!=="hidden")void check();},60000),seen=()=>{if(document.visibilityState!=="hidden")void check();};
  document.addEventListener("visibilitychange",seen);
  return()=>{a.abort();window.clearInterval(timer);document.removeEventListener("visibilitychange",seen);};},[isAuthenticated,getAccessTokenSilently,gateTick]);
 useEffect(()=>{if(!readOnly)return;return installReadOnlyGuard(()=>setBlocked(Date.now()));},[readOnly]);
 useEffect(()=>{if(!blocked)return;const t=window.setTimeout(()=>setBlocked(0),4500);return()=>window.clearTimeout(t);},[blocked]);
 const [apiResult,setApiResult]=useState<string>("");
 const [checking,setChecking]=useState(false);
 const [departments,setDepartments]=useState<Department[]>([]);
 const [departmentResult,setDepartmentResult]=useState("");
 const [loadingDepartments,setLoadingDepartments]=useState(false);
 const [workers,setWorkers]=useState<Worker[]>([]);
 const [workerResult,setWorkerResult]=useState("");
 const [loadingWorkers,setLoadingWorkers]=useState(false);
 const [tasks,setTasks]=useState<Task[]>([]);
 const [taskMessage,setTaskMessage]=useState("");
 const [loadingTasks,setLoadingTasks]=useState(false);
 const [companies,setCompanies]=useState<Company[]>([]);
 const [selectedCompany,setSelectedCompany]=useState<string>("");
 function switchCompany(nextId:string){
   setSelectedCompany(nextId);
   setDepartments([]);setWorkers([]);setTasks([]);
   setDepartmentResult("");setWorkerResult("");setTaskMessage("");
 }
 async function checkOrganizations(){
   setChecking(true);setApiResult("");setCompanies([]);setDepartments([]);setWorkers([]);setTasks([]);
   try {
     const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
     const response=await fetch(API_ROOT+"/v1/me/organizations",{headers:{Authorization:`Bearer ${token}`}});
     if(response.ok){ const data:unknown=await response.json(); if(!Array.isArray(data) || !data.every((v:unknown)=>typeof v==="object" && v!==null && typeof (v as Company).id==="string" && typeof (v as Company).name==="string" && typeof (v as Company).role==="string")) throw new Error("Respuesta de empresas inválida"); const verified=data as Company[]; setCompanies(verified);setSelectedCompany(current=>verified.some(v=>v.id===current)?current:(verified[0]?.id??""));setApiResult(verified.length===0?"Autenticación válida. Todavía no hay empresas vinculadas a este usuario.":`Empresas autorizadas: ${verified.length}`); }
     else {setApiResult(`La API ha respondido con código ${response.status}.`);}
   } catch {setApiResult("No se pudo completar la consulta autenticada. Comprueba la sesión y los permisos de Auth0.");}
   finally {setChecking(false);}
 }

 async function loadDepartments(){
  if(!selectedCompany){setDepartmentResult("Primero consulta y selecciona una empresa en Empresas.");return;}
  setLoadingDepartments(true);setDepartmentResult("");setDepartments([]);
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
   const response=await fetch(API_ROOT+"/v1/me/organizations/"+encodeURIComponent(selectedCompany)+"/departments",{headers:{Authorization:`Bearer ${token}`}});
   if(!response.ok){setDepartmentResult("La API ha respondido con código "+response.status+".");return;}
   const data:unknown=await response.json();
   if(!Array.isArray(data)||!data.every((v:unknown)=>typeof v==="object"&&v!==null&&typeof (v as Department).id==="string"&&typeof (v as Department).name==="string"))throw new Error("Invalid departments response");
   setDepartments(data as Department[]);setDepartmentResult("Departamentos autorizados: "+data.length);
  }catch{setDepartmentResult("No se pudo consultar departamentos. Revisa API y permisos.");}
  finally{setLoadingDepartments(false);}
 }
 async function loadWorkers(){
  if(!selectedCompany){setWorkerResult("Selecciona primero una empresa desde Empresas.");return;}
  setLoadingWorkers(true);setWorkerResult("");setWorkers([]);
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
   const response=await fetch(API_ROOT+"/v1/me/organizations/"+encodeURIComponent(selectedCompany)+"/workers",{headers:{Authorization:`Bearer ${token}`}});
   if(!response.ok){setWorkerResult("La API ha respondido con código "+response.status+".");return;}
   const data:unknown=await response.json();
   if(!Array.isArray(data)||!data.every((v:unknown)=>typeof v==="object"&&v!==null&&typeof (v as Worker).id==="string"&&typeof (v as Worker).department_id==="string"&&typeof (v as Worker).name==="string"&&typeof (v as Worker).specialty==="string"&&typeof (v as Worker).state==="string"))throw new Error("Invalid workers");
   setWorkers(data as Worker[]);setWorkerResult("Trabajadores IA registrados: "+data.length);
  }catch{setWorkerResult("No se pudo consultar los trabajadores IA.");}
  finally{setLoadingWorkers(false);}
 }
 async function loadOrgChart(){
  if(!selectedCompany){setDepartmentResult("Selecciona antes una empresa en Empresas.");return;}
  await Promise.all([loadDepartments(),loadWorkers()]);
 }
 async function loadTasks(){
   if(!selectedCompany){setTaskMessage("Selecciona una empresa en Empresas.");return;}
   const currentCompany=selectedCompany;
   setLoadingTasks(true);setTaskMessage("");setTasks([]);setDepartments([]);setWorkers([]);
   try{
     const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
     const endpoint=API_ROOT+"/v1/me/organizations/"+encodeURIComponent(currentCompany)+"/";
     const results=await Promise.all(["tasks","departments","workers"].map(path=>fetch(endpoint+path,{headers:{Authorization:"Bearer "+token}})));
     const failed=results.find(r=>!r.ok);
     if(failed){setTaskMessage("Una de las consultas ha respondido con código "+failed.status+". No se muestra información parcial.");return;}
     const [rawTasks,rawDepartments,rawWorkers]:unknown[]=await Promise.all(results.map(r=>r.json()));
     if(!Array.isArray(rawTasks)||!rawTasks.every((v:unknown)=>typeof v==="object"&&v!==null&&typeof (v as Task).id==="string"&&typeof (v as Task).title==="string"&&typeof (v as Task).department_id==="string"&&typeof (v as Task).status==="string"&&((v as Task).assignee_worker_id===null||typeof (v as Task).assignee_worker_id==="string")))throw Error("Invalid tasks response");
     if(!Array.isArray(rawDepartments)||!rawDepartments.every((v:unknown)=>typeof v==="object"&&v!==null&&typeof (v as Department).id==="string"&&typeof (v as Department).name==="string"))throw Error("Invalid departments response");
     if(!Array.isArray(rawWorkers)||!rawWorkers.every((v:unknown)=>typeof v==="object"&&v!==null&&typeof (v as Worker).id==="string"&&typeof (v as Worker).name==="string"&&typeof (v as Worker).department_id==="string"&&typeof (v as Worker).state==="string"))throw Error("Invalid workers response");
     const validDepts=new Set((rawDepartments as Department[]).map(d=>d.id));
     const validWorkers=new Map((rawWorkers as Worker[]).map(w=>[w.id,w]));
     if((rawTasks as Task[]).some(t=>!validDepts.has(t.department_id)||(t.assignee_worker_id!==null&&(!validWorkers.has(t.assignee_worker_id)||validWorkers.get(t.assignee_worker_id)?.department_id!==t.department_id))))throw Error("Inconsistent task assignment");
     setTasks(rawTasks as Task[]);
     setDepartments(rawDepartments as Department[]);
     setWorkers(rawWorkers as Worker[]);
     setTaskMessage(rawTasks.length===0?"No hay tareas registradas en esta empresa.":"Tareas registradas: "+rawTasks.length);
   }catch{setTaskMessage("No se pudieron verificar las tareas y sus responsables.");}
   finally{setLoadingTasks(false);}
 }
 const [section,setSection]=useState<Section>("Campus");
 if(isLoading)return <main className="container">Comprobando sesión…</main>;
 if(!isAuthenticated){const stashed=peekStashedInvite(window.sessionStorage);
  return <LoginIntro error={error?.message} invited={!!stashed} onLogin={hint=>loginWithRedirect(hint?{authorizationParams:{login_hint:hint}}:undefined)} onSignup={signupOpen?()=>loginWithRedirect({authorizationParams:{screen_hint:"signup"}}):undefined}
   own={ownAccess?{login:(email,password)=>ownLogin(email,password,setSession),reset:ownPasswordReset,signup:stashed&&signupOpen?v=>ownSignup({...v,invite:stashed},setSession):undefined}:undefined}/>;}
 if(gate!=="allowed")return <AccessGate state={gate} account={user?.email||user?.name||""} note={inviteNote&&!inviteNote.ok?inviteNote.text:undefined} onRetry={()=>{setGate("checking");setGateTick(n=>n+1);}} onLogout={()=>logout({logoutParams:{returnTo:window.location.origin}})}/>;
 const page=examples[section];
 return <div className={"workspace"+(navSlim?" nav-slim":"")+(section==="Oficina 3D"?" company-office-workspace":section==="Campus"?" campus-workspace":"")}><aside className="sidebar"><div className="sidebar-head"><div className="brand">ADMINISTRADOR <b>PANEL</b></div><button type="button" className="nav-slim-toggle" aria-pressed={navSlim} aria-label={navSlim?"Mostrar el menú completo":"Recoger el menú para ver más grande"} title={navSlim?"Mostrar el menú":"Recoger el menú"} onClick={()=>{store("nl_nav_slim",!navSlim);setNavSlim(!navSlim);}}>{navSlim?"»":"«"}</button></div><div className="sidebar-caption">{companies.find(c=>c.id===selectedCompany)?.name||"CENTRO MULTIEMPRESA"}</div><nav aria-label="Navegación principal">{(()=>{
 const item=(s:Section)=><button key={s} className={section===s?"nav-button selected":"nav-button"} title={NAV[s].hint} aria-label={NAV[s].label} onClick={e=>{setSection(s);e.currentTarget.scrollIntoView?.({inline:"center",block:"nearest",behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});}} aria-current={section===s?"page":undefined}><span className="nav-ico" aria-hidden="true">{NAV[s].icon}</span><span className="nav-txt">{NAV[s].label}</span></button>;
 const rest=sections.filter(s=>!MAIN_SECTIONS.includes(s)),open=navMore||rest.includes(section);
 return <>{MAIN_SECTIONS.map(item)}<button type="button" className="nav-button nav-more" aria-expanded={open} title="El resto de pantallas: informes, documentos, registro…" onClick={()=>{store("nl_nav_more",!open);setNavMore(!open);}}><span className="nav-ico" aria-hidden="true">{open?"▾":"▸"}</span><span className="nav-txt">Más herramientas</span></button>{open&&rest.map(item)}</>;})()}</nav><div className="sidebar-foot">DESARROLLO · V0.1</div></aside><main className="work-main"><div className="work-top"><span className="stage">ADMINISTRADOR PANEL / {NAV[section].label.toUpperCase()}</span>{readOnly&&<span className="read-only-chip" role="status" title={READ_ONLY_NOTE}>👁 Solo consulta</span>}{blocked>0&&<div className="read-only-toast" role="alert">{READ_ONLY_NOTE}</div>}{inviteNote&&<div className={"invite-note "+(inviteNote.ok?"ok":"bad")} role={inviteNote.ok?"status":"alert"}>{inviteNote.text}<button type="button" aria-label="Cerrar aviso" onClick={()=>setInviteNote(null)}>×</button></div>}<button className="button-outline" onClick={()=>logout({logoutParams:{returnTo:window.location.origin}})}>Cerrar sesión</button></div><div className="greeting">Bienvenido al Centro de Mando</div><p>Sesión de <strong>{user?.name||user?.email||"usuario autenticado"}</strong></p><div className="demo-banner" role="status">Entorno de desarrollo: empresas, departamentos, trabajadores y tareas conectados a PostgreSQL. La ejecución documental en segundo plano requiere autorización previa. La autonomía general sigue en desarrollo.</div><section className="panel"><div className="eyebrow">PLATAFORMA MULTIEMPRESA</div><h1>{page.title}</h1><p>{page.subtitle}</p>{section==="Campus"&&<FreddyCampus companies={companies} onEnterCompany={id=>{if(id!==selectedCompany)switchCompany(id);setSection("Oficina 3D");}} onNavigate={(next,id)=>{if(id!==selectedCompany)switchCompany(id);setSection(next);}} onLoadCompanies={checkOrganizations}/>}{section==="Resumen"&&<OperationsOffice key={selectedCompany+":"+section} companyId={selectedCompany} companies={companies} onSelectCompany={switchCompany} onLoadCompanies={checkOrganizations} onNavigate={setSection} variant="summary"/>}{section==="Oficina 3D"&&<CompanyOffice key={selectedCompany} companyId={selectedCompany} companies={companies} onSelectCompany={switchCompany} onLoadCompanies={checkOrganizations} onNavigate={setSection} ownerName={user?.given_name||user?.name||undefined}/>} {section==="Director virtual" && <EliotTextChat preferredCompanyId={selectedCompany}/>}{section==="Dirección IA" && <AISupervision key={selectedCompany} companies={companies} selectedCompany={selectedCompany} onSelect={switchCompany} onRefreshCompanies={checkOrganizations}/>}{section==="Asignaciones" && <WorkerAssignments key={selectedCompany} companies={companies} selectedCompany={selectedCompany} onSelectCompany={switchCompany} onLoadCompanies={checkOrganizations}/>}{section==="Planes IA" && <PlanTrackingOverview key={selectedCompany+":plans"} companyId={selectedCompany} companies={companies} onSelectCompany={switchCompany} onLoadCompanies={checkOrganizations}/> }{section==="Informes IA" && <AgentWorkOverview key={selectedCompany} companyId={selectedCompany} companies={companies} onSelectCompany={switchCompany} onLoadCompanies={checkOrganizations}/>}{section==="Informes IA" && <ModelUsageLocal key={selectedCompany+":model-budget"} companyId={selectedCompany} role={companies.find(x=>x.id===selectedCompany)?.role??""}/>}{section==="Informes IA" && <DurableBudgetTriage key={selectedCompany+":durable"} companyId={selectedCompany} role={companies.find(x=>x.id===selectedCompany)?.role??""}/>}{section==="Actividad" && <CompanyActivity key={selectedCompany} companyId={selectedCompany} companyName={companies.find(c=>c.id===selectedCompany)?.name||""} companies={companies} onSelectCompany={switchCompany} onLoadCompanies={checkOrganizations}/>}{section==="Documentos" && <GitHubSources key={selectedCompany} organizationId={selectedCompany} organizationName={companies.find(c=>c.id===selectedCompany)?.name||""} role={companies.find(c=>c.id===selectedCompany)?.role||""}/>} {section==="Tareas" && selectedCompany && companies.find(c=>c.id===selectedCompany)?.role==="owner" && <TaskCreatePanel organizationId={selectedCompany} onCreated={loadTasks}/>}{section==="Tareas" && <div className="info"><p>Empresa: <strong>{companies.find(c=>c.id===selectedCompany)?.name??"Ninguna seleccionada"}</strong></p><button disabled={!selectedCompany||loadingTasks} onClick={loadTasks}>{loadingTasks?"Consultando…":"Cargar tareas reales"}</button><p aria-live="polite">{taskMessage}</p>{tasks.length>0&&<div className="company-list">{tasks.map(t=><article className="task-record" key={t.id}><div className="task-record-head"><strong>{t.title}</strong><span>Estado: {t.status}</span></div><div className="task-assignment-meta"><span>Departamento: <strong>{departments.find(d=>d.id===t.department_id)?.name??"Desconocido"}</strong></span><span>Responsable: <strong>{workers.find(w=>w.id===t.assignee_worker_id)?.name??"Sin asignar"}</strong>{workers.find(w=>w.id===t.assignee_worker_id)?.state==="inactive"?" · Inactivo":""}</span></div>{companies.find(c=>c.id===selectedCompany)?.role==="owner"&&<TaskAssignmentControl
 key={t.id+":"+(t.assignee_worker_id||"none")} organizationId={selectedCompany} taskId={t.id}
 departmentId={t.department_id} assigneeWorkerId={t.assignee_worker_id}
 workers={workers} status={t.status} onAssigned={loadTasks}/>}
 <TaskExecutionPreview key={t.id+":"+t.status+":preview"} organizationId={selectedCompany} taskId={t.id}/>{companies.find(c=>c.id===selectedCompany)?.role==="owner"&&<AnalysisApprovalControl key={t.id+":"+(t.assignee_worker_id||"none")} organizationId={selectedCompany} taskId={t.id} workerId={t.assignee_worker_id} workerState={workers.find(w=>w.id===t.assignee_worker_id)?.state??null} taskStatus={t.status}/>}{companies.find(c=>c.id===selectedCompany)?.role==="owner"&&<AnalysisRunControl key={t.id+":"+t.status+":"+(t.assignee_worker_id||"none")} organizationId={selectedCompany} taskId={t.id} taskStatus={t.status} workerId={t.assignee_worker_id} workerState={workers.find(w=>w.id===t.assignee_worker_id)?.state??null}/>}{companies.find(c=>c.id===selectedCompany)?.role==="owner"&&<DocumentEvidencePreflight key={t.id+":evidence:"+(t.assignee_worker_id||"none")} organizationId={selectedCompany} taskId={t.id} taskStatus={t.status} workerId={t.assignee_worker_id} workerState={workers.find(w=>w.id===t.assignee_worker_id)?.state??null}/>} <TaskEventHistory key={t.id+":"+t.status+":"+(t.assignee_worker_id||"none")} organizationId={selectedCompany} taskId={t.id}/>{companies.find(c=>c.id===selectedCompany)?.role==="owner"&&<TaskStatusControls organizationId={selectedCompany} taskId={t.id} status={t.status} onChanged={loadTasks}/>}</article>)}</div>}</div>}{section==="Organigrama" && <div className="org-view"><div className="org-eliot"><strong>✦ Freddy</strong><small>Supervisión global · no activada</small></div><div className="org-line">↓</div><div className="org-company"><strong>{companies.find(c=>c.id===selectedCompany)?.name??"Selecciona una empresa"}</strong><small>Empresa seleccionada</small></div><button disabled={!selectedCompany||loadingDepartments||loadingWorkers} onClick={loadOrgChart}>{loadingDepartments||loadingWorkers?"Consultando…":"Actualizar organigrama real"}</button><p role="status">{departmentResult} {workerResult}</p><div className="org-grid">{departments.map(d=><article className="org-department" key={d.id}><strong>{d.name}</strong>{workers.filter(w=>w.department_id===d.id).map(w=><div className="org-worker" key={w.id}><span>{w.name}</span><small>{w.state==="inactive"?"Inactivo":w.state}</small></div>)}{!workers.some(w=>w.department_id===d.id)&&<small>Sin trabajadores cargados</small>}</article>)}</div><p className="org-caption">Estructura de PostgreSQL. Sin ejecución de agentes ni comunicaciones en vivo.</p>{departments.length>0&&<Eliot3DOrg key={selectedCompany} companyName={companies.find(c=>c.id===selectedCompany)?.name||"Empresa seleccionada"} departments={departments} workers={workers}/>}</div>}{section==="Trabajadores IA" && <div className="info"><p>Empresa: <strong>{companies.find(c=>c.id===selectedCompany)?.name??"Ninguna seleccionada"}</strong></p><button onClick={loadWorkers} disabled={loadingWorkers||!selectedCompany}>{loadingWorkers?"Consultando…":"Cargar trabajadores IA"}</button><p aria-live="polite">{workerResult}</p>{workers.length>0&&<div className="company-list">{workers.map(w=><article className="company-choice" key={w.id}><span><strong>{w.name}</strong> · {w.specialty}</span><span>Estado: {w.state}</span>{companies.find(c=>c.id===selectedCompany)?.role==="owner"&&<WorkerAvailabilityControl key={w.id+":"+w.state} organizationId={selectedCompany} workerId={w.id} state={w.state} onChanged={loadWorkers}/>}</article>)}</div>}</div>}{section==="Departamentos" && <div className="info"><p>Empresa: <strong>{companies.find(c=>c.id===selectedCompany)?.name??"Ninguna seleccionada"}</strong></p><p>Consulta autenticada a PostgreSQL, sin datos de demostración.</p><button onClick={loadDepartments} disabled={loadingDepartments||!selectedCompany}>{loadingDepartments?"Consultando…":"Cargar departamentos"}</button><p aria-live="polite">{departmentResult}</p>{departments.length>0&&<div className="company-list">{departments.map(d=><article className="company-choice" key={d.id}><strong>{d.name}</strong><span>Registrado en PostgreSQL</span></article>)}</div>}</div>}{section==="Empresas" && <div className="info" role="status"><p><strong>Prueba de conexión autenticada</strong></p><p>No se muestran tokens ni datos empresariales. Solo se consulta el número de empresas autorizadas.</p><button disabled={checking} onClick={checkOrganizations}>{checking?"Comprobando…":"Comprobar conexión con API"}</button>{apiResult && <p aria-live="polite">{apiResult}</p>}{companies.length>0 && <div aria-label="Empresas autorizadas" className="company-list">{companies.map(company=><button key={company.id} className={selectedCompany===company.id?"company-choice active":"company-choice"} onClick={()=>switchCompany(company.id)} aria-pressed={selectedCompany===company.id}><strong>{company.name}</strong><span>Rol: {company.role}</span></button>)}</div>}{selectedCompany && <p>Empresa seleccionada: <strong>{companies.find(c=>c.id===selectedCompany)?.name}</strong>. La selección es solo visual; todavía no habilita operaciones empresariales.</p>}</div>}<div className="feature-grid">{page.items.map((item,index)=><article className="feature-card" key={item}><div className="feature-symbol">{["◈","✦","◇"][index%3]}</div><h2>{item}</h2><span>En preparación</span></article>)}</div></section><footer>Nova Demo · Entorno de desarrollo</footer></main></div>
}


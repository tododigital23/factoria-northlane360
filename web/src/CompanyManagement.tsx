import {useCallback,useEffect,useId,useRef,useState} from "react";
import type {KeyboardEvent} from "react";
import {useAuth0} from "./auth";
import {CAPABILITIES,CAPABILITY_INFO,STATE_LABEL} from "./holdingApi";
import type {Capability,CapabilityState,HoldingCompany,ManageTab} from "./holdingApi";
import {CADENCES,CADENCE_LABEL,ROUTINE_TEMPLATES,companyNamePayload,retirePayload,validRetireAck,validRenameAck,validateCompanyName,emptyRoutine,newestFirst,profilePayload,routinePayload,urls,validCapabilityAck,validControlAck,validDepartments,validMessageList,validProfileAck,validRoutineAck,validRoutineList,validRunDueAck,validWorkers,validateProfile,validateRoutine} from "./companyManagementApi";
import {useDialogFocus} from "./office/useDialogFocus";
import {IntegrationTab} from "./IntegrationTab";
import type {AgentMessage,CapabilityChange,Department,ProfileDraft,Routine,RoutineDraft,Worker} from "./companyManagementApi";

export const MANAGEMENT_UNAVAILABLE="La gestión de la empresa aún no está disponible en el servidor (actualización 034). No se muestran controles.";
export const MANAGEMENT_UNCONFIRMED="No se ha podido confirmar el resultado. Puedes reintentar: se enviará exactamente la misma solicitud.";
const READ={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}};
const WRITE={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}};
type Sent={kind:"ok";raw:unknown}|{kind:"status";status:number}|{kind:"uncertain"}|{kind:"aborted"};
type Op="profile"|"rename"|"retire"|"capability"|"routine"|"control"|"runDue";
const conflict:Record<Op,string>={
 profile:"El servidor no ha guardado el perfil: ahora mismo la empresa no admite este cambio.",
 rename:"No se ha cambiado el nombre: ya hay otra empresa con ese nombre en el holding.",
 retire:"No se ha retirado: el nombre escrito no coincide o la empresa tiene pilotos automáticos en marcha. Páralos y vuelve a intentarlo.",
 capability:"El servidor no ha aplicado el cambio: la capacidad ya cambió de estado o no se puede modificar aquí.",
 routine:"El servidor no ha creado la rutina: ya existe una igual, o el agente o el departamento ya no son válidos.",
 control:"La rutina ya no permite ese cambio. Actualiza la lista.",
 runDue:"No se han podido crear las tareas vencidas ahora mismo. Vuelve a intentarlo más tarde."
};
function statusMessage(op:Op,status:number){
 if(status===409)return conflict[op];
 if(status===403)return "No tienes permiso para esta acción en esta empresa.";
 if(status===422)return "El servidor ha rechazado los datos. Revísalos y vuelve a intentarlo.";
 return MANAGEMENT_UNAVAILABLE;
}
/** Peticiones con token; distingue rechazo explícito, resultado incierto y cancelación. */
function useApi(){
 const {getAccessTokenSilently}=useAuth0();
 const get=useCallback(async(url:string,signal:AbortSignal)=>{
  const token=await getAccessTokenSilently(READ);if(signal.aborted)throw new DOMException("aborted","AbortError");
  return fetch(url,{headers:{Authorization:"Bearer "+token},signal});
 },[getAccessTokenSilently]);
 const post=useCallback(async(url:string,body:string|undefined,signal:AbortSignal):Promise<Sent>=>{
  let r:Response;
  try{
   const token=await getAccessTokenSilently(WRITE);if(signal.aborted)return {kind:"aborted"};
   r=await fetch(url,{method:"POST",signal,headers:{Authorization:"Bearer "+token,...(body!==undefined?{"Content-Type":"application/json"}:{})},...(body!==undefined?{body}:{})});
  }catch{return signal.aborted?{kind:"aborted"}:{kind:"uncertain"};}
  if(signal.aborted)return {kind:"aborted"};
  if([403,404,409,422,503].includes(r.status))return {kind:"status",status:r.status===404?503:r.status};
  if(!r.ok)return {kind:"uncertain"};
  try{const raw:unknown=await r.json();return signal.aborted?{kind:"aborted"}:{kind:"ok",raw};}catch{return signal.aborted?{kind:"aborted"}:{kind:"uncertain"};}
 },[getAccessTokenSilently]);
 return {get,post};
}
/** Controlador que se cancela al desmontar y guarda contra doble clic. */
function useRunner(){
 const controller=useRef(new AbortController()),guard=useRef(false),[busy,setBusy]=useState<string|null>(null);
 useEffect(()=>{const c=new AbortController();controller.current=c;return()=>c.abort();},[]);
 const run=useCallback(async(name:string,fn:(signal:AbortSignal)=>Promise<void>)=>{
  if(guard.current)return;guard.current=true;setBusy(name);const signal=controller.current.signal;
  try{await fn(signal);}finally{if(!signal.aborted){guard.current=false;setBusy(null);}}
 },[]);
 return {busy,run};
}

type RoutineState={state:"loading"}|{state:"ready";routines:Routine[]}|{state:"unavailable"}|{state:"error"};
const TABS:[ManageTab,string][]=[["profile","Perfil y capacidades"],["routines","Tareas recurrentes"],["messages","Mensajes entre agentes"],["integration","Integración"]];

export function CompanyManagement({company,canEdit,tab,onTab,onClose,onChanged}:{company:HoldingCompany;canEdit:boolean;tab:ManageTab;onTab:(t:ManageTab)=>void;onClose:()=>void;onChanged:()=>void}){
 const dialogRef=useRef<HTMLDivElement>(null);useDialogFocus(dialogRef);
 const {get}=useApi();const org=company.organization_id;
 const [routines,setRoutines]=useState<RoutineState>({state:"loading"}),[tick,setTick]=useState(0);
 const titleId=useId(),base=useId(),tabRefs=useRef<(HTMLButtonElement|null)[]>([]);
 // GET /routines también indica si la actualización 034 está instalada.
 useEffect(()=>{
  const abort=new AbortController();
  (async()=>{try{
   const r=await get(urls.routines(org),abort.signal);if(abort.signal.aborted)return;
   if(r.status===404||r.status===503){setRoutines({state:"unavailable"});return;}
   if(!r.ok){setRoutines({state:"error"});return;}
   const raw:unknown=await r.json();if(abort.signal.aborted)return;
   if(!validRoutineList(raw)){setRoutines({state:"error"});return;}
   setRoutines(raw.enabled?{state:"ready",routines:raw.routines}:{state:"unavailable"});
  }catch{if(!abort.signal.aborted)setRoutines({state:"error"});}})();
  return()=>abort.abort();
 },[org,tick,get]);
 const reloadRoutines=useCallback(()=>setTick(t=>t+1),[]);
 const unavailable=useCallback(()=>setRoutines({state:"unavailable"}),[]);
 function onKey(e:KeyboardEvent,i:number){
  const L=TABS.length;const n=e.key==="ArrowRight"?(i+1)%L:e.key==="ArrowLeft"?(i+L-1)%L:e.key==="Home"?0:e.key==="End"?L-1:-1;
  if(n<0)return;e.preventDefault();onTab(TABS[n][0]);tabRefs.current[n]?.focus();
 }
 const available=routines.state==="ready"?true:routines.state==="loading"?null:false;
 return <div className="wizard-backdrop" onKeyDown={e=>{if(e.key==="Escape")onClose();}}>
  <div className="wizard management" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
   <div className="wizard-head"><div><span className="guide-eyebrow">PARCELA {company.slot} · GESTIÓN DE LA EMPRESA</span><h2 id={titleId}>{company.name}</h2></div><button type="button" className="guide-toggle" onClick={onClose}>Cerrar</button></div>
   {!canEdit&&<p className="wizard-help">Solo quien es propietario del holding puede cambiar la configuración. Puedes consultar los datos.</p>}
   <div className="management-tabs" role="tablist" aria-label="Secciones de gestión">{TABS.map(([k,l],i)=><button key={k} type="button" role="tab" id={base+k} aria-controls={base+k+"-panel"} aria-selected={tab===k} tabIndex={tab===k?0:-1} ref={el=>{tabRefs.current[i]=el;}} onClick={()=>onTab(k)} onKeyDown={e=>onKey(e,i)}>{l}</button>)}</div>
   <div role="tabpanel" id={base+tab+"-panel"} aria-labelledby={base+tab} className="management-panel">
    {tab==="profile"&&<ProfileTab key={org} company={company} canEdit={canEdit} available={available} onChanged={onChanged} onUnavailable={unavailable}/>}
    {tab==="routines"&&<RoutinesTab key={org} company={company} canEdit={canEdit} state={routines} onReload={reloadRoutines} onChanged={onChanged} onUnavailable={unavailable}/>}
    {tab==="messages"&&<MessagesTab key={org} org={org}/>}
    {tab==="integration"&&<IntegrationTab key={org} company={company} canEdit={canEdit}/>}
   </div>
  </div>
 </div>;
}

/* ---------- Retirar la empresa (038) ---------- */
/** Saca la empresa de La Factoría y deja libre su parcela. No borra datos; hay que escribir su nombre. */
function RetireCompanyCard({company,onChanged,onUnavailable}:{company:HoldingCompany;onChanged:()=>void;onUnavailable:()=>void}){
 const {post}=useApi();const {busy,run}=useRunner();const org=company.organization_id;const uid=useId();
 const [open,setOpen]=useState(false),[typed,setTyped]=useState(""),[error,setError]=useState("");
 const match=typed.trim()===company.name;
 const retire=()=>run("retire",async signal=>{
  if(!match)return;setError("");
  const r=await post(urls.retire(org),JSON.stringify(retirePayload(typed)),signal);if(r.kind==="aborted")return;
  if(r.kind==="status"){if(r.status===503)onUnavailable();else setError(statusMessage("retire",r.status));return;}
  if(r.kind==="uncertain"||!validRetireAck(r.raw,org)){setError("No se ha podido confirmar. Cierra y mira el Campus: si la parcela "+company.slot+" está libre, la empresa ya se retiró.");onChanged();return;}
  onChanged();
 });
 return <section aria-label="Retirar la empresa" className="management-card management-danger">
  <h3>Retirar la empresa</h3>
  <p className="wizard-help">Saca «{company.name}» de La Factoría y deja libre la parcela {company.slot} para una empresa nueva. No se borra nada: sus datos, agentes y documentos se conservan, pero dejarás de verla y sus tareas recurrentes se pausan. Volver a traerla solo puede hacerlo un administrador.</p>
  {!open?<button type="button" className="campus-ghost danger" onClick={()=>setOpen(true)}>Retirar esta empresa…</button>:<>
   <div className="wizard-field"><label htmlFor={uid+"r"}>Escribe el nombre exacto para confirmar: <b>{company.name}</b></label>
    <input id={uid+"r"} value={typed} maxLength={200} autoComplete="off" autoCapitalize="off" spellCheck={false} disabled={!!busy} onChange={e=>{setTyped(e.target.value);setError("");}}/></div>
   <div className="management-actions"><button type="button" className="campus-primary danger" disabled={!!busy||!match} onClick={()=>void retire()}>{busy==="retire"?"Retirando…":"Retirar y liberar la parcela "+company.slot}</button>
    <button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>{setOpen(false);setTyped("");setError("");}}>Cancelar</button></div></>}
  {error&&<p className="wizard-error" role="alert">{error}</p>}
 </section>;
}

/* ---------- Perfil y capacidades ---------- */
/** 036: cambia solo el nombre de la empresa. No mueve datos, agentes ni permisos. */
function CompanyNameCard({company,canEdit,onChanged,onUnavailable}:{company:HoldingCompany;canEdit:boolean;onChanged:()=>void;onUnavailable:()=>void}){
 const {post}=useApi();const {busy,run}=useRunner();const org=company.organization_id;const uid=useId();
 const [name,setName]=useState(company.name),[message,setMessage]=useState(""),[error,setError]=useState(""),[retry,setRetry]=useState(false);
 const frozen=useRef<string|null>(null);
 useEffect(()=>{setName(company.name);},[company.name]);
 const problem=validateCompanyName(name);const same=name.trim()===company.name;
 const save=()=>run("rename",async signal=>{
  if(!retry||!frozen.current){if(problem||same)return;frozen.current=JSON.stringify(companyNamePayload(name));}
  setMessage("");setError("");
  const sent=(JSON.parse(frozen.current) as {name:string}).name;
  const r=await post(urls.name(org),frozen.current,signal);if(r.kind==="aborted")return;
  if(r.kind==="status"){frozen.current=null;setRetry(false);if(r.status===503)onUnavailable();else setError(statusMessage("rename",r.status));return;}
  if(r.kind==="uncertain"||!validRenameAck(r.raw,org,sent)){setRetry(true);setError(MANAGEMENT_UNCONFIRMED);return;}
  frozen.current=null;setRetry(false);setMessage(r.raw.renamed?`La empresa ahora se llama «${r.raw.name}».`:"La empresa ya tenía ese nombre.");onChanged();
 });
 return <section aria-label="Nombre de la empresa" className="management-card">
  <h3>Nombre de la empresa</h3>
  <div className="wizard-field"><label htmlFor={uid+"n"}>Nombre</label>
   <input id={uid+"n"} value={name} maxLength={200} onChange={e=>{setName(e.target.value);frozen.current=null;setRetry(false);setMessage("");setError("");}} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();if(retry?!!frozen.current:(!problem&&!same))void save();}}} enterKeyHint="done" aria-invalid={!!problem} aria-describedby={uid+"n-h"} disabled={!canEdit||!!busy}/>
   <small id={uid+"n-h"} className={problem?"wizard-error":undefined}>{problem||"Cambia solo el nombre: datos, agentes y permisos de la empresa no se tocan. No puede repetirse dentro del holding."}</small></div>
  {canEdit&&<button type="button" className="campus-primary" disabled={!!busy||(retry?!frozen.current:(!!problem||same))} onClick={()=>void save()}>{busy==="rename"?"Guardando…":retry?"Reintentar el mismo cambio":"Cambiar nombre"}</button>}
  {message&&<p className="management-ok" role="status">{message}</p>}
  {error&&<p className="wizard-error" role="alert">{error}</p>}
 </section>;
}

function ProfileTab({company,canEdit,available,onChanged,onUnavailable}:{company:HoldingCompany;canEdit:boolean;available:boolean|null;onChanged:()=>void;onUnavailable:()=>void}){
 const {post}=useApi();const {busy,run}=useRunner();const org=company.organization_id;const uid=useId();
 const [draft,setDraft]=useState<ProfileDraft>({project_name:company.project_name,project_summary:company.project_summary,repository:company.repository??"",website_url:company.website_url??""});
 const [message,setMessage]=useState(""),[error,setError]=useState(""),[retry,setRetry]=useState(false),[pendingDisable,setPendingDisable]=useState<Capability|null>(null);
 const [overrides,setOverrides]=useState<Partial<Record<Capability,CapabilityState>>>({});
 const frozen=useRef<string|null>(null);
 useEffect(()=>{setOverrides({});},[company]);
 const errors=validateProfile(draft);const invalid=Object.keys(errors).length>0;
 function edit(k:keyof ProfileDraft,v:string){setDraft(d=>({...d,[k]:v}));frozen.current=null;setRetry(false);setMessage("");setError("");}
 const saveProfile=()=>run("profile",async signal=>{
  if(!retry||!frozen.current){if(invalid)return;frozen.current=JSON.stringify(profilePayload(draft));}
  setMessage("");setError("");
  const r=await post(urls.profile(org),frozen.current,signal);if(r.kind==="aborted")return;
  if(r.kind==="status"){frozen.current=null;setRetry(false);if(r.status===503)onUnavailable();else setError(statusMessage("profile",r.status));return;}
  if(r.kind==="uncertain"||!validProfileAck(r.raw,org)){setRetry(true);setError(MANAGEMENT_UNCONFIRMED);return;}
  frozen.current=null;setRetry(false);setMessage("Perfil guardado.");onChanged();
 });
 const changeCapability=(cap:Capability,state:CapabilityChange)=>run("cap:"+cap,async signal=>{
  setMessage("");setError("");setPendingDisable(null);
  const r=await post(urls.capability(org,cap),JSON.stringify({state}),signal);if(r.kind==="aborted")return;
  if(r.kind==="status"){if(r.status===503)onUnavailable();else setError(statusMessage("capability",r.status));return;}
  if(r.kind==="uncertain"||!validCapabilityAck(r.raw,org,cap,state)){setError(`No se ha podido confirmar el cambio de «${CAPABILITY_INFO[cap].label}». Consulta el estado antes de repetirlo; repetirlo no duplica nada.`);return;}
  setOverrides(o=>({...o,[cap]:state}));
  setMessage(state==="planned"?`«${CAPABILITY_INFO[cap].label}» añadida como planificada${r.raw&&(r.raw as {departments_created:number}).departments_created>0?": se ha creado su departamento con un agente inactivo.":"."}`:`«${CAPABILITY_INFO[cap].label}» desactivada. Sus departamentos y agentes se conservan.`);
  onChanged();
 });
 if(available===null)return <p>Comprobando si la gestión está disponible…</p>;
 if(!available)return <p className="management-note" role="status">{MANAGEMENT_UNAVAILABLE}</p>;
 const states=new Map(company.capabilities.map(c=>[c.capability,c.state]));
 const show=(k:keyof ProfileDraft)=>errors[k];
 const field=(k:"project_name"|"repository"|"website_url",label:string,help:string,extra:object={})=><div className="wizard-field"><label htmlFor={uid+k}>{label}</label>
  <input id={uid+k} value={draft[k]} onChange={e=>edit(k,e.target.value)} aria-invalid={!!show(k)} aria-describedby={uid+k+"-h"} disabled={!canEdit||!!busy} {...extra}/>
  <small id={uid+k+"-h"} className={show(k)?"wizard-error":undefined}>{show(k)||help}</small></div>;
 return <div className="management-grid">
  <CompanyNameCard company={company} canEdit={canEdit} onChanged={onChanged} onUnavailable={onUnavailable}/>
  <section aria-label="Perfil del proyecto" className="management-card">
   <h3>Perfil del proyecto</h3>
   {field("project_name","Nombre del proyecto","Entre 2 y 120 caracteres.",{maxLength:200})}
   <div className="wizard-field"><label htmlFor={uid+"summary"}>Resumen del proyecto</label><textarea id={uid+"summary"} rows={4} maxLength={800} value={draft.project_summary} onChange={e=>edit("project_summary",e.target.value)} aria-invalid={!!show("project_summary")} aria-describedby={uid+"summary-h"} disabled={!canEdit||!!busy}/>
    <small id={uid+"summary-h"} className={show("project_summary")?"wizard-error":undefined}>{show("project_summary")||"Entre 10 y 600 caracteres."}</small></div>
   {field("repository","Repositorio GitHub (opcional)","Formato propietario/repositorio. Vacío = sin repositorio.",{spellCheck:false,autoCapitalize:"off",placeholder:"propietario/repositorio"})}
   {field("website_url","Web del proyecto (opcional)","Dirección completa con https://. Vacío = sin web.",{spellCheck:false,autoCapitalize:"off",placeholder:"https://",type:"url"})}
   {canEdit&&<button type="button" className="campus-primary" disabled={!!busy||(retry?!frozen.current:invalid)} onClick={()=>void saveProfile()}>{busy==="profile"?"Guardando…":retry?"Reintentar el mismo guardado":"Guardar perfil"}</button>}
  </section>
  <section aria-label="Capacidades" className="management-card">
   <h3>Capacidades</h3>
   <p className="wizard-help">Añadir una capacidad la deja <strong>planificada</strong> y crea su departamento con un agente <strong>inactivo</strong> si aún no existe. Conectar el servicio real (email, tienda, analítica…) será un paso posterior con credenciales seguras; por eso aquí no se puede marcar como activa. Desactivar nunca borra departamentos ni agentes.</p>
   <ul className="management-caps">{CAPABILITIES.map(c=>{const s=overrides[c]??states.get(c);const on=!!s&&s!=="disabled";return <li key={c}>
    <div><strong>{CAPABILITY_INFO[c].label}</strong><small>{CAPABILITY_INFO[c].explains}</small></div>
    <span className={"cap-badge cap-"+(s??"none")}>{s?STATE_LABEL[s]:"No elegida"}</span>
    {canEdit&&(on?(pendingDisable===c?<span className="management-confirm"><button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void changeCapability(c,"disabled")} aria-label={"Confirmar desactivar "+CAPABILITY_INFO[c].label}>Confirmar</button><button type="button" className="campus-ghost" onClick={()=>setPendingDisable(null)}>Cancelar</button></span>
     :<button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>setPendingDisable(c)} aria-label={"Desactivar "+CAPABILITY_INFO[c].label}>Desactivar</button>)
     :<button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void changeCapability(c,"planned")} aria-label={"Añadir "+CAPABILITY_INFO[c].label}>{busy==="cap:"+c?"Añadiendo…":"Añadir"}</button>)}
   </li>;})}</ul>
  </section>
  {message&&<p role="status" className="management-ok">{message}</p>}{error&&<p role="alert" className="wizard-error">{error}</p>}
  {canEdit&&<div className="wide"><RetireCompanyCard company={company} onChanged={onChanged} onUnavailable={onUnavailable}/></div>}
 </div>;
}

/* ---------- Tareas recurrentes ---------- */
function RoutinesTab({company,canEdit,state,onReload,onChanged,onUnavailable}:{company:HoldingCompany;canEdit:boolean;state:RoutineState;onReload:()=>void;onChanged:()=>void;onUnavailable:()=>void}){
 const {get,post}=useApi();const {busy,run}=useRunner();const org=company.organization_id;const uid=useId();
 const [team,setTeam]=useState<{departments:Department[];workers:Worker[]}|null>(null),[teamError,setTeamError]=useState(false);
 const [draft,setDraft]=useState<RoutineDraft>(emptyRoutine),[touched,setTouched]=useState(false);
 const [message,setMessage]=useState(""),[error,setError]=useState(""),[retry,setRetry]=useState(false);
 const frozen=useRef<string|null>(null);
 useEffect(()=>{
  if(state.state!=="ready")return;const abort=new AbortController();setTeamError(false);
  (async()=>{try{
   const [d,w]=await Promise.all([get(urls.departments(org),abort.signal),get(urls.workers(org),abort.signal)]);if(abort.signal.aborted)return;
   if(!d.ok||!w.ok)throw Error("team");
   const [rd,rw]:unknown[]=await Promise.all([d.json(),w.json()]);if(abort.signal.aborted)return;
   if(!validDepartments(rd)||!validWorkers(rw,rd))throw Error("invalid team");
   setTeam({departments:rd,workers:rw});
  }catch{if(!abort.signal.aborted){setTeam(null);setTeamError(true);}}})();
  return()=>abort.abort();
 },[org,state.state,get]);
 if(state.state==="loading")return <p>Consultando las tareas recurrentes…</p>;
 if(state.state==="unavailable")return <p className="management-note" role="status">{MANAGEMENT_UNAVAILABLE}</p>;
 if(state.state==="error")return <p role="alert">No se han podido verificar las tareas recurrentes. No se muestran controles. <button type="button" className="campus-ghost" onClick={onReload}>Reintentar</button></p>;
 const routines=state.routines,workers=team?.workers??[],departments=team?.departments??[];
 const errors=validateRoutine(draft,workers);const invalid=Object.keys(errors).length>0;
 const show=(k:keyof RoutineDraft)=>touched?errors[k]:undefined;
 function edit(patch:Partial<RoutineDraft>){setDraft(d=>({...d,...patch}));frozen.current=null;setRetry(false);setMessage("");setError("");}
 function applyTemplate(t:typeof ROUTINE_TEMPLATES[number],dep:Department){
  edit({department_id:dep.id,worker_id:workers.find(w=>w.department_id===dep.id)?.id??"",title:t.title,instructions:t.instructions,cadence:t.cadence,capability:t.capability??""});
 }
 const create=()=>run("create",async signal=>{
  setTouched(true);
  if(!retry||!frozen.current){if(invalid)return;frozen.current=JSON.stringify(routinePayload(draft,crypto.randomUUID()));}
  setMessage("");setError("");
  const r=await post(urls.routines(org),frozen.current,signal);if(r.kind==="aborted")return;
  if(r.kind==="status"){frozen.current=null;setRetry(false);if(r.status===503)onUnavailable();else setError(statusMessage("routine",r.status));return;}
  if(r.kind==="uncertain"||!validRoutineAck(r.raw,org)){setRetry(true);setError(MANAGEMENT_UNCONFIRMED);return;}
  frozen.current=null;setRetry(false);setDraft(emptyRoutine());setTouched(false);setMessage("Rutina creada. Creará una tarea pendiente en cada periodo; no ejecuta nada por sí sola.");onReload();onChanged();
 });
 const control=(r:Routine,next:"active"|"paused")=>run("control:"+r.id,async signal=>{
  setMessage("");setError("");
  const res=await post(urls.routineControl(org,r.id),JSON.stringify({state:next}),signal);if(res.kind==="aborted")return;
  if(res.kind==="status"){if(res.status===503)onUnavailable();else setError(statusMessage("control",res.status));return;}
  if(res.kind==="uncertain"||!validControlAck(res.raw,org,r.id,next)){setError("No se ha podido confirmar el cambio de la rutina. Actualiza la lista antes de repetirlo.");return;}
  setMessage(next==="paused"?`«${r.title}» en pausa.`:`«${r.title}» reanudada.`);onReload();onChanged();
 });
 const runDue=()=>run("runDue",async signal=>{
  setMessage("");setError("");
  const res=await post(urls.runDue(org),undefined,signal);if(res.kind==="aborted")return;
  if(res.kind==="status"){if(res.status===503)onUnavailable();else setError(statusMessage("runDue",res.status));return;}
  if(res.kind==="uncertain"||!validRunDueAck(res.raw,org)){setError("No se ha podido confirmar cuántas tareas se han creado. Revisa «Tareas» antes de repetirlo.");return;}
  const n=res.raw.tasks_created;setMessage(n===0?"No había tareas vencidas: no se ha creado ninguna.":`Se han creado ${n} tarea${n===1?"":"s"} pendiente${n===1?"":"s"}. No se ha ejecutado nada.`);onReload();onChanged();
 });
 const templates=ROUTINE_TEMPLATES.flatMap(t=>{const dep=departments.find(d=>d.name===t.department);return dep?[{t,dep}]:[];});
 const depWorkers=workers.filter(w=>w.department_id===draft.department_id);
 return <div className="management-grid">
  <p className="management-note">Una tarea recurrente solo crea una <strong>tarea pendiente</strong> en cada periodo para el agente elegido. No ejecuta nada ni gasta cuota: la ejecución sigue necesitando tu autorización.</p>
  <section aria-label="Rutinas de la empresa" className="management-card wide">
   <div className="management-row"><h3>Rutinas ({routines.length})</h3>
    {canEdit&&<button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void runDue()}>{busy==="runDue"?"Creando tareas…":"Crear tareas vencidas ahora"}</button>}</div>
   {routines.length===0?<p>Todavía no hay tareas recurrentes. Empieza con una sugerencia.</p>:
   <ul className="management-list">{routines.map(r=><li key={r.id}>
    <div><strong>{r.title}</strong><small>{r.department} · {r.worker} · {CADENCE_LABEL[r.cadence]}{r.capability?" · "+CAPABILITY_INFO[r.capability].short:""}</small><small>{r.runs} periodo{r.runs===1?"":"s"} generado{r.runs===1?"":"s"}{r.last_period?" · último: "+r.last_period:""}</small></div>
    <span className={"cap-badge "+(r.state==="active"?"cap-enabled":"cap-disabled")}>{r.state==="active"?"Activa":"En pausa"}</span>
    {canEdit&&<button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void control(r,r.state==="active"?"paused":"active")} aria-label={(r.state==="active"?"Pausar ":"Reanudar ")+r.title}>{r.state==="active"?"Pausar":"Reanudar"}</button>}
   </li>)}</ul>}
  </section>
  {canEdit&&<section aria-label="Nueva tarea recurrente" className="management-card wide">
   <h3>Nueva tarea recurrente</h3>
   {teamError&&<p role="alert">No se han podido verificar los departamentos y agentes. No se puede crear una rutina.</p>}
   {!team&&!teamError&&<p>Consultando departamentos y agentes…</p>}
   {team&&<>
    {templates.length>0&&<div className="management-templates" role="group" aria-label="Sugerencias rápidas">{templates.map(({t,dep})=><button key={t.title} type="button" className="guide-link" onClick={()=>applyTemplate(t,dep)} disabled={!!busy}>{t.title}</button>)}</div>}
    <div className="management-form">
     <div className="wizard-field"><label htmlFor={uid+"dep"}>Departamento</label><select id={uid+"dep"} value={draft.department_id} disabled={!!busy} aria-invalid={!!show("department_id")} onChange={e=>edit({department_id:e.target.value,worker_id:workers.find(w=>w.department_id===e.target.value)?.id??""})}><option value="">Elige un departamento</option>{departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select>{show("department_id")&&<small className="wizard-error">{show("department_id")}</small>}</div>
     <div className="wizard-field"><label htmlFor={uid+"wk"}>Agente responsable</label><select id={uid+"wk"} value={draft.worker_id} disabled={!!busy||!draft.department_id} aria-invalid={!!show("worker_id")} onChange={e=>edit({worker_id:e.target.value})}><option value="">{draft.department_id&&depWorkers.length===0?"Este departamento no tiene agentes":"Elige un agente"}</option>{depWorkers.map(w=><option key={w.id} value={w.id}>{w.name}{w.state==="inactive"?" (inactivo)":""}</option>)}</select>{show("worker_id")&&<small className="wizard-error">{show("worker_id")}</small>}</div>
     <div className="wizard-field"><label htmlFor={uid+"t"}>Título</label><input id={uid+"t"} value={draft.title} maxLength={200} disabled={!!busy} aria-invalid={!!show("title")} onChange={e=>edit({title:e.target.value})}/><small className={show("title")?"wizard-error":undefined}>{show("title")||"Entre 3 y 160 caracteres."}</small></div>
     <div className="wizard-field"><label htmlFor={uid+"c"}>Frecuencia</label><select id={uid+"c"} value={draft.cadence} disabled={!!busy} onChange={e=>edit({cadence:e.target.value as RoutineDraft["cadence"]})}>{CADENCES.map(c=><option key={c} value={c}>{CADENCE_LABEL[c]}</option>)}</select></div>
     <div className="wizard-field full"><label htmlFor={uid+"i"}>Instrucciones</label><textarea id={uid+"i"} rows={4} maxLength={2400} value={draft.instructions} disabled={!!busy} aria-invalid={!!show("instructions")} onChange={e=>edit({instructions:e.target.value})}/><small className={show("instructions")?"wizard-error":undefined}>{show("instructions")||"Entre 10 y 2000 caracteres."}</small></div>
     <div className="wizard-field"><label htmlFor={uid+"cap"}>Capacidad relacionada (opcional)</label><select id={uid+"cap"} value={draft.capability} disabled={!!busy} onChange={e=>edit({capability:e.target.value as RoutineDraft["capability"]})}><option value="">Ninguna</option>{CAPABILITIES.map(c=><option key={c} value={c}>{CAPABILITY_INFO[c].label}</option>)}</select></div>
    </div>
    <button type="button" className="campus-primary" disabled={!!busy||(retry&&!frozen.current)} onClick={()=>void create()}>{busy==="create"?"Creando…":retry?"Reintentar la misma solicitud":"Crear tarea recurrente"}</button>
   </>}
  </section>}
  {message&&<p role="status" className="management-ok">{message}</p>}{error&&<p role="alert" className="wizard-error">{error}</p>}
 </div>;
}

/* ---------- Mensajes entre agentes ---------- */
function MessagesTab({org}:{org:string}){
 const {get}=useApi();
 const [state,setState]=useState<{state:"loading"}|{state:"ready";messages:AgentMessage[]}|{state:"unavailable"}|{state:"error"}>({state:"loading"}),[tick,setTick]=useState(0);
 useEffect(()=>{
  const abort=new AbortController();setState({state:"loading"});
  (async()=>{try{
   const r=await get(urls.messages(org),abort.signal);if(abort.signal.aborted)return;
   if(r.status===404||r.status===503){setState({state:"unavailable"});return;}
   if(!r.ok){setState({state:"error"});return;}
   const raw:unknown=await r.json();if(abort.signal.aborted)return;
   if(!validMessageList(raw,org)){setState({state:"error"});return;}
   setState(raw.enabled?{state:"ready",messages:newestFirst(raw.messages)}:{state:"unavailable"});
  }catch{if(!abort.signal.aborted)setState({state:"error"});}})();
  return()=>abort.abort();
 },[org,tick,get]);
 return <div className="management-grid">
  <p className="management-note">Los agentes solo pueden comunicarse con agentes de esta misma empresa. Esta lista es de solo lectura.</p>
  {state.state==="loading"&&<p>Consultando mensajes…</p>}
  {state.state==="unavailable"&&<p className="management-note" role="status">{MANAGEMENT_UNAVAILABLE}</p>}
  {state.state==="error"&&<p role="alert">No se han podido verificar los mensajes. <button type="button" className="campus-ghost" onClick={()=>setTick(t=>t+1)}>Reintentar</button></p>}
  {state.state==="ready"&&(state.messages.length===0?<p>Todavía no hay mensajes entre agentes.</p>:
   <ol className="management-messages" aria-label="Mensajes, más recientes primero">{state.messages.map(m=><li key={m.id}>
    <div className="management-row"><strong>{m.from_worker} → {m.to_worker}</strong><time dateTime={m.created_at}>{new Date(m.created_at).toLocaleString("es-ES")}</time></div>
    {/* Texto plano: React escapa el contenido; nunca se interpreta como HTML. */}
    <p className="management-body">{m.body}</p>
    {m.task_id&&<small>Tarea {m.task_id}</small>}
   </li>)}</ol>)}
 </div>;
}

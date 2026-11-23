import {CompanyId} from "./fabrica/CompanyId";
import {useEffect,useId,useRef,useState} from "react";
import {useDialogFocus} from "./office/useDialogFocus";
import {useAuth0} from "./auth";
import {CAPABILITIES,CAPABILITY_INFO,BASE_DEPARTMENTS,buildPayload,departmentsFor,emptyDraft,holdingCompaniesUrl,stepFields,validCreateAck,validateDraft,MAX_COMPANIES} from "./holdingApi";
import type {Capability,CreateCompanyAck,CreatePayload,Holding,WizardDraft} from "./holdingApi";

export const WIZARD_UNCONFIRMED="No se ha podido confirmar si la empresa se ha creado. Reintenta: se enviará exactamente la misma solicitud y el servidor no la duplicará.";
const statusText:Record<number,string>={
 409:"El servidor no ha creado la empresa: el holding ya tiene 5 empresas, ya existe una con ese nombre o ahora mismo no se puede crear.",
 403:"No tienes permiso para crear empresas en este holding.",
 422:"El servidor ha rechazado los datos. Revísalos y vuelve a confirmar.",
 503:"La creación de empresas aún no está disponible en el servidor. No se ha creado nada."
};
const STEPS=["Empresa","Proyecto","Capacidades","Resumen"];
type Frozen={payload:CreatePayload;body:string};

export function CreateCompanyWizard({holding,onClose,onCreated}:{holding:Holding;onClose:()=>void;onCreated:(ack:CreateCompanyAck)=>void}){
 const {getAccessTokenSilently}=useAuth0();
 const [draft,setDraft]=useState<WizardDraft>(emptyDraft),[step,setStep]=useState(0),[touched,setTouched]=useState<Set<number>>(new Set());
 const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[retry,setRetry]=useState(false),[error,setError]=useState(""),[done,setDone]=useState<CreateCompanyAck|null>(null);
 const frozen=useRef<Frozen|null>(null),guard=useRef(false),controller=useRef(new AbortController()),dialog=useRef<HTMLDivElement>(null);
 const titleId=useId(),descId=useId(),uid=useId();
 const names=holding.companies.map(c=>c.name);
 const errors=validateDraft(draft,names);
 const stepErrors=(i:number)=>stepFields[i].filter(f=>errors[f]);
 const full=holding.companies.length>=MAX_COMPANIES;
 useDialogFocus(dialog);
 useEffect(()=>{const c=new AbortController();controller.current=c;return()=>c.abort();},[]);
 useEffect(()=>{dialog.current?.querySelector<HTMLElement>("input,textarea,button.wizard-primary")?.focus();},[step,done]);
 function edit<K extends keyof WizardDraft>(k:K,v:WizardDraft[K]){setDraft(d=>({...d,[k]:v}));frozen.current=null;setRetry(false);setConfirm(false);setError("");}
 function toggleCap(c:Capability){edit("capabilities",draft.capabilities.includes(c)?draft.capabilities.filter(x=>x!==c):[...draft.capabilities,c]);}
 // Si el paso tiene errores no avanza y lleva el foco al primer campo que falla, para corregirlo sin buscarlo.
 function nextStep(){
  setTouched(t=>new Set(t).add(step));
  if(stepErrors(step).length===0){setStep(step+1);return;}
  requestAnimationFrame(()=>dialog.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
 }
 function close(){if(!busy){controller.current.abort();onClose();}}
 async function submit(){
  if(guard.current||busy||full)return;
  if(!retry||!frozen.current){
   if(!confirm||Object.keys(errors).length)return;
   const payload=buildPayload(draft,crypto.randomUUID());frozen.current={payload,body:JSON.stringify(payload)};
  }
  const sent=frozen.current;guard.current=true;setBusy(true);setError("");const signal=controller.current.signal;
  const uncertain=()=>{setRetry(true);setError(WIZARD_UNCONFIRMED);};
  try{
   let r:Response;
   try{
    const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}});if(signal.aborted)return;
    r=await fetch(holdingCompaniesUrl(holding.id),{method:"POST",signal,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:sent.body});
   }catch{if(!signal.aborted)uncertain();return;}
   if(signal.aborted)return;
   if(statusText[r.status]){frozen.current=null;setRetry(false);setConfirm(false);setError(statusText[r.status]);return;}
   if(r.status!==201&&r.status!==200){uncertain();return;}
   let raw:unknown;try{raw=await r.json();}catch{if(!signal.aborted)uncertain();return;}
   if(signal.aborted)return;
   if(!validCreateAck(raw,holding,sent.payload)){uncertain();return;}
   frozen.current=null;setRetry(false);setDone(raw);onCreated(raw);
  }finally{if(!signal.aborted){guard.current=false;setBusy(false);}}
 }
 const show=(f:keyof WizardDraft)=>touched.has(stepFields.findIndex(x=>x.includes(f)))&&errors[f];
 const field=(f:"name"|"project_name"|"repository"|"website_url",label:string,help:string,extra:object={})=><div className="wizard-field"><label htmlFor={uid+f}>{label}</label>
  <input id={uid+f} value={draft[f]} onChange={e=>edit(f,e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&step<3){e.preventDefault();nextStep();}}} enterKeyHint="next" aria-invalid={!!show(f)} aria-describedby={uid+f+"-help"} disabled={busy} {...extra}/>
  <small id={uid+f+"-help"} className={show(f)?"wizard-error":undefined}>{show(f)||help}</small></div>;
 const deps=departmentsFor(draft.capabilities);
 return <div className="wizard-backdrop" onKeyDown={e=>{if(e.key==="Escape")close();}}>
  <div className="wizard" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} ref={dialog}>
   <div className="wizard-head"><div><span className="guide-eyebrow">{holding.name.toUpperCase()}</span><h2 id={titleId}>Crear empresa</h2></div><button type="button" className="guide-toggle" onClick={close} disabled={busy}>Cerrar</button></div>
   <p id={descId} className="wizard-intro">Freddy prepara una empresa aislada con su proyecto, sus departamentos y un agente inactivo en cada uno. No se llama a ningún modelo de IA.</p>
   {done?<div className="wizard-done" role="status">
    <h3>Empresa creada en la parcela {done.slot}{done.replayed?" (solicitud ya registrada)":""}</h3>
    <p>{done.departments.length} departamentos y {done.workers_created} agentes inactivos preparados: {done.departments.map(d=>d.name).join(", ")}.</p>
    <CompanyId id={done.organization_id}/>
    <p>Guarda ese identificador: hace falta para conectar los agentes de esta empresa con Freddy. También lo tienes siempre en la ficha de la empresa.</p>
    <p>Siguiente paso recomendado: revisa los agentes y activa los que necesites.</p>
    <button type="button" className="campus-primary wizard-primary" onClick={onClose}>Volver al campus</button>
   </div>:<>
   <ol className="wizard-steps" aria-label="Pasos del asistente">{STEPS.map((s,i)=><li key={s} aria-current={i===step?"step":undefined} className={i===step?"current":i<step?"done":""}>{i+1}. {s}</li>)}</ol>
   {full&&<p role="alert">El holding ya tiene sus 5 empresas.</p>}
   {step===0&&<fieldset className="wizard-pane"><legend>¿Cómo se llama la empresa?</legend>
    {field("name","Nombre de la empresa","Entre 2 y 120 caracteres. Debe ser distinto de tus otras empresas.",{maxLength:200,autoComplete:"organization"})}</fieldset>}
   {step===1&&<fieldset className="wizard-pane"><legend>¿Qué proyecto gestiona?</legend>
    {field("project_name","Nombre del proyecto","Entre 2 y 120 caracteres.",{maxLength:200})}
    <div className="wizard-field"><label htmlFor={uid+"summary"}>Resumen del proyecto</label><textarea id={uid+"summary"} value={draft.project_summary} rows={4} maxLength={800} onChange={e=>edit("project_summary",e.target.value)} aria-invalid={!!show("project_summary")} aria-describedby={uid+"summary-help"} disabled={busy}/>
     <small id={uid+"summary-help"} className={show("project_summary")?"wizard-error":undefined}>{show("project_summary")||`Entre 10 y 600 caracteres (${Array.from(draft.project_summary.trim()).length}/600).`}</small></div>
    {field("repository","Repositorio GitHub (opcional)","Formato propietario/repositorio, por ejemplo nova/tienda.",{placeholder:"propietario/repositorio",spellCheck:false,autoCapitalize:"off"})}
    {field("website_url","Web del proyecto (opcional)","Dirección completa que empiece por https://",{placeholder:"https://",type:"url",spellCheck:false,autoCapitalize:"off"})}
   </fieldset>}
   {step===2&&<fieldset className="wizard-pane"><legend>¿Qué necesita el proyecto?</legend>
    <p className="wizard-help">Cada capacidad indica a Freddy qué trabajo hay que preparar. Podrás activarlas poco a poco.</p>
    <div className="wizard-caps">{CAPABILITIES.map(c=><label key={c} className={draft.capabilities.includes(c)?"wizard-cap selected":"wizard-cap"}>
     <input type="checkbox" checked={draft.capabilities.includes(c)} onChange={()=>toggleCap(c)} disabled={busy}/>
     <span><strong>{CAPABILITY_INFO[c].label}</strong><small>{CAPABILITY_INFO[c].explains}</small></span></label>)}</div>
    {show("capabilities")&&<p className="wizard-error" role="alert">{errors.capabilities}</p>}
   </fieldset>}
   {step===3&&<section className="wizard-pane" aria-label="Resumen de lo que se creará">
    <dl className="wizard-summary">
     <dt>Empresa</dt><dd>{draft.name.trim()}</dd>
     <dt>Proyecto</dt><dd>{draft.project_name.trim()} — {draft.project_summary.trim()}</dd>
     <dt>Repositorio</dt><dd>{draft.repository.trim()||"Sin repositorio"}</dd>
     <dt>Web</dt><dd>{draft.website_url.trim()||"Sin web"}</dd>
     <dt>Capacidades</dt><dd>{CAPABILITIES.filter(c=>draft.capabilities.includes(c)).map(c=>CAPABILITY_INFO[c].label).join(", ")}</dd>
    </dl>
    <h3>Se crearán {deps.length} departamentos y {deps.length} agentes inactivos</h3>
    <ul className="wizard-deps">{deps.map(d=><li key={d}>{d}<small>{(BASE_DEPARTMENTS as readonly string[]).includes(d)?"base":"por capacidad"} · 1 agente inactivo</small></li>)}</ul>
    {draft.capabilities.includes("repository")&&!draft.repository.trim()&&<p className="wizard-help">Has marcado «Repositorio» sin indicar cuál: la guía lo dejará pendiente.</p>}
    {draft.capabilities.includes("website")&&!draft.website_url.trim()&&<p className="wizard-help">Has marcado «Sitio web» sin indicar la dirección: la guía lo dejará pendiente.</p>}
    {Object.keys(errors).length>0&&<p className="wizard-error" role="alert">Hay datos por corregir en pasos anteriores.</p>}
    <label className="wizard-confirm"><input type="checkbox" checked={confirm} disabled={busy||retry||Object.keys(errors).length>0} onChange={e=>setConfirm(e.target.checked)}/>Confirmo crear esta empresa con estos departamentos y agentes inactivos.</label>
   </section>}
   {error&&<p className="wizard-error" role="alert">{error}</p>}
   <div className="wizard-actions">
    {step>0&&<button type="button" className="guide-toggle" onClick={()=>setStep(step-1)} disabled={busy}>Atrás</button>}
    {step<3&&<button type="button" className="campus-primary wizard-primary" onClick={nextStep}>Siguiente</button>}
    {step===3&&<button type="button" className="campus-primary wizard-primary" disabled={busy||full||(retry?!frozen.current:!confirm||Object.keys(errors).length>0)} onClick={()=>void submit()}>{busy?"Creando…":retry?"Reintentar la misma solicitud":"Crear empresa"}</button>}
   </div></>}
  </div>
 </div>;
}

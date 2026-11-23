import {useEffect,useRef,useState} from 'react';
import {useAuth0} from "./auth";
import './ObjectivePlanning.css';
import {ObjectiveProposal} from './ObjectiveProposal';

type Department={id:string;name:string};
type Worker={id:string;name:string;department_id:string;state:string};
type Source={repository:string;ref:string;prefix:string};
type Document={path:string;sha:string};
type DraftStep={title:string;department_id:string;worker_id:string;deliverable:string;acceptance:string;document:string};
type Context={enabled:boolean;generative:boolean;departments:Department[];workers:Worker[];sources:Source[]};
type Payload={objective:string;request_key:string;confirm_save:true;steps:(Omit<DraftStep,'document'>&Source&Document)[]};
type Result={organization_id:string;request_key:string;mission_id:string;atomic_save:true;provider_called:false;source_fetched:false;execution_started:false;permissions_granted:false;budget_reserved:false;steps:{position:number;task_id:string;plan_id:string;worker_id:string}[]};
const api='https://api.tu-factoria.example/v1/me/organizations/';
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object';
const unique=(rows:{id:string}[])=>new Set(rows.map(x=>x.id)).size===rows.length;
const empty=():DraftStep=>({title:'',department_id:'',worker_id:'',deliverable:'',acceptance:'',document:''});

function validResult(raw:unknown,org:string,body:Payload):raw is Result{
 if(!object(raw)||raw.organization_id!==org||raw.request_key!==body.request_key||!uuid(raw.mission_id)||raw.atomic_save!==true||
  raw.provider_called!==false||raw.source_fetched!==false||raw.execution_started!==false||raw.permissions_granted!==false||raw.budget_reserved!==false||
  !Array.isArray(raw.steps)||raw.steps.length!==body.steps.length)return false;
 const rows=raw.steps;
 return rows.every((s,i)=>object(s)&&s.position===i+1&&uuid(s.task_id)&&uuid(s.plan_id)&&s.worker_id===body.steps[i].worker_id)&&
  new Set(rows.map(s=>s.task_id)).size===rows.length&&new Set(rows.map(s=>s.plan_id)).size===rows.length;
}

export function ObjectivePlanning({companyId,role,onSaved}:{companyId:string;role:string;onSaved:()=>void}){
 return role==='owner'&&uuid(companyId)?<PlanningForm key={companyId+':'+role} companyId={companyId} onSaved={onSaved}/>:null;
}

function PlanningForm({companyId,onSaved}:{companyId:string;onSaved:()=>void}){
 const {getAccessTokenSilently}=useAuth0();
 const [context,setContext]=useState<Context|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true);
 const [objective,setObjective]=useState(''),[steps,setSteps]=useState<DraftStep[]>([]),[confirmed,setConfirmed]=useState(false);
 const [generative,setGenerative]=useState(false);
 const [sourceIndex,setSourceIndex]=useState(''),[documents,setDocuments]=useState<Document[]>([]),[result,setResult]=useState<Result|null>(null);
 const [locked,setLocked]=useState(false),attempt=useRef<Payload|null>(null),active=useRef(true),inFlight=useRef(false),abort=useRef(new AbortController());
 const base=api+encodeURIComponent(companyId),source=context?.sources[Number(sourceIndex)];
 useEffect(()=>{
  active.current=true;const controller=new AbortController();abort.current=controller;
  async function load(){try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:'read:tasks'}});
   if(controller.signal.aborted)return;
   const responses=await Promise.all(['execution/objective-planning','departments','workers'].map(path=>fetch(base+'/'+path,{headers:{Authorization:'Bearer '+token},signal:controller.signal})));
   if(responses.some(r=>!r.ok))throw Error();
   const [cap,depts,workers]:unknown[]=await Promise.all(responses.map(r=>r.json()));
   if(!object(cap)||cap.organization_id!==companyId||typeof cap.enabled!=='boolean'||cap.proposal_mode!=='guided_documentary'||cap.provider_called!==false||cap.execution_started!==false||cap.min_steps!==2||cap.max_steps!==5||
    !Array.isArray(cap.sources)||cap.sources.length>20||!cap.sources.every(s=>object(s)&&typeof s.repository==='string'&&typeof s.ref==='string'&&typeof s.prefix==='string')||
    !Array.isArray(depts)||depts.length>40||!depts.every(d=>object(d)&&uuid(d.id)&&typeof d.name==='string')||!unique(depts)||
    !Array.isArray(workers)||workers.length>120||!workers.every(w=>object(w)&&uuid(w.id)&&uuid(w.department_id)&&typeof w.name==='string'&&typeof w.state==='string'&&depts.some(d=>d.id===w.department_id))||!unique(workers))throw Error();
   if(active.current)setContext({enabled:cap.enabled,generative:cap.generative_proposal_available===true,departments:depts as Department[],workers:workers as Worker[],sources:(cap.sources as Source[]).filter((s,i,a)=>a.findIndex(x=>x.repository===s.repository)===i)});
  }catch{if(active.current)setError('No se pudo verificar la planificación y los responsables de esta empresa.');}
  finally{if(active.current)setBusy(false);}}
  void load();return()=>{active.current=false;controller.abort();};
 },[base,companyId,getAccessTokenSilently]);
 function edit(index:number,patch:Partial<DraftStep>){setSteps(v=>v.map((s,i)=>i===index?{...s,...patch}:s));setConfirmed(false);}
 function propose(){
  setSteps([
   {...empty(),title:'Diagnóstico documental',deliverable:'Identificar hechos, carencias y riesgos relacionados con el objetivo.',acceptance:'Cada hallazgo distingue evidencia documentada de información no disponible.'},
   {...empty(),title:'Recomendaciones documentales',deliverable:'Proponer acciones para el objetivo respaldadas por el documento elegido.',acceptance:'Cada recomendación cita evidencia y explica sus límites y cómo revisarla.'}
  ]);setGenerative(false);setConfirmed(false);setError('');
 }
 async function listDocuments(){
  if(!source||sourceIndex===''||busy||locked)return;setBusy(true);setError('');setDocuments([]);setConfirmed(false);setSteps(v=>v.map(s=>({...s,document:''})));
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:'read:tasks'}});if(!active.current)return;
   const response=await fetch(base+'/sources/github/documents?repository='+encodeURIComponent(source.repository),{headers:{Authorization:'Bearer '+token},signal:abort.current.signal});
   if(!response.ok)throw Error();const raw:unknown=await response.json();
   if(!object(raw)||raw.organization_id!==companyId||raw.repository!==source.repository||raw.read_only!==true||raw.sent_to_model!==false||!Array.isArray(raw.documents)||raw.documents.length>100||
    !raw.documents.every(d=>object(d)&&typeof d.path==='string'&&d.path.startsWith(source.prefix)&&typeof d.sha==='string'&&/^[0-9a-f]{40}$/.test(d.sha))||new Set(raw.documents.map(d=>d.path)).size!==raw.documents.length)throw Error();
   if(active.current)setDocuments(raw.documents.map(d=>({path:d.path as string,sha:d.sha as string})));
  }catch{if(active.current)setError('No se pudo comprobar el listado de documentos autorizados.');}
  finally{if(active.current)setBusy(false);}
 }
 const eligible=!!context?.enabled&&objective.trim().length>=10&&objective.trim().length<=400&&sourceIndex!==''&&!!source&&steps.length>=2&&steps.length<=5&&
  new Set(steps.map(s=>s.title.trim().toLocaleLowerCase('es'))).size===steps.length&&steps.every(s=>s.title.trim().length>=3&&s.title.trim().length<=200&&s.deliverable.trim().length>=10&&s.deliverable.trim().length<=250&&s.acceptance.trim().length>=10&&s.acceptance.trim().length<=250&&
  context.departments.some(d=>d.id===s.department_id)&&context.workers.some(w=>w.id===s.worker_id&&w.department_id===s.department_id&&w.state==='idle')&&documents.some(d=>d.path===s.document));
 async function save(){
  if(inFlight.current||result||(!attempt.current&&(!eligible||!confirmed)))return;
  if(!attempt.current){
   const chosen=source!;
   attempt.current={objective:objective.trim(),request_key:crypto.randomUUID(),confirm_save:true,steps:steps.map(s=>{
    const doc=documents.find(d=>d.path===s.document)!;
    return {title:s.title.trim(),department_id:s.department_id,worker_id:s.worker_id,deliverable:s.deliverable.trim(),acceptance:s.acceptance.trim(),repository:chosen.repository,ref:chosen.ref,prefix:chosen.prefix,...doc};
   })};
  }
  const body=attempt.current;setLocked(true);inFlight.current=true;setBusy(true);setError('');
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:'read:tasks create:tasks'}});if(!active.current)return;
   // Prefix is listing metadata, not part of the strict write contract.
   const response=await fetch(base+'/execution/objective-planning',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:abort.current.signal,body:JSON.stringify({...body,steps:body.steps.map(({prefix,...s})=>s)})});
   if(!response.ok)throw Error();const raw:unknown=await response.json();
   if(!validResult(raw,companyId,body))throw Error();
   if(active.current){setResult(raw);onSaved();}
  }catch{if(active.current)setError('Guardado no confirmado. Conservamos la misma solicitud: comprueba el seguimiento o reintenta exactamente este guardado; no prepares otro para sustituirlo.');}
  finally{inFlight.current=false;if(active.current)setBusy(false);}
 }
 return <section className="objective-planning" aria-label="Planificar un objetivo con Freddy">
  <h2>Planificar un objetivo con Freddy</h2>
  <p>Propuesta documental editable. Cada paso analiza su propio documento; los informes anteriores no se transfieren al siguiente. Guardar crea tareas, planes y una misión sin iniciar ejecuciones.</p>
  {busy&&!context&&<p role="status">Comprobando planificación y responsables…</p>}
  {context&&!context.enabled&&<p role="status">El almacenamiento necesario no está disponible. No se puede guardar una propuesta.</p>}
  {error&&<p role="alert">{error}</p>}
  {context?.enabled&&!result&&<>
   <fieldset disabled={busy||locked}>
    <label>Objetivo de la empresa<textarea maxLength={400} value={objective} onChange={e=>{setObjective(e.target.value);setConfirmed(false);}}/></label>
    {steps.length===0&&<button type="button" disabled={objective.trim().length<10} onClick={propose}>Preparar propuesta guiada</button>}
    {steps.length===0&&context.generative&&<ObjectiveProposal companyId={companyId} objective={objective} onBusy={setBusy} onProposed={rows=>{setSteps(rows.map(s=>({...empty(),...s})));setGenerative(true);setConfirmed(false);}}/>}
    {steps.length>0&&<>
     <p>{generative?'Borrador generado por IA, pendiente de revisión y selección de responsables y documentos.':'Borrador guiado local, editable antes de guardar.'}</p>
     <label>Repositorio autorizado<select value={sourceIndex} onChange={e=>{setSourceIndex(e.target.value);setDocuments([]);setSteps(v=>v.map(s=>({...s,document:''})));setConfirmed(false);}}><option value="">Seleccionar repositorio</option>{context.sources.map((s,i)=><option key={s.repository} value={i}>{s.repository} · {s.ref}</option>)}</select></label>
     <button type="button" disabled={sourceIndex===''} onClick={()=>void listDocuments()}>Consultar documentos autorizados</button>
     <p>El orden establece dependencias: los pasos posteriores esperan la aceptación de todos los anteriores. Cada envío conserva su autorización y presupuesto propios.</p>
     {steps.map((s,i)=><fieldset key={i} className="objective-step"><legend>Paso {i+1}{i?' · espera los anteriores':''}</legend>
      <label>Título del paso {i+1}<input maxLength={200} value={s.title} onChange={e=>edit(i,{title:e.target.value})}/></label>
      <label>Departamento del paso {i+1}<select value={s.department_id} onChange={e=>edit(i,{department_id:e.target.value,worker_id:''})}><option value="">Seleccionar departamento</option>{context.departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>Responsable del paso {i+1}<select value={s.worker_id} onChange={e=>edit(i,{worker_id:e.target.value})}><option value="">Seleccionar responsable disponible</option>{context.workers.filter(w=>w.department_id===s.department_id&&w.state==='idle').map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      <label>Documento del paso {i+1}<select value={s.document} onChange={e=>edit(i,{document:e.target.value})}><option value="">Seleccionar documento</option>{documents.map(d=><option key={d.path} value={d.path}>{d.path} · {d.sha.slice(0,12)}</option>)}</select></label>
      <label>Entregable del paso {i+1}<textarea maxLength={250} value={s.deliverable} onChange={e=>edit(i,{deliverable:e.target.value})}/></label>
      <label>Criterio de revisión del paso {i+1}<textarea maxLength={250} value={s.acceptance} onChange={e=>edit(i,{acceptance:e.target.value})}/></label>
      {steps.length>2&&<button type="button" onClick={()=>{setSteps(v=>v.filter((_,n)=>n!==i));setConfirmed(false);}}>Quitar paso {i+1}</button>}
     </fieldset>)}
     {steps.length<5&&<button type="button" onClick={()=>{setSteps(v=>[...v,empty()]);setConfirmed(false);}}>Añadir paso</button>}
     <label className="objective-consent"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>He revisado el objetivo, los responsables, documentos y criterios. Confirmo guardar el conjunto completo sin ejecutarlo.</label>
    </>}
   </fieldset>
   {steps.length>0&&<button type="button" disabled={busy||(!attempt.current&&(!eligible||!confirmed))} onClick={()=>void save()}>{busy?'Guardando conjunto…':locked?'Reintentar la misma solicitud':'Guardar tareas y misión'}</button>}
   {attempt.current&&<p>Solicitud de guardado: <code>{attempt.current.request_key}</code>. Ante un resultado incierto, conserva esta referencia y consulta el seguimiento antes de iniciar otro plan.</p>}
  </>}
  {result&&<div role="status"><strong>Conjunto guardado: {result.steps.length} tareas y planes documentales.</strong><p>Misión: <code>{result.mission_id}</code>. Puedes consultar sus pasos en el seguimiento. No se ha iniciado ninguna ejecución.</p></div>}
 </section>;
}

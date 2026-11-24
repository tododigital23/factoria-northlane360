import {useEffect,useRef,useState} from 'react';
import {useAuth0} from "./auth";
import './ObjectivePlanning.css';
import {ObjectiveProposal} from './ObjectiveProposal';
import {API_ROOT} from "./holdingApi";

type Department={id:string;name:string};
type Worker={id:string;name:string;department_id:string;state:string};
type Source={kind?:'github'|'database';repository:string;ref:string;prefix:string;label?:string};
type Document={path:string;sha:string};
type DraftStep={title:string;department_id:string;worker_id:string;deliverable:string;acceptance:string;document:string};
type Context={enabled:boolean;generative:boolean;departments:Department[];workers:Worker[];sources:Source[]};
type Payload={objective:string;request_key:string;confirm_save:true;steps:(Omit<DraftStep,'document'>&Source&Document)[]};
type Result={organization_id:string;request_key:string;mission_id:string;atomic_save:true;provider_called:false;source_fetched:false;execution_started:false;permissions_granted:false;budget_reserved:false;steps:{position:number;task_id:string;plan_id:string;worker_id:string}[]};
const api=API_ROOT+'/v1/me/organizations/';
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object';
const unique=(rows:{id:string}[])=>new Set(rows.map(x=>x.id)).size===rows.length;
const empty=():DraftStep=>({title:'',department_id:'',worker_id:'',deliverable:'',acceptance:'',document:''});
const sourceKind=(s:Source)=>s.kind==='database'||s.repository.startsWith('company-db/')?'database':'github';
const sourceLabel=(s:Source)=>sourceKind(s)==='database'
 ?`Base de datos · ${s.label||s.repository.replace(/^company-db\//,'')}`
 :`${s.repository} · ${s.ref}`;

const STORE_STEPS: {title:string;path:string;deliverable:string;acceptance:string}[]=[
 {title:'Verificar pedidos',path:'ops/pedidos.md',deliverable:'Revisar pedidos atascados o cobros fallidos y proponer siguiente acción.',acceptance:'Cada pedido citado indica estado, urgencia y qué hacer a continuación.'},
 {title:'Gestionar problemas',path:'ops/problemas.md',deliverable:'Listar incidencias abiertas de la tienda y priorizar las críticas.',acceptance:'Cada problema tiene prioridad y criterio para darlo por cerrado.'},
 {title:'Atender chats',path:'ops/chats.md',deliverable:'Identificar chats o mensajes pendientes y asignar respuesta.',acceptance:'Cada hilo pendiente tiene responsable y plazo de respuesta.'},
 {title:'Reporte diario',path:'ops/reporte-diario.md',deliverable:'Definir el reporte diario de la tienda (ventas, pedidos, incidencias).',acceptance:'El reporte indica qué cifras incluye, a qué hora sale y por qué canal.'},
 {title:'Mejora continua',path:'ops/mejora-continua.md',deliverable:'Proponer mejoras del sistema y rutinas diarias de la tienda.',acceptance:'Cada mejora indica impacto esperado y cómo comprobarlo al día siguiente.'},
];

function validResult(raw:unknown,org:string,body:Payload):raw is Result{
 if(!object(raw)||raw.organization_id!==org||raw.request_key!==body.request_key||!uuid(raw.mission_id)||raw.atomic_save!==true||
  raw.provider_called!==false||raw.source_fetched!==false||raw.execution_started!==false||raw.permissions_granted!==false||raw.budget_reserved!==false||
  !Array.isArray(raw.steps)||raw.steps.length!==body.steps.length)return false;
 const rows=raw.steps;
 return rows.every((s,i)=>object(s)&&s.position===i+1&&uuid(s.task_id)&&uuid(s.plan_id)&&s.worker_id===body.steps[i].worker_id)&&
  new Set(rows.map(s=>s.task_id)).size===rows.length&&new Set(rows.map(s=>s.plan_id)).size===rows.length;
}

function firstIdle(workers:Worker[],departmentId:string){
 return workers.find(w=>w.department_id===departmentId&&w.state==='idle');
}

function fillActors(step:DraftStep,departments:Department[],workers:Worker[]):DraftStep{
 if(step.department_id&&step.worker_id)return step;
 const dept=step.department_id
  ?departments.find(d=>d.id===step.department_id)
  :departments.find(d=>workers.some(w=>w.department_id===d.id&&w.state==='idle'))||departments[0];
 if(!dept)return step;
 const worker=step.worker_id?workers.find(w=>w.id===step.worker_id):firstIdle(workers,dept.id);
 return {...step,department_id:dept.id,worker_id:worker?.id||''};
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
 const docsLoaded=useRef(false);
 const base=api+encodeURIComponent(companyId),source=context?.sources[Number(sourceIndex)];
 useEffect(()=>{
  active.current=true;const controller=new AbortController();abort.current=controller;
  async function load(){try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:'read:tasks'}});
   if(controller.signal.aborted)return;
   const responses=await Promise.all(['execution/objective-planning','departments','workers','connectors'].map(path=>fetch(base+'/'+path,{headers:{Authorization:'Bearer '+token},signal:controller.signal})));
   if(responses.slice(0,3).some(r=>!r.ok))throw Error();
   const [cap,depts,workers]:unknown[]=await Promise.all(responses.slice(0,3).map(r=>r.json()));
   const connectorsRaw:unknown=responses[3]?.ok?await responses[3].json():null;
   if(!object(cap)||cap.organization_id!==companyId||typeof cap.enabled!=='boolean'||cap.proposal_mode!=='guided_documentary'||cap.provider_called!==false||cap.execution_started!==false||cap.min_steps!==2||cap.max_steps!==5||
    !Array.isArray(cap.sources)||cap.sources.length>20||!cap.sources.every(s=>object(s)&&typeof s.repository==='string'&&typeof s.ref==='string'&&typeof s.prefix==='string'&&(s.kind===undefined||s.kind==='github'||s.kind==='database'))||
    !Array.isArray(depts)||depts.length>40||!depts.every(d=>object(d)&&uuid(d.id)&&typeof d.name==='string')||!unique(depts)||
    !Array.isArray(workers)||workers.length>120||!workers.every(w=>object(w)&&uuid(w.id)&&uuid(w.department_id)&&typeof w.name==='string'&&typeof w.state==='string'&&depts.some(d=>d.id===w.department_id))||!unique(workers))throw Error();
   let sources=(cap.sources as Source[]).filter((s,i,a)=>a.findIndex(x=>x.repository===s.repository)===i);
   if(!sources.some(s=>sourceKind(s)==='database')&&object(connectorsRaw)&&Array.isArray(connectorsRaw.connectors)){
    const dbKinds=new Set(['mysql','mariadb','postgresql','mssql','mongodb']);
    const row=connectorsRaw.connectors.find(c=>object(c)&&typeof c.kind==='string'&&dbKinds.has(c.kind)&&typeof c.status==='string'&&(c.status==='configured'||c.status==='failed')&&typeof c.database_name==='string'&&c.database_name.trim()&&typeof c.label==='string');
    if(row&&object(row)&&typeof row.label==='string'){
     const slug=row.label.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'tienda';
     sources=[{kind:'database',repository:'company-db/'+slug,ref:'live',prefix:'ops/',label:row.label.trim().slice(0,80)},...sources];
    }
   }
   if(active.current){
    setContext({enabled:cap.enabled,generative:cap.generative_proposal_available===true,departments:depts as Department[],workers:workers as Worker[],sources});
    const prefer=sources.findIndex(s=>sourceKind(s)==='database');
    if(prefer>=0)setSourceIndex(String(prefer));
    else if(sources.length===1)setSourceIndex('0');
   }
  }catch{if(active.current)setError('No se pudo verificar la planificación y los responsables de esta empresa.');}
  finally{if(active.current)setBusy(false);}}
  void load();return()=>{active.current=false;controller.abort();};
 },[base,companyId,getAccessTokenSilently]);
 function edit(index:number,patch:Partial<DraftStep>){setSteps(v=>v.map((s,i)=>i===index?{...s,...patch}:s));setConfirmed(false);}
 function propose(){
  const db=!!source&&sourceKind(source)==='database';
  const depts=context?.departments||[];
  const workers=context?.workers||[];
  if(db){
   setSteps(STORE_STEPS.map(row=>fillActors({...empty(),title:row.title,deliverable:row.deliverable,acceptance:row.acceptance,document:row.path},depts,workers)));
  }else{
   setSteps([
    fillActors({...empty(),title:'Diagnóstico documental',deliverable:'Identificar hechos, carencias y riesgos relacionados con el objetivo.',acceptance:'Cada hallazgo distingue evidencia documentada de información no disponible.'},depts,workers),
    fillActors({...empty(),title:'Recomendaciones documentales',deliverable:'Proponer acciones para el objetivo respaldadas por el documento elegido.',acceptance:'Cada recomendación cita evidencia y explica sus límites y cómo revisarla.'},depts,workers)
   ]);
  }
  setGenerative(false);setConfirmed(false);setError('');docsLoaded.current=false;
 }
 async function listDocuments(autoAssign=true){
  if(!source||sourceIndex===''||busy||locked)return;setBusy(true);setError('');
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:'read:tasks'}});if(!active.current)return;
   const kind=sourceKind(source);
   const path=kind==='database'?'/sources/database/documents?repository=':'/sources/github/documents?repository=';
   const response=await fetch(base+path+encodeURIComponent(source.repository),{headers:{Authorization:'Bearer '+token},signal:abort.current.signal});
   if(!response.ok)throw Error();const raw:unknown=await response.json();
   if(!object(raw)||raw.organization_id!==companyId||raw.repository!==source.repository||raw.read_only!==true||raw.sent_to_model!==false||!Array.isArray(raw.documents)||raw.documents.length>100||
    !raw.documents.every(d=>object(d)&&typeof d.path==='string'&&d.path.startsWith(source.prefix)&&typeof d.sha==='string'&&/^[0-9a-f]{40}$/.test(d.sha))||new Set(raw.documents.map(d=>d.path)).size!==raw.documents.length)throw Error();
   const docs=raw.documents.map(d=>({path:d.path as string,sha:d.sha as string}));
   if(active.current){
    setDocuments(docs);
    docsLoaded.current=true;
    if(autoAssign&&docs.length){
     setSteps(v=>v.map((s,i)=>{
      const preferred=STORE_STEPS.find(x=>x.title===s.title)?.path;
      const doc=docs.find(d=>d.path===preferred)||docs[i%docs.length];
      const preset=STORE_STEPS.find(x=>x.path===doc.path);
      return fillActors({
       ...s,
       document:doc.path,
       deliverable:s.deliverable.trim().length>=10?s.deliverable:(preset?.deliverable||s.deliverable),
       acceptance:s.acceptance.trim().length>=10?s.acceptance:(preset?.acceptance||s.acceptance),
       title:s.title.trim().length>=3?s.title:(preset?.title||s.title||`Paso ${i+1}`),
      },context?.departments||[],context?.workers||[]);
     }));
     setConfirmed(false);
    }
   }
  }catch{if(active.current)setError(sourceKind(source)==='database'
   ?'No se pudo consultar la base de datos conectada de esta empresa.'
   :'No se pudo comprobar el listado de documentos autorizados.');}
  finally{if(active.current)setBusy(false);}
 }
 // Auto-load ops areas once the store source and draft exist.
 useEffect(()=>{
  if(!context?.enabled||!source||sourceKind(source)!=='database'||steps.length<2||docsLoaded.current||busy||locked||result)return;
  void listDocuments(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[context,sourceIndex,steps.length]);
 const blockReasons:string[]=[];
 if(context&&!context.enabled)blockReasons.push('El almacenamiento de planificación no está disponible.');
 if(objective.trim().length<10)blockReasons.push('El objetivo debe tener al menos 10 caracteres.');
 if(sourceIndex===''||!source)blockReasons.push('Selecciona la fuente autorizada (base de datos).');
 if(steps.length<2)blockReasons.push('Haz clic en «Preparar propuesta guiada».');
 if(steps.length>5)blockReasons.push('Máximo 5 pasos.');
 if(documents.length===0&&steps.length>=2)blockReasons.push('Pulsa «Consultar áreas operativas de la base» (o espera la carga automática).');
 steps.forEach((s,i)=>{
  const n=i+1;
  if(s.title.trim().length<3)blockReasons.push(`Paso ${n}: falta el título.`);
  if(s.deliverable.trim().length<10)blockReasons.push(`Paso ${n}: rellena el entregable (mín. 10 caracteres).`);
  if(s.acceptance.trim().length<10)blockReasons.push(`Paso ${n}: rellena el criterio de revisión.`);
  if(!s.department_id)blockReasons.push(`Paso ${n}: elige departamento.`);
  else if(!s.worker_id)blockReasons.push(`Paso ${n}: elige un responsable en estado disponible (idle).`);
  else if(context&&!context.workers.some(w=>w.id===s.worker_id&&w.department_id===s.department_id&&w.state==='idle'))
   blockReasons.push(`Paso ${n}: el responsable no está disponible (idle).`);
  if(!s.document)blockReasons.push(`Paso ${n}: elige el área operativa.`);
 });
 if(new Set(steps.map(s=>s.title.trim().toLocaleLowerCase('es')).filter(Boolean)).size!==steps.filter(s=>s.title.trim()).length)
  blockReasons.push('Los títulos de los pasos deben ser distintos.');
 if(!confirmed&&steps.length>=2)blockReasons.push('Marca la casilla de confirmación abajo.');
 const eligible=!!context?.enabled&&blockReasons.length===0;
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
   const response=await fetch(base+'/execution/objective-planning',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:abort.current.signal,body:JSON.stringify({...body,steps:body.steps.map(({prefix,...s})=>s)})});
   if(!response.ok)throw Error();const raw:unknown=await response.json();
   if(!validResult(raw,companyId,body))throw Error();
   if(active.current){setResult(raw);onSaved();}
  }catch{if(active.current)setError('Guardado no confirmado. Conservamos la misma solicitud: comprueba el seguimiento o reintenta exactamente este guardado; no prepares otro para sustituirlo.');}
  finally{inFlight.current=false;if(active.current)setBusy(false);}
 }
 return <section className="objective-planning" aria-label="Planificar un objetivo con Freddy">
  <h2>Planificar un objetivo con Freddy</h2>
  <p>Propuesta editable. Con base de datos de la empresa usa áreas operativas (pedidos, problemas, chats, reporte); con GitHub, documentos del repositorio. Guardar crea tareas, planes y una misión sin iniciar ejecuciones.</p>
  {busy&&!context&&<p role="status">Comprobando planificación y responsables…</p>}
  {context&&!context.enabled&&<p role="status">El almacenamiento necesario no está disponible. No se puede guardar una propuesta.</p>}
  {context?.enabled&&context.sources.length===0&&<p role="status">Esta empresa no tiene fuente autorizada. Conecta su base de datos en Hosting o configura un repositorio GitHub.</p>}
  {error&&<p role="alert">{error}</p>}
  {context?.enabled&&!result&&<>
   <fieldset disabled={busy||locked}>
    <label>Objetivo de la empresa<textarea maxLength={400} value={objective} onChange={e=>{setObjective(e.target.value);setConfirmed(false);}}/></label>
    {context.sources.length>0&&<label>Fuente autorizada<select value={sourceIndex} onChange={e=>{setSourceIndex(e.target.value);setDocuments([]);docsLoaded.current=false;setSteps(v=>v.map(s=>({...s,document:''})));setConfirmed(false);}} disabled={locked}><option value="">Seleccionar fuente</option>{context.sources.map((s,i)=><option key={s.repository} value={i}>{sourceLabel(s)}</option>)}</select></label>}
    {steps.length===0&&<button type="button" disabled={objective.trim().length<10||sourceIndex===''} onClick={propose}>Preparar propuesta guiada</button>}
    {steps.length===0&&context.generative&&<ObjectiveProposal companyId={companyId} objective={objective} onBusy={setBusy} onProposed={rows=>{setSteps(rows.map(s=>fillActors({...empty(),...s},context.departments,context.workers)));setGenerative(true);setConfirmed(false);docsLoaded.current=false;}}/>}
    {steps.length>0&&<>
     <p>{generative?'Borrador generado por IA, pendiente de revisión.':'Borrador guiado local. Completa responsables y áreas; luego confirma y guarda.'}</p>
     <button type="button" disabled={sourceIndex===''||busy} onClick={()=>void listDocuments(true)}>{source&&sourceKind(source)==='database'?(documents.length?'Volver a cargar áreas operativas':'Consultar áreas operativas de la base'):'Consultar documentos autorizados'}</button>
     {documents.length>0&&<p role="status">{documents.length} áreas listas. Revisa cada paso y pulsa guardar cuando el botón se active.</p>}
     <p>El orden establece dependencias: los pasos posteriores esperan la aceptación de todos los anteriores.</p>
     {steps.map((s,i)=><fieldset key={i} className="objective-step"><legend>Paso {i+1}{i?' · espera los anteriores':''}</legend>
      <label>Título del paso {i+1}<input maxLength={200} value={s.title} onChange={e=>edit(i,{title:e.target.value})}/></label>
      <label>Departamento del paso {i+1}<select value={s.department_id} onChange={e=>edit(i,{department_id:e.target.value,worker_id:''})}><option value="">Seleccionar departamento</option>{context.departments.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>Responsable del paso {i+1}<select value={s.worker_id} onChange={e=>edit(i,{worker_id:e.target.value})}><option value="">Seleccionar responsable disponible</option>{context.workers.filter(w=>w.department_id===s.department_id&&w.state==='idle').map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
      <label>{source&&sourceKind(source)==='database'?`Área operativa del paso ${i+1}`:`Documento del paso ${i+1}`}<select value={s.document} onChange={e=>edit(i,{document:e.target.value})}><option value="">{source&&sourceKind(source)==='database'?'Seleccionar área':'Seleccionar documento'}</option>{documents.map(d=><option key={d.path} value={d.path}>{d.path} · {d.sha.slice(0,12)}</option>)}</select></label>
      <label>Entregable del paso {i+1}<textarea maxLength={250} value={s.deliverable} onChange={e=>edit(i,{deliverable:e.target.value})}/></label>
      <label>Criterio de revisión del paso {i+1}<textarea maxLength={250} value={s.acceptance} onChange={e=>edit(i,{acceptance:e.target.value})}/></label>
      {steps.length>2&&<button type="button" onClick={()=>{setSteps(v=>v.filter((_,n)=>n!==i));setConfirmed(false);}}>Quitar paso {i+1}</button>}
     </fieldset>)}
     {steps.length<5&&<button type="button" onClick={()=>{setSteps(v=>[...v,fillActors(empty(),context.departments,context.workers)]);setConfirmed(false);}}>Añadir paso</button>}
     <label className="objective-consent"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>He revisado el objetivo, los responsables, fuentes y criterios. Confirmo guardar el conjunto completo sin ejecutarlo.</label>
    </>}
   </fieldset>
   {steps.length>0&&!eligible&&!locked&&blockReasons.length>0&&<div className="objective-blockers" role="status">
    <p><strong>Aún no se puede guardar.</strong> Completa esto:</p>
    <ul>{blockReasons.slice(0,8).map(r=><li key={r}>{r}</li>)}</ul>
   </div>}
   {steps.length>0&&<button type="button" disabled={busy||(!attempt.current&&(!eligible||!confirmed))} onClick={()=>void save()}>{busy?'Guardando conjunto…':locked?'Reintentar la misma solicitud':'Guardar tareas y misión'}</button>}
   {attempt.current&&<p>Solicitud de guardado: <code>{attempt.current.request_key}</code>. Ante un resultado incierto, conserva esta referencia y consulta el seguimiento antes de iniciar otro plan.</p>}
  </>}
  {result&&<div role="status"><strong>Conjunto guardado: {result.steps.length} tareas y planes.</strong><p>Misión: <code>{result.mission_id}</code>. Puedes consultar sus pasos en el seguimiento. No se ha iniciado ninguna ejecución.</p></div>}
 </section>;
}

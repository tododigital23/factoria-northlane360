import {useEffect,useRef,useState} from 'react';
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";
export type ProposedStep={title:string;deliverable:string;acceptance:string};
type Props={companyId:string;objective:string;onProposed:(steps:ProposedStep[])=>void;onBusy:(value:boolean)=>void};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object';
function valid(raw:unknown,companyId:string,objective:string,count:number):raw is {steps:ProposedStep[]}{
 if(!object(raw)||raw.organization_id!==companyId||raw.objective!==objective||raw.step_count!==count||raw.proposal_mode!=='generative_documentary'||
  raw.provider_called!==true||raw.source_fetched!==false||raw.tasks_created!==false||raw.execution_started!==false||raw.requires_owner_review!==true||
  raw.quota_reserved_units!==10000||raw.quota_is_currency!==false||!Array.isArray(raw.steps)||raw.steps.length!==count)return false;
 return raw.steps.every(s=>object(s)&&Object.keys(s).sort().join(',')==='acceptance,deliverable,title'&&
  typeof s.title==='string'&&s.title.trim().length>=3&&s.title.length<=200&&
  typeof s.deliverable==='string'&&s.deliverable.trim().length>=10&&s.deliverable.length<=250&&
  typeof s.acceptance==='string'&&s.acceptance.trim().length>=10&&s.acceptance.length<=250)&&
  new Set(raw.steps.map(s=>s.title.trim().toLocaleLowerCase('es'))).size===count;
}
export function ObjectiveProposal({companyId,objective,onProposed,onBusy}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [count,setCount]=useState(2),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef<AbortController|null>(null),sequence=useRef(0),inFlight=useRef(false);
 useEffect(()=>{sequence.current++;setConsent(false);setError('');setBusy(false);inFlight.current=false;onBusy(false);return()=>{sequence.current++;request.current?.abort();onBusy(false);};},[companyId,objective,onBusy]);
 async function generate(){
  if(inFlight.current||!consent||objective.trim().length<10||objective.trim().length>400)return;
  const version=sequence.current,exact=objective.trim(),controller=new AbortController();request.current=controller;
  const timer=setTimeout(()=>controller.abort(),45000);inFlight.current=true;setBusy(true);onBusy(true);setError('');
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:'read:tasks create:tasks'}});
   if(controller.signal.aborted||version!==sequence.current)return;
   const response=await fetch(API_ROOT+'/v1/me/organizations/'+encodeURIComponent(companyId)+'/execution/objective-planning/propose',{
    method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:controller.signal,
    body:JSON.stringify({objective:exact,step_count:count,consent_openai:true})});
   if(!response.ok)throw Error();const raw:unknown=await response.json();
   if(!valid(raw,companyId,exact,count))throw Error();
   if(version===sequence.current&&!controller.signal.aborted)onProposed(raw.steps);
  }catch{if(version===sequence.current)setError('Propuesta no confirmada. No se reintenta automáticamente y la solicitud puede haber consumido cuota. Puedes usar la propuesta guiada local; una nueva generación requiere otra confirmación.');}
  finally{clearTimeout(timer);if(request.current===controller)inFlight.current=false;if(version===sequence.current){setBusy(false);setConsent(false);onBusy(false);}}
 }
 return <fieldset className="objective-proposal" disabled={busy}>
  <legend>Propuesta generada por IA</legend>
  <p>Se envía a OpenAI únicamente el objetivo que has escrito y el número de pasos. No se envían nombres de trabajadores, tareas existentes ni documentos. La propuesta no comprueba hechos ni guarda trabajo.</p>
  <label>Número de pasos de la propuesta<select value={count} onChange={e=>{setCount(Number(e.target.value));setConsent(false);}}>{[2,3,4,5].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
  <p>Cada generación reserva 10.000 unidades de la cuota existente; son capacidad de uso, no euros. No hay reintentos automáticos. Otra solicitud puede consumir cuota de nuevo.</p>
  <label className="objective-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>Autorizo enviar este objetivo a OpenAI para una propuesta, con coste de API sujeto a la cuota existente.</label>
  <button type="button" disabled={busy||!consent||objective.trim().length<10||objective.trim().length>400} onClick={()=>void generate()}>{busy?'Generando propuesta…':'Generar propuesta con IA'}</button>
  {error&&<p role="alert">{error}</p>}
 </fieldset>;
}

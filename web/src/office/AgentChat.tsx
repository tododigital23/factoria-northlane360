import {useEffect,useRef,useState} from "react";
import type {Agent} from "./officeModel";
import {AgentAvatar} from "./TeamSidebar";
import {newRequestKey,orgUrl,submitTaskRequest} from "./officeApi";
import type {TokenGetter} from "./officeApi";
import {useDialogFocus} from "./useDialogFocus";

/** Encargo que el agente propone tras hablarlo contigo. No existe como tarea hasta que lo confirmas. */
export type Proposal={request:string;deliverable:string|null};
type Line={id:number;from:"me"|"agent";text:string;proposal?:Proposal;state?:"open"|"sending"|"done"|"dropped"|"failed";key?:string};
export const CHAT_SUGGESTIONS=["¿Qué sabes hacer?","Quiero encargarte un trabajo","¿Qué tienes entre manos?","¿En qué me necesitas?"];
export function validProposal(v:unknown):v is Proposal{
 const p=v as Record<string,unknown>|null;
 return !!p&&typeof p==="object"&&typeof p.request==="string"&&p.request.trim().length>=10&&p.request.length<=600&&(p.deliverable===null||(typeof p.deliverable==="string"&&p.deliverable.length<=300));
}
export function validAgentReply(raw:unknown,org:string,worker:string):raw is {answer:string;mode:string}{
 const r=raw as Record<string,unknown>|null;
 return !!r&&typeof r==="object"&&typeof r.answer==="string"&&r.answer.length>0&&r.answer.length<=4000&&r.organization_id===org&&r.worker_id===worker&&r.read_only===true;
}

/** Chat con UN agente: contesta él, en primera persona, con lo que La Factoría tiene verificado de su trabajo. Solo consulta. */
export function AgentChat({organizationId,agent,token,onClose,canRequest=true,onCreated}:{organizationId:string;agent:Agent;token:TokenGetter;onClose:()=>void;
 /** Puede confirmar encargos (propietario, y el servidor los ofrece). */ canRequest?:boolean;onCreated?:()=>void}){
 const ref=useRef<HTMLDivElement>(null);useDialogFocus(ref);
 const [lines,setLines]=useState<Line[]>([]),[text,setText]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const end=useRef<HTMLDivElement>(null),seq=useRef(0),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{end.current?.scrollIntoView?.({block:"end"});},[lines,busy]);
 async function ask(q:string){
  const question=q.trim();if(question.length<2||busy)return;
  setText("");setError("");setBusy(true);setLines(l=>[...l,{id:++seq.current,from:"me",text:question}]);
  try{
   const t=await token();
   const r=await fetch(orgUrl(organizationId,"eliot/chat"),{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({question:question.slice(0,500),worker_id:agent.id})});
   const raw:unknown=r.ok?await r.json().catch(()=>null):null;
   if(!alive.current)return;
   if(!validAgentReply(raw,organizationId,agent.id)){setError(r.status===404||r.status===422||r.status===503?"El chat con agentes estará disponible al actualizar el servidor.":"No he podido hablar con "+agent.name+". Inténtalo de nuevo.");return;}
   const proposal=(raw as {proposal?:unknown}).proposal;
   setLines(l=>[...l,{id:++seq.current,from:"agent",text:raw.answer,...(validProposal(proposal)?{proposal,state:"open" as const,key:newRequestKey()}:{})}]);
  }catch{if(alive.current)setError("No he podido hablar con "+agent.name+". Inténtalo de nuevo.");}
  finally{if(alive.current)setBusy(false);}
 }
 const mark=(id:number,state:Line["state"])=>setLines(l=>l.map(x=>x.id===id?{...x,state}:x));
 async function confirm(line:Line){
  if(!line.proposal||!line.key||line.state==="sending"||line.state==="done")return;
  mark(line.id,"sending");
  const r=await submitTaskRequest(organizationId,agent.id,{request:line.proposal.request.trim(),deliverable:line.proposal.deliverable?.trim()||null,request_key:line.key},token,new AbortController().signal);
  if(!alive.current)return;
  if(r.ok){mark(line.id,"done");onCreated?.();setLines(l=>[...l,{id:++seq.current,from:"agent",text:"Hecho: lo tengo apuntado como encargo pendiente. Lo verás en mis tareas."}]);}
  else{mark(line.id,"failed");setError(r.kind==="forbidden"?"Solo el propietario puede confirmar encargos.":r.kind==="unavailable"?"Los encargos estarán disponibles al actualizar el servidor.":"No se pudo crear el encargo. Puedes volver a pulsar «Confirmar».");}
 }
 return <div className="office-modal-backdrop" onKeyDown={e=>{if(e.key==="Escape")onClose();}}>
  <div className="agent-chat office-theme" role="dialog" aria-modal="true" aria-label={"Chat con "+agent.name} ref={ref}>
   <header><AgentAvatar agent={agent} size={44}/><div><strong>{agent.person??agent.name}</strong><small>{agent.person?agent.name+" · ":""}{agent.departmentName}</small></div><button type="button" className="office-ghost" onClick={onClose}>Cerrar</button></header>
   <div className="agent-chat-log" role="log" aria-live="polite">
    {lines.length===0&&<div className="agent-chat-hello"><p><strong>Hola 👋</strong> Soy {agent.person?agent.person+", "+agent.name.toLowerCase():agent.name}. Pregúntame qué sé hacer o cuéntame qué necesitas: lo hablamos y te propongo el encargo para que lo confirmes.</p>
     <div>{CHAT_SUGGESTIONS.map(s=><button key={s} type="button" className="office-secondary" disabled={busy} onClick={()=>void ask(s)}>{s}</button>)}</div></div>}
    {lines.map(l=><div key={l.id} className={"bubble-wrap "+l.from}><p className={"bubble "+l.from}>{l.text}</p>
     {l.proposal&&<div className={"chat-proposal st-"+l.state} role="group" aria-label="Encargo propuesto">
      <small>ENCARGO PROPUESTO</small><p>{l.proposal.request}</p>
      {l.proposal.deliverable&&<p className="chat-proposal-out"><b>Recibirás:</b> {l.proposal.deliverable}</p>}
      {l.state==="done"?<p className="chat-proposal-done" role="status">✓ Encargo creado</p>:l.state==="dropped"?<p className="chat-proposal-done" role="status">Descartado</p>:
       <div><button type="button" className="office-primary" disabled={!canRequest||l.state==="sending"} onClick={()=>void confirm(l)}>{l.state==="sending"?"Creando…":"Confirmar encargo"}</button>
        <button type="button" className="office-ghost" disabled={l.state==="sending"} onClick={()=>mark(l.id,"dropped")}>Descartar</button></div>}
      {!canRequest&&l.state!=="done"&&l.state!=="dropped"&&<small>Solo el propietario puede confirmarlo.</small>}
     </div>}</div>)}
    {busy&&<p className="bubble agent typing" role="status">Escribiendo…</p>}
    {error&&<p className="office-alert" role="alert">{error}</p>}
    <div ref={end}/>
   </div>
   <form onSubmit={e=>{e.preventDefault();void ask(text);}}>
    <label className="sr-only" htmlFor="agent-chat-q">Tu pregunta</label>
    <input id="agent-chat-q" value={text} maxLength={500} placeholder={"Escribe a "+(agent.person??agent.name)+"…"} autoComplete="off" enterKeyHint="send" onChange={e=>setText(e.target.value)}/>
    <button type="submit" className="office-primary" disabled={busy||text.trim().length<2}>Enviar</button>
   </form>
   <small className="agent-chat-note">El agente propone; nada se crea hasta que pulsas «Confirmar encargo».</small>
  </div>
 </div>;
}

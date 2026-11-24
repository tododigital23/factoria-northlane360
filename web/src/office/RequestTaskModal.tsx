import {useEffect,useRef,useState} from "react";
import {useDialogFocus} from "./useDialogFocus";
import {departmentCopy} from "./officeModel";
import type {Agent,RequestAck} from "./officeModel";
import {UNAVAILABLE_NOTE,newRequestKey,submitTaskRequest} from "./officeApi";
import type {TokenGetter} from "./officeApi";
import {AgentAvatar} from "./TeamSidebar";

type Props={organizationId:string;agent:Agent;available:boolean;canRequest:boolean;token:TokenGetter;onClose:()=>void;onCreated:(ack:RequestAck)=>void};
export const REQUEST_MIN=10,REQUEST_MAX=2000,DELIVERABLE_MAX=300;
const ERRORS={
 network:"No se pudo confirmar el envío. Pulsa de nuevo: se reenviará el mismo encargo y no se duplicará.",
 conflict:"Este agente no puede recibir encargos ahora mismo. Revisa su estado o elige otro agente.",
 forbidden:"Solo el propietario de la empresa puede pedir tareas a sus agentes.",
 invalid:"El servidor no ha aceptado el texto. Revisa la longitud y vuelve a intentarlo.",
 unavailable:"Pedir tareas estará "+UNAVAILABLE_NOTE.toLowerCase(),
 server:"La respuesta del servidor no es coherente. No se da el encargo por registrado."
} as const;

export function RequestTaskModal({organizationId,agent,available,canRequest,token,onClose,onCreated}:Props){
 const copy=departmentCopy(agent.departmentName);
 const [text,setText]=useState(""),[deliverable,setDeliverable]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<keyof typeof ERRORS|null>(null),[done,setDone]=useState<RequestAck|null>(null),[serverOff,setServerOff]=useState(!available);
 const key=useRef<string|null>(null),lock=useRef(false),abort=useRef<AbortController|null>(null),area=useRef<HTMLTextAreaElement>(null),box=useRef<HTMLDivElement>(null);
 useDialogFocus(box);
 useEffect(()=>{area.current?.focus();const esc=(e:KeyboardEvent)=>{if(e.key==="Escape")onClose();};window.addEventListener("keydown",esc);return()=>{window.removeEventListener("keydown",esc);abort.current?.abort();};},[onClose]);
 const length=text.trim().length,valid=length>=REQUEST_MIN&&text.length<=REQUEST_MAX&&deliverable.trim().length<=DELIVERABLE_MAX;
 const disabled=!valid||busy||serverOff||!canRequest||!!done;
 function edit(next:()=>void){next();key.current=null;if(error!=="unavailable")setError(null);}
 async function submit(){
  if(lock.current||disabled)return;lock.current=true;setBusy(true);setError(null);
  if(!key.current)key.current=newRequestKey();
  abort.current=new AbortController();
  const result=await submitTaskRequest(organizationId,agent.id,{request:text.trim(),deliverable:deliverable.trim()?deliverable.trim():null,request_key:key.current},token,abort.current.signal);
  lock.current=false;setBusy(false);
  if(result.ok){setDone(result.ack);onCreated(result.ack);return;}
  if(result.kind==="unavailable")setServerOff(true);
  if(result.kind!=="network")key.current=null;
  setError(result.kind);
 }
 return <div className="office-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
  <div className="office-modal" role="dialog" aria-modal="true" aria-labelledby="request-modal-agent" ref={box}>
   <button type="button" className="office-modal-close" aria-label="Cerrar" onClick={onClose}>×</button>
   <header className="request-head"><AgentAvatar agent={agent} size={56}/><div><small>{agent.departmentName}</small><strong id="request-modal-agent">{agent.name}</strong><span>{agent.specialty}</span></div></header>
   {done?<div className="request-done" role="status">
     <h2>{done.execution_started?"Encargo en marcha":"Encargo registrado"}</h2>
     <p><strong>{done.title}</strong></p>
     <p>{done.replayed?"Ya estaba registrado: no se ha duplicado. ":""}
      {done.execution_started
       ?`${agent.name} ya está generando el borrador. Síguelo en Tareas (monitoreo).`
       :done.auto_reason==="executor_disabled"||done.auto_reason==="on_break"
        ?`La tarea quedó para ${agent.name}. El borrador automático no arrancó (${done.auto_reason==="on_break"?"modo descanso":"motor IA apagado"}). Revísalo en Tareas.`
        :`La tarea quedó para ${agent.name}. Revisa el estado en Tareas.`}</p>
     <button type="button" className="office-primary wide" onClick={onClose}>Entendido</button>
    </div>:<>
   <h2>¿Qué necesitas?</h2>
   <p className="request-intro">Cuéntale qué necesitas, para quién y qué resultado esperas. {agent.name} recibe tu pedido tal cual lo escribes.</p>
   {agent.status==="inactive"&&<p className="request-note warn" role="note">Este agente está inactivo: la tarea quedará pendiente hasta que lo actives.</p>}
   {serverOff&&<p className="request-note" role="note">Pedir tareas a un agente estará {UNAVAILABLE_NOTE.toLowerCase()}</p>}
   {!canRequest&&!serverOff&&<p className="request-note" role="note">Solo el propietario de la empresa puede pedir tareas.</p>}
   <label className="request-label" htmlFor="request-text">Tu encargo · {copy.title}</label>
   <textarea id="request-text" ref={area} value={text} maxLength={REQUEST_MAX} rows={6} placeholder={copy.example.slice(0,60)+"…"} onChange={e=>edit(()=>setText(e.target.value))} onKeyDown={e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();void submit();}}} aria-describedby="request-count"/>
   <div className="request-row"><button type="button" className="office-link" onClick={()=>edit(()=>setText(copy.example))}>Usar ejemplo</button><span id="request-count" className={length>0&&length<REQUEST_MIN?"warn":""}>{text.length} / {REQUEST_MAX}</span></div>
   <label className="request-label" htmlFor="request-deliverable">Resultado que esperas <small>(opcional)</small></label>
   <input id="request-deliverable" value={deliverable} maxLength={DELIVERABLE_MAX} onChange={e=>edit(()=>setDeliverable(e.target.value))} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void submit();}}} enterKeyHint="send" placeholder="Por ejemplo: una lista priorizada"/>
   <aside className="request-receive"><strong>Qué vas a recibir</strong><p>{copy.receive}</p></aside>
   {length>0&&length<REQUEST_MIN&&<p className="request-hint">Escribe al menos {REQUEST_MIN} caracteres.</p>}
   {error&&<p className="request-error" role="alert">{ERRORS[error]}</p>}
   <button type="button" className="office-primary wide" disabled={disabled} onClick={()=>void submit()}>{busy?"Asignando…":`Asignar a ${agent.name} →`}</button>
   </>}
  </div>
 </div>;
}

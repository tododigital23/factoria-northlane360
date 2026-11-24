import {NEED_LABEL} from "./officeModel";
import type {Agent} from "./officeModel";
import {AgentAvatar} from "./TeamSidebar";

type Props={agent:Agent;/** Activar («contratar») a un agente inactivo. */ onActivate?:()=>void;activating?:boolean;canRequest:boolean;requestsAvailable:boolean;onRequest:()=>void;onChat:()=>void;onOpenModule:()=>void;onSeeNeed:()=>void;onCreate:()=>void;onClose:()=>void};
/** Lo que «dice» el agente al acercarte a su mesa: una frase sobre su trabajo real, sin inventar nada. */
export function bubbleLine(a:Agent):string{
 if(a.ghost)return "Este puesto está libre. "+a.step+".";
 if(a.needs.length)return a.needs.length===1?"Te necesito para seguir con «"+a.needs[0].title+"».":"Te necesito en "+a.needs.length+" cosas para poder seguir.";
 if(a.status==="working")return "Estoy con «"+a.headline+"». "+a.step+".";
 if(a.status==="inactive")return "Estoy en la Oficina de Empleo, esperando a que me actives. En cuanto lo hagas, voy a mi mesa y puedo recibir trabajo.";
 if(a.status==="waiting")return "Tengo «"+a.headline+"» esperando para empezar.";
 return "Hola. Estoy libre: ¿qué necesitas?";
}
/** Bocadillo que sale del agente al pulsar su mesa: como si hablaras con él, con las acciones a mano. */
export function AgentBubble({agent:a,onActivate,activating,canRequest,requestsAvailable,onRequest,onChat,onOpenModule,onSeeNeed,onCreate,onClose}:Props){
 return <div className={"agent-bubble"+(a.ghost?" ghost":"")} role="dialog" aria-label={(a.ghost?"Puesto libre: ":"Hablando con ")+a.name}>
  <button type="button" className="bubble-close" aria-label="Cerrar y volver a toda la oficina" onClick={onClose}>×</button>
  <header><AgentAvatar agent={{...a,needs:[]}} size={40}/><div><strong>{a.person??a.name}</strong><small>{a.ghost?a.departmentName:a.person?a.name:(a.specialty||a.departmentName)}</small></div></header>
  <p className="bubble-say">{bubbleLine(a)}</p>
  {a.needs.length>0&&<ul className="bubble-needs" aria-label={"Lo que "+a.name+" necesita de ti"}>{a.needs.slice(0,2).map(n=><li key={n.id}><span><strong>{n.title}</strong><small>{NEED_LABEL[n.kind]}</small></span><button type="button" className="office-secondary" onClick={onSeeNeed}>Ver</button></li>)}
   {a.needs.length>2&&<li className="more">y {a.needs.length-2} más en «Te toca»</li>}</ul>}
  {a.ghost?<div className="bubble-actions"><button type="button" className="office-primary" disabled={!canRequest} onClick={onCreate}>Añadirlo en el Campus →</button></div>:
  <div className="bubble-actions">
   {a.status==="inactive"&&onActivate&&<button type="button" className="office-primary bubble-hire" disabled={!canRequest||activating} onClick={onActivate}>{activating?"Activando…":"✅ Activar agente"}</button>}
   <button type="button" className={a.status==="inactive"?"office-secondary":"office-primary"} disabled={!requestsAvailable||!canRequest} onClick={onRequest}>Pedir una tarea →</button>
   <button type="button" className="office-secondary" onClick={onChat}>💬 Hablar</button>
   <button type="button" className="office-secondary" onClick={onOpenModule}>Ir a Tareas ↗</button>
  </div>}
 </div>;
}

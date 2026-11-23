import {NEED_LABEL,timeAgo} from "./officeModel";
import type {Agent} from "./officeModel";
import {AgentAvatar,StatusText} from "./TeamSidebar";
import {UNAVAILABLE_NOTE} from "./officeApi";

type Props={agent:Agent|null;requestsAvailable:boolean;canRequest:boolean;now?:number;onRequest:()=>void;onOpenModule:()=>void;onChat?:()=>void;onSeeNeed?:()=>void;onCreate?:()=>void};
export function AgentBar({agent,requestsAvailable,canRequest,now,onRequest,onOpenModule,onChat,onSeeNeed,onCreate}:Props){
 if(!agent)return <section className="agent-bar empty" aria-label="Agente seleccionado"><p>Selecciona un agente en la oficina o en «Tu equipo» para ver su estado y pedirle una tarea.</p></section>;
 if(agent.ghost)return <section className="agent-bar ghost" aria-label={"Agente por crear: "+agent.name}>
  <div className="agent-bar-who"><AgentAvatar agent={agent} size={58}/><div><h3>{agent.name}</h3><span className="agent-status ghost">Todavía no existe</span><small>{agent.departmentName}</small></div></div>
  <div className="agent-bar-state"><span className="bar-overline">Agente por crear</span><strong>Este puesto está libre</strong><span>{agent.step}.</span></div>
  <div className="agent-bar-actions"><span className="bar-overline">Acciones</span>
   <button type="button" className="office-primary" disabled={!canRequest||!onCreate} onClick={onCreate}>Añadirlo en el Campus →</button>
   <small className="agent-bar-note">Se añade desde «Gestión e integración» de la empresa, en Perfil y capacidades.</small></div>
 </section>;
 const ago=timeAgo(agent.lastAssignedAt,now);
 return <section className="agent-bar" aria-label={"Agente seleccionado: "+agent.name}>
  <div className="agent-bar-who"><AgentAvatar agent={agent} size={58}/><div><h3>{agent.person??agent.name}</h3><StatusText agent={agent}/><small>{agent.person?agent.name+" · ":""}{agent.departmentName}</small></div></div>
  <div className="agent-bar-state"><span className="bar-overline">Estado del agente</span><strong>{agent.headline}</strong><span>{agent.step}</span>
   <div className="agent-progress" role="progressbar" aria-label="Progreso de la fase actual" aria-valuemin={0} aria-valuemax={100} aria-valuenow={agent.progress}><i style={{width:agent.progress+"%"}}/></div>
   {agent.needs.length>0&&<ul className="agent-needs" aria-label={"Lo que "+agent.name+" necesita de ti"}>{agent.needs.slice(0,4).map(n=><li key={n.id}><span><strong>{n.title}</strong><small>{NEED_LABEL[n.kind]}</small></span><button type="button" className="office-secondary" onClick={onSeeNeed??onOpenModule}>Ver</button></li>)}
    {agent.needs.length>4&&<li className="more">y {agent.needs.length-4} más</li>}</ul>}</div>
  <div className="agent-bar-actions"><span className="bar-overline">Acciones</span>
   <button type="button" className="office-primary" disabled={!requestsAvailable||!canRequest} onClick={onRequest}>Pedir una tarea →</button>
   {onChat&&<button type="button" className="office-secondary" onClick={onChat}>💬 Hablar con {(agent.person??agent.name).split(" ")[0]}</button>}
   <button type="button" className="office-secondary" onClick={onOpenModule}>Abrir módulo ↗</button>
   <small className="agent-bar-note">{!requestsAvailable?"Pedir tareas: "+UNAVAILABLE_NOTE.toLowerCase():!canRequest?"Solo el propietario puede pedir tareas.":ago?"◷ Tarea asignada "+ago:"◷ Sin tarea registrada"}</small>
  </div>
 </section>;
}

import {STATUS_LABEL,roomTint} from "./officeModel";
import type {CSSProperties} from "react";
import type {Agent,RoomLayout} from "./officeModel";
import {AgentAvatar,StatusText} from "./TeamSidebar";

type Props={rooms:RoomLayout[];cols:number;agents:Agent[];ownerName:string;selectedId:string|null;focusKey:string|null;onSelect:(id:string)=>void};
const inRoom=(r:RoomLayout,agents:Agent[])=>agents.filter(a=>r.departmentId!==null&&a.departmentId===r.departmentId);

/** Plano 2D equivalente a la escena 3D (sin WebGL): mismas salas, mismos agentes y mismos estados. */
export function OfficeMap2D({rooms,cols,agents,ownerName,selectedId,focusKey,onSelect}:Props){
 return <div className="office-map2d" role="group" aria-label="Plano 2D de la oficina" style={{gridTemplateColumns:`repeat(${cols},minmax(0,1fr))`}}>
  {rooms.map(r=><section key={r.key} className={"map-room"+(r.key.startsWith("ghost:")?" ghost":"")+(focusKey===r.key?" focused":"")+(focusKey&&focusKey!==r.key?" dimmed":"")} aria-label={"Sala "+r.name} style={{"--o-floor":roomTint(r).floor,"--o-orange":roomTint(r).accent} as CSSProperties}>
   <h3 className="map-sign">{r.name}</h3>
   <div className="map-board" aria-hidden="true"><i/><i/><i/></div>
   <ul>
    {r.direction&&<><li><span className="office-pill owner"><i/>{ownerName} · tú</span></li><li><span className="office-pill freddy"><i/>Freddy · director</span></li></>}
    {inRoom(r,agents).map(a=><li key={a.id}><button type="button" className={(selectedId===a.id?"office-card":"office-pill")+" st-"+a.status+(a.ghost?" ghost":"")} aria-pressed={selectedId===a.id} aria-label={`${a.name} · ${a.ghost?"por crear":STATUS_LABEL[a.status]} · ${a.activity}${a.needs.length?` · te necesita en ${a.needs.length}`:""}`} onClick={()=>onSelect(a.id)}><i aria-hidden="true"/>{selectedId===a.id?<span><strong>{a.name}</strong><small>{a.activity}</small></span>:a.name}{a.needs.length>0&&<b className="need-badge" aria-hidden="true">{a.needs.length}</b>}</button></li>)}
    {!r.direction&&inRoom(r,agents).length===0&&<li className="map-empty">{r.lounge?"Aquí descansa el equipo en modo descanso":r.jobs?"Aquí esperan los agentes inactivos hasta que los actives":"Sin agentes en esta sala"}</li>}
   </ul>
  </section>)}
 </div>;
}

/** Vista de lista accesible: agentes agrupados por sala con su estado real. */
export function OfficeList({rooms,agents,selectedId,focusKey,onSelect}:Omit<Props,"cols"|"ownerName">){
 const shown=focusKey?rooms.filter(r=>r.key===focusKey):rooms;
 return <div className="office-list" role="region" aria-label="Lista de la oficina">
  {shown.map(r=>{const list=inRoom(r,agents);return <section key={r.key}><h3>{r.name}<small>{list.length} {list.length===1?"agente":"agentes"}</small></h3>
   {list.length===0?<p className="map-empty">{r.direction?"Tú y Freddy dirigís desde esta sala.":r.lounge?"Aquí descansa el equipo en modo descanso.":r.jobs?"Aquí esperan los agentes inactivos hasta que los actives.":"Sin agentes en esta sala."}</p>:
   <table><thead><tr><th scope="col">Agente</th><th scope="col">Estado</th><th scope="col">Ahora</th><th scope="col">Progreso</th></tr></thead><tbody>
    {list.map(a=><tr key={a.id} className={selectedId===a.id?"selected":""}><td><button type="button" className="list-agent" aria-pressed={selectedId===a.id} onClick={()=>onSelect(a.id)}><AgentAvatar agent={a} size={30}/><span><strong>{a.name}</strong><small>{a.specialty}</small></span></button></td><td><StatusText agent={a}/></td><td>{a.headline}</td><td>{a.progress}%</td></tr>)}
   </tbody></table>}
  </section>;})}
 </div>;
}

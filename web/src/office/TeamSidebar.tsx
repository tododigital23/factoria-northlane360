import {FILTER_LABEL,STATUS_LABEL,filterAgents} from "./officeModel";
import type {Agent,TeamFilter} from "./officeModel";
import {GHOST_FACE,faceOf} from "./people";

const TONES=["#ffd9c2","#ffe7b8","#d8ecd9","#dbe4f5","#f3dbe8","#e9e1d6"];
function tone(id:string){let h=0;for(const c of id)h=(h*31+c.charCodeAt(0))>>>0;return TONES[h%TONES.length];}
export function initials(name:string){return name.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0]!.toUpperCase()).join("")||"·";}
/** Retrato del agente: la misma cara siempre para el mismo agente. Los «por crear» salen en gris. */
export function FaceSvg({id,ghost,size}:{id:string;ghost?:boolean;size:number}){
 const f=ghost?GHOST_FACE:faceOf(id),ink=ghost?"#b4b9c7":"#2b2420",o=ghost?undefined:f.outfit,hc=o?.hatColor??f.shirt;
 return <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
  <path d="M6 40c0-8 6-12 14-12s14 4 14 12z" fill={f.shirt}/>
  {o?.jacket&&<><path d="M6 40c0-8 6-12 14-12l-5 12z" fill={o.top2}/><path d="M34 40c0-8-6-12-14-12l5 12z" fill={o.top2}/></>}
  {o?.stripes&&<path d="M8 33h24M7 37h26" stroke={o.top2} strokeWidth="1.6"/>}
  {o?.dots&&[[11,34],[16,37],[24,33],[29,37],[20,35]].map(([x,y])=><circle key={x} cx={x} cy={y} r="1.3" fill={o.top2}/>)}
  {o?.emblem&&<rect x="17.5" y="33" width="5" height="4.5" rx="1" fill={o.emblem}/>}
  {o?.hat==="hood"&&<path d="M7 20c0-10 6-17 13-17s13 7 13 17v8H7z" fill={f.shirt}/>}
  <rect x="17" y="24" width="6" height="6" rx="2" fill={f.skin}/>
  {o?.neck==="tie"&&<path d="M19 29h2l1 8-2 2-2-2z" fill={o.neckColor}/>}
  {o?.neck==="bow"&&<path d="M15.5 28.5l4.5 2 4.5-2v4l-4.5-2-4.5 2z" fill={o.neckColor}/>}
  {o?.neck==="scarf"&&<path d="M13 28c4 3 10 3 14 0v3c-4 3-10 3-14 0z" fill={o.neckColor}/>}
  {o?.neck==="sweater"&&<path d="M9 31c5-4 17-4 22 0l-2 3c-5-3-13-3-18 0z" fill={o.neckColor}/>}
  {o?.neck==="chain"&&<path d="M15 29c2 4 8 4 10 0" stroke={o.neckColor} strokeWidth="1.2" fill="none"/>}
  {f.style===2&&<path d="M9 17c0-9 5-13 11-13s11 4 11 13v9c0 2-3 2-3 0V18H12v8c0 2-3 2-3 0z" fill={f.hair}/>}
  <path d="M17 27.5c2 1.6 4 1.6 6 0v2.2c-2 1.4-4 1.4-6 0z" fill="#000" opacity=".12"/>
  {!ghost&&!o?.jacket&&o?.neck!=="scarf"&&o?.neck!=="sweater"&&o?.hat!=="hood"&&<path d="M15.2 29.2l4.8 4 4.8-4-1.6-1.4-3.2 2.6-3.2-2.6z" fill="#fff" opacity=".55"/>}
  <ellipse cx="10.4" cy="17.6" rx="1.7" ry="2.3" fill={f.skin}/><ellipse cx="29.6" cy="17.6" rx="1.7" ry="2.3" fill={f.skin}/>
  <circle cx="20" cy="17" r="9.5" fill={f.skin}/>
  <path d="M10.5 17a9.5 9.5 0 0 0 19 0c0 6-4 10.2-9.5 10.2S10.5 23 10.5 17z" fill="#000" opacity=".06"/>
  {!ghost&&<><ellipse cx="14.2" cy="20.6" rx="2" ry="1.3" fill="#ff6b6b" opacity=".28"/><ellipse cx="25.8" cy="20.6" rx="2" ry="1.3" fill="#ff6b6b" opacity=".28"/></>}
  {f.style===0&&<path d="M10.5 15c0-7 4-10.5 9.5-10.5S29.5 8 29.5 15c-3-1-5-3-6-5-2 3-7 5-13 5z" fill={f.hair}/>}
  {f.style===1&&<path d="M10.5 14c1-7 5-9.5 9.5-9.5s8.5 2.5 9.5 9.5c-6-4-13-4-19 0z" fill={f.hair}/>}
  {f.style===2&&<path d="M10.5 15c0-7 4-10.5 9.5-10.5S29.5 8 29.5 15c-5 0-9-2-11-5-2 3-5 5-8 5z" fill={f.hair}/>}
  {f.style===3&&<><circle cx="20" cy="5" r="3.2" fill={f.hair}/><path d="M10.5 14c1-6 5-8.5 9.5-8.5s8.5 2.5 9.5 8.5c-6-3-13-3-19 0z" fill={f.hair}/></>}
  {!ghost&&(!o||o.hat==="none"||o.hat==="band")&&<path d="M14 8.2c2-1.9 5-2.6 8-1.9" stroke="#fff" strokeOpacity=".3" strokeWidth="1.3" fill="none" strokeLinecap="round"/>}
  {!ghost&&!o?.shades&&<path d="M14.4 14.6c1.2-.9 2.8-.9 3.9-.2M21.7 14.4c1.1-.7 2.7-.7 3.9.2" stroke={f.hair} strokeWidth="1.05" fill="none" strokeLinecap="round"/>}
  <ellipse cx="16.5" cy="17.5" rx="1.35" ry="1.6" fill={ink}/><ellipse cx="23.5" cy="17.5" rx="1.35" ry="1.6" fill={ink}/>
  {!ghost&&<><circle cx="17" cy="16.9" r=".45" fill="#fff"/><circle cx="24" cy="16.9" r=".45" fill="#fff"/><path d="M19.4 19.6c.4.5.8.5 1.2 0" stroke="#000" strokeOpacity=".28" strokeWidth=".8" fill="none" strokeLinecap="round"/></>}
  {!ghost&&<path d="M16.5 21.5c2 2 5 2 7 0" stroke={ink} strokeWidth="1.3" fill="none" strokeLinecap="round"/>}
  {o?.hat==="straw"&&<><ellipse cx="20" cy="9.5" rx="15" ry="2.6" fill={hc}/><path d="M12 9.5c0-5 3.5-7 8-7s8 2 8 7z" fill={hc}/><path d="M12 8h16" stroke="#b3261e" strokeWidth="1.4"/></>}
  {o?.hat==="cap"&&<><path d="M10.5 12c0-6 4-9 9.5-9s9.5 3 9.5 9z" fill={hc}/><rect x="27" y="10.5" width="8" height="2.2" rx="1.1" fill={hc}/></>}
  {o?.hat==="mohawk"&&<path d="M17.5 12V2.5l2.5 2 2.5-3V12z" fill={hc}/>}
  {o?.hat==="band"&&<rect x="10.3" y="10.5" width="19.4" height="2.6" rx="1.3" fill={hc}/>}
  {o?.hat==="beret"&&<><ellipse cx="18.5" cy="7.5" rx="10.5" ry="4.2" fill={hc}/><rect x="19.2" y="2" width="1.4" height="2.4" fill={hc}/></>}
  {o?.hat==="helmet"&&<><path d="M10 12.5c0-6.5 4.5-10 10-10s10 3.5 10 10z" fill={hc}/><rect x="8.5" y="11.5" width="23" height="2.2" rx="1.1" fill={hc}/></>}
  {o?.hat==="beanie"&&<><path d="M10.3 13c0-6.5 4.3-10 9.7-10s9.7 3.5 9.7 10z" fill={hc}/><circle cx="20" cy="2.6" r="2" fill="#fff"/></>}
  {o?.shades&&<><rect x="12.6" y="15.2" width="6.6" height="4.4" rx="1.6" fill="#16161c"/><rect x="20.8" y="15.2" width="6.6" height="4.4" rx="1.6" fill="#16161c"/><path d="M19.2 16.6h1.6" stroke="#16161c" strokeWidth="1.2"/></>}
  {f.glasses&&<><rect x="13.3" y="15" width="6" height="5" rx="2" fill="none" stroke={ink} strokeWidth="1.1"/><rect x="20.7" y="15" width="6" height="5" rx="2" fill="none" stroke={ink} strokeWidth="1.1"/><path d="M19.3 17.2h1.4" stroke={ink} strokeWidth="1.1"/></>}
  {f.headset&&<><path d="M10 18c0-8 4-12 10-12s10 4 10 12" stroke={ink} strokeWidth="1.5" fill="none"/><rect x="8.5" y="16" width="3" height="6" rx="1.5" fill={ink}/><rect x="28.5" y="16" width="3" height="6" rx="1.5" fill={ink}/></>}
 </svg>;
}
export function AgentAvatar({agent,size=40}:{agent:Pick<Agent,"id"|"name"|"status">&{ghost?:boolean;needs?:{id:string}[]};size?:number}){
 const n=agent.needs?.length??0;
 return <span className={"agent-avatar st-"+agent.status+(agent.ghost?" ghost":"")} style={{width:size,height:size,background:agent.ghost?"#f2f3f7":tone(agent.id)}} aria-hidden="true">
  <FaceSvg id={agent.id} ghost={agent.ghost} size={size}/>
  {n>0&&<b className="need-badge">{n>99?"99+":n}</b>}
 </span>;
}
export function StatusText({agent}:{agent:Pick<Agent,"status">}){return <span className={"agent-status st-"+agent.status}><i aria-hidden="true"/>{STATUS_LABEL[agent.status]}</span>;}

type Props={agents:Agent[];ownerName:string;selectedId:string|null;filter:TeamFilter;query:string;onFilter:(f:TeamFilter)=>void;onQuery:(q:string)=>void;onSelect:(id:string)=>void};
export function TeamSidebar({agents,ownerName,selectedId,filter,query,onFilter,onQuery,onSelect}:Props){
 const shown=filterAgents(agents,filter,query);
 const ghosts=agents.filter(a=>a.ghost);
 return <aside className="team-sidebar" aria-label="Tu equipo">
  <h2>Tu equipo</h2>
  <div className="team-owner"><span className="owner-avatar" aria-hidden="true">{initials(ownerName)}</span><div><strong>{ownerName} <small>tú</small></strong><span>Vista de dirección</span></div></div>
  <label className="team-search"><span className="sr-only">Buscar agente</span><input type="search" placeholder="Buscar agente" value={query} onChange={e=>onQuery(e.target.value)}/></label>
  <div className="team-filters" role="group" aria-label="Filtrar agentes">{(Object.keys(FILTER_LABEL) as TeamFilter[]).map(f=><button key={f} type="button" aria-pressed={filter===f} onClick={()=>onFilter(f)}>{FILTER_LABEL[f]}</button>)}</div>
  <ul className="team-list" aria-label="Agentes">
   {shown.map(a=><li key={a.id}><button type="button" className={"team-agent"+(selectedId===a.id?" selected":"")} aria-pressed={selectedId===a.id} aria-label={`${a.name} · ${STATUS_LABEL[a.status]}${a.needs.length?` · te necesita en ${a.needs.length}`:""}`} onClick={()=>onSelect(a.id)}>
    <AgentAvatar agent={a} size={34}/><span className="team-agent-text"><strong>{a.person??a.name}</strong><small className="team-role">{a.person?a.name:(a.specialty||a.departmentName)}</small>{a.needs.length>0?<span className="agent-status needs"><i aria-hidden="true"/>Te necesita</span>:<StatusText agent={a}/>}</span>
   </button></li>)}
   {shown.length===0&&<li className="team-empty">{agents.some(a=>!a.ghost)?"Ningún agente coincide con el filtro.":"Esta empresa todavía no tiene agentes registrados."}</li>}
  </ul>
  {ghosts.length>0&&<><h3 className="team-sub">Por crear <small>{ghosts.length}</small></h3>
   <ul className="team-list ghosts" aria-label="Agentes por crear">
    {ghosts.map(a=><li key={a.id}><button type="button" className={"team-agent ghost"+(selectedId===a.id?" selected":"")} aria-pressed={selectedId===a.id} aria-label={`${a.name} · por crear`} onClick={()=>onSelect(a.id)}>
     <AgentAvatar agent={a}/><span className="team-agent-text"><strong>{a.name}</strong><small>{a.departmentName}</small><span className="agent-status ghost">Todavía no existe</span></span>
    </button></li>)}
   </ul></>}
  <p className="team-foot">Tus agentes en la oficina · tú en dirección</p>
 </aside>;
}

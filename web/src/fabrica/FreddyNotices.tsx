import {useEffect,useRef,useState} from "react";
import {loadPortalAgents} from "../office/PortalAgents";
import {orgUrl} from "../office/officeApi";
import type {TokenGetter} from "../office/officeApi";
import {LEVEL_LABEL,collectNotices,noticeChanges} from "./notices";
import type {CompanyFeed,Notice} from "./notices";

/** Cada cuánto vuelve Freddy a preguntar a los agentes de cada empresa mientras la pestaña está a la vista. */
export const NOTICES_INTERVAL_MS=60000;
type Company={organization_id:string;name:string;slot:number};
type Props={companies:Company[];token:TokenGetter;onChange?:(notices:Notice[],fresh:Notice[],resolved:Notice[])=>void;onSelect?:(slot:number)=>void};

/** «Olvidar»: el propietario ya lo arregló a mano. La empresa deja de contar ese aviso para esos pedidos; no toca ningún pedido. */
export async function forgetNotice(n:Notice,token:TokenGetter):Promise<boolean>{
 try{
  const r=await fetch(orgUrl(n.organizationId,"portal-agents/forget"),{method:"POST",headers:{Authorization:"Bearer "+await token(),"Content-Type":"application/json"},
   body:JSON.stringify(n.refs.length?{code:n.code,refs:n.refs}:{code:n.code,count:n.count??1})});
  return r.status===200;
 }catch{return false;}
}

/** Bandeja única con lo que los agentes de todas las empresas tienen que decirte. Nada se guarda: se pregunta a cada empresa y se muestra. */
export function FreddyNotices({companies,token,onChange,onSelect}:Props){
 const [notices,setNotices]=useState<Notice[]|null>(null),[resolved,setResolved]=useState<Notice[]>([]),[connected,setConnected]=useState(0),[at,setAt]=useState<number|null>(null);
 const last=useRef<Notice[]|null>(null),cb=useRef(onChange);cb.current=onChange;
 // Los avisos no ocupan pantalla: viven detrás de una campana con el número de pendientes, y se abren al tocarla.
 const [open,setOpen]=useState(false);
 const [asking,setAsking]=useState<string|null>(null),[working,setWorking]=useState<string|null>(null),[failed,setFailed]=useState<string|null>(null),reload=useRef<()=>void>(()=>{});
 const ids=companies.map(c=>c.organization_id+":"+c.name+":"+c.slot).join("|");
 useEffect(()=>{
  const abort=new AbortController();let busy=false;last.current=null;setNotices(null);setResolved([]);
  const run=async()=>{
   if(busy||!companies.length)return;busy=true;
   try{
    const loaded=await Promise.all(companies.map(async c=>({c,r:await loadPortalAgents(c.organization_id,token,abort.signal)})));
    if(abort.signal.aborted)return;
    const feeds:CompanyFeed[]=loaded.flatMap(({c,r})=>r.state==="ready"&&r.data.available?[{organizationId:c.organization_id,company:c.name,slot:c.slot,panelUrl:r.data.panel_url,agents:r.data.agents}]:[]);
    const next=collectNotices(feeds),prev=last.current;last.current=next;
    setConnected(feeds.length);setNotices(next);setAt(Date.now());
    if(prev){const ch=noticeChanges(prev,next);if(ch.resolved.length)setResolved(r=>[...ch.resolved,...r].slice(0,8));cb.current?.(next,ch.fresh,ch.resolved);}
    else cb.current?.(next,[],[]);
   }finally{busy=false;}
  };
  reload.current=()=>void run();
  void run();
  const timer=window.setInterval(()=>{if(document.visibilityState!=="hidden")void run();},NOTICES_INTERVAL_MS);
  const onVisible=()=>{if(document.visibilityState!=="hidden")void run();};document.addEventListener("visibilitychange",onVisible);
  return()=>{abort.abort();window.clearInterval(timer);document.removeEventListener("visibilitychange",onVisible);};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[ids,token]);
 if(notices===null||!connected)return null;
 const urgent=notices.filter(n=>n.level==="urgente").length,important=notices.filter(n=>n.level==="importante").length;
 // Con algo urgente, lo demás queda plegado para que lo importante no se pierda (ni empuje la escena en el móvil).
 const first=urgent?notices.filter(n=>n.level==="urgente"):notices,rest=urgent?notices.filter(n=>n.level!=="urgente"):[];
 async function forget(n:Notice){
  setWorking(n.key);setFailed(null);
  const ok=await forgetNotice(n,token);
  setWorking(null);setAsking(null);
  if(ok)reload.current();else setFailed(n.key);
 }
 const item=((n:Notice)=><li key={n.key} className={"lv-"+n.level}>
   <div className="notice-top"><span className="notice-level">{LEVEL_LABEL[n.level]}</span><span className="notice-who">{n.company} · {n.agent}</span></div>
   <strong>{n.title}</strong>
   {n.refs.length>0&&<p className="notice-refs"><span className="sr-only">Pedidos: </span>{n.refs.map(r=><code key={r}>{r}</code>)}{n.count!==null&&n.count>n.refs.length&&<span> y {n.count-n.refs.length} más</span>}</p>}
   {n.proposal&&<p>{n.proposal}</p>}
   <div className="notice-actions">
    {n.panelUrl&&<a className="campus-ghost" href={n.panelUrl} target="_blank" rel="noopener noreferrer" aria-label={"Abrir el panel de "+n.company}>Abrir el panel ↗</a>}
    {n.slot!==null&&onSelect&&<button type="button" className="campus-ghost" onClick={()=>{setOpen(false);onSelect(n.slot as number);}}>Ver la empresa</button>}
    {asking!==n.key&&<button type="button" className="campus-ghost notice-forget" onClick={()=>{setAsking(n.key);setFailed(null);}}>Olvidar</button>}
   </div>
   {asking===n.key&&<div className="notice-confirm" role="group" aria-label="Confirmar olvidar aviso">
    <p>¿Ya lo has arreglado a mano? Freddy dejará de avisarte {n.refs.length?(n.refs.length===1?"de este pedido":"de estos pedidos"):"de este aviso mientras no aumente"}. No cambia nada en la empresa.</p>
    <button type="button" className="campus-primary" disabled={working===n.key} onClick={()=>void forget(n)}>{working===n.key?"Olvidando…":"Sí, olvidar"}</button>
    <button type="button" className="campus-ghost" disabled={working===n.key} onClick={()=>setAsking(null)}>Cancelar</button>
   </div>}
   {failed===n.key&&<p className="notice-error" role="alert">No se ha podido olvidar. Inténtalo de nuevo en un momento.</p>}
  </li>);
 const hour=at?new Date(at).toLocaleTimeString("es-ES",{hour:"2-digit",minute:"2-digit"}):"";
 const total=notices.length,bellLabel="Avisos de Freddy: "+(total===0?"ninguno":total===1?"1 aviso":total+" avisos")+(urgent?" ("+urgent+(urgent===1?" urgente)":" urgentes)"):"");
 return <div className="notice-bell-wrap" onKeyDown={e=>{if(e.key==="Escape")setOpen(false);}}>
  <button type="button" className={"notice-bell"+(urgent?" urgent":important?" important":"")} aria-label={bellLabel} aria-expanded={open} title={bellLabel} onClick={()=>setOpen(!open)}>
   <span aria-hidden="true">🔔</span>{total>0&&<b className="need-badge" aria-hidden="true">{total>99?"99+":total}</b>}
  </button>
  {open&&<section className={"freddy-notices notice-pop"+(urgent?" has-urgent":"")} aria-label="Avisos de Freddy">
  <div className="freddy-notices-head">
   <h3>Avisos de Freddy</h3><button type="button" className="campus-ghost notice-close" onClick={()=>setOpen(false)}>Cerrar</button>
   <p role="status">{notices.length?<>{urgent>0&&<b className="lv-urgente">{urgent} {urgent===1?"urgente":"urgentes"}</b>}{urgent>0&&important>0&&" · "}{important>0&&<b className="lv-importante">{important} {important===1?"importante":"importantes"}</b>}{urgent+important===0&&"Solo información"}</>:"Tus agentes no tienen nada pendiente que decirte."} <span>· revisado a las {hour}</span></p>
  </div>
  {first.length>0&&<ul>{first.map(item)}</ul>}
  {rest.length>0&&<details><summary>{rest.length===1?"Ver 1 aviso más":`Ver ${rest.length} avisos más`}</summary><ul>{rest.map(item)}</ul></details>}
  {resolved.length>0&&<div className="freddy-notices-resolved" role="status"><h4>Resuelto desde que abriste esta pantalla</h4><ul>{resolved.map((n,i)=><li key={n.key+i}>✓ {n.company} · {n.title}</li>)}</ul></div>}
  <p className="campus-help">Mientras tienes esta pantalla abierta, Freddy pregunta a los agentes de cada empresa cada minuto. Un aviso desaparece solo cuando el problema deja de existir; si lo has arreglado a mano y sigue saliendo, pulsa «Olvidar». De cada caso solo llega la referencia del pedido: los datos de tus clientes se quedan en su empresa.</p>
  </section>}
 </div>;
}

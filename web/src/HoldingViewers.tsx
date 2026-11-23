import {useCallback,useEffect,useId,useRef,useState} from "react";
import {APP_NAME} from "./brand";
import {useAuth0} from "./auth";
import type {Holding} from "./holdingApi";
import {inviteLink,untilText,validLabel,validNewInvite,validViewerList,viewersUrls} from "./viewersApi";
import type {NewInvite,ViewerList} from "./viewersApi";

const READ={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}};
const WRITE={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}};
type Load={state:"loading"}|{state:"ready";list:ViewerList}|{state:"error"}|{state:"hidden"};

/** Solo para el propietario: invitar a alguien a mirar (sin poder cambiar nada), ver quién tiene acceso y retirarlo. */
export function HoldingViewers({holding,origin=window.location.origin}:{holding:Holding;origin?:string}){
 const {getAccessTokenSilently}=useAuth0();const uid=useId();const id=holding.id;
 const [load,setLoad]=useState<Load>({state:"loading"}),[tick,setTick]=useState(0),[busy,setBusy]=useState<string|null>(null);
 const [label,setLabel]=useState(""),[fresh,setFresh]=useState<NewInvite|null>(null),[copied,setCopied]=useState(false);
 const [note,setNote]=useState<{ok:boolean;text:string}|null>(null),[confirm,setConfirm]=useState<string|null>(null);
 const guard=useRef(false);
 useEffect(()=>{
  const abort=new AbortController();
  (async()=>{try{
   const token=await getAccessTokenSilently(READ);if(abort.signal.aborted)return;
   const r=await fetch(viewersUrls.list(id),{headers:{Authorization:"Bearer "+token},signal:abort.signal});if(abort.signal.aborted)return;
   if(r.status===403||r.status===404){setLoad({state:"hidden"});return;}   // un observador no ve este panel
   if(!r.ok){setLoad({state:"error"});return;}
   const raw:unknown=await r.json();if(abort.signal.aborted)return;
   setLoad(validViewerList(raw,id)?{state:"ready",list:raw}:{state:"error"});
  }catch{if(!abort.signal.aborted)setLoad({state:"error"});}})();
  return()=>abort.abort();
 },[id,tick,getAccessTokenSilently]);
 const post=useCallback(async(url:string,body?:string)=>{
  if(guard.current)return null;guard.current=true;
  try{
   const token=await getAccessTokenSilently(WRITE);
   const r=await fetch(url,{method:"POST",headers:{Authorization:"Bearer "+token,...(body?{"Content-Type":"application/json"}:{})},body});
   return{status:r.status,raw:await r.json().catch(()=>null) as unknown};
  }catch{return null;}finally{guard.current=false;}
 },[getAccessTokenSilently]);
 const invite=async()=>{
  if(!validLabel(label)||busy)return;
  setBusy("invite");setNote(null);setFresh(null);setCopied(false);
  const r=await post(viewersUrls.invite(id),JSON.stringify({label:label.trim()}));setBusy(null);
  if(r&&r.status===201&&validNewInvite(r.raw,id)){setFresh(r.raw);setLabel("");setTick(t=>t+1);return;}
  setNote({ok:false,text:r?.status===409?"No se pudo crear: has llegado al máximo de accesos e invitaciones. Quita alguno primero.":r?.status===403?"Solo el propietario puede invitar.":"No se pudo crear la invitación. Inténtalo de nuevo."});
 };
 const revoke=async(item:string,what:string)=>{
  setBusy(item);setNote(null);
  const r=await post(viewersUrls.revoke(id,item));setBusy(null);setConfirm(null);
  if(r&&r.status===200){setNote({ok:true,text:what+" retirado. Ya no puede entrar."});if(fresh?.invite_id===item)setFresh(null);setTick(t=>t+1);return;}
  setNote({ok:false,text:"No se pudo retirar. Inténtalo de nuevo."});
 };
 const copy=async(link:string)=>{try{await navigator.clipboard.writeText(link);setCopied(true);}catch{setCopied(false);setNote({ok:false,text:"No se pudo copiar solo: mantén pulsado el enlace y cópialo a mano."});}};
 if(load.state==="hidden")return null;
 const link=fresh?inviteLink(origin,fresh.token):"";
 return <section className="holding-viewers" aria-labelledby={uid+"t"}>
  <h3 id={uid+"t"}>👁 Accesos de solo consulta</h3>
  <p className="hv-lead">Invita a alguien a <strong>mirar</strong> {APP_NAME}. Lo ve todo, puede preguntar a los agentes, y <strong>no puede cambiar nada</strong>. Tú decides quién entra y se lo quitas cuando quieras.</p>
  <form className="hv-form" onSubmit={e=>{e.preventDefault();void invite();}}>
   <label htmlFor={uid+"l"}>¿Para quién es?</label>
   <div className="hv-row"><input id={uid+"l"} value={label} maxLength={80} placeholder="Ej.: Gestor, socio, Marta…" onChange={e=>setLabel(e.target.value)}/>
   <button type="submit" disabled={!validLabel(label)||busy!==null}>{busy==="invite"?"Creando…":"Crear enlace de invitación"}</button></div>
  </form>
  {fresh&&<div className="hv-fresh" role="status">
   <strong>Enlace para {fresh.label}</strong>
   <p>Envíaselo solo a esa persona. Sirve <strong>una vez</strong> y {untilText(fresh.expires_at)}. No volverá a mostrarse.</p>
   <code className="hv-link">{link}</code>
   <button type="button" onClick={()=>void copy(link)}>{copied?"✓ Copiado":"Copiar enlace"}</button>
  </div>}
  {note&&<p className={note.ok?"hv-note ok":"hv-note bad"} role={note.ok?"status":"alert"}>{note.text}</p>}
  {load.state==="loading"&&<p className="hv-muted">Cargando accesos…</p>}
  {load.state==="error"&&<p className="hv-muted">No se pudo consultar la lista de accesos. <button type="button" className="hv-linkish" onClick={()=>setTick(t=>t+1)}>Reintentar</button></p>}
  {load.state==="ready"&&<>
   {load.list.viewers.length===0&&load.list.invites.length===0&&<p className="hv-muted">Ahora mismo nadie más tiene acceso.</p>}
   <ul className="hv-list">
    {load.list.viewers.map(v=><li key={v.id}><span><strong>{v.label}</strong><small>Con acceso desde el {new Date(v.since).toLocaleDateString("es-ES")}</small></span>
     {confirm===v.id?<span className="hv-confirm"><button type="button" className="danger" disabled={busy!==null} onClick={()=>void revoke(v.id,"Acceso de "+v.label)}>{busy===v.id?"Quitando…":"Sí, quitar"}</button><button type="button" onClick={()=>setConfirm(null)}>No</button></span>
      :<button type="button" onClick={()=>setConfirm(v.id)}>Quitar acceso</button>}</li>)}
    {load.list.invites.map(v=><li key={v.id} className="pending"><span><strong>{v.label}</strong><small>Invitación sin usar · {untilText(v.expires_at)}</small></span>
     <button type="button" disabled={busy!==null} onClick={()=>void revoke(v.id,"Invitación de "+v.label)}>{busy===v.id?"Anulando…":"Anular"}</button></li>)}
   </ul></>}
 </section>;
}

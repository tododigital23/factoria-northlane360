/**
 * Observadores (acceso de solo consulta) por invitación: direcciones, validadores puros y el viaje del código del enlace.
 * El código va en la dirección (?invitacion=…) una sola vez: se guarda en la pestaña para sobrevivir al inicio de sesión y se limpia.
 */
import {API_ROOT} from "./holdingApi";
const base=(id:string)=>API_ROOT+"/v1/me/holding/"+encodeURIComponent(id)+"/viewers";
export const viewersUrls={list:base,invite:(id:string)=>base(id)+"/invites",revoke:(id:string,item:string)=>base(id)+"/"+encodeURIComponent(item)+"/revoke",redeem:API_ROOT+"/v1/me/viewer-invites/redeem"};
export type Viewer={id:string;label:string;since:string};
export type PendingInvite={id:string;label:string;expires_at:string};
export type ViewerList={holding_id:string;invite_hours:number;viewers:Viewer[];invites:PendingInvite[]};
export type NewInvite={holding_id:string;invite_id:string;label:string;expires_at:string;token:string};
export const TOKEN=/^[A-Za-z0-9_-]{30,80}$/;
const KEY="nl_invitacion";
const obj=(v:unknown):v is Record<string,unknown>=>typeof v==="object"&&v!==null&&!Array.isArray(v);
const text=(v:unknown,max=200)=>typeof v==="string"&&v.length>0&&v.length<=max;
const date=(v:unknown)=>typeof v==="string"&&Number.isFinite(Date.parse(v));
export function validViewerList(v:unknown,holdingId:string):v is ViewerList{
 return obj(v)&&v.holding_id===holdingId&&Number.isInteger(v.invite_hours)&&Array.isArray(v.viewers)&&Array.isArray(v.invites)
  &&v.viewers.every(x=>obj(x)&&text(x.id)&&text(x.label,80)&&date(x.since))&&v.invites.every(x=>obj(x)&&text(x.id)&&text(x.label,80)&&date(x.expires_at));
}
export function validNewInvite(v:unknown,holdingId:string):v is NewInvite{
 return obj(v)&&v.holding_id===holdingId&&text(v.invite_id)&&text(v.label,80)&&date(v.expires_at)&&typeof v.token==="string"&&TOKEN.test(v.token);
}
export const validLabel=(s:string)=>{const t=s.trim();return t.length>=1&&t.length<=80&&!/[\x00-\x1f\x7f]/.test(t);};
export const inviteLink=(origin:string,token:string)=>origin.replace(/\/+$/,"")+"/?invitacion="+encodeURIComponent(token);
export function untilText(iso:string,now=Date.now()):string{
 const h=Math.round((Date.parse(iso)-now)/3_600_000);
 return h<=0?"caducada":h<24?"caduca en "+h+" h":"caduca en "+Math.round(h/24)+" día"+(Math.round(h/24)===1?"":"s");
}
/** Saca el código de la dirección (si viene), lo deja guardado en la pestaña y limpia la dirección. */
export function stashInviteFromUrl(href:string,store:Pick<Storage,"setItem">,replace:(url:string)=>void):boolean{
 try{
  const u=new URL(href),v=u.searchParams.get("invitacion");if(v===null)return false;
  u.searchParams.delete("invitacion");replace(u.pathname+(u.search||"")+u.hash);
  if(!TOKEN.test(v))return false;
  store.setItem(KEY,v);return true;
 }catch{return false;}
}
export function hasStashedInvite(store:Pick<Storage,"getItem">):boolean{try{const v=store.getItem(KEY);return !!v&&TOKEN.test(v);}catch{return false;}}
/** El código guardado, sin gastarlo: lo necesita el alta de cuenta, que solo se permite con invitación. */
export function peekStashedInvite(store:Pick<Storage,"getItem">):string|null{try{const v=store.getItem(KEY);return v&&TOKEN.test(v)?v:null;}catch{return null;}}
export function takeStashedInvite(store:Pick<Storage,"getItem"|"removeItem">):string|null{
 try{const v=store.getItem(KEY);store.removeItem(KEY);return v&&TOKEN.test(v)?v:null;}catch{return null;}
}
export type RedeemResult={ok:true;holding:string}|{ok:false;text:string};
export async function redeemInvite(invite:string,token:()=>Promise<string>):Promise<RedeemResult>{
 try{
  const r=await fetch(viewersUrls.redeem,{method:"POST",headers:{Authorization:"Bearer "+await token(),"Content-Type":"application/json"},body:JSON.stringify({token:invite})});
  const d:unknown=await r.json().catch(()=>null);
  if(r.ok&&obj(d)&&d.joined===true&&text(d.holding,120))return{ok:true,holding:d.holding as string};
  if(r.status===409)return{ok:false,text:obj(d)&&typeof d.detail==="string"&&d.detail.length<200?d.detail:"La invitación ya no es válida."};
  return{ok:false,text:"No se pudo activar la invitación ahora. Abre de nuevo el enlace dentro de un rato."};
 }catch{return{ok:false,text:"No se pudo activar la invitación ahora. Abre de nuevo el enlace dentro de un rato."};}
}

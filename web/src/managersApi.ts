import {API_ROOT} from "./holdingApi";
import {TOKEN} from "./viewersApi";

const KEY="nl_manager_invite";
const obj=(v:unknown):v is Record<string,unknown>=>typeof v==="object"&&v!==null&&!Array.isArray(v);
const text=(v:unknown,max=200)=>typeof v==="string"&&v.length>0&&v.length<=max;

export function stashManagerInviteFromUrl(href:string,store:Pick<Storage,"setItem">,replace:(url:string)=>void):boolean{
 try{
  const u=new URL(href),v=u.searchParams.get("manager_invite");if(v===null)return false;
  u.searchParams.delete("manager_invite");replace(u.pathname+(u.search||"")+u.hash);
  if(!TOKEN.test(v))return false;
  store.setItem(KEY,v);return true;
 }catch{return false;}
}
export function takeStashedManagerInvite(store:Pick<Storage,"getItem"|"removeItem">):string|null{
 try{const v=store.getItem(KEY);store.removeItem(KEY);return v&&TOKEN.test(v)?v:null;}catch{return null;}
}
export type ManagerRedeem={ok:true;company:string}|{ok:false;text:string};
export async function redeemManagerInvite(invite:string,token:()=>Promise<string>):Promise<ManagerRedeem>{
 try{
  const r=await fetch(API_ROOT+"/v1/me/managers/redeem",{method:"POST",headers:{Authorization:"Bearer "+await token(),"Content-Type":"application/json"},body:JSON.stringify({token:invite})});
  const d:unknown=await r.json().catch(()=>null);
  if(r.ok&&obj(d)&&d.joined===true&&text(d.company,120))return{ok:true,company:d.company as string};
  if(r.status===409)return{ok:false,text:"La invitación de gestor ya no es válida."};
  return{ok:false,text:"No se pudo activar el perfil de gestor ahora. Abre de nuevo el enlace dentro de un rato."};
 }catch{return{ok:false,text:"No se pudo activar el perfil de gestor ahora. Abre de nuevo el enlace dentro de un rato."};}
}

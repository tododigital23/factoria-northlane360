/**
 * Acceso de solo consulta. El servidor es quien manda (rechaza cualquier cambio de un observador); esto solo evita el
 * viaje y lo explica: si la sesión es de consulta, toda petición que no sea leer —salvo preguntar en el chat— se
 * contesta aquí mismo con un 403 y un aviso en pantalla.
 */
import {API_ROOT} from "./holdingApi";
export const ACCESS_URL=API_ROOT+"/v1/me/access";
export const READ_ONLY_NOTE="Tu acceso es solo de consulta: puedes verlo todo, pero no hacer cambios.";
const ASK=/\/v1\/me\/organizations\/[0-9a-fA-F-]{36}\/eliot\/chat\/?$/;
export function blocksInReadOnly(url:string,method:string|undefined):boolean{
 const m=(method??"GET").toUpperCase();
 return url.startsWith(API_ROOT)&&m!=="GET"&&m!=="HEAD"&&!(m==="POST"&&ASK.test(url.split("?")[0]));
}
export async function loadReadOnly(token:()=>Promise<string>,signal?:AbortSignal):Promise<boolean>{
 try{const r=await fetch(ACCESS_URL,{headers:{Authorization:"Bearer "+await token()},signal});if(!r.ok)return false;const d:unknown=await r.json();
  return !!d&&typeof d==="object"&&(d as {read_only?:unknown}).read_only===true;}catch{return false;}
}
/** Lo que el servidor dice de esta cuenta: si puede pasar y si es de solo consulta. */
export type Access={gate:"allowed";readOnly:boolean}|{gate:"denied"}|{gate:"error"};
export async function loadAccess(token:()=>Promise<string>,signal?:AbortSignal):Promise<Access>{
 try{
  const r=await fetch(ACCESS_URL,{headers:{Authorization:"Bearer "+await token()},signal});
  if(r.status===401||r.status===403)return{gate:"denied"};if(!r.ok)return{gate:"error"};
  const d:unknown=await r.json();if(!d||typeof d!=="object")return{gate:"error"};
  const o=d as {read_only?:unknown;allowed?:unknown};
  // Un servidor antiguo no manda «allowed»: se deja pasar como hasta ahora.
  return o.allowed===false?{gate:"denied"}:{gate:"allowed",readOnly:o.read_only===true};
 }catch{return{gate:"error"};}
}
/** Instala el freno en fetch y devuelve cómo quitarlo. */
export function installReadOnlyGuard(onBlocked:()=>void):()=>void{
 const real=window.fetch;
 const guarded:typeof window.fetch=(input,init)=>{
  const url=typeof input==="string"?input:input instanceof URL?input.href:input.url,method=init?.method??(typeof input==="object"&&!(input instanceof URL)?input.method:undefined);
  if(blocksInReadOnly(url,method)){onBlocked();return Promise.resolve(new Response(JSON.stringify({detail:READ_ONLY_NOTE}),{status:403,headers:{"Content-Type":"application/json"}}));}
  return real(input,init);
 };
 window.fetch=guarded;
 return()=>{if(window.fetch===guarded)window.fetch=real;};
}

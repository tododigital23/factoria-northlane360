import {API_ROOT} from "../holdingApi";
import {validBreak,validMemory,validRequestAck,validTaskRequests} from "./officeModel";
import type {BreakState,MemoryItem,MemoryKey,RequestAck,TaskRequest} from "./officeModel";

export type TokenGetter=()=>Promise<string>;
export const orgUrl=(org:string,path:string)=>API_ROOT+"/v1/me/organizations/"+encodeURIComponent(org)+"/"+path;
export const TOKEN_PARAMS={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}};

/** Resultado de un recurso opcional: si el servidor aún no lo ofrece (404/503), la UI queda deshabilitada con una nota neutral. */
export type Optional<T>={state:"loading"}|{state:"ready";data:T}|{state:"unavailable"}|{state:"error"};
export const UNAVAILABLE_NOTE="Disponible al actualizar el servidor.";

async function getJson(url:string,token:TokenGetter,signal:AbortSignal):Promise<{status:number;body:unknown}>{
 const t=await token();if(signal.aborted)throw new DOMException("Aborted","AbortError");
 const r=await fetch(url,{headers:{Authorization:"Bearer "+t},signal});
 if(!r.ok)return {status:r.status,body:null};
 return {status:r.status,body:await r.json()};
}
export async function loadTaskRequests(org:string,token:TokenGetter,signal:AbortSignal):Promise<Optional<TaskRequest[]>>{
 try{const {status,body}=await getJson(orgUrl(org,"task-requests"),token,signal);
  if(status===404||status===503)return {state:"unavailable"};if(status!==200||!validTaskRequests(body))return {state:"error"};
  return body.enabled?{state:"ready",data:body.requests}:{state:"unavailable"};
 }catch{return {state:"error"};}
}
export async function loadMemory(org:string,token:TokenGetter,signal:AbortSignal):Promise<Optional<MemoryItem[]>>{
 try{const {status,body}=await getJson(orgUrl(org,"memory"),token,signal);
  if(status===404||status===503)return {state:"unavailable"};if(status!==200||!validMemory(body))return {state:"error"};
  return body.enabled?{state:"ready",data:body.items}:{state:"unavailable"};
 }catch{return {state:"error"};}
}

export type SubmitResult={ok:true;ack:RequestAck}|{ok:false;kind:"network"|"conflict"|"forbidden"|"invalid"|"unavailable"|"server"};
export async function submitTaskRequest(org:string,worker:string,payload:{request:string;deliverable:string|null;request_key:string},token:TokenGetter,signal:AbortSignal):Promise<SubmitResult>{
 let r:Response;
 try{const t=await token();r=await fetch(orgUrl(org,"workers/"+encodeURIComponent(worker)+"/requests"),{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify(payload),signal});}
 catch{return {ok:false,kind:"network"};}
 if(r.status===409)return {ok:false,kind:"conflict"};if(r.status===403)return {ok:false,kind:"forbidden"};if(r.status===422||r.status===400)return {ok:false,kind:"invalid"};
 if(r.status===404||r.status===503)return {ok:false,kind:"unavailable"};
 if(r.status!==201&&r.status!==200)return {ok:false,kind:"server"};
 let raw:unknown;try{raw=await r.json();}catch{return {ok:false,kind:"server"};}
 return validRequestAck(raw,org,worker)?{ok:true,ack:raw}:{ok:false,kind:"server"};
}
export type MemorySaveResult={ok:true}|{ok:false;kind:"network"|"forbidden"|"invalid"|"unavailable"|"server"};
export async function saveMemory(org:string,key:MemoryKey,content:string,token:TokenGetter,signal:AbortSignal):Promise<MemorySaveResult>{
 let r:Response;
 try{const t=await token();r=await fetch(orgUrl(org,"memory/"+key),{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({content}),signal});}
 catch{return {ok:false,kind:"network"};}
 if(r.status===403)return {ok:false,kind:"forbidden"};if(r.status===422||r.status===400)return {ok:false,kind:"invalid"};if(r.status===404||r.status===503)return {ok:false,kind:"unavailable"};
 if(!r.ok)return {ok:false,kind:"server"};
 let raw:unknown;try{raw=await r.json();}catch{return {ok:false,kind:"server"};}
 const x=raw as {organization_id?:unknown;key?:unknown;updated?:unknown};
 return x&&x.organization_id===org&&x.key===key&&x.updated===true?{ok:true}:{ok:false,kind:"server"};
}
export function newRequestKey():string{
 if(typeof crypto!=="undefined"&&"randomUUID" in crypto)return crypto.randomUUID();
 const b=Array.from({length:16},()=>Math.floor(Math.random()*256));b[6]=b[6]&15|64;b[8]=b[8]&63|128;
 const h=b.map(x=>x.toString(16).padStart(2,"0")).join("");return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

/** Modo descanso: null si el servidor todavía no lo ofrece o no se pudo confirmar. */
export async function loadBreak(org:string,token:TokenGetter,signal:AbortSignal):Promise<BreakState|null>{
 try{const {status,body}=await getJson(orgUrl(org,"break"),token,signal);return status===200&&validBreak(body,org)&&body.available?body:null;}catch{return null;}
}
export type BreakResult={ok:true;state:BreakState}|{ok:false;kind:"forbidden"|"unavailable"|"network"};
export async function setBreak(org:string,on:boolean,token:TokenGetter):Promise<BreakResult>{
 try{
  const t=await token();const r=await fetch(orgUrl(org,"break"),{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({on})});
  if(r.status===403)return {ok:false,kind:"forbidden"};if(!r.ok)return {ok:false,kind:"unavailable"};
  const raw:unknown=await r.json().catch(()=>null);
  return validBreak(raw,org)&&raw.on_break===on?{ok:true,state:raw}:{ok:false,kind:"unavailable"};
 }catch{return {ok:false,kind:"network"};}
}

/** Activa («contrata») a un agente inactivo: pasa a disponible y puede recibir trabajo. Necesita el permiso de gestión. */
export async function activateWorker(org:string,worker:string,token:TokenGetter):Promise<{ok:true}|{ok:false;kind:"forbidden"|"conflict"|"unavailable"|"network"}>{
 try{
  const t=await token();
  const r=await fetch(orgUrl(org,"workers/"+encodeURIComponent(worker)+"/availability"),{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({state:"idle",request_key:newRequestKey()})});
  if(r.ok)return {ok:true};
  return {ok:false,kind:r.status===403?"forbidden":r.status===409?"conflict":"unavailable"};
 }catch{return {ok:false,kind:"network"};}
}

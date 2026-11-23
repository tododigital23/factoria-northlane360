/**
 * Sesión de La Factoría. Hay dos formas de entrar y el resto de la aplicación no necesita saber cuál se usó:
 *  · acceso propio: usuario y contraseña en nuestra pantalla; el servidor los comprueba con Auth0 y devuelve el permiso;
 *  · página de Auth0: como hasta ahora, mientras el acceso propio no esté encendido en el servidor.
 * `useAuth0()` de este archivo tiene la misma forma que el de la librería, así que cada pantalla pide su permiso igual que siempre.
 *
 * El permiso del acceso propio se guarda solo en la pestaña (sessionStorage): se pierde al cerrarla y caduca cuando dice Auth0.
 * La contraseña no se guarda nunca: se envía una vez y se olvida.
 */
import {createContext,useCallback,useContext,useEffect,useMemo,useState} from "react";
import type {ReactNode} from "react";
import {useAuth0 as useAuth0Page} from "@auth0/auth0-react";
import {API_ROOT} from "./holdingApi";

export type OwnSession={token:string;exp:number;user:{name:string|null;email:string|null}};
const KEY="nl_sesion";
export const AUTH_URL=API_ROOT+"/v1/auth";
const text=(v:unknown,max:number):v is string=>typeof v==="string"&&v.length>0&&v.length<=max;
export function validSession(v:unknown,now=Date.now()):v is OwnSession{
 const s=v as Record<string,unknown>|null;if(!s||typeof s!=="object"||!text(s.token,12000)||typeof s.exp!=="number"||!(s.exp>now))return false;
 const u=s.user as Record<string,unknown>|null;return !!u&&typeof u==="object"&&(u.name===null||text(u.name,80))&&(u.email===null||text(u.email,254));
}
export function readSession(store:Pick<Storage,"getItem">,now=Date.now()):OwnSession|null{
 try{const raw=store.getItem(KEY);if(!raw)return null;const v:unknown=JSON.parse(raw);return validSession(v,now)?v:null;}catch{return null;}
}
function save(s:OwnSession|null){try{if(s)window.sessionStorage.setItem(KEY,JSON.stringify(s));else window.sessionStorage.removeItem(KEY);}catch{/* sin almacenamiento: la sesión dura lo que la página */}}
/** Lo que devuelve el servidor al entrar, convertido en sesión (o null si no tiene la forma esperada). */
export function sessionFrom(raw:unknown,now=Date.now()):OwnSession|null{
 const r=raw as Record<string,unknown>|null;if(!r||typeof r!=="object"||!text(r.access_token,12000)||typeof r.expires_in!=="number"||!(r.expires_in>0))return null;
 const u=(r.user??{}) as Record<string,unknown>;
 return {token:r.access_token,exp:now+Math.min(r.expires_in,2_592_000)*1000,user:{name:text(u.name,80)?u.name:null,email:text(u.email,254)?u.email:null}};
}

type Ctx={session:OwnSession|null;setSession:(s:OwnSession|null)=>void};
const OwnContext=createContext<Ctx|null>(null);
export function OwnSessionProvider({children}:{children:ReactNode}){
 const [session,set]=useState<OwnSession|null>(()=>{try{return readSession(window.sessionStorage);}catch{return null;}});
 const setSession=useCallback((s:OwnSession|null)=>{save(s);set(s);},[]);
 // Al caducar el permiso se cierra la sesión sola: mejor volver a entrar que ver fallos por todas partes.
 useEffect(()=>{if(!session)return;const ms=session.exp-Date.now()-15000;const t=window.setTimeout(()=>setSession(null),Math.max(0,Math.min(ms,2_147_000_000)));return()=>window.clearTimeout(t);},[session,setSession]);
 const value=useMemo(()=>({session,setSession}),[session,setSession]);
 return <OwnContext.Provider value={value}>{children}</OwnContext.Provider>;
}
export function useOwnSession():Ctx{return useContext(OwnContext)??{session:null,setSession:()=>{}};}

/** Misma forma que el `useAuth0` de la librería. Con sesión propia, el permiso sale de ella; si no, de la página de Auth0. */
export function useAuth0():ReturnType<typeof useAuth0Page>{
 const page=useAuth0Page(),{session,setSession}=useOwnSession();
 const token=session?.token,exp=session?.exp;
 const getOwn=useCallback(async()=>{if(!token||!exp||Date.now()>=exp-5000){setSession(null);throw new Error("login_required");}return token;},[token,exp,setSession]);
 const logoutOwn=useCallback(async()=>{setSession(null);window.location.assign(window.location.origin);},[setSession]);
 return useMemo(()=>session?{...page,isAuthenticated:true,isLoading:false,error:undefined,
  user:{name:session.user.name??session.user.email??undefined,email:session.user.email??undefined,given_name:session.user.name?.split(" ")[0]},
  getAccessTokenSilently:getOwn as unknown as typeof page.getAccessTokenSilently,logout:logoutOwn as unknown as typeof page.logout}:page,[page,session,getOwn,logoutOwn]);
}

export type AuthResult={ok:true}|{ok:false;text:string;secure?:boolean};
const GENERIC="No se pudo completar. Inténtalo de nuevo en un momento.";
async function send(path:string,body:unknown):Promise<{status:number;data:unknown}|null>{
 try{const r=await fetch(AUTH_URL+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>null)};}catch{return null;}
}
const detail=(d:unknown)=>{const t=(d as {detail?:unknown}|null)?.detail;return typeof t==="string"&&t.length<=240?t:GENERIC;};
/** Cómo se entra, según el servidor: con nuestro formulario o por la página de Auth0, y si se admiten cuentas nuevas.
 *  Si el servidor no contesta o es antiguo: página de Auth0 y registros cerrados. */
export type AccessConfig={own:boolean;signup:boolean};
export async function loadAccessConfig(signal?:AbortSignal):Promise<AccessConfig>{
 try{const r=await fetch(AUTH_URL+"/config",{signal});if(!r.ok)return {own:false,signup:false};const d=await r.json() as {own_login?:unknown;signup?:unknown}|null;
  return {own:d?.own_login===true,signup:d?.signup===true};}catch{return {own:false,signup:false};}
}
export async function loadOwnLogin(signal?:AbortSignal):Promise<boolean>{return (await loadAccessConfig(signal)).own;}
export async function ownLogin(email:string,password:string,setSession:(s:OwnSession)=>void):Promise<AuthResult>{
 const r=await send("/login",{email:email.trim(),password});
 if(!r)return {ok:false,text:"No hay conexión con el servidor. Inténtalo de nuevo."};
 const s=r.status===200?sessionFrom(r.data):null;
 if(s){setSession(s);return {ok:true};}
 return {ok:false,text:r.status===200?GENERIC:detail(r.data),secure:r.status===409};
}
export async function ownSignup(v:{email:string;password:string;name:string;invite:string},setSession:(s:OwnSession)=>void):Promise<AuthResult>{
 const r=await send("/signup",{email:v.email.trim(),password:v.password,name:v.name.trim(),invite:v.invite});
 if(!r)return {ok:false,text:"No hay conexión con el servidor. Inténtalo de nuevo."};
 const s=r.status===201?sessionFrom(r.data):null;
 if(s){setSession(s);return {ok:true};}
 const d=(r.data as {detail?:unknown}|null)?.detail;
 return {ok:false,text:r.status===201?GENERIC:r.status===422&&typeof d!=="string"?"Revisa los datos: correo válido, nombre y contraseña de al menos 10 caracteres.":detail(r.data)};
}
export async function ownPasswordReset(email:string):Promise<void>{await send("/password-reset",{email:email.trim()});}

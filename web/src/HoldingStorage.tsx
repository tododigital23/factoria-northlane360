import {useCallback,useEffect,useId,useRef,useState} from "react";
import {useAuth0} from "./auth";
import type {Holding} from "./holdingApi";
import {RETURN_MESSAGES,TEST_REASONS,storageUrls,validDisconnect,validHoldingRename,validStart,validStorageStatus,validTest,validateHoldingName} from "./storageApi";
import type {StorageStatus,StorageTest} from "./storageApi";

const READ={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}};
const WRITE={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}};
type Load={state:"loading"}|{state:"ready";status:StorageStatus}|{state:"error"};

/** Lee y limpia de la dirección el resultado de volver de Google. */
function takeReturn():string|null{
 try{
  const u=new URL(window.location.href),v=u.searchParams.get("almacen");if(!v)return null;
  u.searchParams.delete("almacen");window.history.replaceState(null,"",u.pathname+(u.search||"")+u.hash);
  return v in RETURN_MESSAGES?v:"error";
 }catch{return null;}
}

/** Solo para el propietario del holding: nombre del holding y almacén cifrado por empresa. */
export function HoldingStorage({holding,onChanged,go=(url:string)=>window.location.assign(url)}:{holding:Holding;onChanged:()=>void;go?:(url:string)=>void}){
 const {getAccessTokenSilently}=useAuth0();const uid=useId();const id=holding.id;
 const [load,setLoad]=useState<Load>({state:"loading"}),[tick,setTick]=useState(0),[busy,setBusy]=useState<string|null>(null);
 const [note,setNote]=useState<{ok:boolean;text:string}|null>(null),[test,setTest]=useState<StorageTest|null>(null),[confirmOff,setConfirmOff]=useState(false);
 const [name,setName]=useState(holding.name);
 const guard=useRef(false),returned=useRef(false);
 useEffect(()=>{setName(holding.name);},[holding.name]);
 useEffect(()=>{if(returned.current)return;returned.current=true;const r=takeReturn();if(r)setNote(RETURN_MESSAGES[r]);},[]);
 useEffect(()=>{
  const abort=new AbortController();
  (async()=>{try{
   const token=await getAccessTokenSilently(READ);if(abort.signal.aborted)return;
   const r=await fetch(storageUrls.status(id),{headers:{Authorization:"Bearer "+token},signal:abort.signal});if(abort.signal.aborted)return;
   if(!r.ok){setLoad({state:"error"});return;}
   const raw:unknown=await r.json();if(abort.signal.aborted)return;
   setLoad(validStorageStatus(raw,id)?{state:"ready",status:raw}:{state:"error"});
  }catch{if(!abort.signal.aborted)setLoad({state:"error"});}})();
  return()=>abort.abort();
 },[id,tick,getAccessTokenSilently]);
 const post=useCallback(async(url:string,body?:string):Promise<{status:number;raw:unknown}|null>=>{
  try{
   const token=await getAccessTokenSilently(WRITE);
   const r=await fetch(url,{method:"POST",headers:{Authorization:"Bearer "+token,...(body!==undefined?{"Content-Type":"application/json"}:{})},...(body!==undefined?{body}:{})});
   let raw:unknown=null;try{raw=await r.json();}catch{raw=null;}
   return {status:r.status,raw};
  }catch{return null;}
 },[getAccessTokenSilently]);
 async function run(op:string,fn:()=>Promise<void>){if(guard.current)return;guard.current=true;setBusy(op);setNote(null);try{await fn();}finally{guard.current=false;setBusy(null);}}
 const fail=(status:number|undefined,fallback:string)=>setNote({ok:false,text:status===403?"Solo el propietario del holding puede hacer esto.":status===503?"El almacén aún no está disponible en el servidor.":fallback});
 const connect=()=>run("connect",async()=>{
  const r=await post(storageUrls.start(id));
  if(!r||r.status!==200||!validStart(r.raw,id)){fail(r?.status,"No se ha podido iniciar la conexión con Google.");return;}
  go(r.raw.authorization_url);
 });
 const probe=()=>run("test",async()=>{
  setTest(null);const r=await post(storageUrls.test(id));
  if(!r||r.status!==200||!validTest(r.raw,id)){fail(r?.status,r?.status===409?"El almacén no está conectado.":"No se ha podido completar la prueba.");return;}
  setTest(r.raw);setNote(r.raw.ok?{ok:true,text:"Prueba superada: el archivo se subió cifrado, se descargó, se verificó y se borró."}:{ok:false,text:TEST_REASONS[r.raw.reason??""]??"La prueba no se ha completado."});
 });
 const disconnect=()=>run("disconnect",async()=>{
  setConfirmOff(false);const r=await post(storageUrls.disconnect(id));
  if(!r||r.status!==200||!validDisconnect(r.raw,id)){fail(r?.status,"No se ha podido confirmar la desconexión.");return;}
  setTest(null);setNote({ok:true,text:"Almacén desconectado. Las llaves y carpetas de cada empresa se conservan."});setTick(t=>t+1);
 });
 const problem=validateHoldingName(name),same=name.trim()===holding.name;
 const rename=()=>run("rename",async()=>{
  if(problem||same)return;const sent=name.trim();
  const r=await post(storageUrls.name(id),JSON.stringify({name:sent}));
  if(!r||r.status!==200||!validHoldingRename(r.raw,id,sent)){fail(r?.status,r?.status===409||r?.status===422?"El servidor no ha aceptado ese nombre. Prueba con otro.":"No se ha podido confirmar el cambio de nombre.");return;}
  setNote({ok:true,text:`El holding ahora se llama «${r.raw.name}».`});onChanged();
 });
 const status=load.state==="ready"?load.status:null;
 const steps:[keyof StorageTest,string][]=[["uploaded","Subido cifrado"],["stored_unreadable","Ilegible en Google"],["downloaded_and_verified","Descargado y verificado"],["deleted","Borrado"]];
 return <section className="campus-storage" aria-label="Almacén y nombre del holding">
  <div className="campus-storage-card">
   <h3>Almacén cifrado</h3>
   {load.state==="loading"&&<p>Consultando el almacén…</p>}
   {load.state==="error"&&<><p role="alert">No se ha podido consultar el almacén.</p><button type="button" className="campus-ghost campus-storage-retry" onClick={()=>{setLoad({state:"loading"});setTick(t=>t+1);}}>Reintentar</button></>}
   {status&&!status.enabled&&<p role="status">El almacén aún no está disponible en el servidor.</p>}
   {status&&status.enabled&&!status.server_configured&&<p role="status">Faltan en el servidor las credenciales de Google o la llave maestra de cifrado. Hasta que estén, no se puede conectar.</p>}
   {status&&status.enabled&&status.server_configured&&<>
    <p><strong>{status.connected?"Conectado a Google Drive":"Sin conectar"}</strong>{status.connected&&typeof status.companies_with_storage==="number"?` · ${status.companies_with_storage} empresa(s) con almacén propio`:""}</p>
    <p className="campus-help">Cada archivo se cifra aquí con la llave de su empresa antes de subir. En Google solo hay contenido ilegible, y la aplicación solo puede ver los archivos que ella misma crea.</p>
    <div className="campus-actions">
     {!status.connected&&<button type="button" className="campus-primary" disabled={!!busy} onClick={()=>void connect()}>{busy==="connect"?"Abriendo Google…":"Conectar Google Drive"}</button>}
     {status.connected&&<button type="button" className="campus-primary" disabled={!!busy} onClick={()=>void probe()}>{busy==="test"?"Probando…":"Probar"}</button>}
     {status.connected&&<button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void connect()}>Volver a conectar</button>}
     {status.connected&&(confirmOff
      ?<><button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void disconnect()}>Confirmar desconexión</button><button type="button" className="campus-ghost" onClick={()=>setConfirmOff(false)}>Cancelar</button></>
      :<button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>setConfirmOff(true)}>Desconectar</button>)}
    </div>
    {test&&<ul className="campus-storage-steps" aria-label="Resultado de la prueba">{steps.map(([k,label])=><li key={k} className={test[k]?"ok":"ko"}>{test[k]?"✓":"✗"} {label}</li>)}</ul>}
   </>}
  </div>
  <div className="campus-storage-card">
   <h3>Nombre del holding</h3>
   <div className="wizard-field"><label htmlFor={uid+"h"}>Nombre</label>
    <input id={uid+"h"} value={name} maxLength={200} disabled={!!busy} onChange={e=>{setName(e.target.value);setNote(null);}} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();if(!problem&&!same)void rename();}}} enterKeyHint="done" aria-invalid={!!problem} aria-describedby={uid+"h-h"}/>
    <small id={uid+"h-h"} className={problem?"wizard-error":undefined}>{problem||"Es el nombre de todo el proyecto. Cambiarlo no toca ninguna empresa."}</small></div>
   <button type="button" className="campus-primary" disabled={!!busy||!!problem||same} onClick={()=>void rename()}>{busy==="rename"?"Guardando…":"Cambiar nombre"}</button>
  </div>
  {note&&<p className={note.ok?"management-ok":"wizard-error"} role={note.ok?"status":"alert"}>{note.text}</p>}
 </section>;
}

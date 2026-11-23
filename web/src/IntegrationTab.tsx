import {useEffect,useRef,useState} from "react";
import {useAuth0} from "./auth";
import {orgUrl} from "./office/officeApi";
import type {HoldingCompany} from "./holdingApi";

const READ={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}};
const WRITE={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}};
const REPO=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
type Notice={clave:string;nivel:"urgente"|"importante"|"info";titulo:string;cuando:string;como_se_detecta:string};
type Agent={id:string;nombre:string;capacidad:string;para_que:string;avisos:Notice[]};
export type IntegrationPlan={negocio:string;tecnologia:{lenguaje:string;donde_corre:string;datos:string;pagos:string};se_puede_conectar:{veredicto:"si"|"con_trabajo"|"no";por_que:string};
 agentes:Agent[];consultas:{nombre:string;para_que:string}[];acciones:{nombre:string;para_que:string;riesgo:"bajo"|"medio"|"alto"}[];requisitos:string[];riesgos:string[];pasos:string[];configuracion:string;dudas:string[]};
export type IntegrationResult={repository:string;branch:string;files_read:string[];generated_at:string;cost_usd:number;plan:IntegrationPlan};
const str=(v:unknown)=>typeof v==="string",list=(v:unknown)=>Array.isArray(v)&&v.every(str);
/** Solo se pinta una propuesta que tenga la forma esperada; cualquier otra cosa se trata como fallo. */
export function validIntegration(raw:unknown):raw is IntegrationResult{
 if(!raw||typeof raw!=="object")return false;const r=raw as Record<string,unknown>,p=r.plan as Record<string,unknown>|undefined;
 if(!str(r.repository)||!str(r.branch)||!list(r.files_read)||!str(r.generated_at)||typeof r.cost_usd!=="number"||!p||typeof p!=="object")return false;
 const t=p.tecnologia as Record<string,unknown>|undefined,s=p.se_puede_conectar as Record<string,unknown>|undefined;
 if(!str(p.negocio)||!t||!["lenguaje","donde_corre","datos","pagos"].every(k=>str(t[k]))||!s||!["si","con_trabajo","no"].includes(s.veredicto as string)||!str(s.por_que))return false;
 if(!Array.isArray(p.agentes)||!p.agentes.every(a=>a&&str(a.id)&&str(a.nombre)&&str(a.capacidad)&&str(a.para_que)&&Array.isArray(a.avisos)&&a.avisos.every((n:Record<string,unknown>)=>n&&str(n.clave)&&["urgente","importante","info"].includes(n.nivel as string)&&str(n.titulo)&&str(n.cuando)&&str(n.como_se_detecta))))return false;
 if(!Array.isArray(p.consultas)||!p.consultas.every(c=>c&&str(c.nombre)&&str(c.para_que)))return false;
 if(!Array.isArray(p.acciones)||!p.acciones.every(a=>a&&str(a.nombre)&&str(a.para_que)&&["bajo","medio","alto"].includes(a.riesgo)))return false;
 return list(p.requisitos)&&list(p.riesgos)&&list(p.pasos)&&list(p.dudas)&&str(p.configuracion);
}
const VERDICT={si:"Se puede conectar",con_trabajo:"Se puede conectar, con trabajo",no:"Hoy no se puede conectar"} as const;
const LEVEL={urgente:"Urgente",importante:"Importante",info:"Menor"} as const;
const FAIL:Record<number,string>={404:"No puedo leer ese repositorio: no existe, o es privado y Freddy no tiene permiso de lectura.",422:"En ese repositorio no he encontrado código que pueda leer, o el nombre no tiene la forma «propietario/repositorio».",429:"Hoy ya se ha analizado esta empresa el máximo de veces. Mañana se puede repetir.",503:"El asistente de integración no está disponible ahora mismo."};

/** Pestaña «Integración»: Freddy lee el repositorio de la empresa y propone cómo conectarla. No instala ni cambia nada. */
export function IntegrationTab({company,canEdit}:{company:HoldingCompany;canEdit:boolean}){
 const {getAccessTokenSilently}=useAuth0(),org=company.organization_id;
 const [repo,setRepo]=useState(company.repository??""),[result,setResult]=useState<IntegrationResult|null>(null),[left,setLeft]=useState<number|null>(null),[available,setAvailable]=useState(true);
 const [busy,setBusy]=useState(false),[error,setError]=useState(""),[copied,setCopied]=useState(false),lock=useRef(false);
 useEffect(()=>{
  const abort=new AbortController();
  (async()=>{try{
   const r=await fetch(orgUrl(org,"integration"),{headers:{Authorization:"Bearer "+await getAccessTokenSilently(READ)},signal:abort.signal});
   if(!r.ok||abort.signal.aborted)return;const b=await r.json() as Record<string,unknown>;
   setAvailable(b.available===true);if(typeof b.analyses_left_today==="number")setLeft(b.analyses_left_today);if(validIntegration(b.result))setResult(b.result);
  }catch{/* la pestaña sigue sirviendo para lanzar un análisis */}})();
  return()=>abort.abort();
 },[org,getAccessTokenSilently]);
 async function analyze(){
  if(lock.current||!REPO.test(repo.trim()))return;lock.current=true;setBusy(true);setError("");
  try{
   const r=await fetch(orgUrl(org,"integration/analyze"),{method:"POST",headers:{Authorization:"Bearer "+await getAccessTokenSilently(WRITE),"Content-Type":"application/json"},
    body:JSON.stringify({repository:repo.trim(),company_name:company.name,capabilities:(company.capabilities??[]).filter(c=>c.state!=="disabled").map(c=>c.capability)})});
   if(!r.ok){setError(FAIL[r.status]??"No se ha podido hacer el análisis. Inténtalo de nuevo en un momento.");return;}
   const b:unknown=await r.json();
   if(!validIntegration(b)){setError("El asistente ha devuelto una propuesta que no se puede mostrar. Inténtalo de nuevo.");return;}
   setResult(b);setLeft(l=>l===null?null:Math.max(0,l-1));
  }catch{setError("No se ha podido conectar con el servidor.");}
  finally{lock.current=false;setBusy(false);}
 }
 async function copy(text:string){try{await navigator.clipboard.writeText(text);setCopied(true);window.setTimeout(()=>setCopied(false),2500);}catch{setCopied(false);}}
 const p=result?.plan,valid=REPO.test(repo.trim());
 return <div className="integration">
  <p className="management-note">Freddy lee el repositorio de esta empresa y te propone qué agentes ponerle y qué vigilaría cada uno. <strong>Solo propone: no instala nada, no cambia el repositorio y no conecta la empresa.</strong> Conectarla requiere poder modificar su código.</p>
  <div className="integration-form">
   <label htmlFor="integration-repo">Repositorio de GitHub<small>Con la forma propietario/repositorio. Si es privado, Freddy necesita permiso de lectura.</small></label>
   <input id="integration-repo" value={repo} maxLength={141} placeholder="propietario/repositorio" readOnly={!canEdit||busy} onChange={e=>{setRepo(e.target.value);setError("");}}/>
   {canEdit&&<button type="button" className="campus-primary" disabled={busy||!valid||!available||left===0} onClick={()=>void analyze()}>{busy?"Leyendo el repositorio… (hasta 2 minutos)":result?"Volver a analizar":"Analizar el repositorio"}</button>}
   <small role="status">{!available?"El asistente de integración no está disponible en este servidor.":!canEdit?"Solo el propietario puede lanzar el análisis.":left===0?"Hoy ya no quedan análisis para esta empresa.":left!==null?`Te quedan ${left} análisis hoy para esta empresa. Cada uno cuesta alrededor de medio dólar de IA.`:""}</small>
  </div>
  {error&&<p className="request-error" role="alert">{error}</p>}
  {result&&p&&<article className="integration-plan" aria-label="Propuesta de integración">
   <header><span className={"integration-verdict v-"+p.se_puede_conectar.veredicto}>{VERDICT[p.se_puede_conectar.veredicto]}</span><p>{p.se_puede_conectar.por_que}</p>
    <small>{result.repository} · rama {result.branch} · {result.files_read.length} archivos leídos · {new Date(result.generated_at).toLocaleString("es-ES")}</small></header>
   <section><h4>Qué hace esta empresa</h4><p>{p.negocio}</p>
    <dl className="integration-tech"><div><dt>Lenguaje</dt><dd>{p.tecnologia.lenguaje}</dd></div><div><dt>Dónde corre</dt><dd>{p.tecnologia.donde_corre}</dd></div><div><dt>Datos</dt><dd>{p.tecnologia.datos}</dd></div><div><dt>Pagos</dt><dd>{p.tecnologia.pagos}</dd></div></dl></section>
   <section><h4>Agentes que propone ({p.agentes.length})</h4>
    {p.agentes.length===0&&<p>No propone ningún agente para este repositorio.</p>}
    {p.agentes.map(a=><div key={a.id} className="integration-agent"><strong>{a.nombre}</strong><p>{a.para_que}</p>
     {a.avisos.length>0&&<ul>{a.avisos.map(n=><li key={n.clave} className={"lv-"+n.nivel}><span className="notice-level">{LEVEL[n.nivel]}</span><div><b>{n.titulo}</b><p>{n.cuando}</p><small>Cómo se detecta: {n.como_se_detecta}</small></div></li>)}</ul>}</div>)}</section>
   {p.consultas.length>0&&<section><h4>Lo que podrías preguntarle a Freddy</h4><ul className="integration-list">{p.consultas.map(c=><li key={c.nombre}><b>{c.nombre}</b> — {c.para_que}</li>)}</ul></section>}
   {p.acciones.length>0&&<section><h4>Lo que podrías mandarle hacer</h4><ul className="integration-list">{p.acciones.map(a=><li key={a.nombre}><b>{a.nombre}</b> — {a.para_que} <em>(riesgo {a.riesgo})</em></li>)}</ul></section>}
   {p.requisitos.length>0&&<section><h4>Qué hace falta</h4><ul className="integration-list">{p.requisitos.map((x,i)=><li key={i}>{x}</li>)}</ul></section>}
   {p.riesgos.length>0&&<section><h4>Riesgos</h4><ul className="integration-list">{p.riesgos.map((x,i)=><li key={i}>{x}</li>)}</ul></section>}
   {p.dudas.length>0&&<section><h4>Lo que no ha podido saber</h4><ul className="integration-list">{p.dudas.map((x,i)=><li key={i}>{x}</li>)}</ul></section>}
   {p.pasos.length>0&&<section><h4>Pasos para conectarla</h4><ol className="integration-list">{p.pasos.map((x,i)=><li key={i}>{x}</li>)}</ol></section>}
   <section><h4>Borrador de configuración</h4>
    <p>Es un punto de partida para el conector estándar (<code>freddy.config.mjs</code>). <strong>Hay que revisarlo antes de usarlo:</strong> lo ha escrito una IA leyendo el código, sin poder probarlo.</p>
    <pre className="integration-code" tabIndex={0}>{p.configuracion}</pre>
    <button type="button" className="campus-ghost" onClick={()=>void copy(p.configuracion)}>{copied?"Copiado ✓":"Copiar el borrador"}</button></section>
  </article>}
 </div>;
}

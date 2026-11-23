import {useEffect,useRef,useState} from "react";
/**
 * El identificador de una empresa, a la vista y con botón para copiarlo. Es el número que hace falta para conectar
 * los agentes de esa empresa con Freddy; no es un secreto.
 */
export function CompanyId({id}:{id:string}){
 const [state,setState]=useState<"idle"|"copied"|"failed">("idle"),timer=useRef<number|undefined>(undefined);
 useEffect(()=>()=>window.clearTimeout(timer.current),[]);
 async function copy(){
  let ok=false;
  try{await navigator.clipboard.writeText(id);ok=true;}catch{ok=false;}
  setState(ok?"copied":"failed");window.clearTimeout(timer.current);timer.current=window.setTimeout(()=>setState("idle"),2500);
 }
 return <p className="company-id">
  <span>Identificador de la empresa</span>
  <code>{id}</code>
  <button type="button" className="campus-ghost" onClick={()=>void copy()} aria-label="Copiar el identificador de la empresa">{state==="copied"?"Copiado ✓":"Copiar"}</button>
  <small role="status">{state==="failed"?"No se pudo copiar: mantén pulsado el número y cópialo a mano.":""}</small>
 </p>;
}

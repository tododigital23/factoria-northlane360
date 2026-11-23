import {useEffect,useRef,useState} from "react";
import {MEMORY_HINT,MEMORY_KEYS,MEMORY_LABEL} from "./officeModel";
import type {MemoryItem,MemoryKey} from "./officeModel";
import {UNAVAILABLE_NOTE,saveMemory} from "./officeApi";
import type {Optional,TokenGetter} from "./officeApi";

export const MEMORY_MAX=2000;
const SAVE_ERRORS={network:"No se pudo confirmar el guardado. Inténtalo de nuevo.",forbidden:"Solo el propietario puede editar la memoria compartida.",invalid:"El servidor no ha aceptado el texto (máximo 2000 caracteres).",unavailable:"La memoria compartida estará "+UNAVAILABLE_NOTE.toLowerCase(),server:"La respuesta del servidor no es coherente; no se da por guardado."} as const;

/** Tarjeta central «Memoria compartida» (se dibuja sobre el núcleo de las líneas punteadas). */
export function MemoryCore(){return <div className="memory-core" role="note"><span aria-hidden="true">🧠</span><div><strong>Memoria compartida</strong><small>Todos los agentes de esta empresa saben lo que pasa</small></div></div>;}

type Props={organizationId:string;memory:Optional<MemoryItem[]>;canEdit:boolean;token:TokenGetter;onSaved:(key:MemoryKey,content:string)=>void;onClose:()=>void};
export function SharedMemory({organizationId,memory,canEdit,token,onSaved,onClose}:Props){
 const [editing,setEditing]=useState<MemoryKey|null>(null);
 const items=memory.state==="ready"?memory.data:[];
 const content=(k:MemoryKey)=>items.find(i=>i.key===k)?.content??"";
 const ready=memory.state==="ready";
 return <section className="memory-card" aria-label="Skills del negocio">
  <button type="button" className="office-modal-close" aria-label="Cerrar memoria compartida" onClick={onClose}>×</button>
  <span className="memory-overline">Skills del negocio</span>
  <h3>Lo que saben todos</h3>
  {memory.state==="loading"&&<p className="memory-note">Consultando la memoria…</p>}
  {memory.state==="unavailable"&&<p className="memory-note" role="note">La memoria compartida estará {UNAVAILABLE_NOTE.toLowerCase()}</p>}
  {memory.state==="error"&&<p className="memory-note" role="alert">No se pudo leer la memoria compartida.</p>}
  <ul className="memory-list">{MEMORY_KEYS.map(k=>{const filled=content(k).trim().length>0;return <li key={k}>
   <button type="button" className={"memory-item"+(filled?" filled":"")} disabled={!ready} aria-expanded={editing===k} aria-label={MEMORY_LABEL[k]+(filled?" · con contenido":" · vacío")} onClick={()=>setEditing(editing===k?null:k)}>
    <i aria-hidden="true">{filled?"✓":""}</i><span>{MEMORY_LABEL[k]}</span></button>
   {editing===k&&ready&&<MemoryEditor key={k} organizationId={organizationId} memoryKey={k} initial={content(k)} canEdit={canEdit} token={token} onSaved={c=>{onSaved(k,c);setEditing(null);}} onCancel={()=>setEditing(null)}/>}
  </li>;})}</ul>
  {ready&&<p className="memory-foot">{items.filter(i=>i.content.trim()).length} de {MEMORY_KEYS.length} completados · todos tus agentes los usan como contexto.</p>}
 </section>;
}

function MemoryEditor({organizationId,memoryKey,initial,canEdit,token,onSaved,onCancel}:{organizationId:string;memoryKey:MemoryKey;initial:string;canEdit:boolean;token:TokenGetter;onSaved:(c:string)=>void;onCancel:()=>void}){
 const [text,setText]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState<keyof typeof SAVE_ERRORS|null>(null);
 const lock=useRef(false),abort=useRef<AbortController|null>(null);
 useEffect(()=>()=>abort.current?.abort(),[]);
 async function save(){
  if(lock.current||text.length>MEMORY_MAX||!canEdit)return;lock.current=true;setBusy(true);setError(null);abort.current=new AbortController();
  const r=await saveMemory(organizationId,memoryKey,text,token,abort.current.signal);lock.current=false;setBusy(false);
  if(r.ok)onSaved(text);else setError(r.kind);
 }
 const id="memory-edit-"+memoryKey;
 return <div className="memory-editor">
  <label htmlFor={id}>{MEMORY_LABEL[memoryKey]}<small>{MEMORY_HINT[memoryKey]}</small></label>
  <textarea id={id} value={text} maxLength={MEMORY_MAX} rows={5} readOnly={!canEdit} onChange={e=>{setText(e.target.value);setError(null);}}/>
  <div className="request-row"><span>{canEdit?"":"Solo lectura: lo edita el propietario."}</span><span>{text.length} / {MEMORY_MAX}</span></div>
  {error&&<p className="request-error" role="alert">{SAVE_ERRORS[error]}</p>}
  <div className="memory-actions"><button type="button" className="office-secondary" onClick={onCancel}>Cancelar</button>{canEdit&&<button type="button" className="office-primary" disabled={busy||text===initial||text.length>MEMORY_MAX} onClick={()=>void save()}>{busy?"Guardando…":"Guardar"}</button>}</div>
 </div>;
}

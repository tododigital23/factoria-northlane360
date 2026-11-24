import {useId,useState} from "react";
import type {Guide,GuideAction,GuideStep} from "./holdingApi";

const manageLabel={profile:"Abrir perfil y capacidades",routines:"Abrir tareas recurrentes",messages:"Ver mensajes entre agentes",integration:"Abrir la integración",hosting:"Abrir hosting y bases de datos",tienda:"Abrir operación de tienda"};
const actionLabel=(a:GuideAction)=>a.kind==="wizard"?"Crear empresa":a.kind==="manage"?manageLabel[a.tab]:a.kind==="select"?"Ver en el campus":a.kind==="section"?"Ir a "+a.section:"";

/** Panel lateral persistente: qué falta, en qué orden y dónde se hace. */
export function ProjectGuide({guide,onAction,serverNote}:{guide:Guide;onAction:(a:GuideAction)=>void;serverNote?:string}){
 const [open,setOpen]=useState(true);const body=useId();
 const next=guide.next;
 return <aside className="project-guide" aria-label="Guía del proyecto">
  <div className="guide-head">
   <div><span className="guide-eyebrow">GUÍA DEL PROYECTO</span><h2>Siguiente paso</h2></div>
   <button type="button" className="guide-toggle" aria-expanded={open} aria-controls={body} onClick={()=>setOpen(!open)}>{open?"Plegar":"Desplegar"}<span className="sr-only"> la guía</span></button>
  </div>
  <div className="guide-progress">
   <div className="guide-progress-text"><span>Progreso global</span><strong>{guide.percent}%</strong></div>
   <div className="guide-bar" role="progressbar" aria-label="Progreso global del holding" aria-valuemin={0} aria-valuemax={guide.total} aria-valuenow={guide.done} aria-valuetext={`${guide.done} de ${guide.total} pasos completados`}><span style={{width:guide.percent+"%"}}/></div>
   <small>{guide.done} de {guide.total} pasos completados</small>
  </div>
  <div id={body} hidden={!open}>
   <div className="guide-freddy">
    <img src="/freddy-views/front.png" alt="" aria-hidden="true"/>
    <p><strong>Freddy</strong>{guide.freddy}</p>
   </div>
   {serverNote&&<p className="guide-note" role="status">{serverNote}</p>}
   {next&&<div className="guide-next" aria-label="Paso recomendado">
    <span>RECOMENDADO AHORA</span><strong>{next.label}</strong>
    {next.action.kind!=="none"&&<button type="button" className="campus-primary" onClick={()=>onAction(next.action)}>{actionLabel(next.action)}</button>}
   </div>}
   <ol className="guide-phases">
    {guide.phases.map(p=><li key={p.id} className={p.done===p.total?"guide-phase complete":"guide-phase"}>
     <details open={p.done<p.total&&p.steps.some(s=>s===next)||undefined}>
      <summary><span className="guide-phase-title">{p.title}</span><span className="guide-count" aria-label={`${p.done} de ${p.total} completados`}>{p.done}/{p.total}</span></summary>
      <ul>{p.steps.map(s=><StepItem key={s.id} step={s} current={s===next} onAction={onAction}/>)}</ul>
     </details>
    </li>)}
   </ol>
  </div>
 </aside>;
}
function StepItem({step,current,onAction}:{step:GuideStep;current:boolean;onAction:(a:GuideAction)=>void}){
 return <li className={"guide-step"+(step.done?" done":"")+(current?" current":"")} aria-current={current?"step":undefined}>
  <span className="guide-check" aria-hidden="true">{step.done?"✓":current?"➜":"○"}</span>
  <span className="guide-step-label">{step.label}<span className="sr-only">{step.done?" · completado":" · pendiente"}</span></span>
  {!step.done&&step.action.kind!=="none"&&<button type="button" className="guide-link" onClick={()=>onAction(step.action)} aria-label={actionLabel(step.action)+": "+step.label}>{step.action.kind==="wizard"?"Crear":"Ir"}</button>}
 </li>;
}

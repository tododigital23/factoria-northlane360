import {useEffect,useRef} from "react";
import {createFactory} from "./factoryEngine";
import type {Factory,FactoryEventKind} from "./factoryEngine";
import {factoryPose,toFactoryPlot} from "./plots";
import type {Preset} from "./layout";
import {CompanyLogo,companyBrand} from "./CompanyLogo";
import type {CampusPlot} from "../holdingApi";

export type FactoryEvent={id:number;kind:FactoryEventKind;slot:number};
type Props={plots:CampusPlot[];selected:number|null;paused:boolean;calm:boolean;fx:boolean;preset:Preset;
 /** Cambia cada vez que se pulsa una vista de cámara, para repetir el vuelo aunque sea la misma. */ presetNonce:number;
 events:FactoryEvent[];onSelect:(slot:number)=>void;onFreddy:()=>void;onFail:()=>void;onBloom?:(available:boolean)=>void};

/** Escena 3D de La Factoría. Las etiquetas flotantes (logo y nombre) son para el puntero; el teclado y el lector de pantalla usan la fila de parcelas. */
export function FactoryScene({plots,selected,paused,calm,fx,preset,presetNonce,events,onSelect,onFreddy,onFail,onBloom}:Props){
 const stage=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),engine=useRef<Factory|null>(null),seen=useRef(0),first=useRef(true);
 const cb=useRef({onSelect,onFail,onBloom});cb.current={onSelect,onFail,onBloom};
 const elements=useRef(new Map<string,HTMLElement>());
 const aspect=()=>{const s=stage.current;return s&&s.clientHeight?s.clientWidth/s.clientHeight:1.6;};
 useEffect(()=>{
  if(!canvas.current||!stage.current)return;let f:Factory;
  try{f=createFactory({canvas:canvas.current,stage:stage.current,calm,onSelect:s=>cb.current.onSelect(s),onLost:()=>cb.current.onFail()});}catch{cb.current.onFail();return;}
  engine.current=f;for(const [k,el] of elements.current)f.setLabel(k,el);cb.current.onBloom?.(f.bloom);first.current=true;
  return()=>{engine.current=null;f.dispose();};
 // El motor se crea una vez; el resto de propiedades se le pasan en los efectos de abajo.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 useEffect(()=>{engine.current?.setPlots(plots.map(toFactoryPlot));},[plots]);
 useEffect(()=>{engine.current?.setSelected(selected);},[selected]);
 useEffect(()=>{engine.current?.setPaused(paused);},[paused]);
 useEffect(()=>{engine.current?.setCalm(calm);},[calm]);
 useEffect(()=>{engine.current?.setFx(fx);},[fx]);
 useEffect(()=>{engine.current?.setPose(factoryPose(preset,selected,aspect()),first.current);first.current=false;
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[preset,presetNonce,preset==="empresa"?selected:null]);
 useEffect(()=>{for(const e of events)if(e.id>seen.current){seen.current=e.id;if(!paused)engine.current?.emit(e.kind,e.slot);}},[events,paused]);
 const ref=(key:string)=>(el:HTMLElement|null)=>{if(el)elements.current.set(key,el);else elements.current.delete(key);engine.current?.setLabel(key,el);};
 return <div className="fab-stage" ref={stage}>
  <canvas ref={canvas} aria-hidden="true"/>
  <div className="fab-labels">
   <button type="button" tabIndex={-1} aria-hidden="true" className="fab-tag freddy" ref={ref("freddy")} onClick={onFreddy}><span>Freddy · director</span></button>
   {/* Las parcelas libres no llevan rótulo flotante: su cartel de «Se vende» está a pie de obra */}
   {plots.filter(p=>p.company||p.member).map(p=>{const name=p.company?.name??p.member?.name??null,c=p.company;
    return <button key={p.slot} type="button" tabIndex={-1} aria-hidden="true" ref={ref("slot-"+p.slot)} onClick={()=>onSelect(p.slot)}
     className={"fab-tag"+(name?"":" empty")+(selected===p.slot?" sel":"")+(c&&c.tasks.blocked>0?" alert":"")}>
     {name?<CompanyLogo name={name} {...(c?companyBrand(c,plots.flatMap(x=>x.company?[x.company]:[])):{website:null})}/>:<span className="company-logo" aria-hidden="true"><span className="company-logo-letters">+</span></span>}
     <span>{name??"Espacio libre"}</span></button>;})}
  </div>
 </div>;
}

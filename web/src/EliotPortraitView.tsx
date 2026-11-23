import {lazy,Suspense,useState} from 'react';
import './EliotPortraitView.css';
import {freddyFrame,FREDDY_ATLAS} from './freddyProjection';
const FreddyModelPreview=lazy(()=>import('./FreddyModelPreview'));
/** Display the original reference pixels; framing never changes face or clothes. */
export function FreddyReference({waist=false,angle=0}:{waist?:boolean;angle?:number}){
 const frame=freddyFrame(angle*Math.PI/180),[failed,setFailed]=useState(false);
 return <span className={'freddy-reference'+(waist?' freddy-waist':'')}>
  {failed?<span className="freddy-image-error" role="status">No se ha podido cargar la imagen de Freddy.</span>:<img src="/freddy-reference.png" alt={waist?'Freddy de cintura hacia arriba':'Freddy de cuerpo entero'} draggable={false} onError={()=>setFailed(true)} style={{left:`-${frame.x/FREDDY_ATLAS.cellWidth*100}%`,top:`-${frame.y/(waist?235:FREDDY_ATLAS.cropHeight)*100}%`}}/>}
 </span>;
}
export function EliotPortraitView({speaking,listening,queued}:{speaking:boolean;listening:boolean;queued:boolean}){
 const [waist,setWaist]=useState(true),[angle,setAngle]=useState(0),[model,setModel]=useState(false);
 return <section className="eliot-portrait-view" aria-label="Retrato de Freddy conectado a la voz">
  <div className="eliot-portrait-stage"><FreddyReference waist={waist} angle={angle}/></div>
  <p role="status">{listening?'Dictado activo':speaking?'Lectura de respuesta en curso':queued?'Preparando lectura de respuesta':'Freddy · Listo para conversar'}</p>
  <div role="group" aria-label="Encuadre de Freddy"><button type="button" aria-pressed={!waist} onClick={()=>setWaist(false)}>Cuerpo entero</button><button type="button" aria-pressed={waist} onClick={()=>setWaist(true)}>Cintura arriba</button></div>
  <div className="freddy-turn" role="group" aria-label="Girar Freddy"><button type="button" aria-label="Girar Freddy 45 grados a la izquierda" onClick={()=>setAngle(a=>(a+315)%360)}>←</button><output aria-live="polite">Vista {angle}°</output><button type="button" aria-label="Girar Freddy 45 grados a la derecha" onClick={()=>setAngle(a=>(a+45)%360)}>→</button><button type="button" onClick={()=>setAngle(0)}>Vista frontal</button></div>
  <small>Imagen original de Freddy. La lectura de voz no anima los labios.</small>
  <button type="button" aria-expanded={model} onClick={()=>setModel(v=>!v)}>{model?'Cerrar modelo 3D':'Revisar modelo 3D'}</button>
  {model&&<Suspense fallback={<p role="status">Abriendo visor…</p>}><FreddyModelPreview/></Suspense>}
 </section>;
}

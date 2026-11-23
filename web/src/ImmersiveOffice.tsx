import {Component,useEffect,useMemo,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {Canvas,useFrame,useThree} from '@react-three/fiber';
import * as THREE from 'three';
import {SVGRenderer,SVGObject} from 'three/examples/jsm/renderers/SVGRenderer.js';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {EliotHologram} from './EliotHologram';
import {SceneLabel} from './Eliot3DLabels';
import {actorPose,officeHome,officeRoom,officeDesk,OFFICE_AGENT_SCALE,OFFICE_SLOTS_PER_ROOM,officeCameraFit} from './officeChoreography';
import type {Point} from './officeChoreography';
import './ImmersiveOffice.css';
type Person={id:string;department_id:string;name:string;phase:string;recorded_state:string;motionActive:boolean};
type Department={id:string;name:string};
type Props={companyName:string;departments:Department[];workers:Person[];paused:boolean;visible:boolean;onSelect:(id:string)=>void;onUnavailable:()=>void};
const palette=['#537eb1','#9b6c98','#4a998e','#bb895e','#6e74aa','#788d66'];
/** Same Three.js scene graph, with a software renderer when WebGL is unavailable. */
export function createOfficeRenderer(canvas:HTMLCanvasElement|OffscreenCanvas,onSoftware:()=>void):THREE.WebGLRenderer{
 try{return new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});}
 catch{
  if(!(canvas instanceof HTMLCanvasElement))throw Error('A visible canvas is required for software rendering');
  const renderer=new SVGRenderer();renderer.setQuality('low');renderer.setPrecision(2);
  const svg=renderer.domElement;svg.style.position='absolute';svg.style.inset='0';svg.style.width='100%';svg.style.height='100%';canvas.style.visibility='hidden';canvas.parentElement?.appendChild(svg);
  const adapted=renderer as unknown as THREE.WebGLRenderer & {officeSoftware:boolean};adapted.officeSoftware=true;
  adapted.dispose=()=>svg.remove();
  const render=renderer.render.bind(renderer);let lastFrame=-Infinity;
  renderer.render=(scene,camera)=>{const now=performance.now();if(now-lastFrame<66)return;lastFrame=now;render(scene,camera);};
  onSoftware();return adapted;
 }
}
export function bindOfficeLabel(node:SVGElement,onSelect:()=>void){
 node.addEventListener('pointerdown',event=>{event.stopPropagation();onSelect();});
 node.addEventListener('click',event=>event.stopPropagation());
}
function OfficeLabel({text,position,kind='department',onSelect}:{text:string;position:Point;kind?:'eliot'|'department'|'worker';onSelect?:()=>void}){
 const software=!!(useThree(s=>s.gl) as unknown as {officeSoftware?:boolean}).officeSoftware;
 const selectRef=useRef(onSelect);selectRef.current=onSelect;
 const object=useMemo(()=>{
  if(!software)return null;const ns='http://www.w3.org/2000/svg',g=document.createElementNS(ns,'g'),rect=document.createElementNS(ns,'rect'),label=document.createElementNS(ns,'text'),width=kind==='worker'?104:118;
  rect.setAttribute('x',String(-width/2));rect.setAttribute('y','-10');rect.setAttribute('width',String(width));rect.setAttribute('height','19');rect.setAttribute('rx','6');rect.setAttribute('fill',kind==='eliot'?'#193e50':'#293b50');rect.setAttribute('fill-opacity','.92');rect.setAttribute('stroke',kind==='eliot'?'#79e8eb':'#8babb7');rect.setAttribute('stroke-width','.7');
  label.setAttribute('text-anchor','middle');label.setAttribute('y','3');label.setAttribute('fill','#eefaff');label.setAttribute('font-family','sans-serif');label.setAttribute('font-size',kind==='worker'?'7.2':'8.6');label.textContent=text.length>29?text.slice(0,26)+'…':text;
  g.append(rect,label);g.style.cursor='pointer';bindOfficeLabel(g,()=>selectRef.current?.());return new SVGObject(g);
 },[software,text,kind]);
 return software&&object?<primitive object={object} position={position}/>:<SceneLabel text={text} position={position} kind={kind}/>;
}
function Box({position,size,color,metal=0,rough=.65}:{position:Point;size:Point;color:string;metal?:number;rough?:number}){return <mesh position={position} renderOrder={position[1]<.05?-80:0} castShadow receiveShadow><boxGeometry args={size}/><meshStandardMaterial color={color} metalness={metal} roughness={rough}/></mesh>;}
function Plant({position}:{position:Point}){return <group position={position}><mesh position={[0,.22,0]} castShadow><cylinderGeometry args={[.21,.15,.42,12]}/><meshStandardMaterial color="#d7d7ce"/></mesh>{[0,1,2,3,4].map(i=><mesh key={i} position={[Math.sin(i*2)*.15,.65+i*.045,Math.cos(i*2)*.15]} rotation={[.2,i*2,.4]} castShadow><sphereGeometry args={[.19,6,4]}/><meshStandardMaterial color={i%2?'#337568':'#4a9275'}/></mesh>)}</group>;}
function Desk({position,index,occupied=true}:{position:Point;index:number;occupied?:boolean}){return <group position={position} scale={OFFICE_AGENT_SCALE}>
 <Box position={[0,1,0]} size={[2.25,.12,1.1]} color="#947858"/>
 {[-.9,.9].map(x=><Box key={x} position={[x,.48,0]} size={[.07,.95,.8]} color="#344c61" metal={.5}/>)}
 <Box position={[0,1.29,-.28]} size={[.07,.5,.07]} color="#25394c"/>
 <Box position={[0,1.6,-.3]} size={[1.08,.67,.07]} color="#202d3e"/>
 <Box position={[0,1.6,-.345]} size={[.98,.56,.018]} color="#18354b"/>
 {/* Workstation faces the avatar on the near side. Decorative screen, no fabricated report. */}
 <mesh position={[0,1.6,-.253]}><planeGeometry args={[.96,.55]}/><meshStandardMaterial color={occupied?'#123d3c':'#172b2c'} emissive={occupied?'#28a994':'#000000'} emissiveIntensity={.6}/></mesh>
 {occupied&&[0,1,2,3].map(i=><Box key={i} position={[-.15,1.78-i*.1,-.241]} size={[.54-i*.075,.022,.012]} color={occupied?(i%2?'#78c4bb':'#58e3d0'):'#304546'}/>)}
 <Box position={[-.05,1.073,.24]} size={[.76,.036,.23]} color="#647483" metal={.3}/>
 <mesh position={[.62,1.08,.23]}><sphereGeometry args={[.075,8,6]}/><meshStandardMaterial color="#647483"/></mesh>
 <mesh position={[-.78,1.16,.15]} castShadow><cylinderGeometry args={[.085,.07,.22,12]}/><meshStandardMaterial color={palette[index%palette.length]}/></mesh>
 <group position={[0,0,.86]}><Box position={[0,.60,0]} size={[.66,.13,.66]} color="#243e54"/><Box position={[0,.97,.30]} size={[.67,.72,.10]} color="#2e4c62"/><Box position={[0,.29,0]} size={[.08,.5,.08]} color="#63717c" metal={.8}/><Box position={[0,.07,0]} size={[.8,.06,.08]} color="#4d606d"/><Box position={[0,.07,0]} size={[.08,.06,.8]} color="#4d606d"/></group>
 </group>;}
function RoomShell({x,z,title,onSelect}:{x:number;z:number;title:string;onSelect?:()=>void}){return <group>
 <Box position={[x,-.045,z]} size={[5.7,.08,3.65]} color="#314547"/>
 <gridHelper position={[x,.008,z]} args={[5.6,8,'#425b5b','#3a5153']} scale={[1,1,.64]} renderOrder={-70}/>
 <Box position={[x,.2,z-1.83]} size={[5.7,.4,.09]} color="#496064"/>
 <Box position={[x,.415,z-1.83]} size={[5.7,.025,.07]} color="#58d0bd"/>
 <Box position={[x+(x<0?-2.85:2.85),.2,z]} size={[.09,.4,3.7]} color="#496064"/>
 {[-1,1].map(side=><Box key={side} position={[x+(x<0?2.85:-2.85),.2,z+side*1.2]} size={[.09,.4,1.3]} color="#496064"/>)}
 <OfficeLabel text={title} position={[x,.65,z-1.5]} kind="department" onSelect={onSelect}/>
 </group>;}
function Room({d,index,people,onSelect}:{d:Department;index:number;people:Person[];onSelect:Props['onSelect']}){
 const [x,,z]=officeRoom(index);
 return <group>
  <RoomShell x={x} z={z} title={d.name} onSelect={()=>onSelect('department:'+d.id)}/>
  {Array.from({length:OFFICE_SLOTS_PER_ROOM},(_,j)=><Desk key={j} index={index} position={officeDesk(index,j)} occupied={j<Math.min(people.length,3)}/>)}
  <group scale={.6} position={[x+(x<0?-2.5:2.5),0,z+1.45]}><Plant position={[0,0,0]}/></group>
 </group>;
}
function Avatar({worker,index,home,preview,animate,onSelect,hologram=false,showName=true}:{worker?:Person;index:number;home:Point;preview:boolean;animate:boolean;onSelect:Props['onSelect'];hologram?:boolean;showName?:boolean}){
 const root=useRef<THREE.Group>(null),hips=useRef<THREE.Group>(null),head=useRef<THREE.Group>(null),leftArm=useRef<THREE.Group>(null),rightArm=useRef<THREE.Group>(null),leftElbow=useRef<THREE.Group>(null),rightElbow=useRef<THREE.Group>(null),leftThigh=useRef<THREE.Group>(null),rightThigh=useRef<THREE.Group>(null),leftKnee=useRef<THREE.Group>(null),rightKnee=useRef<THREE.Group>(null);
 const timer=useRef(0),last=useRef('rest');
 const color=hologram?'#63e9ef':worker?.recorded_state==='inactive'&&!preview?'#8796a3':palette[index%6];
 const skin=hologram?'#90fbff':['#d3a587','#c58b69','#e1ba9f','#aa7658','#d8ae8f','#c39f85'][index%6];
 function material(c:string){return <meshStandardMaterial color={c} roughness={hologram?.3:.7} metalness={hologram?.25:.04} transparent={hologram} opacity={hologram?.54:1} emissive={hologram?'#288fa7':'#000000'} emissiveIntensity={hologram?.9:0} depthWrite={!hologram}/>;}
 useFrame((_,delta)=>{
  if(!root.current||!hips.current)return;
  if(animate)timer.current+=Math.min(delta,.1);
  const time=timer.current,pose=hologram?{position:home,yaw:Math.PI,action:'talking',stride:time}:actorPose(index,time,home,preview,!!worker?.motionActive);
  root.current.position.set(...pose.position);
  const turn=Math.atan2(Math.sin(pose.yaw-root.current.rotation.y),Math.cos(pose.yaw-root.current.rotation.y));
  root.current.rotation.y=animate?root.current.rotation.y+THREE.MathUtils.damp(0,turn,10,Math.min(delta,.1)):pose.yaw;
  const moving=animate&&pose.action==='walking',typing=pose.action==='typing',sitting=typing||!hologram&&pose.action==='rest',talk=animate&&pose.action==='talking';
  const target=hologram?1.12:sitting?.64:1.05;hips.current.position.y=animate?THREE.MathUtils.damp(hips.current.position.y,target,10,Math.min(delta,.1)):target;
  hips.current.position.y+=animate?(moving?Math.abs(Math.sin(time*7))*.035:Math.sin(time*1.7+index)*.008):0;
  const swing=moving?Math.sin(time*7)*.50:0;
  if(leftThigh.current)leftThigh.current.rotation.x=sitting?Math.PI/2:swing;
  if(rightThigh.current)rightThigh.current.rotation.x=sitting?Math.PI/2:-swing;
  if(leftKnee.current)leftKnee.current.rotation.x=sitting?-Math.PI/2:Math.max(0,-swing)*.6;
  if(rightKnee.current)rightKnee.current.rotation.x=sitting?-Math.PI/2:Math.max(0,swing)*.6;
  if(leftArm.current){leftArm.current.rotation.x=typing?1.05+(animate?Math.sin(time*9+index)*.06:0):-swing;leftArm.current.rotation.z=talk?-.22-Math.sin(time*1.8)*.2:-.1;}
  if(rightArm.current){rightArm.current.rotation.x=typing?1.05+(animate?Math.sin(time*8+index+1)*.06:0):talk?.48+Math.sin(time*2)*.25:swing;rightArm.current.rotation.z=talk?.38:.1;}
  if(leftElbow.current)leftElbow.current.rotation.x=typing?.45:talk?.75:.08;
  if(rightElbow.current)rightElbow.current.rotation.x=typing?.45:talk?.9:.08;
  if(head.current){head.current.rotation.x=typing?.15:animate?Math.sin(time*1.2+index)*.04:0;head.current.rotation.y=talk?Math.sin(time*.9)*.16:0;}
  last.current=pose.action;
 });
 return <group ref={root} position={home} scale={hologram?1.1:OFFICE_AGENT_SCALE} onClick={e=>{e.stopPropagation();onSelect(hologram?'eliot':'worker:'+worker!.id);}}>
  <group ref={hips} position={[0,1.05,0]}>
   <mesh position={[0,.03,0]} castShadow={!hologram}><sphereGeometry args={[.23,12,8]}/>{material(color)}</mesh>
   <mesh position={[0,.40,0]} scale={[1,.95,.65]} castShadow={!hologram}><capsuleGeometry args={[.27,.32,4,12]}/>{material(color)}</mesh>
   <mesh position={[0,.46,-.177]}><boxGeometry args={[.12,.44,.02]}/>{material(hologram?'#d7ffff':'#e5e8e9')}</mesh>
   <mesh position={[0,.47,-.193]} rotation={[0,0,.05]}><boxGeometry args={[.038,.30,.018]}/>{material(hologram?'#72edff':'#40516c')}</mesh>
   <group ref={head} position={[0,.85,0]}>
    <mesh position={[0,-.05,0]}><cylinderGeometry args={[.072,.085,.18,10]}/>{material(skin)}</mesh>
    <mesh position={[0,.14,0]} scale={[.90,1.1,.90]} castShadow={!hologram}><sphereGeometry args={[.195,16,12]}/>{material(skin)}</mesh>
    <mesh position={[0,.25,.025]} scale={[1,.65,1]}><sphereGeometry args={[.19,12,8,0,Math.PI*2,0,Math.PI*.48]}/>{material(hologram?'#baffff':index%2?'#3d2e2a':'#253040')}</mesh>
    <mesh position={[0,.13,-.18]}><sphereGeometry args={[.036,8,6]}/>{material(skin)}</mesh>
    {[-1,1].map(side=><group key={side}><mesh position={[side*.07,.18,-.168]}><sphereGeometry args={[.018,8,6]}/>{material(hologram?'#e4ffff':'#263d4b')}</mesh><mesh position={[side*.181,.14,0]} scale={[.6,1,.7]}><sphereGeometry args={[.045,8,6]}/>{material(skin)}</mesh></group>)}
   </group>
   {[-1,1].map(side=><group key={side} ref={side<0?leftArm:rightArm} position={[side*.31,.63,0]}>
    <mesh position={[0,-.16,0]} castShadow={!hologram}><capsuleGeometry args={[.075,.26,4,8]}/>{material(color)}</mesh>
    <group ref={side<0?leftElbow:rightElbow} position={[0,-.33,0]}><mesh position={[0,-.14,0]} castShadow={!hologram}><capsuleGeometry args={[.065,.23,4,8]}/>{material(color)}</mesh><mesh position={[0,-.31,0]} scale={[.7,1,.6]}><sphereGeometry args={[.09,8,8]}/>{material(skin)}</mesh></group>
   </group>)}
   {[-1,1].map(side=><group key={side} ref={side<0?leftThigh:rightThigh} position={[side*.13,-.02,0]}>
    <mesh position={[0,-.235,0]} castShadow={!hologram}><capsuleGeometry args={[.095,.30,4,8]}/>{material(hologram?'#61d5e7':'#304355')}</mesh>
    <group ref={side<0?leftKnee:rightKnee} position={[0,-.47,0]}><mesh position={[0,-.21,0]} castShadow={!hologram}><capsuleGeometry args={[.078,.30,4,8]}/>{material(hologram?'#61d5e7':'#304355')}</mesh><mesh position={[0,-.46,-.07]} castShadow={!hologram}><boxGeometry args={[.17,.13,.32]}/>{material(hologram?'#b1ffff':'#1b2a38')}</mesh></group>
   </group>)}
  </group>
  {!hologram&&showName&&<OfficeLabel text={worker!.name} position={[0,2.35,0]} kind="worker" onSelect={()=>onSelect('worker:'+worker!.id)}/>}
 </group>;
}
function CameraRig({preset}:{preset:string}){
 const {camera,gl,invalidate,size}=useThree();const controls=useRef<OrbitControls|null>(null);
 useEffect(()=>{const c=new OrbitControls(camera,gl.domElement);controls.current=c;c.enableDamping=true;c.dampingFactor=.08;c.minDistance=3;c.maxDistance=85;c.maxPolarAngle=Math.PI*.47;c.minPolarAngle=.18;c.target.set(0,.7,.4);gl.domElement.tabIndex=0;c.listenToKeyEvents(gl.domElement);const onChange=()=>invalidate();c.addEventListener('change',onChange);return()=>{c.removeEventListener('change',onChange);c.dispose();controls.current=null;};},[camera,gl,invalidate]);
 useEffect(()=>{const pos:Point=preset==='front'?[0,8,23]:preset==='hologram'?[-5.2,2.02,-.1]:preset==='meeting'?[9,4.6,-.5]:preset==='plan'?[0,28,15]:[17,16,21];const target:Point=[preset==='hologram'?-5.2:preset==='meeting'?5.2:0,preset==='hologram'?1.8:.5,preset==='hologram'?-6:preset==='meeting'?-6:0],fit=['plan','overview','front'].includes(preset)?officeCameraFit(size.width/size.height):1;camera.position.set(target[0]+(pos[0]-target[0])*fit,target[1]+(pos[1]-target[1])*fit,target[2]+(pos[2]-target[2])*fit);controls.current?.target.set(...target);controls.current?.update();},[camera,preset,size.width,size.height]);
 useFrame(()=>controls.current?.update());return null;
}
function Scene({p,preview,animate,preset,showNames}:{p:Props;preview:boolean;animate:boolean;preset:string;showNames:boolean}){
 const software=!!(useThree(s=>s.gl) as unknown as {officeSoftware?:boolean}).officeSoftware;
 const placed=p.departments.slice(0,6).flatMap((d,i)=>p.workers.filter(w=>w.department_id===d.id).slice(0,3).map((w,j)=>({w,index:i*3+j,home:officeHome(i,j)})));
 return <>
  <color attach="background" args={['#051719']}/><fog attach="fog" args={['#051719',80,160]}/>
  <ambientLight intensity={software?.35:1.2}/><hemisphereLight args={['#d8f4ff','#5c6775',1.4]}/>
  <directionalLight position={[-7,16,9]} intensity={software?.55:3.1} color="#fff0d8" castShadow shadow-mapSize={[1024,1024]} shadow-camera-left={-13} shadow-camera-right={13} shadow-camera-top={14} shadow-camera-bottom={-14} shadow-normalBias={.035}/>
  <pointLight position={[-5.2,4,-6]} intensity={software?.25:18} color="#62e9ef" distance={12}/>
  <mesh position={[0,-.18,0]} renderOrder={-100} receiveShadow><boxGeometry args={[18,.28,18.6,12,1,12]}/><meshStandardMaterial color="#1b3337" roughness={.75}/></mesh>
  <mesh position={[0,-.027,0]} renderOrder={-90} rotation={[-Math.PI/2,0,0]} receiveShadow><planeGeometry args={[4.1,18.4,2,12]}/><meshStandardMaterial color="#2b4145" roughness={.4}/></mesh>
  <Box position={[-2.12,.02,.2]} size={[.035,.02,17.4]} color="#64c4ca"/><Box position={[2.12,.02,.2]} size={[.035,.02,17.4]} color="#64c4ca"/>
  {p.departments.slice(0,6).map((d,i)=><Room key={d.id} d={d} index={i} people={p.workers.filter(w=>w.department_id===d.id)} onSelect={p.onSelect}/>)}
  <RoomShell x={-5.2} z={-6} title="FREDDY · DIRECCIÓN" onSelect={()=>p.onSelect('eliot')}/>
  <RoomShell x={5.2} z={-6} title="SALA DE ENCUENTRO"/>
  <group position={[5.2,0,-6]}><Box position={[0,.67,0]} size={[3.5,.12,1.1]} color="#947858"/><Box position={[0,.3,0]} size={[1,.6,.65]} color="#365157"/>{[-1,1].map(i=><Box key={i} position={[i*.85,.75,0]} size={[.23,.025,.18]} color="#cfdbd1"/>)}</group>
  <group position={[-5.2,0,-6]} onClick={e=>{e.stopPropagation();p.onSelect('eliot');}}>
   <mesh position={[0,.14,0]} receiveShadow><cylinderGeometry args={[.88,1,.25,32]}/><meshStandardMaterial color="#244b50" metalness={.7} roughness={.25}/></mesh>
   {[0,1,2].map(i=><mesh key={i} position={[0,.28+i*.07,0]} rotation={[Math.PI/2,0,0]}><torusGeometry args={[.6+i*.12,.012,6,48]}/><meshBasicMaterial color={i%2?'#86dcd3':'#55f5cc'} transparent opacity={.8}/></mesh>)}
  </group>
  <EliotHologram animate={animate} onSelect={()=>p.onSelect('eliot')}/>
  {placed.map(({w,index,home})=><Avatar key={w.id} worker={w} index={index} home={home} preview={preview} animate={animate} onSelect={p.onSelect} showName={showNames}/>)}
  <CameraRig preset={preset}/>
 </>;
}
class SceneBoundary extends Component<{onUnavailable:()=>void;children:ReactNode},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}componentDidCatch(){this.props.onUnavailable();}render(){return this.state.failed?<p role="alert">La escena 3D no se pudo iniciar. Se mantiene la vista compatible.</p>:this.props.children;}
}
export function ImmersiveOffice(p:Props){
 const [preview,setPreview]=useState(false),[preset,setPreset]=useState('plan'),[motion,setMotion]=useState(true),[reduced,setReduced]=useState(false),[software,setSoftware]=useState(false),[showNames,setShowNames]=useState(false);
 useEffect(()=>{const query=window.matchMedia?.('(prefers-reduced-motion: reduce)');if(!query)return;const change=()=>setReduced(query.matches);change();query.addEventListener('change',change);return()=>query.removeEventListener('change',change);},[]);
 const animate=motion&&!p.paused&&!reduced&&p.visible;
 return <section className="immersive-office" aria-label={'Oficina 3D interactiva de '+p.companyName}>
  <div className="immersive-toolbar"><div><span>ESCENA TRIDIMENSIONAL</span><h3>Personajes, espacio e interacción</h3></div><button type="button" aria-pressed={preview} onClick={()=>setPreview(!preview)}>{preview?'Volver a estados reales':'Ver interacción animada'}</button><button type="button" aria-pressed={!motion} onClick={()=>setMotion(!motion)}>{motion?'Pausar movimiento':'Reanudar movimiento'}</button></div>
  <p className={preview?'immersive-notice preview':'immersive-notice'} role="status">{preview?'VISTA PREVIA ANIMADA · Coreografía visual: caminar, trabajar en un puesto y conversar. No ejecuta tareas ni representa mensajes reales entre trabajadores.':'ESTADOS REALES · Los movimientos de trabajo requieren ejecución registrada vigente. La respiración y los gestos ambientales son visuales; no acreditan actividad del trabajador.'}</p>
  {software&&<p className="immersive-help">Render 3D por software: personajes y movimientos disponibles sin WebGL; iluminación y sombras simplificadas.</p>}
  <div className="immersive-camera" aria-label="Vistas de cámara">{[['plan','Planta de oficina'],['overview','Vista general'],['front','Vista frontal'],['meeting','Zona de encuentro'],['hologram','Freddy holográfico']].map(([key,label])=><button type="button" key={key} aria-pressed={preset===key} onClick={()=>setPreset(key)}>{label}</button>)}</div>
  {preset==='hologram'&&<p className="immersive-notice">FREDDY · Proyección de la imagen original en ocho vistas. Modelo articulado pendiente.</p>}
  <label className="immersive-label-toggle"><input type="checkbox" checked={showNames} onChange={e=>setShowNames(e.target.checked)}/>Mostrar nombres sobre los agentes</label>
  <div className="immersive-canvas" role="group" aria-label="Personajes tridimensionales y oficina explorable">
   <SceneBoundary onUnavailable={p.onUnavailable}><Canvas shadows camera={{position:[0,28,15],fov:40,near:.1,far:150}} dpr={[1,1.5]} frameloop={p.visible?'always':'never'} gl={canvas=>createOfficeRenderer(canvas,()=>setSoftware(true))} onCreated={({gl})=>{gl.domElement.addEventListener('webglcontextlost',p.onUnavailable,{once:true});}} fallback={<p role="alert">WebGL 2 no está disponible. Se mantiene la vista compatible.</p>}>
    <Scene p={p} preview={preview} animate={animate} preset={preset} showNames={showNames}/>
   </Canvas></SceneBoundary>
   <div className="immersive-overlay"><strong>{p.companyName}</strong><span>{preview?'ENSAYO VISUAL · SIN EJECUCIÓN':'SUPERVISIÓN · DATOS CONSULTADOS'}</span></div>
  </div>
  <p className="immersive-help">Arrastra para girar la cámara; rueda para acercar; botón derecho para desplazar. Toca un personaje o una sala para consultar su registro. Escena: hasta 6 departamentos, 6 puestos visuales por sala y 3 agentes por departamento. Los puestos vacíos son mobiliario, no trabajadores dados de alta. El listado inferior conserva toda la muestra.</p>
  {(!animate||reduced)&&<p>Movimiento visual pausado{reduced?' por preferencia de movimiento reducido':''}. Esto no cambia el estado de los trabajos.</p>}
 </section>;
}

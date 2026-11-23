import {Component,useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {Canvas,useFrame,useThree} from '@react-three/fiber';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import * as THREE from 'three';

const SOURCE='/freddy-3d/Freddy_draft.glb';
export function disposeFreddyModel(root:THREE.Object3D){
 const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();
 root.traverse(node=>{if(!(node instanceof THREE.Mesh))return;geometries.add(node.geometry);for(const material of Array.isArray(node.material)?node.material:[node.material]){materials.add(material);for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);}});
 textures.forEach(t=>{const data=t.source?.data;if(data&&typeof data.close==='function')data.close();t.dispose();});materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose());
}
export function normalizeFreddyModel(model:THREE.Object3D){
 model.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(model),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
 if(!Number.isFinite(size.y)||size.y<=0)throw Error('Modelo sin geometría visible');
 const root=new THREE.Group(),frame=new THREE.Group();frame.position.set(-center.x,-bounds.min.y,-center.z);frame.add(model);root.scale.setScalar(1.7/size.y);root.add(frame);return root;
}
function Rig({animate,onStatus}:{animate:boolean;onStatus:(message:string)=>void}){
 const [root,setRoot]=useState<THREE.Group|null>(null),mixer=useRef<THREE.AnimationMixer|null>(null);
 useEffect(()=>{
  const controller=new AbortController();let active=true,owned:THREE.Group|null=null;
  onStatus('Cargando modelo 3D…');
  void(async()=>{
   try{
    const response=await fetch(SOURCE,{signal:controller.signal});if(!response.ok)throw Error('Archivo no disponible');
    if(Number(response.headers.get('content-length'))>24*1024*1024)throw Error('Archivo demasiado grande');
    const buffer=await response.arrayBuffer();if(buffer.byteLength>24*1024*1024)throw Error('Archivo demasiado grande');if(!active)return;
    const asset=await new GLTFLoader().parseAsync(buffer,'');
    if(!active){disposeFreddyModel(asset.scene);return;}
    try{owned=normalizeFreddyModel(asset.scene);}catch(error){disposeFreddyModel(asset.scene);throw error;}
    mixer.current=new THREE.AnimationMixer(asset.scene);
    if(asset.animations.length)mixer.current.clipAction(asset.animations[0]).play();
    setRoot(owned);onStatus(asset.animations.length?'Modelo cargado · animación de reposo':'Modelo cargado · sin animación');
   }catch{if(active)onStatus('No se pudo cargar el modelo. La referencia original sigue disponible.');}
  })();
  return()=>{active=false;controller.abort();mixer.current?.stopAllAction();mixer.current=null;if(owned)disposeFreddyModel(owned);};
 },[onStatus]);
 useFrame((_,delta)=>{if(animate)mixer.current?.update(Math.min(delta,.1));});
 return root?<primitive object={root}/>:null;
}
function Camera(){
 const {camera,gl,size}=useThree(),control=useRef<OrbitControls|null>(null);
 useEffect(()=>{const c=new OrbitControls(camera,gl.domElement);control.current=c;c.enableDamping=true;c.minDistance=1.5;c.maxDistance=8;c.minPolarAngle=.2;c.maxPolarAngle=Math.PI*.85;c.target.set(0,.85,0);return()=>{c.dispose();control.current=null;};},[camera,gl]);
 useEffect(()=>{camera.position.set(0,1,3.3*Math.max(1,.8/Math.max(.25,size.width/size.height)));camera.lookAt(0,.85,0);control.current?.update();},[camera,size.width,size.height]);
 useFrame(()=>control.current?.update());return null;
}
class PreviewBoundary extends Component<{children:ReactNode},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<p role="status">El visor 3D no está disponible en este navegador. Puedes descargar el modelo.</p>:this.props.children;}
}
export default function FreddyModelPreview(){
 const [supported,setSupported]=useState<boolean|null>(null),[paused,setPaused]=useState(false),[visible,setVisible]=useState(!document.hidden),[reduced,setReduced]=useState(false),[status,setStatus]=useState('Preparando visor 3D…');
 useEffect(()=>{
  const canvas=document.createElement('canvas');let context:WebGL2RenderingContext|null=null;try{context=canvas.getContext('webgl2');setSupported(!!context);}catch{setSupported(false);}finally{context?.getExtension('WEBGL_lose_context')?.loseContext();}
  const query=window.matchMedia?.('(prefers-reduced-motion: reduce)'),change=()=>setReduced(!!query?.matches),visibility=()=>setVisible(!document.hidden);change();query?.addEventListener('change',change);document.addEventListener('visibilitychange',visibility);
  return()=>{query?.removeEventListener('change',change);document.removeEventListener('visibilitychange',visibility);};
 },[]);
 const animate=!paused&&visible&&!reduced;
 return <section className="freddy-model-preview" aria-label="Borrador tridimensional de Freddy">
  <p><strong>Modelo 3D de prueba</strong></p><small>Malla generada a partir de la referencia, todavía sin articulación validada. Revisa el parecido; la voz no anima el rostro.</small>
  {supported===false?<p role="status">Este navegador no ofrece WebGL 2. La referencia original sigue disponible.</p>:supported&&<PreviewBoundary><div className="freddy-model-canvas"><Canvas camera={{position:[0,1,3.3],fov:38,near:.01,far:30}} dpr={[1,1.5]} frameloop={visible?'always':'never'}>
   <color attach="background" args={['#061c20']}/><ambientLight intensity={1.8}/><hemisphereLight args={['#e6faff','#38555e',1.8]}/><directionalLight position={[2,4,5]} intensity={3}/>
   <Rig animate={animate} onStatus={setStatus}/><Camera/>
   <mesh position={[0,-.025,0]}><cylinderGeometry args={[.6,.65,.04,48]}/><meshStandardMaterial color="#285c60"/></mesh>
  </Canvas></div><p role="status">{status}</p>{status==='Modelo cargado · animación de reposo'&&<button type="button" aria-pressed={paused} onClick={()=>setPaused(v=>!v)}>{paused?'Reanudar modelo':'Pausar modelo'}</button>}{reduced&&<p>Movimiento detenido por tu preferencia de movimiento reducido.</p>}<small>Arrastra para girar y usa la rueda para acercar.</small></PreviewBoundary>}
  <a href={SOURCE} download="Freddy_draft.glb">Descargar modelo GLB</a>
 </section>;
}

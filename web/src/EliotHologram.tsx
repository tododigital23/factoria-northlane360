import {useEffect,useMemo,useRef,useState} from 'react';
import {useFrame,useThree} from '@react-three/fiber';
import {SVGObject} from 'three/examples/jsm/renderers/SVGRenderer.js';
import * as THREE from 'three';
import {FREDDY_ATLAS,FREDDY_PLANE,freddyFrame,freddySoftwareSize} from './freddyProjection';
import {createFreddySoftwareImage} from './freddySoftwareImage';
const SOURCE='/freddy-reference.png';
/** Eight photographic views projected in 3D, not a rigged human mesh. */
export function EliotHologram({animate,onSelect,speaking=false}:{animate:boolean;onSelect:()=>void;speaking?:boolean}){
 const {camera,gl,size}=useThree();
 const software=!!(gl as unknown as {officeSoftware?:boolean}).officeSoftware;
 const group=useRef<THREE.Group>(null),clock=useRef(0);
 const select=useRef(onSelect);select.current=onSelect;
 const [texture,setTexture]=useState<THREE.Texture|null>(null);
 useEffect(()=>{
  if(software)return;let active=true;let owned:THREE.Texture|undefined;
  new THREE.TextureLoader().load(SOURCE,t=>{owned=t;if(!active){t.dispose();return;}t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;t.repeat.set(.25,440/1024);setTexture(t);},undefined,()=>{});
  return()=>{active=false;owned?.dispose();};
 },[software]);
 const svg=useMemo(()=>{
  if(!software)return null;const {outer,image}=createFreddySoftwareImage(SOURCE,()=>select.current());
  return {object:new SVGObject(outer),image};
 },[software]);
 useFrame((_,delta)=>{
  // Choose the supplied view nearest the camera, preserving the actual identity.
  const angle=Math.atan2(camera.position.x+5.2,camera.position.z+6);
  const frame=freddyFrame(angle);
  if(texture){texture.offset.set(frame.x/FREDDY_ATLAS.width,1-(frame.y+FREDDY_ATLAS.cropHeight)/FREDDY_ATLAS.height);}
  if(svg){
   svg.image.setAttribute('x',String(-frame.x));svg.image.setAttribute('y',String(-frame.y));
   const center=new THREE.Vector3(-5.2,group.current?.position.y??1.88,-6);
   const projected=freddySoftwareSize(camera,center,size),node=svg.object.node;
   node.setAttribute('width',String(projected.width));node.setAttribute('height',String(projected.height));
   node.setAttribute('x',String(-projected.width/2));node.setAttribute('y',String(-projected.height/2));
  }
  if(group.current){group.current.rotation.y=angle;if(animate)clock.current+=Math.min(delta,.1);group.current.position.y=1.88+(animate?Math.sin(clock.current*1.5)*.025:0);}
 });
 return <group position={[-5.2,0,-6]} onClick={event=>{event.stopPropagation();onSelect();}}>
  <group ref={group} position={[0,1.88,0]}>{software&&svg?<primitive object={svg.object}/>:texture?<mesh><planeGeometry args={[FREDDY_PLANE.width,FREDDY_PLANE.height]}/><meshBasicMaterial map={texture} toneMapped={false} transparent onBeforeCompile={shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\n diffuseColor.a *= smoothstep(0.015, 0.07, max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)));');}} depthWrite={false} side={THREE.DoubleSide}/></mesh>:null}</group>
  {[0,1,2].map(i=><mesh key={i} position={[0,.1+i*.06,0]} rotation={[-Math.PI/2,0,0]}><ringGeometry args={[.48+i*.16,.5+i*.16,48]}/><meshBasicMaterial color="#65ead5" transparent opacity={speaking?.85:.55} side={THREE.DoubleSide}/></mesh>)}
 </group>;
}

import {Component,useEffect,useMemo,useRef,useState} from "react";
import type {MutableRefObject,ReactNode} from "react";
import {Canvas,useFrame,useThree} from "@react-three/fiber";
import type {ThreeEvent} from "@react-three/fiber";
import * as THREE from "three";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {CORRIDOR,MAX_DESKS,ROOM_D,ROOM_W,STATUS_LABEL,deskSlot,jobsSpot,loungeSpot,roomTint} from "./officeModel";
import type {JobsSpot} from "./officeModel";
import {GHOST_FACE,faceOf} from "./people";
import type {Face,Outfit} from "./people";
import type {Agent,RoomLayout} from "./officeModel";
import {MemoryCore} from "./SharedMemory";

/* Paleta del lenguaje visual (tema claro y cálido). */
export const OFFICE_COLORS={orange:"#4f46e5",orangeSoft:"#818cf8",white:"#fffaf0",wall:"#f6efe0",floor:"#f1ead8",black:"#2d3142",wood:"#dfe3ea",plant:"#3fb657",plant2:"#2e9a48",bg:"#bfe3ff"};
const SKINS=["#f1c7a5","#d7a07a","#a8714f","#e8b48f","#c58a63","#7d5038"];
const HAIR=["#2b211c","#5a3a24","#121212","#8a5a35","#d9b48a","#3d2b20"];
const CLOTHES=["#f4f1ec","#2f3a4a","#7c8aa0","#e7dccd","#3e5d4f","#9b5f46","#c9c2b8","#1f2a36"];
type V3=[number,number,number];

export type CameraApi={zoomBy:(f:number)=>void;recenter:()=>void;focus:(key:string|null)=>void};
type Layout={rooms:RoomLayout[];width:number;depth:number};
export type SceneProps={/** Bocadillo del agente elegido (acciones); lo pinta quien usa la escena. */ bubble?:(a:Agent)=>ReactNode;/** Al pulsar el suelo de una sala. */ onRoom?:(key:string)=>void;
 /** Modo descanso: todo el equipo va a la Sala de Descanso y baila; nadie trabaja. */ onBreak?:boolean;
 layout:Layout;agents:Agent[];ownerName:string;selectedId:string|null;focusKey:string|null;paused:boolean;ambient:boolean;memory:boolean;visible:boolean;
 /** Instante (ms) en que cada agente recibió su último encargo real nuevo. */ arrivals?:Record<string,number>;/** Instante (ms) en que cada agente terminó su último trabajo. */ completions?:Record<string,number>;
 cameraApi:MutableRefObject<CameraApi|null>;onSelect:(id:string)=>void;onZoom:(pct:number)=>void;onUnavailable:()=>void};

/** Posición de cada agente: su puesto en la sala de su departamento (máx. 6 por sala). */
export function agentSeats(layout:Layout,agents:Agent[]):Map<string,{room:RoomLayout;desk:V3;slot:number}>{
 const m=new Map<string,{room:RoomLayout;desk:V3;slot:number}>();
 for(const room of layout.rooms){
  const mine=agents.filter(a=>room.departmentId!==null&&a.departmentId===room.departmentId).slice(0,room.direction?2:MAX_DESKS);
  mine.forEach((a,i)=>m.set(a.id,{room,desk:deskSlot(room,i,mine.length),slot:i}));
 }
 return m;
}
export const FREDDY_OFFSET:V3=[-3.7,0,.9],OWNER_OFFSET:V3=[-.5,0,2.4];

/* ---------- Texturas generadas (sin recursos externos) ---------- */
function signTexture(text:string,ratio:number,color:string=OFFICE_COLORS.orange){
 const h=180,w=Math.round(h*ratio),c=document.createElement("canvas");c.width=w;c.height=h;const g=c.getContext("2d");if(!g)return null;
 g.fillStyle=color;g.fillRect(0,0,w,h);g.fillStyle="#ffffff";g.textAlign="center";g.textBaseline="middle";
 let size=104;const font=()=>`800 ${size}px Inter, "Segoe UI", system-ui, sans-serif`;g.font=font();while(g.measureText(text).width>w*.9&&size>40){size-=4;g.font=font();}
 g.fillText(text,w/2,h/2+6);const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return t;
}
function woodTexture(){
 const c=document.createElement("canvas");c.width=512;c.height=512;const g=c.getContext("2d");if(!g)return null;
 const tones=["#e9ecf1","#e2e6ec","#eef0f4","#dde1e8","#e6e9ef"];
 for(let row=0;row<16;row++){let x=-(row*53%160);while(x<512){const w=140+((row*37+x)%90);g.fillStyle=tones[(row+Math.floor(x/70))%tones.length];g.fillRect(x,row*32,w,32);g.fillStyle="rgba(90,100,120,.16)";g.fillRect(x,row*32,2,32);x+=w;}g.fillStyle="rgba(90,100,120,.14)";g.fillRect(0,row*32+31,512,1.5);}
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=4;return t;
}

/** Baldosa clara con junta: se tiñe con el color de cada sala. */
function tileTexture(){
 const c=document.createElement("canvas");c.width=128;c.height=128;const g=c.getContext("2d");if(!g)return null;
 g.fillStyle="#ffffff";g.fillRect(0,0,128,128);g.fillStyle="rgba(0,0,0,.045)";g.fillRect(0,0,64,64);g.fillRect(64,64,64,64);
 g.strokeStyle="rgba(0,0,0,.13)";g.lineWidth=2;g.strokeRect(0,0,64,64);g.strokeRect(64,0,64,64);g.strokeRect(0,64,64,64);g.strokeRect(64,64,64,64);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(ROOM_W/2,ROOM_D/2);t.anisotropy=4;return t;
}
/** Fachada con ventanas para los edificios de alrededor. */
function facadeTexture(seed:number){
 const c=document.createElement("canvas");c.width=128;c.height=256;const g=c.getContext("2d");if(!g)return null;
 g.fillStyle="#ffffff";g.fillRect(0,0,128,256);
 for(let r=0;r<8;r++)for(let k=0;k<4;k++){g.fillStyle=((r*7+k*3+seed)%5===0)?"#ffe9a8":"#9cc4e4";g.fillRect(10+k*30,10+r*31,20,20);g.fillStyle="rgba(255,255,255,.55)";g.fillRect(10+k*30,10+r*31,20,5);}
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return t;
}
function Box({p,s,c,shadow=true,rough=.8}:{p:V3;s:V3;c:string;shadow?:boolean;rough?:number}){
 return <mesh position={p} castShadow={shadow} receiveShadow><boxGeometry args={s}/><meshStandardMaterial color={c} roughness={rough}/></mesh>;
}
function Plant({p,scale=1}:{p:V3;scale?:number}){
 return <group position={p} scale={scale}>
  <mesh position={[0,.28,0]} castShadow receiveShadow><cylinderGeometry args={[.32,.25,.56,14]}/><meshStandardMaterial color="#d9805a" roughness={.7}/></mesh>
  {[[0,.95,0,.52],[.24,.82,.12,.38],[-.22,.86,-.08,.4],[.05,1.25,-.05,.36]].map(([x,y,z,r],i)=><mesh key={i} position={[x,y,z]} castShadow><icosahedronGeometry args={[r,1]}/><meshStandardMaterial color={i%2?OFFICE_COLORS.plant2:OFFICE_COLORS.plant} flatShading roughness={.9}/></mesh>)}
 </group>;
}
function Shelf({p}:{p:V3}){
 const items=["#e2574c","#f6c445","#3b82f6","#22a06b","#f08a24","#7c5cd6"];
 return <group position={p}>{[0,1,2].map(r=><group key={r} position={[0,r*.5,0]}>
  <Box p={[0,0,0]} s={[1.5,.05,.32]} c="#c99a66" shadow={false}/>
  {[0,1,2].map(i=><mesh key={i} position={[-.42+i*.42,.14,0]} castShadow><boxGeometry args={[.16,.24+((i+r)%3)*.05,.16]}/><meshStandardMaterial color={items[(i+r*2)%items.length]} roughness={.6}/></mesh>)}
 </group>)}</group>;
}
function Board({p,width=3}:{p:V3;width?:number}){
 return <group position={p}>
  <Box p={[0,0,0]} s={[width,1.15,.06]} c="#2f6b54" shadow={false}/>
  {[0,1,2].map(col=>[0,1,2,3,4].map(r=><mesh key={col+":"+r} position={[-width/3+col*width/3,.32-r*.17,.04]}><planeGeometry args={[width/4.2*(r===0?.75:r%2?1:.8),.05]}/><meshBasicMaterial color={r===0?OFFICE_COLORS.orange:"#e8ebfa"} toneMapped={false}/></mesh>))}
 </group>;
}

function Room({room,tiles,onSelectRoom,party=false,animate=false}:{room:RoomLayout;tiles:THREE.Texture|null;onSelectRoom:(k:string)=>void;party?:boolean;animate?:boolean}){
 // Pulsar una sala acerca la cámara a ella (sin contar los arrastres).
 const signW=Math.min(6.6,Math.max(3.6,room.name.length*.36+1.4)),SIGN_H=.86,tint=roomTint(room),ACC=tint.accent;
 const sign=useMemo(()=>signTexture(room.name,signW/SIGN_H,ACC),[room.name,signW,ACC]);
 useEffect(()=>()=>sign?.dispose(),[sign]);
 const {x,z}=room,back=z-ROOM_D/2,hw=ROOM_W/2;
 return <group onClick={e=>{e.stopPropagation();if(e.delta>5)return;onSelectRoom(room.key);}}>
  <mesh position={[x,.06,z]} receiveShadow><boxGeometry args={[ROOM_W,.12,ROOM_D]}/><meshStandardMaterial color={tint.floor} map={tiles??undefined} roughness={.85}/></mesh>
  {/* Alfombra bajo la zona de trabajo, del color de la sala */}
  <mesh position={[x,.125,z+.55]} rotation={[-Math.PI/2,0,0]} receiveShadow><planeGeometry args={[ROOM_W-2.6,ROOM_D-3.4]}/><meshStandardMaterial color={ACC} transparent opacity={.16} roughness={1}/></mesh>
  {/* Pared del fondo con rótulo, tablero y estanterías */}
  <Box p={[x,1.3,back+.12]} s={[ROOM_W,2.5,.24]} c={OFFICE_COLORS.white}/>
  <Box p={[x-hw+.18,1.45,back+.18]} s={[.36,2.8,.36]} c="#e9dcc0"/>
  <Box p={[x+hw-.18,1.45,back+.18]} s={[.36,2.8,.36]} c="#e9dcc0"/>
  <mesh position={[x,2.72,back+.3]} castShadow><boxGeometry args={[signW,SIGN_H,.12]}/><meshStandardMaterial color={ACC} roughness={.5}/></mesh>
  {sign&&<mesh position={[x,2.72,back+.365]}><planeGeometry args={[signW,SIGN_H]}/><meshBasicMaterial map={sign} toneMapped={false}/></mesh>}
  {room.lounge?<Lounge room={room} on={party} animate={animate}/>:room.jobs?null:<><Board p={[x,1.45,back+.27]} width={room.direction?2.4:3}/>
  <Shelf p={[x-3.1,.95,back+.42]}/><Shelf p={[x+3.1,.95,back+.42]}/></>}
  {/* Paredes laterales bajas con canto naranja */}
  {[-1,1].map(side=><group key={side}>
   <Box p={[x+side*(hw-.08),.55,z-.6]} s={[.16,.9,ROOM_D-1.4]} c={OFFICE_COLORS.white}/>
   <Box p={[x+side*(hw-.08),1.02,z-.6]} s={[.18,.06,ROOM_D-1.4]} c={ACC} shadow={false}/>
   <Box p={[x+side*(hw-.08),.55,z+ROOM_D/2-.75]} s={[.2,.9,.1]} c={ACC} shadow={false}/>
  </group>)}
  {/* Canto frontal naranja del suelo */}
  <Box p={[x,.125,z+ROOM_D/2-.03]} s={[ROOM_W,.02,.06]} c={ACC} shadow={false}/>
  <Plant p={[x-hw+.75,.12,z+ROOM_D/2-1.1]} scale={.8}/>
  <Plant p={[x+hw-.8,.12,back+1.05]} scale={.75}/>
 </group>;
}

/** Placa de sobremesa con el nombre del agente y su puesto. */
function plaqueTexture(name:string,role:string){
 const c=document.createElement("canvas");c.width=384;c.height=112;const g=c.getContext("2d");if(!g)return null;
 g.fillStyle="#ffffff";g.fillRect(0,0,384,112);g.fillStyle="#c9a24a";g.fillRect(0,0,384,10);g.textAlign="center";g.fillStyle="#1b1d2b";
 let size=40;const font=()=>`800 ${size}px Inter, "Segoe UI", system-ui, sans-serif`;g.font=font();while(g.measureText(name).width>360&&size>20){size-=2;g.font=font();}
 g.fillText(name,192,58);g.fillStyle="#5b6170";let s2=24;const f2=()=>`600 ${s2}px Inter, "Segoe UI", system-ui, sans-serif`;g.font=f2();while(g.measureText(role).width>360&&s2>14){s2-=2;g.font=f2();}g.fillText(role,192,92);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return t;
}
function Plaque({name,role}:{name:string;role:string}){
 const map=useMemo(()=>plaqueTexture(name,role),[name,role]);useEffect(()=>()=>map?.dispose(),[map]);
 // En el borde de la mesa que da a la sala (la mesa está girada: su -z local mira a quien observa).
 return <group position={[.52,.86,.38]} rotation={[-.35,0,0]}><mesh castShadow><boxGeometry args={[.78,.24,.05]}/><meshStandardMaterial color="#f7f3ea" roughness={.6}/></mesh>
  {map&&<mesh position={[0,0,.027]}><planeGeometry args={[.76,.222]}/><meshBasicMaterial map={map} toneMapped={false}/></mesh>}</group>;
}
function Desk({p,on}:{p:V3;on:boolean}){
 return <group position={p}>
  <Box p={[0,.74,0]} s={[1.9,.07,.95]} c="#e8c38f" rough={.5}/>
  <Box p={[-.9,.37,0]} s={[.06,.74,.85]} c="#f7f3ea"/>
  <Box p={[.9,.37,0]} s={[.06,.74,.85]} c="#f7f3ea"/>
  <Box p={[0,.5,-.38]} s={[1.75,.42,.04]} c="#d9b07a"/>
  <Box p={[0,.95,-.28]} s={[.06,.36,.06]} c={OFFICE_COLORS.black}/>
  <Box p={[0,1.22,-.3]} s={[.95,.58,.06]} c={OFFICE_COLORS.black}/>
  <mesh position={[0,1.22,-.265]}><planeGeometry args={[.86,.5]}/><meshBasicMaterial color={on?"#dff9ff":"#232a52"} toneMapped={false}/></mesh>
  {on&&[0,1,2,3].map(i=><mesh key={i} position={[-.1+(i%2)*.05,1.38-i*.1,-.26]}><planeGeometry args={[.55-(i%3)*.12,.035]}/><meshBasicMaterial color={i===0?OFFICE_COLORS.orange:"#7fb9d6"} toneMapped={false}/></mesh>)}
  <Box p={[0,.79,.12]} s={[.62,.025,.2]} c="#cdd3ea" shadow={false}/>
 </group>;
}
function Chair({p,color=OFFICE_COLORS.orange}:{p:V3;color?:string}){
 return <group position={p}>
  <Box p={[0,.5,0]} s={[.62,.12,.6]} c={color}/>
  <Box p={[0,.86,.27]} s={[.62,.62,.1]} c={color}/>
  <Box p={[0,.27,0]} s={[.07,.42,.07]} c={OFFICE_COLORS.black}/>
  {[0,1,2,3,4].map(i=><Box key={i} p={[Math.sin(i*1.256)*.22,.05,Math.cos(i*1.256)*.22]} s={[.07,.05,.3]} c={OFFICE_COLORS.black} shadow={false}/>)}
 </group>;
}
/* ---------- Personas articuladas: piernas, torso, brazos, cabeza y pelo ---------- */
const P_SKIN=["#f1c9a5","#d9a47a","#b07a52","#8a5a3b","#f6d7b8"],P_HAIR=["#2b1d14","#5a3a1e","#101018","#8a6a3a","#3a3a44"],P_SHIRT=["#6f76ff","#22b8cf","#f3f5ff","#7ee3a8","#ffc46b","#9aa7ff"];
type PersonProps={p:V3;seed:number;yaw?:number;seated?:boolean;walking?:boolean;inactive?:boolean;typing?:boolean;
 /** Instante (ms) del último encargo recibido: durante unos segundos levanta la mano y mira alrededor. */ freshAt?:number;animate:boolean;scale?:number;shirt?:string;ghost?:boolean;
 /** Baila (modo descanso) cuando está de pie y parado. */ dancing?:boolean;/** Te necesita: levanta la mano y la agita hasta que le atiendas. */ calling?:boolean;/** Lo escribe quien mueve a la figura: si camina y si está fuera de su puesto. */ motion?:MutableRefObject<Motion>};
type Motion={walking:boolean;away:boolean;/** Sentado ahora mismo (en su puesto o en una silla de espera). */ sit:boolean};
function Limb({at,size,color,pivot,children,ghost}:{at:V3;size:V3;color:string;pivot?:MutableRefObject<THREE.Group|null>;children?:ReactNode;ghost?:boolean}){
 return <group ref={pivot} position={at}><mesh position={[0,-size[1]/2,0]} castShadow={!ghost}><boxGeometry args={size}/><meshStandardMaterial color={color} roughness={.85} transparent={ghost} opacity={ghost?.7:1}/></mesh>{children}</group>;
}
/** Figura de persona. Sentada teclea solo con ejecución real vigente; de pie puede caminar (solo en el modo ambiente, decorativo). */
export function Person({p,seed,yaw=0,seated=false,walking=false,inactive=false,typing=false,freshAt,animate,scale=1,shirt,ghost=false,look,dancing=false,calling=false,motion}:PersonProps&{look?:Face}){
 const hips=useRef<THREE.Group>(null),legL=useRef<THREE.Group>(null),legR=useRef<THREE.Group>(null),armL=useRef<THREE.Group>(null),armR=useRef<THREE.Group>(null),head=useRef<THREE.Group>(null),t=useRef(seed*1.7);
 // Un agente «por crear» es una figura blanca, sin color: se ve el puesto, pero todavía no hay nadie.
 // Con «look» la figura lleva la misma cara que su retrato (piel, pelo, peinado, gafas, cascos y color de ropa).
 const f:Face=ghost?GHOST_FACE:look??{skin:P_SKIN[seed%P_SKIN.length],hair:P_HAIR[(seed*3+1)%P_HAIR.length],shirt:P_SHIRT[(seed*5+2)%P_SHIRT.length],style:(seed%4) as Face["style"],glasses:seed%5===0,headset:false};
 const skin=ghost?"#f1f2f7":f.skin,hair=ghost?"#e2e5ee":f.hair,cloth=ghost?"#eceef5":inactive?"#aab0c8":shirt??f.shirt,trousers=ghost?"#dfe2ec":inactive?"#7d84a3":f.outfit?.trousers??"#2a3050",ink=ghost?"#c3c8d6":"#1b1d2b";
 useFrame((_,d)=>{
  if(!hips.current||!legL.current||!legR.current||!armL.current||!armR.current||!head.current)return;
  if(animate)t.current+=Math.min(d,.1);const T=t.current,fresh=calling||(!!freshAt&&Date.now()>=freshAt&&Date.now()-freshAt<ARRIVAL_SECONDS*1000);
  const mv=motion?.current,sit=mv?mv.sit:seated,walk=walking||!!mv?.walking;
  hips.current.rotation.y=0;armL.current.rotation.z=armR.current.rotation.z=0;head.current.rotation.z=0;
  if(dancing&&!sit&&!walk){
   // Baile: rebote, cadera, brazos arriba y cabeza al ritmo. Cada figura lleva su compás y uno de tres pasos.
   const b=T*7.5+seed,style=seed%3,up=Math.abs(Math.sin(b));
   hips.current.position.y=.78+up*.08;hips.current.rotation.y=Math.sin(b*.5)*.45;
   legL.current.rotation.x=Math.sin(b)*.32;legR.current.rotation.x=-Math.sin(b)*.32;
   if(style===0){armL.current.rotation.x=-2.7+Math.sin(b)*.35;armR.current.rotation.x=-2.7-Math.sin(b)*.35;armL.current.rotation.z=-.25;armR.current.rotation.z=.25;}
   else if(style===1){armL.current.rotation.x=-1.2+Math.sin(b)*1.1;armR.current.rotation.x=-1.2-Math.sin(b)*1.1;}
   else{armL.current.rotation.x=-.4;armR.current.rotation.x=-2.9+Math.sin(b*2)*.25;armL.current.rotation.z=-.5-up*.3;armR.current.rotation.z=Math.sin(b)*.4;}
   head.current.rotation.x=Math.sin(b*2)*.14;head.current.rotation.y=Math.sin(b*.5)*.3;head.current.rotation.z=Math.sin(b)*.12;
  }else if(sit){
   hips.current.position.y=.56;legL.current.rotation.x=legR.current.rotation.x=-Math.PI/2;
   const type=typing&&animate;
   armL.current.rotation.x=-1.15+(type?Math.sin(T*11)*.09:0);
   if(calling){armR.current.rotation.z=animate?Math.sin(T*7)*.35:.2;}
   armR.current.rotation.x=calling?-2.85:fresh?(animate?-1.6-Math.abs(Math.sin(T*5))*1.1:-2.4):-1.15+(type?Math.sin(T*11+1.6)*.09:0);
   head.current.rotation.x=fresh?-.5:typing?-.18:-.38;
   head.current.rotation.y=!animate||inactive?0:fresh?Math.sin(T*4)*.25:typing?Math.sin(T*.5)*.08:Math.sin(T*.4)*.3;
  }else{
   const sw=walk&&animate?Math.sin(T*9)*.6:0;
   legL.current.rotation.x=sw;legR.current.rotation.x=-sw;armL.current.rotation.x=-sw*.7;armR.current.rotation.x=sw*.7;
   hips.current.position.y=.78+(walk&&animate?Math.abs(Math.cos(T*9))*.03:0);
   head.current.rotation.x=0;head.current.rotation.y=!walk&&animate?Math.sin(T*.5)*.25:0;
  }
 });
 const mat=(color:string)=><meshStandardMaterial color={color} roughness={.85} transparent={ghost} opacity={ghost?.7:1}/>;
 // Muñeco de proporciones redondeadas: cabeza grande, cuerpo corto. Se reconoce de lejos y coincide con su retrato.
 return <group position={p} rotation={[0,yaw,0]} scale={scale*1.14}>
  <group ref={hips} position={[0,seated?.56:.78,0]}>
   <Limb pivot={legL} at={[-.13,0,0]} size={[.2,.7,.22]} color={trousers} ghost={ghost}><mesh position={[0,-.73,.06]}><boxGeometry args={[.22,.1,.34]}/>{mat(ghost?"#d3d7e2":"#f4f4f6")}</mesh></Limb>
   <Limb pivot={legR} at={[.13,0,0]} size={[.2,.7,.22]} color={trousers} ghost={ghost}><mesh position={[0,-.73,.06]}><boxGeometry args={[.22,.1,.34]}/>{mat(ghost?"#d3d7e2":"#f4f4f6")}</mesh></Limb>
   <mesh position={[0,.31,0]} castShadow={!ghost}><cylinderGeometry args={[.26,.3,.6,14]}/>{mat(cloth)}</mesh>
   <mesh position={[0,.66,0]} castShadow={!ghost}><cylinderGeometry args={[.3,.26,.14,14]}/>{mat(cloth)}</mesh>
   {[-.38,.38].map(x=><mesh key={"s"+x} position={[x,.7,0]}><sphereGeometry args={[.095,10,8]}/>{mat(cloth)}</mesh>)}
   {!ghost&&<mesh position={[0,.02,0]}><cylinderGeometry args={[.305,.305,.05,14]}/>{mat("#22252e")}</mesh>}
   {!ghost&&!f.outfit?.jacket&&f.outfit?.hat!=="hood"&&f.outfit?.neck!=="scarf"&&f.outfit?.neck!=="sweater"&&<mesh position={[0,.735,.02]} rotation={[Math.PI/2,0,0]}><torusGeometry args={[.115,.03,8,14]}/>{mat(inactive?"#c9cde0":"#ffffff")}</mesh>}
   {!ghost&&!f.outfit&&<><mesh position={[0,.5,.262]}><boxGeometry args={[.035,.3,.012]}/>{mat("#22252e")}</mesh><mesh position={[0,.34,.275]}><boxGeometry args={[.11,.14,.02]}/>{mat("#ffffff")}</mesh></>}
   {!ghost&&!inactive&&f.outfit&&<Clothes o={f.outfit}/>}
   <Limb pivot={armL} at={[-.38,.7,0]} size={[.14,.56,.15]} color={cloth} ghost={ghost}><mesh position={[0,-.6,0]}><sphereGeometry args={[.085,10,8]}/>{mat(skin)}</mesh></Limb>
   <Limb pivot={armR} at={[.38,.7,0]} size={[.14,.56,.15]} color={cloth} ghost={ghost}><mesh position={[0,-.6,0]}><sphereGeometry args={[.085,10,8]}/>{mat(skin)}</mesh></Limb>
   <mesh position={[0,.78,0]}><cylinderGeometry args={[.09,.1,.1,10]}/>{mat(skin)}</mesh>
   <group ref={head} position={[0,1.08,0]}>
    <mesh scale={[1,1.02,1]} castShadow={!ghost}><sphereGeometry args={[.27,20,16]}/>{mat(skin)}</mesh>
    <mesh position={[0,.02,-.03]} rotation={[-.5,0,0]} scale={[1.04,1.06,1.06]}><sphereGeometry args={[.275,20,12,0,Math.PI*2,0,Math.PI*(f.style===1?.36:.44)]}/>{mat(hair)}</mesh>
    
    {f.style===2&&<mesh position={[0,-.14,-.17]}><boxGeometry args={[.5,.46,.2]}/>{mat(hair)}</mesh>}
    {f.style===3&&<mesh position={[0,.31,-.06]}><sphereGeometry args={[.12,12,10]}/>{mat(hair)}</mesh>}
    {[-.27,.27].map(x=><mesh key={"e"+x} position={[x,-.01,0]} scale={[.5,1,.8]}><sphereGeometry args={[.07,10,8]}/>{mat(skin)}</mesh>)}
    {[-.095,.095].map(x=><mesh key={x} position={[x,.015,.248]} scale={[1,1.2,1]}><sphereGeometry args={[.036,10,10]}/><meshBasicMaterial color={ink}/></mesh>)}
    {!ghost&&!f.outfit?.shades&&<>{[-.085,.105].map(x=><mesh key={"h"+x} position={[x,.03,.28]}><sphereGeometry args={[.011,6,6]}/><meshBasicMaterial color="#ffffff"/></mesh>)}
     {[-.095,.095].map(x=><mesh key={"b"+x} position={[x,.085,.25]} rotation={[0,0,x<0?.18:-.18]}><boxGeometry args={[.085,.016,.014]}/><meshBasicMaterial color={hair}/></mesh>)}
     {[-.15,.15].map(x=><mesh key={"c"+x} position={[x,-.055,.222]} rotation={[0,x<0?-.5:.5,0]}><circleGeometry args={[.042,12]}/><meshBasicMaterial color="#ff7a7a" transparent opacity={.32}/></mesh>)}</>}
    <mesh position={[0,-.025,.268]}><sphereGeometry args={[.026,8,8]}/>{mat(skin)}</mesh>
    {!ghost&&<mesh position={[0,-.075,.25]} rotation={[0,0,Math.PI]}><torusGeometry args={[.065,.012,6,12,Math.PI]}/><meshBasicMaterial color={ink}/></mesh>}
    {f.glasses&&<>{[-.095,.095].map(x=><mesh key={x} position={[x,.015,.262]}><torusGeometry args={[.058,.011,6,14]}/><meshBasicMaterial color={ink}/></mesh>)}<mesh position={[0,.015,.27]}><boxGeometry args={[.08,.012,.012]}/><meshBasicMaterial color={ink}/></mesh></>}
    {!ghost&&f.outfit&&<Headwear o={f.outfit} shirt={cloth}/>}
    {f.headset&&<><mesh><torusGeometry args={[.295,.02,6,16,Math.PI]}/>{mat("#22252e")}</mesh>{[-.295,.295].map(x=><mesh key={x} position={[x,-.02,0]}><boxGeometry args={[.07,.15,.13]}/>{mat("#22252e")}</mesh>)}</>}
   </group>
  </group>
 </group>;
}
/** La ropa que se ve sobre el cuerpo: chaqueta abierta, rayas, lunares, dibujo en el pecho y lo que lleva al cuello. */
function Clothes({o}:{o:Outfit}){
 const m=(c:string)=><meshStandardMaterial color={c} roughness={.8}/>;
 return <>
  {o.jacket&&<>{[-1,1].map(sd=><mesh key={sd} position={[sd*.185,.36,.07]} castShadow><boxGeometry args={[.2,.66,.5]}/>{m(o.top2??"#22252e")}</mesh>)}<mesh position={[0,.36,-.1]}><boxGeometry args={[.5,.66,.36]}/>{m(o.top2??"#22252e")}</mesh></>}
  {o.stripes&&[.16,.34,.52].map(y=><mesh key={y} position={[0,y,0]}><cylinderGeometry args={[.292,.292,.05,14]}/>{m(o.top2??"#ffffff")}</mesh>)}
  {o.dots&&[[-.14,.5],[.1,.42],[-.04,.26],[.16,.2],[-.17,.14],[.02,.58]].map(([x,y],i)=><mesh key={i} position={[x,y,.275-Math.abs(x)*.12]}><sphereGeometry args={[.035,8,6]}/>{m(o.top2??"#ffffff")}</mesh>)}
  {o.emblem&&<mesh position={[0,.42,.292]}><boxGeometry args={[.16,.16,.02]}/><meshBasicMaterial color={o.emblem} toneMapped={false}/></mesh>}
  {o.neck==="tie"&&<><mesh position={[0,.63,.3]}><boxGeometry args={[.08,.07,.03]}/>{m(o.neckColor??"#b3261e")}</mesh><mesh position={[0,.42,.3]}><boxGeometry args={[.065,.36,.02]}/>{m(o.neckColor??"#b3261e")}</mesh></>}
  {o.neck==="bow"&&<>{[-1,1].map(sd=><mesh key={sd} position={[sd*.065,.66,.3]} rotation={[0,0,sd*.5]}><boxGeometry args={[.11,.075,.03]}/>{m(o.neckColor??"#b3261e")}</mesh>)}<mesh position={[0,.4,.266]}><boxGeometry args={[.42,.5,.02]}/>{m(o.top2??"#8a5a35")}</mesh></>}
  {o.neck==="scarf"&&<><mesh position={[0,.74,0]} rotation={[Math.PI/2,0,0]}><torusGeometry args={[.16,.065,8,16]}/>{m(o.neckColor??"#b3261e")}</mesh><mesh position={[.1,.52,.27]}><boxGeometry args={[.09,.36,.04]}/>{m(o.neckColor??"#b3261e")}</mesh></>}
  {o.neck==="sweater"&&<><mesh position={[0,.72,-.02]} rotation={[Math.PI/2,0,0]}><torusGeometry args={[.25,.07,8,18]}/>{m(o.neckColor??"#2f4a7a")}</mesh>{[-1,1].map(sd=><mesh key={sd} position={[sd*.07,.56,.28]} rotation={[0,0,sd*-.25]}><boxGeometry args={[.07,.26,.05]}/>{m(o.neckColor??"#2f4a7a")}</mesh>)}</>}
  {o.neck==="chain"&&<mesh position={[0,.62,.2]} rotation={[1.15,0,0]}><torusGeometry args={[.13,.014,6,18]}/><meshStandardMaterial color={o.neckColor??"#c9ccd6"} metalness={.7} roughness={.3}/></mesh>}
 </>;
}
/** Lo que lleva en la cabeza (va dentro del grupo de la cabeza, que mide .27 de radio) y las gafas de sol. */
function Headwear({o,shirt}:{o:Outfit;shirt:string}){
 const c=o.hatColor??shirt,m=(col:string)=><meshStandardMaterial color={col} roughness={.75}/>;
 return <>
  {o.hat==="straw"&&<><mesh position={[0,.2,0]}><cylinderGeometry args={[.5,.5,.03,20]}/>{m(c)}</mesh><mesh position={[0,.29,0]}><cylinderGeometry args={[.22,.26,.17,16]}/>{m(c)}</mesh><mesh position={[0,.235,0]}><cylinderGeometry args={[.268,.268,.05,16]}/>{m("#b3261e")}</mesh></>}
  {o.hat==="cap"&&<><mesh position={[0,.07,0]}><sphereGeometry args={[.29,16,10,0,Math.PI*2,0,Math.PI*.5]}/>{m(c)}</mesh><mesh position={[0,.1,-.32]}><boxGeometry args={[.3,.035,.22]}/>{m(c)}</mesh></>}
  {o.hat==="hood"&&<mesh position={[0,.02,-.06]}><sphereGeometry args={[.33,16,12,0,Math.PI*2,0,Math.PI*.72]}/>{m(shirt)}</mesh>}
  {o.hat==="mohawk"&&<mesh position={[0,.28,-.03]}><boxGeometry args={[.07,.2,.46]}/>{m(c)}</mesh>}
  {o.hat==="band"&&<mesh position={[0,.12,0]} rotation={[Math.PI/2,0,0]}><torusGeometry args={[.262,.03,8,20]}/>{m(c)}</mesh>}
  {o.hat==="beret"&&<><mesh position={[.04,.24,0]} scale={[1,.34,1]} rotation={[0,0,-.18]}><sphereGeometry args={[.32,16,10]}/>{m(c)}</mesh><mesh position={[.04,.36,0]}><cylinderGeometry args={[.015,.015,.06,6]}/>{m(c)}</mesh></>}
  {o.hat==="helmet"&&<><mesh position={[0,.08,0]}><sphereGeometry args={[.3,16,10,0,Math.PI*2,0,Math.PI*.5]}/>{m(c)}</mesh><mesh position={[0,.085,.04]}><cylinderGeometry args={[.36,.36,.03,18]}/>{m(c)}</mesh></>}
  {o.hat==="beanie"&&<><mesh position={[0,.06,0]}><sphereGeometry args={[.292,16,10,0,Math.PI*2,0,Math.PI*.52]}/>{m(c)}</mesh><mesh position={[0,.36,0]}><sphereGeometry args={[.06,8,8]}/>{m("#ffffff")}</mesh></>}
  {o.shades&&<><mesh position={[0,.02,.262]}><boxGeometry args={[.36,.09,.03]}/><meshStandardMaterial color="#101014" roughness={.2}/></mesh></>}
 </>;
}
/** Freddy con su modelo real; mientras carga (o si falla), una figura con su chaqueta amarilla. */
function FreddyFigure({p,yaw,animate}:{p:V3;yaw:number;animate:boolean}){
 const [model,setModel]=useState<THREE.Object3D|null>(null),g=useRef<THREE.Group>(null),t=useRef(0);
 useEffect(()=>{let active=true,owned:THREE.Object3D|null=null;
  const drop=(m:THREE.Object3D)=>m.traverse(x=>{const mesh=x as THREE.Mesh;mesh.geometry?.dispose?.();for(const mt of Array.isArray(mesh.material)?mesh.material:mesh.material?[mesh.material]:[]){(mt as THREE.MeshStandardMaterial).map?.dispose();mt.dispose();}});
  new GLTFLoader().load("/freddy-3d/Freddy_draft.glb",gltf=>{const m=gltf.scene;if(!active){drop(m);return;}
   m.traverse(x=>{const mesh=x as THREE.Mesh;if(mesh.isMesh){mesh.castShadow=true;const mt=mesh.material as THREE.MeshStandardMaterial;if(mt&&"roughness" in mt){mt.metalness=0;mt.roughness=.85;}}});
   let bb=new THREE.Box3().setFromObject(m),sz=bb.getSize(new THREE.Vector3());
   if(sz.z>sz.y*1.5){m.rotation.x=-Math.PI/2;bb=new THREE.Box3().setFromObject(m);sz=bb.getSize(new THREE.Vector3());}
   m.scale.setScalar(2.15/sz.y);bb=new THREE.Box3().setFromObject(m);m.position.y-=bb.min.y;m.position.x-=(bb.min.x+bb.max.x)/2;m.position.z-=(bb.min.z+bb.max.z)/2;
   owned=m;setModel(m);},undefined,()=>{});
  return()=>{active=false;if(owned)drop(owned);};},[]);
 useFrame((_,d)=>{if(!g.current||!model)return;if(animate)t.current+=Math.min(d,.1);g.current.rotation.y=yaw+(animate?Math.sin(t.current*.5)*.18:0);});
 if(!model)return <Person p={p} seed={1} yaw={yaw} animate={animate} shirt="#f2c230" scale={1.05}/>;
 return <group ref={g} position={p} rotation={[0,yaw,0]}><primitive object={model}/></group>;
}

/* ---------- Mensajeros: dron con estela al llegar un encargo; onda y confeti al terminarlo ---------- */
export const DRONE_SECONDS=1.6,DONE_SECONDS=1.6;
function Drone({from,to,at,animate}:{from:V3;to:V3;at:number;animate:boolean}){
 const g=useRef<THREE.Group>(null),rotors=useRef<THREE.Group>(null),trail=useRef<THREE.Group>(null);
 const place=(o:THREE.Object3D,k:number)=>{const e=k<.5?4*k*k*k:1-Math.pow(-2*k+2,3)/2;o.position.set(from[0]+(to[0]-from[0])*e,from[1]+(to[1]-from[1])*e+Math.sin(e*Math.PI)*2.2,from[2]+(to[2]-from[2])*e);};
 useFrame((_,d)=>{const k=(Date.now()-at)/1000/DRONE_SECONDS,on=animate&&k>=0&&k<1;
  if(g.current){g.current.visible=on;if(on){place(g.current,k);g.current.rotation.y+=d*2;}}
  if(rotors.current)for(const r of rotors.current.children)r.rotation.y+=d*40;
  if(trail.current){trail.current.visible=on;if(on)trail.current.children.forEach((s,i)=>{place(s,Math.max(0,k-(i+1)*.035));s.position.y-=.26;});}});
 return <>
  <group ref={g} visible={false}>
   <mesh><boxGeometry args={[.42,.14,.42]}/><meshStandardMaterial color="#dfe4ff"/></mesh>
   <group ref={rotors}>{[[-.34,-.34],[.34,-.34],[-.34,.34],[.34,.34]].map(([x,z])=><mesh key={x+":"+z} position={[x,.08,z]}><cylinderGeometry args={[.2,.2,.012,14]}/><meshBasicMaterial color="#cfd6ff" transparent opacity={.5}/></mesh>)}</group>
   <mesh position={[0,-.26,0]}><boxGeometry args={[.3,.3,.3]}/><meshBasicMaterial color="#ffc46b" toneMapped={false}/></mesh>
   <mesh position={[0,-.26,0]}><sphereGeometry args={[.5,12,10]}/><meshBasicMaterial color="#ffc46b" transparent opacity={.22} depthWrite={false}/></mesh>
  </group>
  <group ref={trail} visible={false}>{[0,1,2,3,4,5].map(i=><mesh key={i}><sphereGeometry args={[.13-.015*i,8,6]}/><meshBasicMaterial color="#ffc46b" transparent opacity={.6-i*.09} depthWrite={false} toneMapped={false}/></mesh>)}</group>
 </>;
}
function DoneFx({p,at,animate}:{p:V3;at:number;animate:boolean}){
 const ring=useRef<THREE.Mesh>(null),pts=useRef<THREE.Points>(null),N=24;
 const seeds=useMemo(()=>Array.from({length:N},(_,i)=>[Math.sin(i*12.9898)*1.6,2.4+((i*37)%10)/4,Math.cos(i*78.233)*1.6]),[]);
 const geo=useMemo(()=>{const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.BufferAttribute(new Float32Array(N*3),3));return g;},[]);
 useEffect(()=>()=>geo.dispose(),[geo]);
 useFrame(()=>{const age=(Date.now()-at)/1000,on=age>=0&&age<DONE_SECONDS,k=age/DONE_SECONDS;
  if(ring.current){ring.current.visible=on;if(on){ring.current.scale.setScalar(animate?1+(1-Math.pow(1-k,3))*3.2:2);(ring.current.material as THREE.MeshBasicMaterial).opacity=.95*(1-k);}}
  if(pts.current){pts.current.visible=on&&animate;if(on&&animate){const a=geo.getAttribute("position") as THREE.BufferAttribute;seeds.forEach(([vx,vy,vz],i)=>a.setXYZ(i,vx*age,Math.max(.05,1.5+vy*age-3.5*age*age),.7+vz*age));a.needsUpdate=true;(pts.current.material as THREE.PointsMaterial).opacity=1-k;}}});
 return <group position={p}>
  <mesh ref={ring} visible={false} rotation={[-Math.PI/2,0,0]} position={[0,.03,.6]}><ringGeometry args={[.5,.66,44]}/><meshBasicMaterial color="#7ee3a8" transparent depthWrite={false} side={THREE.DoubleSide} toneMapped={false}/></mesh>
  <points ref={pts} visible={false} geometry={geo} frustumCulled={false}><pointsMaterial color="#7ee3a8" size={.16} transparent depthWrite={false} toneMapped={false}/></points>
 </group>;
}
function DirectionFurniture({room}:{room:RoomLayout}){
 const {x,z}=room;
 return <group>
  <Box p={[x-1.8,.62,z-.7]} s={[2.8,.12,1.2]} c="#8a4b2f" rough={.4}/>
  <Box p={[x-1.8,.32,z-.7]} s={[2.4,.5,.9]} c="#6f3a24"/>
  <Box p={[x-1.8,.95,z-.95]} s={[.9,.55,.05]} c={OFFICE_COLORS.black}/>
  <mesh position={[x-1.8,.95,z-.92]}><planeGeometry args={[.82,.47]}/><meshBasicMaterial color="#dff9ff" toneMapped={false}/></mesh>
  <group position={[x+1.4,0,z+2.2]}><Box p={[0,.35,0]} s={[1.9,.5,.8]} c="#b3261e"/><Box p={[0,.75,-.32]} s={[1.9,.5,.18]} c="#b3261e"/></group>
 </group>;
}

/** Aviso de trabajo recién llegado: anillo ámbar en el suelo y documento sobre la mesa durante unos segundos. Solo aparece con un encargo real nuevo. */
export const ARRIVAL_SECONDS=9;
function ArrivalFx({p,at,animate}:{p:V3;at:number;animate:boolean}){
 const ring=useRef<THREE.Mesh>(null),doc=useRef<THREE.Mesh>(null);
 useFrame(()=>{const age=(Date.now()-at)/1000,on=age>=0&&age<ARRIVAL_SECONDS;
  if(ring.current){ring.current.visible=on;if(on){const k=animate?(age%1.5)/1.5:.35;ring.current.scale.setScalar(1+k*1.5);(ring.current.material as THREE.MeshBasicMaterial).opacity=animate?.9*(1-k):.8;}}
  if(doc.current){doc.current.visible=on;if(on&&animate)doc.current.position.y=.8+Math.sin(age*3)*.015;}});
 return <group position={p}>
  <mesh ref={ring} rotation={[-Math.PI/2,0,0]} position={[0,.03,.6]}><ringGeometry args={[.85,1,40]}/><meshBasicMaterial color="#ffc46b" transparent depthWrite={false} side={THREE.DoubleSide} toneMapped={false}/></mesh>
  <mesh ref={doc} position={[-.6,.8,.1]}><boxGeometry args={[.3,.03,.4]}/><meshBasicMaterial color="#ffc46b" toneMapped={false}/></mesh>
 </group>;
}

/* ---------- Mobiliario propio de cada departamento: cada sala se reconoce por lo que tiene dentro ---------- */
type PropKind="servers"|"monitors"|"boxes"|"easel"|"files"|"sofa"|"chart"|"parcels"|"robot"|"meeting"|"cooler"|"bench";
function Prop({kind,p,accent}:{kind:PropKind;p:V3;accent:string}){
 const led=(x:number,y:number,c:string)=><mesh key={x+":"+y} position={[x,y,.36]}><planeGeometry args={[.1,.05]}/><meshBasicMaterial color={c} toneMapped={false}/></mesh>;
 return <group position={p}>
  {kind==="servers"&&<>{[-.55,.55].map(x=><group key={x} position={[x,0,0]}><Box p={[0,1,0]} s={[.9,2,.7]} c="#2d3142"/>{[0,1,2,3,4].map(r=><group key={r}><Box p={[0,.35+r*.36,.351]} s={[.78,.26,.02]} c="#454b63" shadow={false}/>{led(-.28,.35+r*.36,r%2?"#5cf08a":"#ffd166")}{led(-.12,.35+r*.36,"#5cf08a")}</group>)}</group>)}</>}
  {kind==="monitors"&&<><Box p={[0,.45,0]} s={[2.4,.9,.6]} c="#e8c38f"/>{[-.8,0,.8].map((x,i)=><group key={x}><Box p={[x,1.45,0]} s={[.72,.5,.06]} c="#22252e"/><mesh position={[x,1.45,.035]}><planeGeometry args={[.64,.42]}/><meshBasicMaterial color={i===1?"#ffe1e1":"#dff9ff"} toneMapped={false}/></mesh><Box p={[x,1.05,0]} s={[.06,.3,.06]} c="#22252e" shadow={false}/></group>)}
   <mesh position={[1.05,1.95,0]}><sphereGeometry args={[.13,10,8]}/><meshStandardMaterial color="#e2574c" emissive="#e2574c" emissiveIntensity={.6}/></mesh><Box p={[1.05,1.75,0]} s={[.1,.3,.1]} c="#5b6170" shadow={false}/></>}
  {kind==="boxes"&&<>{[[-.55,.3,0],[.4,.3,.1],[-.1,.3,-.55],[-.3,.9,-.05],[.35,.9,0],[0,1.5,-.05]].map(([x,y,z],i)=><group key={i}><Box p={[x,y,z]} s={[.8,.6,.75]} c={i%2?"#d6a66f":"#c9955c"}/><Box p={[x,y+.305,z]} s={[.14,.01,.75]} c="#f2e3c6" shadow={false}/></group>)}</>}
  {kind==="easel"&&<><Box p={[-.5,.75,0]} s={[.07,1.5,.07]} c="#8a5a3b"/><Box p={[.5,.75,0]} s={[.07,1.5,.07]} c="#8a5a3b"/><Box p={[0,.75,-.4]} s={[.07,1.5,.07]} c="#8a5a3b"/><Box p={[0,1.25,.04]} s={[1.5,1.05,.05]} c="#ffffff"/>
   {["#e2574c","#f6c445","#3b82f6","#22a06b"].map((c,i)=><mesh key={c} position={[-.5+i*.33,1.05+i*.09,.07]}><planeGeometry args={[.22,.3+i*.18]}/><meshBasicMaterial color={c} toneMapped={false}/></mesh>)}
   <group position={[1.3,0,.2]}><mesh position={[0,.22,0]}><cylinderGeometry args={[.32,.32,.44,16]}/><meshStandardMaterial color={accent} roughness={.8}/></mesh></group></>}
  {kind==="files"&&<>{[-.6,0,.6].map((x,i)=><group key={x}><Box p={[x,.65+(i===1?.2:0),0]} s={[.56,1.3+(i===1?.4:0),.6]} c="#c9ced8"/>{[0,1,2].map(r=><group key={r}><Box p={[x,.3+r*.42,.305]} s={[.46,.34,.01]} c="#dfe3ea" shadow={false}/><Box p={[x,.3+r*.42,.315]} s={[.16,.04,.02]} c="#5b6170" shadow={false}/></group>)}</group>)}</>}
  {kind==="sofa"&&<><Box p={[0,.32,0]} s={[2.1,.4,.85]} c={accent}/><Box p={[0,.72,-.34]} s={[2.1,.5,.18]} c={accent}/><Box p={[-1.02,.5,0]} s={[.16,.5,.85]} c={accent}/><Box p={[1.02,.5,0]} s={[.16,.5,.85]} c={accent}/>
   <mesh position={[0,.3,1.05]}><cylinderGeometry args={[.5,.5,.08,20]}/><meshStandardMaterial color="#e8c38f" roughness={.5}/></mesh><Box p={[0,.15,1.05]} s={[.1,.3,.1]} c="#8a5a3b" shadow={false}/>
   <mesh position={[.15,.4,1.05]}><cylinderGeometry args={[.07,.06,.12,10]}/><meshStandardMaterial color="#ffffff"/></mesh></>}
  {kind==="chart"&&<><Box p={[0,.3,0]} s={[.5,.6,.4]} c="#5b6170"/><Box p={[0,1.45,0]} s={[2.1,1.25,.08]} c="#22252e"/><mesh position={[0,1.45,.045]}><planeGeometry args={[1.98,1.13]}/><meshBasicMaterial color="#ffffff" toneMapped={false}/></mesh>
   {[.3,.5,.42,.7,.9].map((h,i)=><mesh key={i} position={[-.7+i*.35,.95+h/2,.05]}><planeGeometry args={[.22,h]}/><meshBasicMaterial color={i===4?accent:"#9cc4e4"} toneMapped={false}/></mesh>)}</>}
  {kind==="parcels"&&<>{[0,1,2].map(r=><group key={r}><Box p={[0,.2+r*.62,0]} s={[2.2,.06,.7]} c="#8a5a3b"/>{[-.75,-.2,.4,.85].map((x,i)=><Box key={x} p={[x,.2+r*.62+.2,0]} s={[.36+((i+r)%2)*.12,.34,.5]} c={["#d6a66f","#f2e3c6","#c9955c","#e9c79a"][(i+r)%4]}/>)}</group>)}
   <Box p={[-1.1,.8,0]} s={[.07,1.6,.7]} c="#5b6170"/><Box p={[1.1,.8,0]} s={[.07,1.6,.7]} c="#5b6170"/></>}
  {kind==="robot"&&<><mesh position={[0,.15,0]}><cylinderGeometry args={[.55,.62,.3,18]}/><meshStandardMaterial color="#5b6170" roughness={.5}/></mesh><Box p={[0,.75,0]} s={[.22,.95,.22]} c={accent}/>
   <group position={[0,1.2,0]} rotation={[0,0,-.7]}><Box p={[0,.4,0]} s={[.18,.85,.18]} c={accent}/><Box p={[0,.85,0]} s={[.3,.14,.3]} c="#22252e"/></group>
   <mesh position={[0,1.2,0]} rotation={[Math.PI/2,0,0]}><cylinderGeometry args={[.16,.16,.3,14]}/><meshStandardMaterial color="#22252e"/></mesh>
   {[[-.95,.5],[1,.35]].map(([x,r],i)=><mesh key={i} position={[x,r+.02,.2]} rotation={[0,0,i*.4]}><torusGeometry args={[r as number,.07,6,10]}/><meshStandardMaterial color="#c9ced8" roughness={.5}/></mesh>)}</>}
  {kind==="meeting"&&<><Box p={[0,.72,0]} s={[2.5,.1,1.1]} c="#8a4b2f" rough={.4}/><Box p={[-.95,.36,0]} s={[.1,.72,.9]} c="#6f3a24"/><Box p={[.95,.36,0]} s={[.1,.72,.9]} c="#6f3a24"/>
   {[-.8,0,.8].flatMap(x=>[-.95,.95].map(z=><group key={x+":"+z} position={[x,0,z]}><Box p={[0,.42,0]} s={[.46,.1,.46]} c="#2d3142"/><Box p={[0,.72,z>0?.2:-.2]} s={[.46,.5,.08]} c="#2d3142"/><Box p={[0,.2,0]} s={[.07,.4,.07]} c="#5b6170" shadow={false}/></group>))}</>}
  {kind==="cooler"&&<><Box p={[0,.55,0]} s={[.5,1.1,.5]} c="#f7f3ea"/><mesh position={[0,1.4,0]}><cylinderGeometry args={[.22,.24,.6,14]}/><meshStandardMaterial color="#9fd3f5" transparent opacity={.75} roughness={.1}/></mesh>
   <group position={[1.1,0,0]}><mesh position={[0,.5,0]}><cylinderGeometry args={[.45,.45,.06,18]}/><meshStandardMaterial color="#e8c38f"/></mesh><Box p={[0,.25,0]} s={[.08,.5,.08]} c="#8a5a3b" shadow={false}/></group></>}
  {kind==="bench"&&<><Box p={[0,.8,0]} s={[2.2,.08,.8]} c="#e8c38f"/><Box p={[-1,.4,0]} s={[.08,.8,.7]} c="#f7f3ea"/><Box p={[1,.4,0]} s={[.08,.8,.7]} c="#f7f3ea"/>
   <Box p={[-.6,1.05,0]} s={[.5,.4,.4]} c="#22252e"/><mesh position={[-.6,1.05,.205]}><planeGeometry args={[.42,.32]}/><meshBasicMaterial color="#dff9ff" toneMapped={false}/></mesh>
   <mesh position={[.3,1.3,0]}><torusGeometry args={[.2,.035,8,18]}/><meshStandardMaterial color="#2d3142"/></mesh><Box p={[.3,.98,0]} s={[.05,.3,.05]} c="#2d3142" shadow={false}/>
   <Box p={[.85,.9,0]} s={[.3,.12,.4]} c="#22a06b"/></>}
 </group>;
}
const DECOR:[RegExp,PropKind,PropKind][]=[[/desarroll|program|c[oó]digo/i,"servers","bench"],[/calidad|qa|prueba/i,"bench","files"],[/operaci/i,"boxes","cooler"],[/marketing|comercial|venta/i,"easel","sofa"],
 [/administra|finanz|contab/i,"files","cooler"],[/seo|contenido/i,"chart","sofa"],[/atenci|email|correo/i,"sofa","files"],[/pedido/i,"parcels","boxes"],[/monitori|fallo/i,"monitors","servers"],[/automatiza/i,"robot","bench"]];
/** Qué dos muebles definen cada departamento (los demás llevan una zona de descanso). */
export function roomDecor(name:string):[PropKind,PropKind]{const d=DECOR.find(x=>x[0].test(name));return d?[d[1],d[2]]:["cooler","sofa"];}

/* ---------- La ciudad alrededor de la oficina: acera, calle con coches, árboles, farolas y edificios vecinos ---------- */
const CAR_COLORS=["#f6c445","#e2574c","#3b82f6","#ffffff","#22a06b","#f08a24"];
const BUILDING_COLORS=["#f4c9a8","#bcd9f2","#cfe8c4","#f2d27f","#e8c3d8","#d6d0f0","#f0b8a0","#c2e4e0"];
function Tree({p,s=1}:{p:V3;s?:number}){
 return <group position={p} scale={s}>
  <mesh position={[0,.7,0]}><cylinderGeometry args={[.16,.22,1.4,8]}/><meshStandardMaterial color="#8a5a3b" roughness={.9}/></mesh>
  <mesh position={[0,1.9,0]}><icosahedronGeometry args={[1,1]}/><meshStandardMaterial color="#3fb657" flatShading roughness={.9}/></mesh>
  <mesh position={[.35,2.6,.1]}><icosahedronGeometry args={[.7,1]}/><meshStandardMaterial color="#56c96c" flatShading roughness={.9}/></mesh>
 </group>;
}
function Lamp({p}:{p:V3}){
 return <group position={p}><mesh position={[0,1.5,0]}><cylinderGeometry args={[.06,.08,3,8]}/><meshStandardMaterial color="#5b6170"/></mesh>
  <mesh position={[0,3.05,0]}><sphereGeometry args={[.22,10,8]}/><meshStandardMaterial color="#fff6d6" emissive="#ffe9a8" emissiveIntensity={.5}/></mesh></group>;
}
function Car({color}:{color:string}){
 return <group>
  <mesh position={[0,.42,0]}><boxGeometry args={[1.5,.5,3.1]}/><meshStandardMaterial color={color} roughness={.45}/></mesh>
  <mesh position={[0,.86,-.1]}><boxGeometry args={[1.3,.46,1.6]}/><meshStandardMaterial color="#cfe6f7" roughness={.2}/></mesh>
  <mesh position={[0,1.1,-.1]}><boxGeometry args={[1.34,.06,1.64]}/><meshStandardMaterial color={color} roughness={.45}/></mesh>
  {[[-.78,1],[.78,1],[-.78,-1],[.78,-1]].map(([x,z],i)=><mesh key={i} position={[x,.26,z]} rotation={[0,0,Math.PI/2]}><cylinderGeometry args={[.26,.26,.2,12]}/><meshStandardMaterial color="#22252e"/></mesh>)}
 </group>;
}
/** Coche que da la vuelta a la manzana. Decorativo: no representa actividad de ningún agente. */
function LoopCar({hx,hz,offset,color,animate,speed=7}:{hx:number;hz:number;offset:number;color:string;animate:boolean;speed?:number}){
 const g=useRef<THREE.Group>(null),t=useRef(offset);
 useFrame((_,d)=>{
  if(!g.current)return;if(animate)t.current+=Math.min(d,.1)*speed;
  const per=4*(hx+hz);let s=((t.current%per)+per)%per,x:number,z:number,yaw:number;
  if(s<2*hx){x=-hx+s;z=hz;yaw=Math.PI/2;}else if((s-=2*hx)<2*hz){x=hx;z=hz-s;yaw=Math.PI;}else if((s-=2*hz)<2*hx){x=hx-s;z=-hz;yaw=-Math.PI/2;}else{s-=2*hx;x=-hx;z=-hz+s;yaw=0;}
  g.current.position.set(x,0,z);g.current.rotation.y=yaw;
 });
 return <group ref={g}><Car color={color}/></group>;
}
function Building({p,w,d,h,color,seed}:{p:V3;w:number;d:number;h:number;color:string;seed:number}){
 const map=useMemo(()=>{const t=facadeTexture(seed);if(t){t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(Math.max(1,Math.round(w/4)),Math.max(1,Math.round(h/8)));}return t;},[seed,w,h]);
 useEffect(()=>()=>map?.dispose(),[map]);
 return <group position={p}>
  <mesh position={[0,h/2,0]}><boxGeometry args={[w,h,d]}/><meshStandardMaterial color={color} map={map??undefined} roughness={.85}/></mesh>
  <mesh position={[0,h+.15,0]}><boxGeometry args={[w+.3,.3,d+.3]}/><meshStandardMaterial color="#f7f3ea" roughness={.9}/></mesh>
  {seed%2===0&&<mesh position={[w*.2,h+.75,0]}><boxGeometry args={[1.4,.9,1.4]}/><meshStandardMaterial color="#c9ced8"/></mesh>}
 </group>;
}
function City({width,depth,animate}:{width:number;depth:number;animate:boolean}){
 const hw=width/2+CORRIDOR+1,hd=depth/2+CORRIDOR+1,WALK=2.4,ROAD=6;
 const rx=hw+WALK+ROAD/2,rz=hd+WALK+ROAD/2;                  // eje de la calle que rodea la manzana
 const dashes=useMemo(()=>{const out:V3[]=[];for(let x=-rx+2;x<rx-1;x+=3.2){out.push([x,.035,rz],[x,.035,-rz]);}for(let z=-rz+2;z<rz-1;z+=3.2){out.push([rx,.036,z],[-rx,.036,z]);}return out;},[rx,rz]);
 const trees=useMemo(()=>{const out:V3[]=[];const ox=hw+1.1,oz=hd+1.1;for(let x=-ox+1;x<=ox-1;x+=5.5){out.push([x,0,-oz],[x,0,oz]);}for(let z=-oz+4;z<=oz-4;z+=5.5){out.push([-ox,0,z],[ox,0,z]);}return out;},[hw,hd]);
 const blocks=useMemo(()=>{const out:{p:V3;w:number;d:number;h:number;c:string;s:number}[]=[];const bx=rx+ROAD/2+WALK,bz=rz+ROAD/2+WALK;let k=0;
  for(let x=-bx-6;x<bx+10;x+=11){const h=9+((k*7)%5)*3.2;out.push({p:[x,0,-bz-5],w:9.4,d:8,h,c:BUILDING_COLORS[k%BUILDING_COLORS.length],s:k});k++;}     // fondo
  for(let z=-bz+6;z<bz-4;z+=11){const h=6+((k*5)%4)*2.6;out.push({p:[-bx-5,0,z],w:8,d:9.4,h,c:BUILDING_COLORS[k%BUILDING_COLORS.length],s:k});k++;out.push({p:[bx+5,0,z],w:8,d:9.4,h:6+((k*3)%4)*2.6,c:BUILDING_COLORS[k%BUILDING_COLORS.length],s:k});k++;}
  return out;},[rx,rz]);
 return <group>
  <mesh rotation={[-Math.PI/2,0,0]} position={[0,-.06,0]}><planeGeometry args={[420,420]}/><meshStandardMaterial color="#8fd07a" roughness={1}/></mesh>
  {/* Acera interior y exterior */}
  <mesh rotation={[-Math.PI/2,0,0]} position={[0,-.03,0]} receiveShadow><planeGeometry args={[(hw+WALK)*2,(hd+WALK)*2]}/><meshStandardMaterial color="#dfe2e8" roughness={.95}/></mesh>
  {/* Calzada: cuatro tramos alrededor de la manzana */}
  {[[0,rz,rx*2+ROAD,ROAD],[0,-rz,rx*2+ROAD,ROAD],[rx,0,ROAD,rz*2-ROAD],[-rx,0,ROAD,rz*2-ROAD]].map(([x,z,w,d],i)=><mesh key={i} rotation={[-Math.PI/2,0,0]} position={[x,-.02,z]}><planeGeometry args={[w,d]}/><meshStandardMaterial color="#555a66" roughness={.95}/></mesh>)}
  {dashes.map((p,i)=><mesh key={i} rotation={[-Math.PI/2,0,i%2&&Math.abs(p[0])===rx?Math.PI/2:0]} position={p}><planeGeometry args={Math.abs(p[0])===rx?[.18,1.5]:[1.5,.18]}/><meshBasicMaterial color="#f4f5f7" toneMapped={false}/></mesh>)}
  {/* Paso de peatones frente a la entrada */}
  {[-2,-1,0,1,2].map(i=><mesh key={i} rotation={[-Math.PI/2,0,0]} position={[i*.9,.034,rz]}><planeGeometry args={[.5,ROAD-1]}/><meshBasicMaterial color="#f4f5f7" toneMapped={false}/></mesh>)}
  {trees.map((p,i)=><Tree key={i} p={p} s={.8+((i*37)%5)*.07}/>)}
  {[[-hw-1.1,0,hd+1.1],[hw+1.1,0,hd+1.1],[-hw-1.1,0,-hd-1.1],[hw+1.1,0,-hd-1.1],[0,0,hd+1.1]].map((p,i)=><Lamp key={i} p={p as V3}/>)}
  {CAR_COLORS.slice(0,5).map((c,i)=><LoopCar key={i} hx={rx} hz={rz} offset={i*((rx+rz)*4/5)+(i%2)*3} color={c} animate={animate} speed={6+i%3}/>)}
  {blocks.map((b,i)=><Building key={i} p={b.p} w={b.w} d={b.d} h={b.h} color={b.c} seed={b.s}/>)}
 </group>;
}

/* ---------- Paseos decorativos del «Modo ambiente» ---------- */
function AmbientWalker({path,index,animate}:{path:V3[];index:number;animate:boolean}){
 const g=useRef<THREE.Group>(null),t=useRef(index*3.7);
 useFrame((_,d)=>{if(!g.current)return;if(animate)t.current+=Math.min(d,.1)*.55;const n=path.length,seg=Math.floor(t.current)%n,f=t.current%1,a=path[seg],b=path[(seg+1)%n];
  g.current.position.set(a[0]+(b[0]-a[0])*f,.02,a[2]+(b[2]-a[2])*f);g.current.rotation.y=Math.atan2(b[0]-a[0],b[2]-a[2]);});
 return <group ref={g}><Person p={[0,0,0]} seed={index+4} walking animate={animate} scale={1.05}/></group>;
}

/* ---------- Cámara: vista general, vuelo a sala, arrastre y rueda ---------- */
const PITCH=0.93,FOV=34;
export function baseDistance(width:number,depth:number,aspect:number){
 const v=Math.tan(THREE.MathUtils.degToRad(FOV/2)),h=v*Math.max(aspect,.3);
 // En vertical (móvil) se encuadra el centro de la planta y se explora arrastrando.
 const w=aspect<1.2?width*.6:width;
 return Math.max((w+1)/(2*h),(depth*Math.sin(PITCH)+2.6)/(2*v))*1.24;   // con margen: se ve la calle y los edificios de alrededor
}
export const ROOM_ZOOM=3.2;
function CameraRig({layout,focusKey,api,onZoom}:{layout:Layout;focusKey:string|null;api:MutableRefObject<CameraApi|null>;onZoom:(p:number)=>void}){
 const {camera,gl,size}=useThree();
 const target=useRef(new THREE.Vector3()),goal=useRef(new THREE.Vector3()),dist=useRef(30),goalDist=useRef(30),lastPct=useRef(0);
 const base=baseDistance(layout.width,layout.depth,size.width/Math.max(1,size.height));
 const baseRef=useRef(base);baseRef.current=base;
 const focus=(key:string|null)=>{const room=key?layout.rooms.find(r=>r.key===key):null;if(room){goal.current.set(room.x,.4,room.z-.95);goalDist.current=base/ROOM_ZOOM;}else{goal.current.set(0,0,.2);goalDist.current=base;}};
 const focusRef=useRef(focus);focusRef.current=focus;
 useEffect(()=>{focusRef.current(focusKey);},[focusKey,base]);
 useEffect(()=>{api.current={zoomBy:f=>{goalDist.current=THREE.MathUtils.clamp(goalDist.current/f,baseRef.current/6,baseRef.current*1.6);},recenter:()=>focusRef.current(null),focus:k=>focusRef.current(k)};return()=>{api.current=null;};},[api]);
 const first=useRef(true);
 useEffect(()=>{if(first.current){first.current=false;target.current.copy(goal.current);dist.current=goalDist.current;}},[]);
 useEffect(()=>{
  const el=gl.domElement;let drag:{x:number;y:number}|null=null;
  const down=(e:PointerEvent)=>{drag={x:e.clientX,y:e.clientY};};
  const move=(e:PointerEvent)=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag={x:e.clientX,y:e.clientY};const wpp=2*dist.current*Math.tan(THREE.MathUtils.degToRad(FOV/2))/Math.max(1,el.clientHeight);
   goal.current.x-=dx*wpp;goal.current.z-=dy*wpp/Math.sin(PITCH);const lim=(v:number,m:number)=>THREE.MathUtils.clamp(v,-m,m);goal.current.x=lim(goal.current.x,layout.width/2+2);goal.current.z=lim(goal.current.z,layout.depth/2+2);target.current.copy(goal.current);el.style.cursor="grabbing";};
  const up=()=>{drag=null;el.style.cursor="grab";};
  const wheel=(e:WheelEvent)=>{e.preventDefault();goalDist.current=THREE.MathUtils.clamp(goalDist.current*Math.exp(e.deltaY*.0012),baseRef.current/6,baseRef.current*1.6);};
  el.style.cursor="grab";el.style.touchAction="none";
  el.addEventListener("pointerdown",down);window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);el.addEventListener("wheel",wheel,{passive:false});
  return()=>{el.removeEventListener("pointerdown",down);window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);el.removeEventListener("wheel",wheel);};
 },[gl,layout.width,layout.depth]);
 useFrame((_,d)=>{
  const k=1-Math.exp(-Math.min(d,.1)*4.5);target.current.lerp(goal.current,k);dist.current+=(goalDist.current-dist.current)*k;
  camera.position.set(target.current.x,target.current.y+Math.sin(PITCH)*dist.current,target.current.z+Math.cos(PITCH)*dist.current);camera.lookAt(target.current);
  const pct=Math.round(baseRef.current/dist.current*100);if(Math.abs(pct-lastPct.current)>=1){lastPct.current=pct;onZoom(pct);}
 });
 return null;
}

/* ---------- Proyección de etiquetas y líneas de memoria a la capa HTML ---------- */
export type Anchors=Map<string,THREE.Vector3>;
function Projector({anchors,nodes,lines}:{anchors:MutableRefObject<Anchors>;nodes:MutableRefObject<Map<string,HTMLElement>>;lines:MutableRefObject<Map<string,SVGLineElement>>}){
 const {camera,size}=useThree();const v=useMemo(()=>new THREE.Vector3(),[]);
 useFrame(()=>{
  const screen=new Map<string,[number,number,boolean]>();
  for(const [id,pos] of anchors.current){v.copy(pos).project(camera);const x=(v.x+1)/2*size.width,y=(1-v.y)/2*size.height;const inside=v.z<1&&x>-80&&x<size.width+80&&y>-40&&y<size.height+40;screen.set(id,[x,y,inside]);}
  for(const [id,el] of nodes.current){const s=screen.get(id);if(!s){el.style.visibility="hidden";continue;}let x=s[0],y=s[1];
   // El bocadillo sale al lado del agente (a la derecha, o a la izquierda si no cabe) y nunca se sale de la escena ni le tapa la cara.
   if(el.dataset.clamp){const c=el.firstElementChild as HTMLElement|null,w=c?.offsetWidth??0,h=c?.offsetHeight??0;const side=x+52+w+10<=size.width||x-52-w<10?"r":"l";if(el.dataset.side!==side)el.dataset.side=side;
    x=Math.min(Math.max(x,side==="l"?w+62:-40),side==="r"?size.width-w-62:size.width+40);y=Math.min(Math.max(y,h*.35+10),size.height-h*.65-10);}
   el.style.transform=`translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;el.style.visibility=s[2]||el.dataset.clamp?"visible":"hidden";}
  const core=screen.get("memory-core");
  for(const [id,line] of lines.current){const s=screen.get(id);if(!s||!core){line.style.visibility="hidden";continue;}line.style.visibility="visible";line.setAttribute("x1",s[0].toFixed(1));line.setAttribute("y1",(s[1]+14).toFixed(1));line.setAttribute("x2",core[0].toFixed(1));line.setAttribute("y2",core[1].toFixed(1));}
 });
 return null;
}

/** Mueve a un agente andando entre su puesto y otro sitio (la pista de descanso o la Oficina de Empleo). La primera vez aparece ya en su sitio.
 *  Al llegar puede quedarse de pie, sentarse o pasear entre dos puntos. */
function AgentBody({home,away,gone,animate,rest="stand",to,yaw=0,children}:{home:V3;away:V3;gone:boolean;animate:boolean;rest?:"stand"|"sit"|"pace";to?:V3;yaw?:number;children:(motion:MutableRefObject<Motion>)=>ReactNode}){
 const g=useRef<THREE.Group>(null),pos=useRef<[number,number]|null>(null),leg=useRef(0),motion=useRef<Motion>({walking:false,away:gone,sit:!gone||rest==="sit"});
 useFrame((_,d)=>{
  if(!g.current)return;
  const pacing=gone&&rest==="pace"&&!!to&&animate,goal=!gone?home:pacing&&leg.current===1?to!:away,tx=goal[0],tz=goal[2];
  if(!pos.current||!animate)pos.current=[gone?away[0]:home[0],gone?away[2]:home[2]];
  const dx=tx-pos.current[0],dz=tz-pos.current[1],dist=Math.hypot(dx,dz);
  if(dist>.04){const step=Math.min(dist,(pacing?1.5:dist>12?9:6)*Math.min(d,.1));pos.current[0]+=dx/dist*step;pos.current[1]+=dz/dist*step;g.current.rotation.y=Math.atan2(dx,dz);motion.current.walking=true;}
  else if(pacing){leg.current=1-leg.current;motion.current.walking=true;}
  else{motion.current.walking=false;g.current.rotation.y=gone?yaw:0;}
  const off=Math.hypot(pos.current[0]-home[0],pos.current[1]-home[2])>.04;
  motion.current.away=off;motion.current.sit=!motion.current.walking&&(!off||(gone&&rest==="sit"));
  g.current.position.set(pos.current[0],home[1],pos.current[1]);
 });
 return <group ref={g} position={gone?[away[0],home[1],away[2]]:home} rotation={[0,gone?yaw:0,0]}>{children(motion)}</group>;
}

/** Logotipo de la Oficina de Empleo: disco amarillo con letras azules. Propio de La Factoría: sin escudo ni siglas de ningún organismo. */
function jobsLogo(){
 const c=document.createElement("canvas");c.width=512;c.height=512;const g=c.getContext("2d");if(!g)return null;
 g.clearRect(0,0,512,512);g.fillStyle="#f6c400";g.beginPath();g.arc(256,256,250,0,Math.PI*2);g.fill();
 g.fillStyle="#1f4fa3";g.textAlign="center";g.font='600 40px Inter, "Segoe UI", system-ui, sans-serif';g.fillText("OFICINA DE EMPLEO",256,170);g.fillText("DE LA FACTORÍA",256,220);
 g.fillRect(96,250,320,7);g.font='800 118px Inter, "Segoe UI", system-ui, sans-serif';g.fillText("EMPLEO",256,372);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=4;return t;
}
/** Oficina de Empleo: mostrador de reclutamiento (el propietario con su ordenador), cola con postes, sillas de espera y pantalla de turnos. */
function JobsOffice({room,animate,waiting,onHoverOwner}:{room:RoomLayout;animate:boolean;waiting:number;onHoverOwner:(on:boolean)=>void}){
 const {x,z}=room,back=z-ROOM_D/2;
 const logo=useMemo(()=>jobsLogo(),[]),mode=useMemo(()=>signTexture("MODO RECLUTACIÓN",4.2,"#0f8a4b"),[]),turn=useMemo(()=>signTexture(waiting?"TURNO "+String(waiting).padStart(2,"0"):"SIN ESPERA",2.6,"#16182d"),[waiting]);
 useEffect(()=>()=>{logo?.dispose();mode?.dispose();},[logo,mode]);useEffect(()=>()=>turn?.dispose(),[turn]);
 return <group>
  {logo&&<mesh position={[x+1.3,1.5,back+.26]}><circleGeometry args={[.92,40]}/><meshBasicMaterial map={logo} transparent toneMapped={false}/></mesh>}
  {/* Mostrador de reclutamiento, en la esquina del fondo */}
  <group position={[x-3.7,.12,z-1.15]} rotation={[0,-Math.PI/2,0]}><Desk p={[0,0,0]} on/><Chair p={[0,0,.78]} color="#1f4fa3"/></group>
  <group onPointerOver={e=>{e.stopPropagation();onHoverOwner(true);}} onPointerOut={()=>onHoverOwner(false)}><Person p={[x-4.5,.12,z-1.15]} seed={2} yaw={Math.PI/2} seated typing animate={animate} shirt="#22b8cf"/></group>
  {mode&&<><Box p={[x-3.3,2.02,back+.27]} s={[2.46,.66,.08]} c="#16182d" shadow={false}/><mesh position={[x-3.3,2.02,back+.32]}><planeGeometry args={[2.36,.56]}/><meshBasicMaterial map={mode} toneMapped={false}/></mesh></>}
  {/* Postes y cinta de la cola */}
  {[0,1,2,3].map(i=><group key={i} position={[x-2.6+i*1.5,.12,z-1.8]}><Box p={[0,.45,0]} s={[.07,.9,.07]} c="#5b6170"/><Box p={[0,.03,0]} s={[.3,.06,.3]} c="#3a3f55" shadow={false}/></group>)}
  <Box p={[x-.35,.92,z-1.8]} s={[4.5,.06,.03]} c="#1f4fa3" shadow={false}/>
  {/* Sillas de espera contra la pared derecha */}
  {[0,1,2,3,4].map(i=><group key={i} position={[x+4.35,.12,z-2.2+i*1.05]} rotation={[0,Math.PI/2,0]}><Box p={[0,.5,0]} s={[.62,.1,.6]} c="#f6c400"/><Box p={[0,.86,.27]} s={[.62,.6,.08]} c="#f6c400"/><Box p={[0,.25,0]} s={[.5,.5,.06]} c="#5b6170" shadow={false}/></group>)}
  {/* Pantalla de turnos */}
  <Box p={[x+3.2,1.1,back+.5]} s={[.1,2,.1]} c="#5b6170"/>
  {turn&&<><Box p={[x+3.2,2.2,back+.5]} s={[1.5,.62,.1]} c="#16182d"/><mesh position={[x+3.2,2.2,back+.56]}><planeGeometry args={[1.4,.54]}/><meshBasicMaterial map={turn} toneMapped={false}/></mesh></>}
  <Plant p={[x-4.3,.12,z+ROOM_D/2-1.2]} scale={.8}/>
 </group>;
}

const DISCO=["#ff3d81","#22d3ee","#facc15","#a855f7","#34d399","#fb923c"];
/** Sala de Descanso: sofá, fuente de agua, altavoces, pista y bola de discoteca. Con la fiesta encendida giran la bola y las luces. */
function Lounge({room,on,animate}:{room:RoomLayout;on:boolean;animate:boolean}){
 const {x,z}=room,back=z-ROOM_D/2,ball=useRef<THREE.Mesh>(null),rig=useRef<THREE.Group>(null),tiles=useRef<(THREE.MeshStandardMaterial|null)[]>([]),t=useRef(0);
 const cells=useMemo(()=>{const out:{p:V3;i:number}[]=[];for(let r=0;r<3;r++)for(let c=0;c<6;c++)out.push({p:[x+(c-2.5)*1.25,.135,z+.7+(r-1)*1.25],i:r*6+c});return out;},[x,z]);
 useFrame((_,d)=>{
  if(animate&&on)t.current+=Math.min(d,.1);const T=t.current;
  if(ball.current)ball.current.rotation.y=T*.9;if(rig.current)rig.current.rotation.y=T*.7;
  const beat=Math.floor(T*2.2);
  tiles.current.forEach((m,i)=>{if(!m)return;if(!on){m.emissiveIntensity=0;m.color.set((i+Math.floor(i/6))%2?"#4a3d85":"#5a4a9c");return;}
   const c=DISCO[(i*5+beat*(1+i%3))%DISCO.length];m.color.set(c);m.emissive.set(c);m.emissiveIntensity=.75+.25*Math.sin(T*6+i);});
 });
 return <group>
  {cells.map(c=><mesh key={c.i} position={c.p} rotation={[-Math.PI/2,0,0]} receiveShadow><planeGeometry args={[1.18,1.18]}/><meshStandardMaterial ref={m=>{tiles.current[c.i]=m;}} color="#5a4a9c" emissive="#000000" roughness={.35}/></mesh>)}
  {/* Zona de estar al fondo */}
  <Prop kind="sofa" p={[x-2.9,.12,back+1.05]} accent="#c026d3"/><Prop kind="cooler" p={[x+3.9,.12,back+.8]} accent="#c026d3"/>
  {[-1,1].map(sd=><group key={sd} position={[x+sd*1.15,.12,back+.62]}><Box p={[0,.75,0]} s={[.75,1.5,.6]} c="#1b1d2b"/>
   {[.45,1.05].map(y=><mesh key={y} position={[0,y,.31]}><circleGeometry args={[y<1?.26:.17,20]}/><meshStandardMaterial color="#3a3f55" roughness={.4}/></mesh>)}</group>)}
  {/* Pórtico del que cuelga la bola */}
  {[-1,1].map(sd=><Box key={sd} p={[x+sd*4.3,2,z+.7]} s={[.14,3.9,.14]} c="#2d3142"/>)}
  <Box p={[x,3.95,z+.7]} s={[8.74,.14,.14]} c="#2d3142"/>
  <Box p={[x,3.6,z+.7]} s={[.03,.6,.03]} c="#9aa3b5" shadow={false}/>
  <mesh ref={ball} position={[x,3.05,z+.7]} castShadow><icosahedronGeometry args={[.5,2]}/><meshStandardMaterial color="#eef1fa" metalness={.35} roughness={.22} flatShading emissive={on?"#dfe5ff":"#9aa3c0"} emissiveIntensity={on?.55:.15}/></mesh>
  {on&&<group ref={rig} position={[x,0,z+.7]}>
   {DISCO.slice(0,4).map((c,i)=>{const a=i*Math.PI/2;return <group key={c}>
    <pointLight position={[Math.cos(a)*2.6,2.3,Math.sin(a)*2.2]} color={c} intensity={26} distance={9} decay={2}/>
    {/* Haz de luz desde la bola hasta la pista */}
    <mesh position={[Math.cos(a)*1.35,1.55,Math.sin(a)*1.15]} rotation={[Math.sin(a)*.72,0,-Math.cos(a)*.78]}><coneGeometry args={[.75,3.3,16,1,true]}/><meshBasicMaterial color={c} transparent opacity={.16} side={THREE.DoubleSide} depthWrite={false} blending={THREE.AdditiveBlending} toneMapped={false}/></mesh>
   </group>;})}
  </group>}
 </group>;
}

function SceneContent(p:SceneProps&{onHover?:(id:string|null)=>void;anchors:MutableRefObject<Anchors>;nodes:MutableRefObject<Map<string,HTMLElement>>;lines:MutableRefObject<Map<string,SVGLineElement>>}){
 const {layout,agents}=p,animate=!p.paused&&p.visible;
 const wood=useMemo(()=>{const t=woodTexture();if(t)t.repeat.set((layout.width+6)/6,(layout.depth+6)/6);return t;},[layout.width,layout.depth]);
 useEffect(()=>()=>wood?.dispose(),[wood]);
 const tiles=useMemo(()=>tileTexture(),[]);
 useEffect(()=>()=>tiles?.dispose(),[tiles]);
 const seats=useMemo(()=>agentSeats(layout,agents),[layout,agents]);
 const dir=layout.rooms.find(r=>r.direction)!;
 // Modo descanso: cada agente real tiene su sitio en la pista de la Sala de Descanso.
 const lounge=layout.rooms.find(r=>r.lounge),party=!!p.onBreak&&!!lounge;
 const spots=useMemo(()=>{const m=new Map<string,V3>();if(!lounge)return m;const real=agents.filter(a=>!a.ghost&&seats.has(a.id));real.forEach((a,i)=>m.set(a.id,loungeSpot(lounge,i,real.length)));return m;},[lounge,agents,seats]);
 // Oficina de Empleo: los agentes inactivos esperan allí (cola, sillas o paseando) hasta que el propietario los activa.
 const jobs=layout.rooms.find(r=>r.jobs);
 const jobSpots=useMemo(()=>{const m=new Map<string,JobsSpot>();if(!jobs)return m;agents.filter(a=>!a.ghost&&a.status==="inactive"&&seats.has(a.id)).slice(0,24).forEach((a,i)=>m.set(a.id,jobsSpot(jobs,i)));return m;},[jobs,agents,seats]);
 // El dron entra por el frente de la planta; el aviso sobre la mesa empieza cuando aterriza (o al instante sin animación).
 const door:V3=[0,2.6,layout.depth/2+CORRIDOR+1];
 const landed=(id:string)=>{const at=p.arrivals?.[id];return at===undefined?undefined:at+(animate?DRONE_SECONDS*1000:0);};
 // Anclas de etiquetas: cabeza de cada agente sentado, propietario, Freddy y núcleo de memoria.
 useEffect(()=>{
  const m:Anchors=new Map();
  for(const [id,s] of seats){const sp=party?spots.get(id):undefined,js=party?undefined:jobSpots.get(id);
   m.set(id,sp?new THREE.Vector3(sp[0],2.75,sp[2]):js?new THREE.Vector3(js.to?(js.at[0]+js.to[0])/2:js.at[0],2.75,js.at[2]):new THREE.Vector3(s.desk[0],2.6,s.desk[2]-.8));}
  if(jobs)m.set("owner-jobs",new THREE.Vector3(jobs.x-4.5,2.6,jobs.z-1.15));
  m.set("owner",new THREE.Vector3(dir.x+OWNER_OFFSET[0],2.45,dir.z+OWNER_OFFSET[2]));
  m.set("freddy",new THREE.Vector3(dir.x+FREDDY_OFFSET[0],2.45,dir.z+FREDDY_OFFSET[2]));
  m.set("memory-core",new THREE.Vector3(0,2.6,0));
  p.anchors.current=m;
 },[seats,dir,p.anchors,party,spots,jobSpots,jobs]);
 const walkPaths=useMemo(()=>{const hw=layout.width/2+CORRIDOR/2,hd=layout.depth/2+CORRIDOR/2,midZ=-layout.depth/2+ROOM_D+CORRIDOR/2,midX=-layout.width/2+ROOM_W+CORRIDOR/2;
  return [[[-hw,0,midZ],[hw,0,midZ]],[[midX,0,-hd+1],[midX,0,hd]],[[hw,0,hd],[-hw,0,hd]]] as V3[][];},[layout.width,layout.depth]);
 return <>
  <color attach="background" args={[OFFICE_COLORS.bg]}/>
  <hemisphereLight args={["#ffffff","#b9d9a8",1.05]}/>
  <ambientLight intensity={.6}/>
  <City width={layout.width} depth={layout.depth} animate={animate}/>
  <directionalLight position={[-14,26,18]} intensity={2.1} color="#fff4dc" castShadow shadow-mapSize={[2048,2048]} shadow-camera-left={-layout.width/2-6} shadow-camera-right={layout.width/2+6} shadow-camera-top={layout.depth/2+6} shadow-camera-bottom={-layout.depth/2-6} shadow-bias={-.0004} shadow-normalBias={.03}/>
  <mesh rotation={[-Math.PI/2,0,0]} position={[0,0,0]} receiveShadow><planeGeometry args={[layout.width+CORRIDOR*2+2,layout.depth+CORRIDOR*2+2]}/><meshStandardMaterial map={wood??undefined} color={wood?"#ffffff":OFFICE_COLORS.wood} roughness={.85}/></mesh>
  {layout.rooms.map(r=><Room key={r.key} room={r} tiles={r.lounge?null:tiles} party={party} animate={animate} onSelectRoom={k=>p.onRoom?p.onRoom(k):p.cameraApi.current?.focus(k)}/>)}
  <DirectionFurniture room={dir}/>
  {/* Los muebles del departamento ocupan los puestos que no usa ningún agente, para no pisar ninguna mesa */}
  {jobs&&<JobsOffice room={jobs} animate={animate} waiting={party?0:jobSpots.size} onHoverOwner={on=>p.onHover?.(on?"owner-jobs":null)}/>}
  {layout.rooms.filter(r=>!r.direction&&!r.lounge&&!r.jobs).map(r=>{const n=agents.filter(a=>a.departmentId===r.departmentId).length;if(n>3)return null;const [k1,k2]=roomDecor(r.name),acc=roomTint(r).accent,s3=deskSlot(r,3,4),s2=deskSlot(r,2,4);
   return <group key={"decor:"+r.key}><Prop kind={k1} p={[s3[0],.12,s3[2]+.35]} accent={acc}/>{n<=2&&<Prop kind={k2} p={[s2[0],.12,s2[2]-.75]} accent={acc}/>}</group>;})}
  <group onPointerOver={e=>{e.stopPropagation();p.onHover?.("freddy");}} onPointerOut={()=>p.onHover?.(null)}><FreddyFigure p={[dir.x+FREDDY_OFFSET[0],.12,dir.z+FREDDY_OFFSET[2]]} yaw={.35} animate={animate}/></group>
  <group onPointerOver={e=>{e.stopPropagation();p.onHover?.("owner");}} onPointerOut={()=>p.onHover?.(null)}><Person p={[dir.x+OWNER_OFFSET[0],.12,dir.z+OWNER_OFFSET[2]]} seed={2} yaw={-.5} animate={animate} shirt="#22b8cf"/></group>
  {agents.map((a,i)=>{const s=seats.get(a.id);if(!s)return null;const [x,,z]=s.desk;const sel=(e:ThreeEvent<MouseEvent>)=>{e.stopPropagation();if(e.delta>5)return;p.onSelect(a.id);};
   return <group key={a.id} onClick={sel} onPointerOver={e=>{e.stopPropagation();p.onHover?.(a.id);}} onPointerOut={()=>p.onHover?.(null)}>
    {/* El agente se sienta de cara a la sala: se le ve la cara por encima de la pantalla */}
    <group position={[x,.12,z]} rotation={[0,Math.PI,0]}><Desk p={[0,0,0]} on={a.status!=="inactive"&&!party}/><Chair p={[0,0,.78]} color={a.ghost?"#d9dce6":roomTint(s.room).accent}/></group>
    <group position={[x,.12,z]}><Plaque name={a.person??a.name} role={a.ghost?"Por crear":(a.person?a.name:(a.specialty||a.departmentName)).slice(0,34)}/></group>
    {a.ghost||!spots.has(a.id)?<Person p={[x,.12,z-.8]} seed={i+3} yaw={0} seated ghost={!!a.ghost} look={a.ghost?undefined:faceOf(a.id)} inactive={a.status==="inactive"} typing={a.status==="working"&&a.motionActive} freshAt={landed(a.id)} animate={animate}/>
     :(()=>{const js=party?undefined:jobSpots.get(a.id);return <AgentBody home={[x,.12,z-.8]} away={js?js.at:spots.get(a.id)!} gone={party||!!js} rest={js?(js.mode==="seat"?"sit":js.mode==="walk"?"pace":"stand"):"stand"} to={js?.to} yaw={js?.yaw??0} animate={animate}>{motion=><Person p={[0,0,0]} seed={i+3} yaw={0} seated look={faceOf(a.id)} inactive={false} typing={!party&&a.status==="working"&&a.motionActive} freshAt={party?undefined:landed(a.id)} calling={!party&&a.needs.length>0} animate={animate} dancing={party} motion={motion}/>}</AgentBody>;})()}
    {p.arrivals?.[a.id]&&<><Drone from={door} to={[x-.6,1.35,z+.1]} at={p.arrivals[a.id]} animate={animate}/><ArrivalFx p={[x,.12,z]} at={landed(a.id)!} animate={animate}/></>}
    {p.completions?.[a.id]&&<DoneFx p={[x,.12,z]} at={p.completions[a.id]} animate={animate}/>}
   </group>;})}
  {p.ambient&&walkPaths.flatMap((path,i)=>[<AmbientWalker key={i} path={path} index={i} animate={animate}/>,<AmbientWalker key={i+"b"} path={[...path].reverse()} index={i+3} animate={animate}/>])}
  <CameraRig layout={layout} focusKey={p.focusKey} api={p.cameraApi} onZoom={p.onZoom}/>
  <Projector anchors={p.anchors} nodes={p.nodes} lines={p.lines}/>
 </>;
}

class Boundary extends Component<{onFail:()=>void;children:ReactNode},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}componentDidCatch(){this.props.onFail();}render(){return this.state.failed?null:this.props.children;}
}

/** Escena isométrica de la oficina con capa HTML de etiquetas accesibles (botones) sincronizada con la cámara. */
export function OfficeScene(p:SceneProps){
 const anchors=useRef<Anchors>(new Map()),nodes=useRef(new Map<string,HTMLElement>()),lines=useRef(new Map<string,SVGLineElement>());
 const seats=useMemo(()=>agentSeats(p.layout,p.agents),[p.layout,p.agents]);
 const placed=p.agents.filter(a=>seats.has(a.id));const [hover,setHover]=useState<string|null>(null);
 const ref=(id:string)=>(el:HTMLElement|null)=>{if(el)nodes.current.set(id,el);else nodes.current.delete(id);};
 const lineRef=(id:string)=>(el:SVGLineElement|null)=>{if(el)lines.current.set(id,el);else lines.current.delete(id);};
 return <div className={"office-scene3d"+(hover?" hovering":"")}>
  <Boundary onFail={p.onUnavailable}>
   <Canvas shadows flat dpr={[1,1.75]} camera={{fov:FOV,near:.5,far:400,position:[0,40,30]}} frameloop={p.visible?"always":"never"} onCreated={({gl})=>gl.domElement.addEventListener("webglcontextlost",()=>p.onUnavailable(),{once:true})} fallback={<p role="alert">WebGL no está disponible.</p>}>
    <SceneContent {...p} onHover={setHover} anchors={anchors} nodes={nodes} lines={lines}/>
   </Canvas>
  </Boundary>
  {p.memory&&<svg className="memory-lines" aria-hidden="true">{placed.map(a=><line key={a.id} ref={lineRef(a.id)}/>)}<line ref={lineRef("owner")}/><line ref={lineRef("freddy")}/></svg>}
  <div className="office-labels">
   {p.memory&&<div className="office-anchor core" ref={ref("memory-core")}><MemoryCore/></div>}
   {/* Sin rótulos fijos: el nombre aparece al pasar el ratón, y al pulsar sale el bocadillo del agente */}
   {hover==="owner"&&<div className="office-anchor" ref={ref("owner")}><span className="office-hint-tag">{p.ownerName} · tú</span></div>}
   {hover==="owner-jobs"&&<div className="office-anchor" ref={ref("owner-jobs")}><span className="office-hint-tag"><strong>{p.ownerName} · tú</strong>Reclutando</span></div>}
   {hover==="freddy"&&<div className="office-anchor" ref={ref("freddy")}><span className="office-hint-tag">Freddy · director</span></div>}
   {placed.map(a=>{const big=p.selectedId===a.id,fresh=!!p.arrivals?.[a.id]&&Date.now()-p.arrivals[a.id]<ARRIVAL_SECONDS*1000;
    if(big&&p.bubble)return <div key={a.id} className="office-anchor front" data-clamp="1" ref={ref(a.id)}>{p.bubble(a)}</div>;
    if(hover===a.id)return <div key={a.id} className="office-anchor front" ref={ref(a.id)}><span className={"office-hint-tag"+(a.ghost?" ghost":"")}><strong>{a.person?a.person+" · "+a.name:a.name}</strong>{a.ghost?"Por crear":p.onBreak?"En descanso":a.status==="inactive"?"Esperando en la Oficina de Empleo":a.needs.length?"✋ Te necesita":STATUS_LABEL[a.status]}</span></div>;
    if(p.onBreak)return null;
    if(a.needs.length>0||fresh)return <div key={a.id} className="office-anchor" ref={ref(a.id)}><button type="button" className={"office-dot"+(a.needs.length?" needs":" arrived")} aria-label={a.needs.length?`${a.name} te necesita en ${a.needs.length}`:`${a.name} recibe un trabajo nuevo`} onClick={()=>p.onSelect(a.id)}>{a.needs.length||""}</button></div>;
    return null;})}
  </div>
 </div>;
}

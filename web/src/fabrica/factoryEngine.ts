/**
 * Motor 3D de La Factoría Northlane360 (three.js sin React): campus nocturno, Freddy en el centro,
 * una torre de cristal por empresa, drones mensajeros, ondas y confeti.
 *
 * Regla de honestidad: los drones, las ondas, el confeti y las ventanas en ámbar SOLO aparecen cuando
 * alguien llama a emit(), y quien llama es el Campus al ver un cambio REAL en los datos del servidor.
 * Los peatones, farolas, anillos y carreteras son ambiente decorativo y no representan datos.
 */
import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import {GLTFLoader} from "three/examples/jsm/loaders/GLTFLoader.js";
import {EffectComposer} from "three/examples/jsm/postprocessing/EffectComposer.js";
import {RenderPass} from "three/examples/jsm/postprocessing/RenderPass.js";
import {UnrealBloomPass} from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {OutputPass} from "three/examples/jsm/postprocessing/OutputPass.js";

export type FactoryEventKind="arrived"|"done"|"blocked";
export type FactoryOptions={canvas:HTMLCanvasElement;stage:HTMLElement;calm:boolean;onSelect:(slot:number)=>void;onLost:()=>void;freddyUrl?:string};
export type Factory={setPlots:(p:FactoryPlot[])=>void;setSelected:(slot:number|null)=>void;emit:(kind:FactoryEventKind,slot:number)=>void;
 setPaused:(v:boolean)=>void;setCalm:(v:boolean)=>void;setFx:(v:boolean)=>void;setPose:(p:FactoryPose,immediate?:boolean)=>void;
 setLabel:(key:string,el:HTMLElement|null)=>void;readonly bloom:boolean;dispose:()=>void};

import {FACTORY_RADIUS} from "./plots";
import type {FactoryPlot,FactoryPose} from "./plots";
export type {FactoryPlot,FactoryPose} from "./plots";
export function factorySlotAngle(slot:number){return Math.PI/2+Math.PI/5+(slot-1)*2*Math.PI/5;}

// Ciudad de día: cielo claro, césped, calzada gris y un color propio para cada empresa.
const C={night:0xd6ecff,roadGlow:0x4f46e5,plot:0xe9e3d3,frame:0xf7f3ea,winOn:"#bfe3ff",winWarm:"#ffe08a",winOff:"#86a9c6",
 roof:0x4b52f0,cyan:0x2f8fd0,amber:0xf08a24,mint:0x22a06b,indigo:0x4f46e5,leaf:0x3fb657,trunk:0x8a5a3b};
const SLOT_WALL=["#f4c9a8","#bcd9f2","#cfe8c4","#f2d27f","#e8c3d8"],SLOT_ROOF=[0xe2574c,0x3b82f6,0x22a06b,0xf08a24,0x7c5cd6];
const SKIN=[0xf1c9a5,0xd9a47a,0xb07a52,0x8a5a3b,0xf6d7b8],HAIR=[0x2b1d14,0x5a3a1e,0x101018,0x8a6a3a,0x3a3a44],SHIRT=[0x6f76ff,0x22b8cf,0xf3f5ff,0x7ee3a8,0xffc46b,0x9aa7ff];

type Person={g:THREE.Group;hips:THREE.Group;legL:THREE.Group;legR:THREE.Group;armL:THREE.Group;armR:THREE.Group;head:THREE.Group};
type Building={slot:number;pos:THREE.Vector3;group:THREE.Group|null;sig:string;plot:FactoryPlot;cv:HTMLCanvasElement|null;tex:THREE.CanvasTexture|null;height:number;
 beacon:THREE.Mesh|null;pulse:THREE.Mesh|null;pulseT:number;bump:number;warmUntil:number;warm:boolean;edge:THREE.Mesh;
 /** Parcela libre: obra en marcha (grúa y operarios). Es decorado: anuncia que ahí cabe una empresa nueva. */
 site:{arm:THREE.Group;cable:THREE.Mesh;load:THREE.Mesh;crew:{P:Person;x:number;z:number;job:"hammer"|"walk"}[]}|null};

export function createFactory(o:FactoryOptions):Factory{
 const {canvas,stage}=o;
 const small=Math.min(window.innerWidth,window.innerHeight)<560;
 const S={paused:false,calm:o.calm,fx:true,time:0,selected:null as number|null};
 const renderer=new THREE.WebGLRenderer({canvas,antialias:!small,powerPreference:"high-performance"});
 renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,small?1.5:2));
 renderer.shadowMap.enabled=!small;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
 const scene=new THREE.Scene();scene.fog=new THREE.FogExp2(C.night,.0042);
 const camera=new THREE.PerspectiveCamera(40,1,.1,600);camera.position.set(6,26,40);
 const controls=new OrbitControls(camera,canvas);
 controls.enableDamping=true;controls.dampingFactor=.08;controls.maxPolarAngle=Math.PI*.47;controls.minDistance=9;controls.maxDistance=95;controls.enablePan=false;controls.target.set(0,2,0);
 controls.autoRotate=!S.calm;controls.autoRotateSpeed=.35;
 const stopRotate=()=>{controls.autoRotate=false;fly=null;};

 const tex=(cv:HTMLCanvasElement)=>{const t=new THREE.CanvasTexture(cv);t.colorSpace=THREE.SRGBColorSpace;return t;};
 const lam=(color:number,extra:THREE.MeshLambertMaterialParameters={})=>new THREE.MeshLambertMaterial({color,...extra});
 const glow=(color:number,extra:THREE.MeshBasicMaterialParameters={})=>new THREE.MeshBasicMaterial({color,...extra});
 const box=(w:number,h:number,d:number,m:THREE.Material|THREE.Material[],shadow=true)=>{const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),m);if(shadow){b.castShadow=true;b.receiveShadow=true;}return b;};
 const cyl=(a:number,b:number,h:number,s:number,m:THREE.Material)=>{const c=new THREE.Mesh(new THREE.CylinderGeometry(a,b,h,s),m);c.castShadow=true;c.receiveShadow=true;return c;};

 /* Cielo de día */
 {const cv=document.createElement("canvas");cv.width=8;cv.height=256;const g=cv.getContext("2d");
  if(g){const gr=g.createLinearGradient(0,0,0,256);gr.addColorStop(0,"#5fb0f2");gr.addColorStop(.5,"#a9d8ff");gr.addColorStop(.8,"#dff1ff");gr.addColorStop(1,"#f4fbff");g.fillStyle=gr;g.fillRect(0,0,8,256);}
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(300,24,16),new THREE.MeshBasicMaterial({map:tex(cv),side:THREE.BackSide,fog:false})));
  const n=0,pos=new Float32Array(n*3);for(let i=0;i<n;i++){const a=Math.random()*Math.PI*2,e=Math.random()*1.2+.15,r=260;pos[i*3]=Math.cos(a)*Math.cos(e)*r;pos[i*3+1]=Math.sin(e)*r;pos[i*3+2]=Math.sin(a)*Math.cos(e)*r;}
  const sg=new THREE.BufferGeometry();sg.setAttribute("position",new THREE.BufferAttribute(pos,3));
  if(n>0)scene.add(new THREE.Points(sg,new THREE.PointsMaterial({color:0xcfd8ff,size:1.3,sizeAttenuation:false,fog:false,transparent:true,opacity:.85})));}
 scene.add(new THREE.HemisphereLight(0xffffff,0x9fd08a,2.0));
 const moon=new THREE.DirectionalLight(0xfff1d6,2.6);moon.position.set(22,38,16);moon.castShadow=!small;
 moon.shadow.mapSize.set(2048,2048);Object.assign(moon.shadow.camera,{left:-42,right:42,top:42,bottom:-42,far:120});moon.shadow.bias=-.0006;scene.add(moon);

 /* Resplandor: si el equipo no puede, se dibuja sin él */
 let composer:EffectComposer|null=null;
 try{composer=new EffectComposer(renderer,new THREE.WebGLRenderTarget(4,4,{samples:small?0:4,type:THREE.HalfFloatType}));composer.addPass(new RenderPass(scene,camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(256,256),.1,.4,.96));composer.addPass(new OutputPass());}catch{composer=null;}

 const campus=new THREE.Group();scene.add(campus);
 /* Suelo: plaza de piedra en el centro, césped alrededor */
 {const cv=document.createElement("canvas");cv.width=cv.height=512;const g=cv.getContext("2d");
  if(g){const gr=g.createRadialGradient(256,256,10,256,256,256);gr.addColorStop(0,"#efe9da");gr.addColorStop(.2,"#e6dfcd");gr.addColorStop(.24,"#9ad67f");gr.addColorStop(1,"#7cc567");g.fillStyle=gr;g.fillRect(0,0,512,512);
   g.strokeStyle="rgba(255,255,255,.16)";g.lineWidth=1.5;for(let r=76;r<256;r+=44){g.beginPath();g.arc(256,256,r,0,Math.PI*2);g.stroke();}
   g.strokeStyle="rgba(255,255,255,0)";for(let a=0;a<0;a++){g.beginPath();g.moveTo(256,256);g.lineTo(256+Math.cos(a*Math.PI/12)*256,256+Math.sin(a*Math.PI/12)*256);g.stroke();}}
  const gm=new THREE.Mesh(new THREE.CircleGeometry(60,72),new THREE.MeshLambertMaterial({map:tex(cv)}));gm.rotation.x=-Math.PI/2;gm.receiveShadow=true;campus.add(gm);}

 const roadTex=(()=>{const cv=document.createElement("canvas");cv.width=16;cv.height=128;const g=cv.getContext("2d");
  if(g){g.fillStyle="#5a5f6b";g.fillRect(0,0,16,128);g.fillStyle="#f4f5f7";g.fillRect(7,8,2,44);g.fillRect(7,72,2,44);}
  const t=tex(cv);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(1,3);return t;})();
 const roadMat=new THREE.MeshBasicMaterial({map:roadTex});
 function tree(x:number,z:number,s:number){const g=new THREE.Group();const t=cyl(.09*s,.13*s,.7*s,6,lam(C.trunk));t.position.y=.35*s;g.add(t);
  const l=new THREE.Mesh(new THREE.IcosahedronGeometry(.55*s,0),lam(C.leaf));l.position.y=1.05*s;l.castShadow=true;g.add(l);
  const l2=new THREE.Mesh(new THREE.IcosahedronGeometry(.38*s,0),lam(0x3fb07c));l2.position.set(.2*s,1.5*s,.1*s);l2.castShadow=true;g.add(l2);g.position.set(x,0,z);campus.add(g);}

 const lamps:THREE.Mesh[]=[],buildings:Building[]=[],pickable:THREE.Object3D[]=[];
 const R=FACTORY_RADIUS;
 for(let slot=1;slot<=5;slot++){
  const a=factorySlotAngle(slot),p=new THREE.Vector3(Math.cos(a)*R,0,Math.sin(a)*R),ang=Math.atan2(p.x,p.z);
  const road=new THREE.Mesh(new THREE.PlaneGeometry(1.5,R-4.2),roadMat);road.rotation.order="YXZ";road.rotation.set(-Math.PI/2,ang,0);road.position.set(p.x*.54,.03,p.z*.54);campus.add(road);
  const pad=cyl(4.6,5,.35,6,lam(C.plot));pad.position.set(p.x,.17,p.z);pad.userData.slot=slot;campus.add(pad);pickable.push(pad);
  const edge=new THREE.Mesh(new THREE.TorusGeometry(4.75,.05,6,6),glow(C.roadGlow));edge.rotation.x=Math.PI/2;edge.rotation.z=Math.PI/6;edge.position.set(p.x,.37,p.z);campus.add(edge);
  for(let k=1;k<=2;k++){const f=k/3+.12,sd=k%2?1:-1,lx=p.x*f+Math.cos(ang)*1.3*sd,lz=p.z*f-Math.sin(ang)*1.3*sd;
   const pole=cyl(.05,.06,1.7,6,lam(0x5b6170));pole.position.set(lx,.85,lz);campus.add(pole);
   const bulb=new THREE.Mesh(new THREE.SphereGeometry(.14,10,8),glow(0xfff1c2));bulb.position.set(lx,1.75,lz);campus.add(bulb);lamps.push(bulb);}
  tree(p.x+Math.cos(ang)*3.6,p.z-Math.sin(ang)*3.6,1.1);tree(p.x-Math.cos(ang)*3.7,p.z+Math.sin(ang)*3.7,.9);
  buildings.push({slot,pos:p,group:null,sig:"",plot:{slot,kind:"empty",floors:0,lit:0,blocked:false},cv:null,tex:null,height:3,beacon:null,pulse:null,pulseT:0,bump:0,warmUntil:0,warm:false,edge,site:null});
 }

 /* La ciudad alrededor: avenida circular con coches, árboles y manzanas de edificios bajos (decorado) */
 const RING=27,ringCars:{g:THREE.Group;a:number;v:number}[]=[];
 {const av=new THREE.Mesh(new THREE.RingGeometry(RING-2.2,RING+2.2,96),new THREE.MeshLambertMaterial({color:0x5a5f6b}));av.rotation.x=-Math.PI/2;av.position.y=.02;av.receiveShadow=true;campus.add(av);
  const acera=new THREE.Mesh(new THREE.RingGeometry(RING+2.2,RING+3.4,96),new THREE.MeshLambertMaterial({color:0xdfe2e8}));acera.rotation.x=-Math.PI/2;acera.position.y=.025;campus.add(acera);
  for(let i=0;i<48;i++){const a=i/48*Math.PI*2,d=new THREE.Mesh(new THREE.PlaneGeometry(.16,1.5),glow(0xf4f5f7));d.rotation.order="YXZ";d.rotation.set(-Math.PI/2,-a,0);d.position.set(Math.cos(a)*RING,.035,Math.sin(a)*RING);campus.add(d);}
  for(let i=0;i<(small?10:18);i++){const a=(i+.5)/(small?10:18)*Math.PI*2;tree(Math.cos(a)*(RING+4.4),Math.sin(a)*(RING+4.4),1.3+((i*37)%5)*.1);}
  const WALLS=[0xf4c9a8,0xbcd9f2,0xcfe8c4,0xf2d27f,0xe8c3d8,0xd6d0f0,0xf0b8a0,0xc2e4e0];
  const fac=(()=>{const cv=document.createElement("canvas");cv.width=64;cv.height=64;const g=cv.getContext("2d");if(g){g.fillStyle="#ffffff";g.fillRect(0,0,64,64);for(let r=0;r<3;r++)for(let k=0;k<3;k++){g.fillStyle=(r+k)%4===0?"#ffe9a8":"#9cc4e4";g.fillRect(6+k*20,6+r*20,12,12);}}
   const t=tex(cv);t.wrapS=t.wrapT=THREE.RepeatWrapping;return t;})();
  for(let i=0;i<(small?12:22);i++){const a=i/(small?12:22)*Math.PI*2+.07,r=RING+10+((i*13)%3)*4.5,h=3+((i*7)%5)*1.3,w=4.2+((i*5)%3);
   const m=new THREE.MeshLambertMaterial({color:WALLS[i%WALLS.length],map:fac.clone()});m.map!.repeat.set(Math.round(w/1.6),Math.round(h/1.5));m.map!.needsUpdate=true;
   const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,w),m);b.position.set(Math.cos(a)*r,h/2,Math.sin(a)*r);b.rotation.y=-a;campus.add(b);
   const top=new THREE.Mesh(new THREE.BoxGeometry(w+.25,.2,w+.25),lam(0xf7f3ea));top.position.set(Math.cos(a)*r,h+.1,Math.sin(a)*r);top.rotation.y=-a;campus.add(top);}
  fac.dispose();
  const CAR=[0xf6c445,0xe2574c,0x3b82f6,0xffffff,0x22a06b,0xf08a24];
  for(let i=0;i<(small?3:6);i++){const g=new THREE.Group();const body=box(1.1,.38,2.2,lam(CAR[i%CAR.length]),false);body.position.y=.34;g.add(body);const cab=box(.95,.34,1.1,lam(0xcfe6f7),false);cab.position.set(0,.68,-.05);g.add(cab);
   for(const [x,z] of [[-.58,.7],[.58,.7],[-.58,-.7],[.58,-.7]]){const w=new THREE.Mesh(new THREE.CylinderGeometry(.19,.19,.14,10),lam(0x22252e));w.rotation.z=Math.PI/2;w.position.set(x,.19,z);g.add(w);}
   campus.add(g);ringCars.push({g,a:i/(small?3:6)*Math.PI*2,v:(.1+.03*(i%3))*(i%2?1:-1)});}}

 /* Personas articuladas (ambiente) */
 function person(seed:number):Person{
  const skin=SKIN[seed%SKIN.length],hair=HAIR[(seed*3+1)%HAIR.length],shirt=SHIRT[(seed*5+2)%SHIRT.length],g=new THREE.Group();
  const hips=new THREE.Group();hips.position.y=.78;g.add(hips);
  const limb=(w:number,h:number,d:number,col:number,x:number,y:number)=>{const piv=new THREE.Group();piv.position.set(x,y,0);const m=box(w,h,d,lam(col));m.position.y=-h/2;piv.add(m);return piv;};
  const legL=limb(.17,.74,.19,0x1c2247,-.11,0),legR=limb(.17,.74,.19,0x1c2247,.11,0);hips.add(legL,legR);
  for(const leg of [legL,legR]){const shoe=box(.18,.08,.28,lam(0x0c1030));shoe.position.set(0,-.76,.05);leg.add(shoe);}
  const torso=cyl(.2,.24,.62,10,lam(shirt));torso.position.y=.33;hips.add(torso);
  const sh=cyl(.26,.2,.14,10,lam(shirt));sh.position.y=.68;hips.add(sh);
  const armL=limb(.11,.6,.12,shirt,-.31,.7),armR=limb(.11,.6,.12,shirt,.31,.7);hips.add(armL,armR);
  for(const arm of [armL,armR]){const hand=new THREE.Mesh(new THREE.SphereGeometry(.065,8,6),lam(skin));hand.position.y=-.63;arm.add(hand);}
  const neck=cyl(.07,.08,.1,8,lam(skin));neck.position.y=.8;hips.add(neck);
  const head=new THREE.Group();head.position.y=1.02;head.scale.setScalar(1.45);hips.add(head);   // cabeza grande, como los muñecos de la oficina
  const skull=new THREE.Mesh(new THREE.SphereGeometry(.17,16,12),lam(skin));skull.scale.set(1,1.12,1.05);skull.castShadow=true;head.add(skull);
  const hr=new THREE.Mesh(new THREE.SphereGeometry(.18,16,10,0,Math.PI*2,0,Math.PI*.56),lam(hair));hr.position.y=.03;hr.scale.set(1.03,1.12,1.08);head.add(hr);
  if(seed%2){const bun=new THREE.Mesh(new THREE.SphereGeometry(.14,10,8),lam(hair));bun.position.set(0,-.02,-.13);bun.scale.set(1.05,1.25,.8);head.add(bun);}
  return {g,hips,legL,legR,armL,armR,head};
 }
 const walkers=Array.from({length:small?4:8},(_,w)=>{const P=person(w+3),b=buildings[w%5],an=Math.atan2(b.pos.x,b.pos.z),off=(w%2?1:-1)*1.15;
  P.g.scale.setScalar(.9);campus.add(P.g);return {P,b,t:Math.random(),dir:w%2?1:-1,speed:.045+Math.random()*.03,ox:Math.cos(an)*off,oz:-Math.sin(an)*off,ang:an};});

 /* Freddy: su modelo real si carga; mientras tanto (o si falla), una figura */
 const freddy=new THREE.Group();campus.add(freddy);
 const hub=cyl(3,3.4,.5,48,lam(0xdcd6c6));hub.position.y=.25;freddy.add(hub);
 const hubTop=cyl(2.5,2.5,.08,48,lam(0xf6f1e4));hubTop.position.y=.52;freddy.add(hubTop);
 const ring=new THREE.Mesh(new THREE.TorusGeometry(2.55,.06,10,72),glow(C.indigo));ring.rotation.x=Math.PI/2;ring.position.y=.6;freddy.add(ring);
 const ring2=new THREE.Mesh(new THREE.TorusGeometry(1.7,.035,8,60),glow(C.cyan));ring2.rotation.x=Math.PI/2;ring2.position.y=.62;freddy.add(ring2);
 const beamMat=new THREE.MeshBasicMaterial({color:C.indigo,transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
 const beam=new THREE.Mesh(new THREE.CylinderGeometry(1.6,2.4,9,32,1,true),beamMat);beam.position.y=5;freddy.add(beam);
 const fbody=new THREE.Group();fbody.position.y=.56;freddy.add(fbody);
 const fStand=person(1);fStand.g.scale.setScalar(1.9);fbody.add(fStand.g);
 let freddyPulse=0,freddyFace=0,freddyModel:THREE.Object3D|null=null,disposed=false;
 new GLTFLoader().load(o.freddyUrl??"/freddy-3d/Freddy_draft.glb",g=>{
  const m=g.scene;if(disposed){disposeTree(m);return;}
  m.traverse(x=>{const mesh=x as THREE.Mesh;if(mesh.isMesh){mesh.castShadow=true;const mat=mesh.material as THREE.MeshStandardMaterial;if(mat&&"roughness" in mat){mat.metalness=0;mat.roughness=.85;}}});
  let bb=new THREE.Box3().setFromObject(m),sz=bb.getSize(new THREE.Vector3());
  if(sz.z>sz.y*1.5){m.rotation.x=-Math.PI/2;bb=new THREE.Box3().setFromObject(m);sz=bb.getSize(new THREE.Vector3());}
  m.scale.setScalar(4.6/sz.y);bb=new THREE.Box3().setFromObject(m);m.position.y-=bb.min.y;m.position.x-=(bb.min.x+bb.max.x)/2;m.position.z-=(bb.min.z+bb.max.z)/2;
  fbody.remove(fStand.g);fbody.add(m);freddyModel=m;
 },undefined,()=>{});

 /* Edificios */
 function paintWindows(b:Building){
  if(!b.cv||!b.tex)return;const g=b.cv.getContext("2d");if(!g)return;
  const F=b.plot.floors,W=b.cv.width,H=b.cv.height,fh=H/F,litFloors=b.plot.kind==="company"?Math.round(F*Math.max(0,Math.min(1,b.plot.lit))):0;
  g.fillStyle=SLOT_WALL[(b.slot-1)%SLOT_WALL.length];g.fillRect(0,0,W,H);
  for(let i=0;i<F;i++){const y=H-(i+1)*fh;g.fillStyle="rgba(255,255,255,.7)";g.fillRect(0,y+fh-3,W,3);
   for(let x=0;x<8;x++){const on=i<litFloors&&((x*7+i*3)%8)<6;g.fillStyle=on?(b.warm?C.winWarm:C.winOn):C.winOff;g.fillRect(6+x*15.5,y+7,11,fh-15);}}
  b.tex.needsUpdate=true;
 }
 function clearBuilding(b:Building){if(!b.group)return;for(let i=pickable.length-1;i>=0;i--)if(pickable[i].userData.owner===b.slot)pickable.splice(i,1);
  campus.remove(b.group);disposeTree(b.group);b.tex?.dispose();b.group=null;b.cv=null;b.tex=null;b.beacon=null;b.pulse=null;b.site=null;}
 function build(b:Building){
  clearBuilding(b);const p=b.pos,g=new THREE.Group();g.position.set(p.x,.35,p.z);g.rotation.y=Math.atan2(-p.x,-p.z);campus.add(g);b.group=g;
  const own=(m:THREE.Object3D)=>{m.userData.slot=b.slot;m.userData.owner=b.slot;pickable.push(m);};
  if(b.plot.kind==="empty"){
   // Obra en marcha: estructura a medio levantar, grúa torre que gira y sube carga, y operarios con casco.
   const steel=lam(0xb9bfcc),conc=lam(0xd9d4c7),yellow=lam(0xf6c445),orange=lam(0xf08a24);
   for(const [x,z] of [[-1.4,-1.4],[1.4,-1.4],[-1.4,1.4],[1.4,1.4]]){const c=box(.16,3.2,.16,steel);c.position.set(x,1.6,z);g.add(c);own(c);}
   for(const y of [.95,2.05]){const s=box(3.1,.14,3.1,conc);s.position.y=y;g.add(s);own(s);}
   for(const [x,z,w,d] of [[0,-1.4,2.96,.12],[0,1.4,2.96,.12],[-1.4,0,.12,2.96],[1.4,0,.12,2.96]]){const beam=box(w,.12,d,steel);beam.position.set(x,3.14,z);g.add(beam);}
   for(const [x,z] of [[-2.4,2.6],[0,3.1],[2.4,2.6]]){const cone=new THREE.Mesh(new THREE.ConeGeometry(.16,.42,10),orange);cone.position.set(x,.21,z);g.add(cone);}
   const pile=box(1,.36,.7,lam(0xc9955c));pile.position.set(2.2,.18,-1.9);g.add(pile);const pile2=box(.8,.3,.6,lam(0xd6a66f));pile2.position.set(2.15,.5,-1.85);g.add(pile2);
   // Cartel de «SE VENDE» a pie de obra, por las dos caras: se lee desde la plaza y desde la avenida.
   {const cv=document.createElement("canvas");cv.width=320;cv.height=160;const c2=cv.getContext("2d");
    if(c2){c2.fillStyle="#e2231a";c2.fillRect(0,0,320,160);c2.strokeStyle="#ffffff";c2.lineWidth=8;c2.strokeRect(8,8,304,144);c2.fillStyle="#ffffff";c2.textAlign="center";
     c2.font="900 62px Inter, system-ui, sans-serif";c2.fillText("SE VENDE",160,84);c2.font="700 22px Inter, system-ui, sans-serif";c2.fillText("parcela "+b.slot+" · tu próxima empresa",160,124);}
    const signTex=tex(cv),mat=new THREE.MeshBasicMaterial({map:signTex});
    for(const [z,ry] of [[3.5,0],[-3.5,Math.PI]] as [number,number][]){const board=new THREE.Mesh(new THREE.PlaneGeometry(2.6,1.3),mat);board.position.set(z>0?-1:1,1.35,z);board.rotation.y=ry;g.add(board);own(board);
     const back=new THREE.Mesh(new THREE.PlaneGeometry(2.6,1.3),lam(0xf7f3ea));back.position.set(z>0?-1:1,1.35,z+(z>0?-.02:.02));back.rotation.y=ry+Math.PI;g.add(back);
     for(const x of [-.9,.9]){const leg=box(.09,1.4,.09,lam(0x8a5a3b),false);leg.position.set((z>0?-1:1)+x,.7,z+(z>0?-.03:.03));g.add(leg);}}}
   const crane=new THREE.Group();crane.position.set(-2.7,0,-2.3);g.add(crane);
   const mast=box(.3,6.4,.3,yellow);mast.position.y=3.2;crane.add(mast);const foot=box(1,.2,1,lam(0x8a90a3));foot.position.y=.1;crane.add(foot);
   const arm=new THREE.Group();arm.position.y=6.4;crane.add(arm);
   const jib=box(5.2,.2,.24,yellow,false);jib.position.x=1.7;arm.add(jib);const back=box(1,.5,.5,lam(0x8a90a3),false);back.position.x=-1.2;arm.add(back);
   const cab=box(.55,.55,.55,lam(0xfdfdfd),false);cab.position.set(.1,-.38,.3);arm.add(cab);const tip=box(.22,.9,.22,yellow,false);tip.position.y=.5;arm.add(tip);
   const cable=box(.035,1,.035,lam(0x22252e),false);cable.position.set(3.4,-.5,0);arm.add(cable);
   const load=box(.6,.42,.6,lam(0xc9955c),false);load.position.set(3.4,-1.2,0);arm.add(load);
   const crew:NonNullable<Building["site"]>["crew"]=[];
   for(const [k,x,z,job] of [[0,1.9,2.3,"hammer"],[1,-.4,2.5,"walk"],[2,.2,.2,"hammer"]] as [number,number,number,"hammer"|"walk"][]){
    if(small&&k===2)continue;const P=person(b.slot*3+k+11);P.g.scale.setScalar(.9);P.g.position.set(x,k===2?1.02:0,z);P.g.rotation.y=k===0?-.6:k===2?2.4:Math.PI/2;
    const helmet=new THREE.Mesh(new THREE.SphereGeometry(.2,14,10,0,Math.PI*2,0,Math.PI*.5),lam(0xf6c445));helmet.position.y=.04;P.head.add(helmet);
    const vest=box(.5,.36,.34,orange,false);vest.position.y=.36;P.hips.add(vest);
    g.add(P.g);crew.push({P,x,z,job});}
   b.site={arm,cable,load,crew};
   b.height=4.4;return;}
  const F=Math.max(1,b.plot.floors),h=F*1.05;b.cv=document.createElement("canvas");b.cv.width=128;b.cv.height=32*F;b.tex=tex(b.cv);
  const sideM=new THREE.MeshLambertMaterial({map:b.tex}),topM=lam(0xf1ece0);const ROOF=SLOT_ROOF[(b.slot-1)%SLOT_ROOF.length];
  const tower=new THREE.Mesh(new THREE.BoxGeometry(3.6,h,3.6),[sideM,sideM,topM,topM,sideM,sideM]);tower.position.y=h/2+.5;tower.castShadow=true;g.add(tower);own(tower);
  const base=box(4.3,.5,4.3,lam(C.frame));base.position.y=.25;g.add(base);own(base);
  const canopy=box(1.8,.1,1,lam(ROOF));canopy.position.set(0,1.05,2.2);g.add(canopy);
  const door=box(1,.75,.06,lam(0x355b7a),false);door.position.set(0,.88,1.83);g.add(door);
  for(const [x,z] of [[-1.8,-1.8],[1.8,-1.8],[-1.8,1.8],[1.8,1.8]]){const f=box(.14,h+.2,.14,lam(C.frame));f.position.set(x,h/2+.5,z);g.add(f);}
  const roof=box(3.9,.2,3.9,lam(ROOF));roof.position.y=h+.6;g.add(roof);
  const ac=box(.9,.4,.7,lam(0xc9ced8));ac.position.set(-.9,h+.9,.8);g.add(ac);
  const mast=cyl(.04,.05,1.6,6,lam(C.frame));mast.position.set(1,h+1.5,-1);g.add(mast);
  b.beacon=new THREE.Mesh(new THREE.SphereGeometry(.13,10,8),glow(C.cyan));b.beacon.position.set(1,h+2.35,-1);g.add(b.beacon);
  b.pulse=new THREE.Mesh(new THREE.RingGeometry(4.4,4.9,48),new THREE.MeshBasicMaterial({color:C.amber,transparent:true,opacity:0,side:THREE.DoubleSide,depthWrite:false}));b.pulse.rotation.x=-Math.PI/2;b.pulse.position.y=.08;g.add(b.pulse);
  b.height=h+1.2;
 }
 function setPlots(plots:FactoryPlot[]){
  for(const b of buildings){const p=plots.find(x=>x.slot===b.slot)??{slot:b.slot,kind:"empty" as const,floors:0,lit:0,blocked:false};
   const floors=p.kind==="empty"?0:Math.min(Math.max(Math.round(p.floors),1),10),sig=p.kind+":"+floors;b.plot={...p,floors};
   if(sig!==b.sig||!b.group){b.sig=sig;build(b);}
   if(b.beacon)(b.beacon.material as THREE.MeshBasicMaterial).color.setHex(b.plot.blocked?C.amber:C.cyan);
   paintWindows(b);}
  paintSelected();
 }
 function paintSelected(){for(const b of buildings){const m=b.edge.material as THREE.MeshBasicMaterial,on=S.selected===b.slot;m.color.setHex(on?0xf3f5ff:C.roadGlow);b.edge.scale.setScalar(on?1.04:1);}}

 /* Drones, ondas y confeti */
 type Drone={m:THREE.Group;from:THREE.Vector3;to:THREE.Vector3;t:number;dur:number;on:()=>void;trail:THREE.Mesh[];hist:THREE.Vector3[];rot:THREE.Mesh[]};
 const drones:Drone[]=[],bursts:{m:THREE.Mesh;t:number;size:number}[]=[],sparks:{m:THREE.Points;v:THREE.Vector3[];t:number}[]=[];
 function sendDrone(from:THREE.Vector3,to:THREE.Vector3,color:number,onArrive:()=>void,dur:number){
  if(S.calm||drones.length>=8){onArrive();return;}
  const g=new THREE.Group();g.add(box(.42,.14,.42,lam(0xdfe4ff),false));const rot:THREE.Mesh[]=[];
  for(const [x,z] of [[-.34,-.34],[.34,-.34],[-.34,.34],[.34,.34]]){const arm=box(.3,.03,.05,lam(0x8792c9),false);arm.position.set(x*.6,0,z*.6);arm.lookAt(0,0,0);g.add(arm);
   const r=new THREE.Mesh(new THREE.CylinderGeometry(.2,.2,.012,14),new THREE.MeshBasicMaterial({color:0xcfd6ff,transparent:true,opacity:.45}));r.position.set(x,.08,z);g.add(r);rot.push(r);}
  const cargo=new THREE.Mesh(new THREE.BoxGeometry(.3,.3,.3),glow(color));cargo.position.y=-.26;g.add(cargo);
  const aura=new THREE.Mesh(new THREE.SphereGeometry(.5,12,10),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.2,depthWrite:false}));aura.position.y=-.26;g.add(aura);
  g.position.copy(from);campus.add(g);
  const trail=Array.from({length:6},(_,i)=>{const t=new THREE.Mesh(new THREE.SphereGeometry(.13-.015*i,8,6),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.6-i*.09,depthWrite:false}));t.position.copy(from);campus.add(t);return t;});
  drones.push({m:g,from:from.clone(),to:to.clone(),t:0,dur,on:onArrive,trail,hist:[],rot});
 }
 function wave(pos:THREE.Vector3,color:number,size:number){if(S.calm)return;
  const r=new THREE.Mesh(new THREE.RingGeometry(.5,.66,44),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.95,side:THREE.DoubleSide,depthWrite:false}));r.rotation.x=-Math.PI/2;r.position.copy(pos);r.position.y+=.12;campus.add(r);bursts.push({m:r,t:0,size});}
 function confetti(pos:THREE.Vector3){if(S.calm||!S.fx)return;
  const n=small?14:26,geo=new THREE.BufferGeometry(),p=new Float32Array(n*3),v:THREE.Vector3[]=[];
  for(let i=0;i<n;i++){p[i*3]=pos.x;p[i*3+1]=pos.y+1.4;p[i*3+2]=pos.z;v.push(new THREE.Vector3((Math.random()-.5)*3,2.5+Math.random()*2.5,(Math.random()-.5)*3));}
  geo.setAttribute("position",new THREE.BufferAttribute(p,3));const pts=new THREE.Points(geo,new THREE.PointsMaterial({color:C.mint,size:.22,transparent:true,opacity:1,depthWrite:false}));campus.add(pts);sparks.push({m:pts,v,t:0});}

 const labels=new Map<string,HTMLElement>();
 function pop(key:string){const el=labels.get(key);if(!el||S.calm)return;el.classList.remove("pop");void el.offsetWidth;el.classList.add("pop");}
 const HUB_TOP=new THREE.Vector3(0,5.6,0);
 function emit(kind:FactoryEventKind,slot:number){
  const b=buildings.find(x=>x.slot===slot);if(!b||!b.group||b.plot.kind==="empty")return;
  const roofPos=new THREE.Vector3(b.pos.x,b.height+.6,b.pos.z),groundPos=new THREE.Vector3(b.pos.x,.3,b.pos.z);
  if(kind==="arrived"){
   freddyPulse=1;freddyFace=Math.atan2(b.pos.x,b.pos.z);pop("freddy");
   sendDrone(HUB_TOP,roofPos,C.amber,()=>{b.bump=1;b.pulseT=1;b.warmUntil=S.time+7;b.warm=true;paintWindows(b);pop("slot-"+slot);wave(groundPos,C.amber,9);},2.1);
  }else if(kind==="done"){
   wave(groundPos,C.mint,8);confetti(new THREE.Vector3(b.pos.x,b.height,b.pos.z));pop("slot-"+slot);
   sendDrone(roofPos,HUB_TOP,C.mint,()=>{freddyPulse=.6;pop("freddy");},1.9);
  }else{b.pulseT=1;b.bump=.6;wave(groundPos,C.amber,6);pop("slot-"+slot);}
 }

 /* Cámara */
 let fly:{fp:THREE.Vector3;ft:THREE.Vector3;tp:THREE.Vector3;tt:THREE.Vector3;t:number}|null=null;
 function setPose(p:FactoryPose,immediate=false){
  const pos=new THREE.Vector3(...p.pos),target=new THREE.Vector3(...p.target);
  if(immediate||S.calm){camera.position.copy(pos);controls.target.copy(target);fly=null;return;}
  controls.autoRotate=false;fly={fp:camera.position.clone(),ft:controls.target.clone(),tp:pos,tt:target,t:0};
 }

 /* Puntero: tocar un edificio lo selecciona (sin arrastre) */
 const ray=new THREE.Raycaster(),ndc=new THREE.Vector2();let down:{x:number;y:number}|null=null;
 function hit(e:PointerEvent){const r=canvas.getBoundingClientRect();ndc.set((e.clientX-r.left)/r.width*2-1,-((e.clientY-r.top)/r.height)*2+1);ray.setFromCamera(ndc,camera);
  const h=ray.intersectObjects(pickable,false)[0];return h?h.object.userData.slot as number:null;}
 const onDown=(e:PointerEvent)=>{down={x:e.clientX,y:e.clientY};stopRotate();};
 const onUp=(e:PointerEvent)=>{const d=down;down=null;if(!d||Math.hypot(e.clientX-d.x,e.clientY-d.y)>6)return;const s=hit(e);if(s)o.onSelect(s);};
 const onMove=(e:PointerEvent)=>{if(e.pointerType!=="mouse"||down)return;canvas.style.cursor=hit(e)?"pointer":"grab";};
 const onWheel=()=>stopRotate();
 const onLost=(e:Event)=>{e.preventDefault();o.onLost();};
 canvas.addEventListener("pointerdown",onDown);canvas.addEventListener("pointerup",onUp);canvas.addEventListener("pointermove",onMove);canvas.addEventListener("wheel",onWheel,{passive:true});canvas.addEventListener("webglcontextlost",onLost);

 /* Bucle */
 const ease=(t:number)=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2,out=(t:number)=>1-Math.pow(1-t,3);
 const v=new THREE.Vector3();let last=performance.now(),lastW=0,lastH=0,raf=0;
 function placeLabels(w:number,h:number){
  for(const [key,el] of labels){
   if(key==="freddy")v.set(0,6.3,0);else{const b=buildings[Number(key.slice(5))-1];if(!b){el.style.visibility="hidden";continue;}v.set(b.pos.x,b.height+1.9,b.pos.z);}
   v.project(camera);const show=v.z<1&&v.x>-1.15&&v.x<1.15&&v.y>-1.15&&v.y<1.15;
   el.style.visibility=show?"visible":"hidden";if(show)el.style.transform=`translate(-50%,-100%) translate(${((v.x*.5+.5)*w).toFixed(1)}px,${((-v.y*.5+.5)*h).toFixed(1)}px)`;}
 }
 function frame(now:number){
  raf=requestAnimationFrame(frame);
  const dt=Math.min(.05,(now-last)/1000);last=now;
  const w=stage.clientWidth,h=stage.clientHeight;if(!w||!h)return;
  if(w!==lastW||h!==lastH){lastW=w;lastH=h;renderer.setSize(w,h,false);composer?.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}
  if(!S.paused){
   S.time+=dt;
   for(let i=drones.length-1;i>=0;i--){const d=drones[i];d.t+=dt/d.dur;const k=ease(Math.min(1,d.t));d.m.position.lerpVectors(d.from,d.to,k);d.m.position.y+=Math.sin(k*Math.PI)*3.2;
    d.m.rotation.y+=dt*2;for(const r of d.rot)r.rotation.y+=dt*40;d.hist.unshift(d.m.position.clone());if(d.hist.length>24)d.hist.pop();
    d.trail.forEach((t,n)=>{const hp=d.hist[Math.min(d.hist.length-1,(n+1)*3)];if(hp){t.position.copy(hp);t.position.y-=.26;}});
    if(d.t>=1){campus.remove(d.m);disposeTree(d.m);for(const t of d.trail){campus.remove(t);disposeTree(t);}drones.splice(i,1);d.on();}}
   for(let j=bursts.length-1;j>=0;j--){const b=bursts[j];b.t+=dt*1.25;b.m.scale.setScalar(1+out(Math.min(1,b.t))*b.size);(b.m.material as THREE.MeshBasicMaterial).opacity=Math.max(0,.95*(1-b.t));if(b.t>=1){campus.remove(b.m);disposeTree(b.m);bursts.splice(j,1);}}
   for(let q=sparks.length-1;q>=0;q--){const sp=sparks[q];sp.t+=dt;const attr=sp.m.geometry.getAttribute("position") as THREE.BufferAttribute,arr=attr.array as Float32Array;
    sp.v.forEach((vel,n)=>{vel.y-=7*dt;arr[n*3]+=vel.x*dt;arr[n*3+1]=Math.max(.05,arr[n*3+1]+vel.y*dt);arr[n*3+2]+=vel.z*dt;});
    attr.needsUpdate=true;(sp.m.material as THREE.PointsMaterial).opacity=Math.max(0,1-sp.t/1.5);if(sp.t>1.5){campus.remove(sp.m);disposeTree(sp.m);sparks.splice(q,1);}}
   for(const b of buildings)if(b.warm&&S.time>b.warmUntil){b.warm=false;paintWindows(b);}
   if(!S.calm){
    ring.rotation.z+=dt*.5;ring2.rotation.z-=dt*.8;
    fbody.position.y=.56+Math.sin(S.time*1.5)*.05;let df=freddyFace-fbody.rotation.y;while(df>Math.PI)df-=Math.PI*2;while(df<-Math.PI)df+=Math.PI*2;fbody.rotation.y+=df*Math.min(1,dt*4);
    freddyPulse=Math.max(0,freddyPulse-dt*1.1);ring.scale.setScalar(1+freddyPulse*.3);beamMat.opacity=freddyPulse*.28;beam.scale.y=.6+freddyPulse*.5;
    if(!freddyModel){fStand.armR.rotation.x=-freddyPulse*2.2;fStand.armR.rotation.z=-freddyPulse*.3;}
    for(const b of buildings){const s=b.site;if(!s)continue;const T=S.time+b.slot*1.7;
     s.arm.rotation.y=Math.sin(T*.22)*1.25+.4;const len=1+(Math.sin(T*.55)+1)*1.5;s.cable.scale.y=len;s.cable.position.y=-len/2;s.load.position.y=-len-.2;
     for(const w of s.crew){if(w.job==="hammer"){w.P.armR.rotation.x=-1.3+Math.sin(T*9+w.x)*.55;w.P.head.rotation.x=.25;}
      else{const ph=Math.sin(T*.45);w.P.g.position.x=w.x+ph*1.3;w.P.g.rotation.y=Math.cos(T*.45)>0?Math.PI/2:-Math.PI/2;const sw=Math.sin(T*6)*.5;w.P.legL.rotation.x=sw;w.P.legR.rotation.x=-sw;w.P.armL.rotation.x=-sw*.7;w.P.armR.rotation.x=sw*.7;}}}
    for(const c of ringCars){c.a+=c.v*dt;c.g.position.set(Math.cos(c.a)*(RING+(c.v>0?1:-1)),0,Math.sin(c.a)*(RING+(c.v>0?1:-1)));c.g.rotation.y=-c.a+(c.v>0?0:Math.PI);}
    buildings.forEach((b,n)=>{if(!b.group)return;b.bump=Math.max(0,b.bump-dt*1.8);b.group.scale.y=1+Math.sin(b.bump*Math.PI)*.05;
     if(b.beacon)b.beacon.visible=b.plot.kind==="company"&&(!b.plot.blocked||Math.sin(S.time*5+n)>-.2);
     if(b.pulse){b.pulseT=Math.max(0,b.pulseT-dt*.7);(b.pulse.material as THREE.MeshBasicMaterial).opacity=b.pulseT*.8;b.pulse.scale.setScalar(1+(1-b.pulseT)*.6);}});
    walkers.forEach((wk,n)=>{wk.t+=dt*wk.speed*wk.dir;if(wk.t>1){wk.t=1;wk.dir=-1;}if(wk.t<0){wk.t=0;wk.dir=1;}
     const f=.22+wk.t*.5;wk.P.g.position.set(wk.b.pos.x*f+wk.ox,0,wk.b.pos.z*f+wk.oz);wk.P.g.rotation.y=wk.ang+(wk.dir>0?0:Math.PI);
     const sw=Math.sin(S.time*6+n)*.55;wk.P.legL.rotation.x=sw;wk.P.legR.rotation.x=-sw;wk.P.armL.rotation.x=-sw*.7;wk.P.armR.rotation.x=sw*.7;wk.P.hips.position.y=.78+Math.abs(Math.cos(S.time*6+n))*.025;});
   }else{beamMat.opacity=0;for(const b of buildings){if(b.group)b.group.scale.y=1;if(b.pulse)(b.pulse.material as THREE.MeshBasicMaterial).opacity=0;if(b.beacon)b.beacon.visible=b.plot.kind==="company";}}
  }
  if(fly){fly.t+=dt/.95;const e=ease(Math.min(1,fly.t));camera.position.lerpVectors(fly.fp,fly.tp,e);controls.target.lerpVectors(fly.ft,fly.tt,e);if(fly.t>=1)fly=null;}
  controls.update();
  if(composer&&S.fx&&!S.calm)composer.render();else renderer.render(scene,camera);
  placeLabels(w,h);
 }
 raf=requestAnimationFrame(frame);

 function disposeTree(root:THREE.Object3D){root.traverse(x=>{const m=x as THREE.Mesh;m.geometry?.dispose?.();const mats=Array.isArray(m.material)?m.material:m.material?[m.material]:[];
  for(const mat of mats){const map=(mat as THREE.MeshBasicMaterial).map;if(map&&map!==roadTex)map.dispose();if(mat!==roadMat)mat.dispose();}});}
 return {
  setPlots,emit,setPose,
  setSelected(slot){S.selected=slot;paintSelected();},
  setPaused(v){S.paused=v;if(v)controls.autoRotate=false;},
  setCalm(v){S.calm=v;if(v)controls.autoRotate=false;},
  setFx(v){S.fx=v;},
  setLabel(key,el){if(el)labels.set(key,el);else labels.delete(key);},
  get bloom(){return !!composer;},
  dispose(){disposed=true;cancelAnimationFrame(raf);
   canvas.removeEventListener("pointerdown",onDown);canvas.removeEventListener("pointerup",onUp);canvas.removeEventListener("pointermove",onMove);canvas.removeEventListener("wheel",onWheel);canvas.removeEventListener("webglcontextlost",onLost);
   controls.dispose();disposeTree(scene);roadTex.dispose();roadMat.dispose();composer?.dispose();renderer.dispose();labels.clear();}
 };
}

import {useEliotServerVoice} from "../src/useEliotServerVoice";
import {useEliotBrowserVoice} from "../src/useEliotBrowserVoice";
// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,renderHook,act} from '@testing-library/react';
import * as THREE from 'three';
import {ImmersiveOffice,createOfficeRenderer,bindOfficeLabel} from '../src/ImmersiveOffice';
import {actorPose,officeHome,officeRoom,officeDesk,OFFICE_AGENT_SCALE,officeCameraFit,officeMeeting,officeMeetingPath} from '../src/officeChoreography';
import {freddyFrame,freddySoftwareSize,FREDDY_ATLAS} from '../src/freddyProjection';
import {EliotPortraitView} from '../src/EliotPortraitView';
import {createFreddySoftwareImage} from '../src/freddySoftwareImage';
import {normalizeFreddyModel,disposeFreddyModel} from '../src/FreddyModelPreview';
const {seen}=vi.hoisted(()=>({seen:{scene:null as any,canvas:null as any}}));
vi.mock('three',async importOriginal=>({...await importOriginal<typeof import('three')>(),WebGLRenderer:class {constructor(){throw Error('WebGL disabled in test');}}}));
vi.mock('@react-three/fiber',()=>({Canvas:(p:any)=>{seen.canvas=p;seen.scene=p.children.props;return <div data-testid="webgl-surface"/>;},useFrame:vi.fn(),useThree:vi.fn()}));
const p={companyName:'Nova',departments:[{id:'d',name:'Desarrollo'}],workers:[{id:'w',department_id:'d',name:'Programador',phase:'available',recorded_state:'idle',motionActive:false}],paused:false,visible:true,onSelect:vi.fn(),onUnavailable:vi.fn()};
beforeEach(()=>{seen.scene=null;seen.canvas=null;});afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('keeps Freddy proportional to the office when software camera distance and viewport change',()=>{
 const camera=new THREE.PerspectiveCamera(40,2,.1,150),center=new THREE.Vector3(-5.2,1.88,-6);
 camera.position.set(-5.2,1.88,4);camera.lookAt(center);
 const near=freddySoftwareSize(camera,center,{width:1000,height:500});
 camera.position.z=14;camera.lookAt(center);
 const far=freddySoftwareSize(camera,center,{width:1000,height:500});
 expect(near.width/far.width).toBeCloseTo(2);expect(near.height/far.height).toBeCloseTo(2);
 const smaller=freddySoftwareSize(camera,center,{width:500,height:250});
 expect(smaller.width).toBeCloseTo(far.width/2);expect(smaller.height).toBeCloseTo(far.height/2);
 camera.lookAt(new THREE.Vector3(-5.2,1.88,30));expect(freddySoftwareSize(camera,center,{width:1000,height:500})).toEqual({width:0,height:0});
});
it('selects the eight original crops without angle captions or neighbouring views',()=>{
 for(let frame=0;frame<8;frame++){
  const crop=freddyFrame(frame*Math.PI/4);expect(crop).toEqual({x:frame%4*384,y:frame<4?0:492});
  expect(crop.x+384).toBeLessThanOrEqual(FREDDY_ATLAS.width);expect(crop.y+440).toBeLessThanOrEqual(FREDDY_ATLAS.height);
  expect(freddyFrame(frame*Math.PI/4-2*Math.PI)).toEqual(crop);
 }
});
it('changes the original portrait framing without starting audio or editing its source',()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);render(<EliotPortraitView speaking={false} listening={false} queued={false}/>);
 const image=screen.getByRole('img',{name:'Freddy de cintura hacia arriba'});expect(image.getAttribute('src')).toBe('/freddy-reference.png');
 fireEvent.click(screen.getByRole('button',{name:'Cuerpo entero'}));expect(screen.getByRole('img',{name:'Freddy de cuerpo entero'})).toBe(image);
 expect(image.getAttribute('src')).toBe('/freddy-reference.png');expect(fetcher).not.toHaveBeenCalled();
});
it('turns through all eight original views and keeps the selected angle when framing changes',()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);render(<EliotPortraitView speaking={false} listening={false} queued={false}/>);
 const image=screen.getByRole('img');
 for(let step=1;step<=8;step++){
  fireEvent.click(screen.getByRole('button',{name:'Girar Freddy 45 grados a la derecha'}));
  const frame=step%8;expect(screen.getByText(`Vista ${frame*45}°`)).toBeTruthy();
  expect(image.style.left).toBe(`${-(frame%4)*100}%`);expect(image.getAttribute('src')).toBe('/freddy-reference.png');
 }
 fireEvent.click(screen.getByRole('button',{name:'Girar Freddy 45 grados a la izquierda'}));expect(screen.getByText('Vista 315°')).toBeTruthy();
 expect(parseFloat(image.style.top)).toBeCloseTo(-492/235*100);
 fireEvent.click(screen.getByRole('button',{name:'Cuerpo entero'}));expect(screen.getByText('Vista 315°')).toBeTruthy();expect(parseFloat(image.style.top)).toBeCloseTo(-492/440*100);
 fireEvent.click(screen.getByRole('button',{name:'Vista frontal'}));expect(screen.getByText('Vista 0°')).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();
});
it('reports an unavailable portrait without losing its controls or issuing a voice request',()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);render(<EliotPortraitView speaking={false} listening={false} queued={false}/>);
 fireEvent.error(screen.getByRole('img'));expect(screen.getByText('No se ha podido cargar la imagen de Freddy.')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Cuerpo entero'}));expect(screen.getByRole('button',{name:'Girar Freddy 45 grados a la derecha'})).toBeTruthy();expect(fetcher).not.toHaveBeenCalled();
});
it('composites the software image using isolated opacity filters and preserves selection',()=>{
 const select=vi.fn(),first=createFreddySoftwareImage('/freddy-reference.png',select),second=createFreddySoftwareImage('/freddy-reference.png',vi.fn());
 expect(first.image.getAttribute('href')).toBe('/freddy-reference.png');expect(first.image.getAttribute('filter')).not.toBe(second.image.getAttribute('filter'));
 const func=first.outer.querySelector('feFuncA')!;const slope=Number(func.getAttribute('slope')),intercept=Number(func.getAttribute('intercept'));
 const opacity=(brightness:number)=>Math.max(0,Math.min(1,brightness*slope+intercept));expect(opacity(0)).toBe(0);expect(opacity(.01)).toBe(0);expect(opacity(.1)).toBe(1);
 const parent=document.createElementNS('http://www.w3.org/2000/svg','svg'),background=vi.fn();parent.append(first.outer);parent.addEventListener('pointerdown',background);parent.addEventListener('click',background);
 first.image.dispatchEvent(new Event('pointerdown',{bubbles:true}));first.image.dispatchEvent(new Event('click',{bubbles:true}));expect(select).toHaveBeenCalledTimes(1);expect(background).not.toHaveBeenCalled();
});
it('keeps the original portrait on entry and offers a download when the optional 3D viewer lacks WebGL',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const context=vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
 render(<EliotPortraitView speaking={false} listening={false} queued={false}/>);expect(screen.queryByRole('region',{name:'Borrador tridimensional de Freddy'})).toBeNull();expect(fetcher).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Revisar modelo 3D'}));await screen.findByText('Este navegador no ofrece WebGL 2. La referencia original sigue disponible.');
 expect(screen.getByRole('img',{name:'Freddy de cintura hacia arriba'})).toBeTruthy();expect(screen.getByRole('link',{name:'Descargar modelo GLB'}).getAttribute('href')).toBe('/freddy-3d/Freddy_draft.glb');expect(fetcher).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Cerrar modelo 3D'}));expect(screen.queryByRole('region',{name:'Borrador tridimensional de Freddy'})).toBeNull();context.mockRestore();
});
it('fits an offset mesh to the ground without rewriting animated root transforms',()=>{
 const mesh=new THREE.Mesh(new THREE.BoxGeometry(1,2,1),new THREE.MeshStandardMaterial());mesh.position.set(2,3,-4);const before=mesh.position.clone(),root=normalizeFreddyModel(mesh),bounds=new THREE.Box3().setFromObject(root);
 expect(bounds.min.y).toBeCloseTo(0);expect(bounds.max.y).toBeCloseTo(1.7);expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0);expect(mesh.position).toEqual(before);disposeFreddyModel(root);
 expect(()=>normalizeFreddyModel(new THREE.Group())).toThrow(/geometría/);
});
it('disposes shared model geometry and texture only once',()=>{
 const root=new THREE.Group(),geometry=new THREE.BoxGeometry(),texture=new THREE.Texture(),material=new THREE.MeshStandardMaterial({map:texture});root.add(new THREE.Mesh(geometry,material),new THREE.Mesh(geometry,material));
 const g=vi.spyOn(geometry,'dispose'),m=vi.spyOn(material,'dispose'),t=vi.spyOn(texture,'dispose');disposeFreddyModel(root);expect(g).toHaveBeenCalledTimes(1);expect(m).toHaveBeenCalledTimes(1);expect(t).toHaveBeenCalledTimes(1);
});
it('starts with real record mode and only enters choreography through the explicit preview control',()=>{
 render(<ImmersiveOffice {...p}/>);expect(screen.getByText(/ESTADOS REALES/)).toBeTruthy();expect(seen.scene.preview).toBe(false);fireEvent.click(screen.getByRole('button',{name:'Ver interacción animada'}));expect(screen.getByText(/VISTA PREVIA ANIMADA/)).toBeTruthy();expect(screen.getByText(/ni representa mensajes reales/i)).toBeTruthy();expect(seen.scene.preview).toBe(true);expect(p.workers[0].motionActive).toBe(false);fireEvent.click(screen.getByRole('button',{name:'Volver a estados reales'}));expect(seen.scene.preview).toBe(false);
});
it('pauses visible movement without issuing a worker or network command',()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);render(<ImmersiveOffice {...p}/>);fireEvent.click(screen.getByRole('button',{name:'Pausar movimiento'}));expect(seen.scene.animate).toBe(false);expect(fetcher).not.toHaveBeenCalled();
});
it('provides camera presets while preserving the same real records',()=>{
 render(<ImmersiveOffice {...p}/>);fireEvent.click(screen.getByRole('button',{name:'Freddy holográfico'}));expect(seen.scene.preset).toBe('hologram');expect(seen.scene.p.workers).toEqual(p.workers);fireEvent.click(screen.getByRole('button',{name:'Zona de encuentro'}));expect(seen.scene.preset).toBe('meeting');
});
it('stops rendering on a hidden tab and respects the common visual pause',()=>{
 const v=render(<ImmersiveOffice {...p} visible={false}/>);expect(seen.canvas.frameloop).toBe('never');expect(seen.scene.animate).toBe(false);v.rerender(<ImmersiveOffice {...p} paused/>);expect(seen.scene.animate).toBe(false);
});
it('respects reduced motion before allowing any visual choreography',()=>{
 vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));render(<ImmersiveOffice {...p}/>);expect(seen.scene.animate).toBe(false);expect(screen.getByText(/preferencia de movimiento reducido/)).toBeTruthy();
});
it('uses only the confirmed work flag for real work poses',()=>{
 const home=officeHome(0,0);expect(actorPose(0,12,home,false,false).action).toBe('rest');expect(actorPose(0,12,home,false,true).action).toBe('typing');expect(actorPose(0,12,home,false,true).position).toEqual(home);
});
it('has continuous complete paths through desk, doorway, encounter and return',()=>{
 for(let i=0;i<6;i++){
  const h=officeHome(i,0),poses=Array.from({length:761},(_,n)=>actorPose(i,n*.05,h,true,false));
  expect(new Set(poses.map(v=>v.action))).toEqual(new Set(['typing','walking','talking']));
  for(let n=0;n<poses.length;n++){const v=poses[n];expect(v.position.every(Number.isFinite)).toBe(true);expect(Math.abs(v.position[0])).toBeLessThan(8);expect(Math.abs(v.position[2])).toBeLessThan(9.3);if(n)expect(Math.hypot(v.position[0]-poses[n-1].position[0],v.position[2]-poses[n-1].position[2])).toBeLessThan(.3);}
 }
});
it('places two workstations separately and leaves a central aisle',()=>{
 for(let i=0;i<6;i++){const a=officeHome(i,0,2),b=officeHome(i,1,2);expect(Math.abs(a[0]-b[0])).toBeGreaterThan(1.5);expect(Math.abs(a[0])).toBeGreaterThan(2);expect(Math.abs(b[0])).toBeGreaterThan(2);}
});
it('separates meeting participants and rotates groups without claiming real communication',()=>{
 for(const time of [25,75,125]){
  const people=Array.from({length:18},(_,i)=>actorPose(i,time,officeHome(Math.floor(i/3),i%3),true,false));
  const meeting=people.filter(p=>p.action==='talking');expect(meeting).toHaveLength(6);
  for(let i=0;i<meeting.length;i++)for(let j=i+1;j<meeting.length;j++)expect(Math.hypot(meeting[i].position[0]-meeting[j].position[0],meeting[i].position[2]-meeting[j].position[2])).toBeGreaterThan(1);
  people.filter(p=>p.action!=='talking').forEach(p=>expect(p.action).toBe('typing'));
 }
 expect(actorPose(0,25,officeHome(0,0),false,false).action).toBe('rest');
});
it('keeps every route and meeting slot clear of the physical table',()=>{
 const inTable=(x:number,z:number)=>x>3.3&&x<7.1&&z>-6.7&&z<-5.3;
 for(let i=0;i<18;i++){
  const home=officeHome(Math.floor(i/3),i%3),path=officeMeetingPath(i,home),meet=officeMeeting(i);
  expect(inTable(meet[0],meet[2])).toBe(false);
  for(let segment=1;segment<path.length;segment++)for(let n=0;n<=100;n++){
   const a=path[segment-1],b=path[segment],t=n/100;
   expect(inTable(a[0]+(b[0]-a[0])*t,a[2]+(b[2]-a[2])*t)).toBe(false);
  }
 }
});

it('projects actual geometry through software when WebGL is unavailable and disposes the surface',()=>{
 const holder=document.createElement('div'),canvas=document.createElement('canvas');holder.append(canvas);const onSoftware=vi.fn(),renderer=createOfficeRenderer(canvas,onSoftware);renderer.setSize(400,300);
 const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(45,4/3,.1,50);camera.position.set(3,3,5);camera.lookAt(0,0,0);scene.add(new THREE.AmbientLight(0xffffff,.8));scene.add(new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshLambertMaterial({color:'#4088a5'})));renderer.render(scene,camera);
 expect(onSoftware).toHaveBeenCalledTimes(1);expect(holder.querySelectorAll('svg path').length).toBeGreaterThan(0);expect(canvas.style.visibility).toBe('hidden');renderer.dispose();expect(holder.querySelector('svg')).toBeNull();
});

it('selects a software label before camera pointer capture and prevents background selection',()=>{
 const root=document.createElementNS('http://www.w3.org/2000/svg','svg'),label=document.createElementNS('http://www.w3.org/2000/svg','g'),text=document.createElementNS('http://www.w3.org/2000/svg','text');root.append(label);label.append(text);const camera=vi.fn(),background=vi.fn(),selected=vi.fn();root.addEventListener('pointerdown',camera);root.addEventListener('click',background);bindOfficeLabel(label,selected);
 text.dispatchEvent(new Event('pointerdown',{bubbles:true}));text.dispatchEvent(new Event('click',{bubbles:true}));expect(selected).toHaveBeenCalledTimes(1);expect(camera).not.toHaveBeenCalled();expect(background).not.toHaveBeenCalled();
});

it('starts with the compact floorplan and keeps avatar labels optional without changing records',()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);render(<ImmersiveOffice {...p}/>);expect(seen.scene.preset).toBe('plan');expect(seen.scene.showNames).toBe(false);fireEvent.click(screen.getByRole('checkbox',{name:'Mostrar nombres sobre los agentes'}));expect(seen.scene.showNames).toBe(true);expect(seen.scene.preview).toBe(false);expect(fetcher).not.toHaveBeenCalled();
});
it('fits six distinct physical workstations inside each room without assigning synthetic workers',()=>{
 for(let room=0;room<6;room++){
  const center=officeRoom(room),slots=Array.from({length:6},(_,i)=>officeDesk(room,i));expect(new Set(slots.map(v=>v.join(','))).size).toBe(6);
  slots.forEach((d,i)=>{expect(Math.abs(d[0]-center[0])+2.25*OFFICE_AGENT_SCALE/2).toBeLessThan(2.85);expect(Math.abs(d[2]-center[2])+1.1*OFFICE_AGENT_SCALE/2).toBeLessThan(1.83);expect(officeHome(room,i)[2]).toBeCloseTo(d[2]+.86*OFFICE_AGENT_SCALE);});
 }
});

it('keeps the whole floorplan inside portrait and landscape camera framing',()=>{
 for(const aspect of [.5,.6,.75,1,1.5,2]){const distance=Math.hypot(27.5,15)*officeCameraFit(aspect),visibleWidth=2*distance*Math.tan(40*Math.PI/360)*aspect;expect(visibleWidth).toBeGreaterThan(20);expect(distance).toBeLessThan(85);}
});

it('identifies the portrait as ambient motion without implying an active voice session',()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);render(<ImmersiveOffice {...p}/>);expect(screen.queryByText(/Proyección de la imagen original/)).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Freddy holográfico'}));expect(screen.getByText(/Modelo articulado pendiente/)).toBeTruthy();expect(seen.scene.preview).toBe(false);expect(fetcher).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Planta de oficina'}));expect(screen.queryByText(/Proyección de la imagen original/)).toBeNull();
});

it('marks speech only after playback starts and ignores events from cancelled utterances',()=>{
 const utterances:any[]=[];vi.stubGlobal('SpeechSynthesisUtterance',class {constructor(public text:string){utterances.push(this);}});vi.stubGlobal('speechSynthesis',{cancel:vi.fn(),getVoices:()=>[{lang:"es-ES"}],speak:vi.fn()});
 const {result}=renderHook(()=>useEliotBrowserVoice(vi.fn()));act(()=>result.current.speak('Respuesta real'));expect(result.current.speaking).toBe(false);expect(result.current.queued).toBe(true);
 act(()=>utterances[0].onstart());expect(result.current.speaking).toBe(true);act(()=>utterances[0].onpause());expect(result.current.speaking).toBe(false);act(()=>utterances[0].onresume());expect(result.current.speaking).toBe(true);
 act(()=>result.current.stopSpeaking());act(()=>utterances[0].onstart());expect(result.current.speaking).toBe(false);expect(result.current.queued).toBe(false);
 act(()=>result.current.speak('Otra respuesta'));act(()=>utterances[1].onerror({error:"synthesis-failed"}));expect(result.current.speaking).toBe(false);expect(result.current.queued).toBe(false);expect(result.current.voiceError).toMatch(/No se pudo/);
});

it('does not queue speech without a Spanish voice and refreshes availability without speaking',()=>{
 let voices:any[]=[];const speak=vi.fn();vi.stubGlobal('SpeechSynthesisUtterance',class {});vi.stubGlobal('speechSynthesis',{cancel:vi.fn(),getVoices:()=>voices,speak});const {result}=renderHook(()=>useEliotBrowserVoice(vi.fn()));expect(result.current.canSpeak).toBe(false);act(()=>result.current.speak('Respuesta'));expect(speak).not.toHaveBeenCalled();expect(result.current.queued).toBe(false);voices=[{lang:'es-ES'}];act(()=>result.current.refreshVoices());expect(result.current.canSpeak).toBe(true);expect(speak).not.toHaveBeenCalled();
});
it('expires a stalled speech queue and ignores its late playback event',()=>{
 vi.useFakeTimers();let utterance:any;vi.stubGlobal('SpeechSynthesisUtterance',class {});vi.stubGlobal('speechSynthesis',{cancel:vi.fn(),getVoices:()=>[{lang:'es-ES'}],speak:(v:any)=>{utterance=v;}});const {result,unmount}=renderHook(()=>useEliotBrowserVoice(vi.fn()));act(()=>result.current.speak('Respuesta'));expect(result.current.queued).toBe(true);act(()=>vi.advanceTimersByTime(8000));expect(result.current.queued).toBe(false);expect(result.current.voiceError).toMatch(/no ha comenzado/);act(()=>utterance.onstart());expect(result.current.speaking).toBe(false);unmount();vi.useRealTimers();
});

it('does not request server audio on entry and aborts playback when company changes',async()=>{
 const fetcher=vi.fn((_url:any,_options:any)=>new Promise(()=>{}));vi.stubGlobal('fetch',fetcher);const token=vi.fn(async()=> 'test-token');const {result,rerender}=renderHook(({company})=>useEliotServerVoice(company,token),{initialProps:{company:'a'}});expect(fetcher).not.toHaveBeenCalled();await act(async()=>{void result.current.play('Signed answer','grant');});expect(fetcher).toHaveBeenCalledTimes(1);const opts=fetcher.mock.calls[0][1] as any;expect(JSON.parse(opts.body).consent).toBe(true);rerender({company:'b'});expect(opts.signal.aborted).toBe(true);expect(result.current.speaking).toBe(false);expect(result.current.loading).toBe(false);
});

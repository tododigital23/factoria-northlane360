import {SceneLabel} from "./Eliot3DLabels";
import {useEffect,useMemo,useRef,useState} from "react";
import {Canvas,useFrame} from "@react-three/fiber";
import * as THREE from "three";

type Department={id:string;name:string};
type Worker={id:string;department_id:string;name:string;specialty:string;state:string};
type Selected={kind:"company"|"department"|"worker"|"eliot";name:string;detail:string};
type Props={companyName:string;departments:Department[];workers:Worker[]};

function Connection({from,to,strong=false}:{from:[number,number,number];to:[number,number,number];strong?:boolean}){
 const line=useMemo(()=>{
  const geometry=new THREE.BufferGeometry().setFromPoints([
   new THREE.Vector3(...from),new THREE.Vector3(...to)
  ]);
  const material=new THREE.LineBasicMaterial({
   color:strong?"#bfb0ff":"#514e7c",
   transparent:true,
   opacity:strong ? 0.7 : 0.48
  });
  return new THREE.Line(geometry,material);
 },[from[0],from[1],from[2],to[0],to[1],to[2],strong]);
 useEffect(()=>()=>{line.geometry.dispose();(line.material as THREE.Material).dispose()},[line]);
 return <primitive object={line}/>;
}

function EliotCore({onSelect}:{onSelect:(s:Selected)=>void}){
 const mesh=useRef<THREE.Mesh>(null);
 useFrame((state,delta)=>{
  if(mesh.current){mesh.current.rotation.y+=delta*.16;mesh.current.position.y=2.75+Math.sin(state.clock.elapsedTime*1.2)*.08;}
 });
 return <group>
  <SceneLabel text="FREDDY · DIRECCIÓN GLOBAL" kind="eliot" position={[0,4.05,0]}/>
  <mesh position={[0,2.75,0]} ref={mesh} onClick={e=>{e.stopPropagation();onSelect({kind:"eliot",name:"Freddy",detail:"Director global previsto. Aún no coordina ni ejecuta agentes autónomos."});}}>
   <icosahedronGeometry args={[.83,2]}/>
   <meshStandardMaterial color="#c4a9ff" emissive="#7053bc" emissiveIntensity={.7} metalness={.55} roughness={.24} transparent opacity={.92}/>
  </mesh>
  <mesh position={[0,2.75,0]} rotation={[Math.PI/3,0,.15]}>
   <torusGeometry args={[1.32,.018,8,90]}/>
   <meshBasicMaterial color="#cab7ff" transparent opacity={.65}/>
  </mesh>
  <mesh position={[0,2.75,0]} rotation={[Math.PI/1.5,Math.PI/3,0]}>
   <torusGeometry args={[1.43,.013,8,90]}/>
   <meshBasicMaterial color="#9cdae9" transparent opacity={.45}/>
  </mesh>
 </group>;
}
function WorkerDot({position,worker,onSelect}:{position:[number,number,number];worker:Worker;onSelect:(s:Selected)=>void}){
 const active=worker.state==="working";
 const blocked=worker.state==="blocked";
 const color=active?"#69dfc2":blocked?"#d6a66d":"#817f9c";
 return <group>
 <mesh position={position} onClick={e=>{e.stopPropagation();onSelect({
    kind:"worker",name:worker.name,detail:worker.specialty+" · Estado real: "+worker.state
 });}}>
  <sphereGeometry args={[.18,16,12]}/>
  <meshStandardMaterial color={color} emissive={active?"#267e73":"#302f4b"} emissiveIntensity={active ? 0.6 : 0.15}/>
 </mesh>
 <SceneLabel text={worker.name} kind="worker" position={[position[0],position[1]-.42,position[2]]}/>
 </group>;
}
function Hierarchy({companyName,departments,workers,angle,onSelect}:{
 companyName:string;departments:Department[];workers:Worker[];angle:number;onSelect:(s:Selected)=>void;
}){
 return <group rotation={[0,angle,0]}>
  <SceneLabel text={companyName} kind="company" position={[0,.1,0]}/>
  <mesh position={[0,.9,0]} onClick={e=>{e.stopPropagation();onSelect({
    kind:"company",name:companyName,detail:"Estructura consultada en PostgreSQL con acceso autenticado."
  });}}>
   <octahedronGeometry args={[.53,0]}/>
   <meshStandardMaterial color="#a7e9ef" metalness={.35} roughness={.4} emissive="#2a7b8d" emissiveIntensity={.3}/>
  </mesh>
  <Connection from={[0,2.1,0]} to={[0,1.35,0]} strong/>
  {departments.map((department,i)=>{
    const a=2*Math.PI*i/Math.max(departments.length,1);
    const x=Math.cos(a)*4.4;const z=Math.sin(a)*4.4;
    const groupWorkers=workers.filter(w=>w.department_id===department.id);
    return <group key={department.id}>
      <Connection from={[0,.9,0]} to={[x,-.35,z]} strong/>
      <mesh position={[x,-.35,z]} onClick={e=>{e.stopPropagation();onSelect({
        kind:"department",name:department.name,
        detail:groupWorkers.length+" trabajadores IA registrados."
      });}}>
       <icosahedronGeometry args={[.48,1]}/>
       <meshStandardMaterial color="#ae9cdb" emissive="#655195" emissiveIntensity={.3} roughness={.4} metalness={.2}/>
      </mesh>
      <SceneLabel text={department.name} kind="department" position={[x,.42,z]}/>
      {groupWorkers.map((worker,j)=>{
       const scatter=(j-(groupWorkers.length-1)/2)*.62;
       const point:[number,number,number]=[x+scatter,-1.5,z+(.65+j*.2)];
       return <group key={worker.id}>
        <Connection from={[x,-.35,z]} to={point}/>
        <WorkerDot worker={worker} position={point} onSelect={onSelect}/>
       </group>;
      })}
    </group>;
  })}
 </group>;
}
function Stage({companyName,departments,workers,angle,onSelect}:{
 companyName:string;departments:Department[];workers:Worker[];angle:number;onSelect:(s:Selected)=>void;
}){
 return <>
  <color attach="background" args={["#191727"]}/>
  <ambientLight intensity={.85}/>
  <pointLight position={[4,6,5]} intensity={35} color="#cfb8ff" distance={26}/>
  <pointLight position={[-4,1,-4]} intensity={22} color="#76d5ec" distance={22}/>
  <mesh position={[0,-2.6,0]} rotation={[-Math.PI/2,0,0]}>
   <circleGeometry args={[7.3,64]}/>
   <meshBasicMaterial color="#29263c" transparent opacity={.35}/>
  </mesh>
  <gridHelper args={[15,15,"#383257","#272538"]} position={[0,-2.54,0]}/>
  <EliotCore onSelect={onSelect}/>
  <Hierarchy companyName={companyName} departments={departments} workers={workers} angle={angle} onSelect={onSelect}/>
 </>
}
export function Eliot3DOrg({companyName,departments,workers}:Props){
 const [enabled,setEnabled]=useState(false);
 const [supported,setSupported]=useState<boolean|null>(null);
 const [angle,setAngle]=useState(.3);
 const [selected,setSelected]=useState<Selected|null>(null);
 function openScene(){
   if(enabled){setEnabled(false);return;}
   const canvas=document.createElement("canvas");
   let available=false;
   try{available=Boolean(canvas.getContext("webgl2")||canvas.getContext("webgl"));}catch{available=false}
   setSupported(available);
   if(available){setEnabled(true);setSelected(null);}
 }
 return <section className="eliot-3d-section">
  <div className="eliot-3d-head">
   <div><span className="ai-overline">PROTOTIPO TRIDIMENSIONAL</span><h2>Centro de mando 3D</h2>
    <p>Representa la jerarquía auténtica de {companyName}, no actividad simulada.</p></div>
   <button className="button-outline" type="button" onClick={openScene}>{enabled?"Cerrar vista 3D":"Activar vista 3D"}</button>
  </div>
  {supported===false&&<p role="alert">Este navegador no dispone de WebGL. Puedes continuar utilizando el organigrama 2D.</p>}
  {enabled&&supported&&<div className="eliot-3d-layout">
   <div className="eliot-3d-view" role="group" aria-label={"Organigrama tridimensional interactivo de "+companyName}>
     <Canvas camera={{position:[0,6.2,15.5],fov:49,near:.1,far:70}} gl={{antialias:true,alpha:false}} dpr={[1,1.5]}>
      <Stage companyName={companyName} departments={departments} workers={workers} angle={angle} onSelect={setSelected}/>
     </Canvas>
   </div>
   <aside className="eliot-3d-inspector">
    <h3>{selected?selected.name:"Explorar estructura"}</h3>
    <p>{selected?selected.detail:"Haz clic en Freddy, un departamento o un trabajador para consultar sus datos."}</p>
    <label>Girar la estructura
     <input type="range" min="-3.14" max="3.14" step=".01" value={angle} onChange={e=>setAngle(Number(e.target.value))}/>
    </label>
    <button type="button" className="eliot-3d-reset" onClick={()=>{setAngle(.3);setSelected(null)}}>Restablecer vista</button>
    <div className="eliot-3d-legend"><span>◆ Freddy — supervisión global</span><span>◆ Empresa — {companyName}</span><span>◆ Departamento</span><span>● Trabajador — estado real</span></div>
    <div className="eliot-3d-tree">
     <strong>Explorar departamentos ({departments.length})</strong>
     {departments.map(d=><div className="eliot-3d-tree-dept" key={d.id}>
       <button type="button" onClick={()=>setSelected({kind:"department",name:d.name,detail:workers.filter(w=>w.department_id===d.id).length+" trabajadores IA registrados."})}>{d.name}</button>
       {workers.filter(w=>w.department_id===d.id).map(w=><button type="button" key={w.id} className="eliot-3d-tree-worker" onClick={()=>setSelected({kind:"worker",name:w.name,detail:w.specialty+" · Estado real: "+w.state})}>{w.name} <small>{w.state==="inactive"?"Inactivo":w.state}</small></button>)}
     </div>)}
    </div>
    <p>Los trabajadores inactivos aparecen en gris. Las líneas muestran pertenencia jerárquica, no comunicaciones reales.</p>
    <p>Sin ejecución automática, mensajería entre agentes ni actividad ficticia.</p>
   </aside>
  </div>}
  {!enabled&&<p className="eliot-3d-note">Esta es una vista opcional. El organigrama 2D permanece disponible en la misma pantalla.</p>}
 </section>;
}

import {describe,expect,it} from "vitest";
import {agentStatus,buildAgents,departmentCopy,deskSlot,filterAgents,phaseProgress,roomLayout,timeAgo,validMemory,validRequestAck,validTaskRequests,workingCount,MEMORY_KEYS,MEMORY_LABEL,ROOM_W,ROOM_D} from "../src/office/officeModel";
import type {OverviewWorker} from "../src/office/officeModel";
import {validOffice} from "../src/OperationsOffice";
import {MOCK_ORG,mockOverview} from "../src/dev/officeMock";

const dep={id:"d1",name:"Marketing"};
const w=(over:Partial<OverviewWorker>={}):OverviewWorker=>({id:"w1",department_id:"d1",name:"Estratega",specialty:"Campañas",recorded_state:"idle",phase:"available",assigned_tasks_in_sample:0,animation_until:null,job_id:null,task_id:null,task_title:null,...over});

describe("estado del agente y progreso por fase real",()=>{
 it("mapea las fases del trabajo al progreso acordado",()=>{
  expect(phaseProgress("queued")).toBe(20);expect(phaseProgress("preparing")).toBe(40);expect(phaseProgress("reading")).toBe(60);
  expect(phaseProgress("analyzing")).toBe(80);expect(phaseProgress("awaiting_review")).toBe(100);expect(phaseProgress("available")).toBe(0);expect(phaseProgress("inventada")).toBe(0);
 });
 it.each([["queued","working"],["preparing","working"],["reading","working"],["analyzing","working"],["awaiting_review","waiting"],["attention","waiting"],["blocked","waiting"],["available","available"],["unconfirmed","available"],["inactive","inactive"]])("fase %s → %s",(phase,status)=>{
  expect(agentStatus({phase,recorded_state:"idle"})).toBe(status);
 });
 it("inactivo prevalece y las tareas abiertas ponen al agente en espera",()=>{
  expect(agentStatus({phase:"analyzing",recorded_state:"inactive"})).toBe("inactive");
  expect(agentStatus({phase:"available",recorded_state:"idle"},1)).toBe("waiting");
 });
 it("no inventa actividad: un agente disponible sin tareas queda listo y con progreso 0",()=>{
  const [a]=buildAgents([w()],[dep],[],[]);
  expect(a).toMatchObject({status:"available",progress:0,headline:"Listo para su próxima tarea",activity:"Sin tarea en curso",lastAssignedAt:null,motionActive:false,departmentName:"Marketing"});
  expect(workingCount([a])).toBe(0);
 });
 it("usa el título real de la tarea y el paso de la fase en curso",()=>{
  const [a]=buildAgents([w({phase:"reading",task_title:"Campaña de invierno",job_id:"j",task_id:"t"})],[dep],[],[]);
  expect(a).toMatchObject({status:"working",progress:60,headline:"Campaña de invierno",step:"Fuente verificada"});
  expect(workingCount([a])).toBe(1);
 });
 it("muestra el encargo pendiente y su fecha; si el agente está inactivo lo advierte",()=>{
  const req={task_id:"t9",worker_id:"w1",department_id:"d1",title:"Ideas de campaña",request:"x".repeat(20),deliverable:null,task_status:"pending",created_at:"2026-11-17T10:00:00Z"};
  const [a]=buildAgents([w()],[dep],[],[req]);
  expect(a).toMatchObject({status:"available",headline:"Ideas de campaña",step:"Encargo pendiente de iniciar",lastAssignedAt:"2026-11-17T10:00:00Z"});
  const [b]=buildAgents([w({recorded_state:"inactive",phase:"inactive"})],[dep],[],[req]);
  expect(b).toMatchObject({status:"inactive",step:"Pendiente hasta que actives al agente"});
 });
 it("la última tarea asignada sale de /tasks",()=>{
  const tasks=[{id:"t1",department_id:"d1",assignee_worker_id:"w1",title:"A",status:"completed",created_at:"2026-11-10T10:00:00Z"},{id:"t2",department_id:"d1",assignee_worker_id:"w1",title:"B",status:"pending",created_at:"2026-11-12T10:00:00Z"}];
  const [a]=buildAgents([w()],[dep],tasks,[]);
  expect(a.status).toBe("waiting");expect(a.headline).toBe("B");expect(a.lastAssignedAt).toBe("2026-11-12T10:00:00Z");
 });
});

describe("filtros y búsqueda del equipo",()=>{
 const agents=buildAgents([w({id:"a",name:"Programador web",phase:"analyzing",task_title:"T",job_id:"j",task_id:"t"}),w({id:"b",name:"Revisor",specialty:"Revisión de código"}),w({id:"c",name:"Asistente",recorded_state:"inactive",phase:"inactive"}),w({id:"d",name:"Redactor",phase:"awaiting_review"})],[dep],[],[]);
 it("filtra por Activos, En espera e Inactivos",()=>{
  expect(filterAgents(agents,"all","").map(a=>a.id)).toEqual(["a","b","c","d"]);
  expect(filterAgents(agents,"active","").map(a=>a.id)).toEqual(["a"]);
  expect(filterAgents(agents,"waiting","").map(a=>a.id)).toEqual(["d"]);
  expect(filterAgents(agents,"inactive","").map(a=>a.id)).toEqual(["c"]);
 });
 it("busca sin distinguir mayúsculas ni tildes en nombre, especialidad y departamento",()=>{
  expect(filterAgents(agents,"all","REVISION").map(a=>a.id)).toEqual(["b"]);
  expect(filterAgents(agents,"all","marketing")).toHaveLength(4);
  expect(filterAgents(agents,"active","revisor")).toHaveLength(0);
 });
});

describe("tiempo relativo",()=>{
 const now=Date.parse("2026-11-17T12:00:00Z");
 it.each([["2026-11-17T11:59:40Z","hace un momento"],["2026-11-17T11:59:00Z","hace 1 minuto"],["2026-11-17T11:15:00Z","hace 45 minutos"],["2026-11-17T09:00:00Z","hace 3 horas"],["2026-11-15T12:00:00Z","hace 2 días"]])("%s → %s",(iso,text)=>{expect(timeAgo(iso,now)).toBe(text);});
 it("sin fecha no inventa nada",()=>{expect(timeAgo(null,now)).toBeNull();expect(timeAgo("no",now)).toBeNull();});
});

describe("disposición de las salas",()=>{
 const names=["Desarrollo","Dirección IA","Calidad","Operaciones","Marketing","Administración","SEO y Contenidos","Atención y Email","Pedidos"];
 it("pone Dirección primero y usa 3×3 para 9 departamentos",()=>{
  const l=roomLayout(names.map((n,i)=>({id:"d"+i,name:n})));
  expect(l.rooms[0]).toMatchObject({name:"Dirección IA",direction:true,departmentId:"d1"});expect(l.cols).toBe(3);expect(l.rows).toBe(3);expect(l.rooms).toHaveLength(9);
 });
 it("crea una sala de Dirección si la empresa no tiene ese departamento y pasa a 4 columnas con 11",()=>{
  const l=roomLayout(Array.from({length:10},(_,i)=>({id:"x"+i,name:"Dep "+i})));
  expect(l.rooms[0]).toMatchObject({name:"Dirección",departmentId:null,direction:true});expect(l.rooms).toHaveLength(11);expect(l.cols).toBe(4);expect(l.rows).toBe(3);
 });
 it("los puestos quedan dentro de la sala y no se solapan",()=>{
  const room=roomLayout([{id:"a",name:"Marketing"}]).rooms[1];
  for(const total of [1,2,4,6]){const pts=Array.from({length:total},(_,i)=>deskSlot(room,i,total));
   expect(new Set(pts.map(p=>p.join(","))).size).toBe(total);
   for(const [x,,z] of pts){expect(Math.abs(x-room.x)).toBeLessThan(ROOM_W/2-.8);expect(Math.abs(z-room.z)).toBeLessThan(ROOM_D/2-.4);}}
 });
});

describe("textos por departamento",()=>{
 it.each(["SEO y Contenidos","Pedidos","Monitorización y Fallos","Atención y Email","Automatizaciones","Marketing","Desarrollo","Calidad","Operaciones","Administración","Dirección IA"])("%s tiene ejemplo y entrega propios",name=>{
  const c=departmentCopy(name);expect(c.example.length).toBeGreaterThanOrEqual(10);expect(c.example.length).toBeLessThanOrEqual(2000);expect(c.receive).not.toBe(departmentCopy("Otro").receive);
 });
});

describe("validación estricta de respuestas nuevas",()=>{
 it("memoria: seis claves en orden, sin duplicados y con contenido ≤ 2000",()=>{
  const ok={enabled:true,keys:[...MEMORY_KEYS],items:[{key:"pricing",content:"10 €",updated_at:"2026-11-10T10:00:00Z"}]};
  expect(validMemory(ok)).toBe(true);
  expect(validMemory({...ok,keys:[...MEMORY_KEYS].reverse()})).toBe(false);
  expect(validMemory({...ok,items:[ok.items[0],ok.items[0]]})).toBe(false);
  expect(validMemory({...ok,items:[{key:"secreto",content:"",updated_at:null}]})).toBe(false);
  expect(validMemory({...ok,items:[{key:"faq",content:"x".repeat(2001),updated_at:null}]})).toBe(false);
  expect(Object.values(MEMORY_LABEL)).toEqual(["A quién vendo","Mis precios","Propuesta de valor","Tono de marca","Productos y servicios","Preguntas frecuentes"]);
 });
 it("encargos y acuse de creación",()=>{
  const r={task_id:"t",worker_id:"w",department_id:"d",title:"T",request:"Hacer algo útil",deliverable:null,task_status:"pending",created_at:"2026-11-17T10:00:00Z"};
  expect(validTaskRequests({enabled:true,requests:[r]})).toBe(true);
  expect(validTaskRequests({enabled:true,requests:[{...r,created_at:"ayer"}]})).toBe(false);
  expect(validTaskRequests({enabled:true,requests:Array(51).fill(r)})).toBe(false);
  const ack={organization_id:"o",worker_id:"w",task_id:"t",department_id:"d",title:"T",status:"pending",replayed:false,execution_started:false};
  expect(validRequestAck(ack,"o","w")).toBe(true);
  expect(validRequestAck({...ack,execution_started:true},"o","w")).toBe(false);
  expect(validRequestAck({...ack,worker_id:"otro"},"o","w")).toBe(false);
  expect(validRequestAck({...ack,status:"running"},"o","w")).toBe(false);
 });
 it("los datos simulados de la previsualización cumplen el contrato real de office-overview",()=>{
  expect(validOffice(mockOverview(),MOCK_ORG)).toBe(true);
 });
});

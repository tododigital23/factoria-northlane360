/**
 * Modelo puro de la Oficina: estados de agente, progreso por fase real, filtros,
 * disposición de salas y textos por departamento. Sin efectos ni datos inventados:
 * todo sale de office-overview, /tasks y /task-requests.
 */
import {assignCast} from "./people";
export type Phase="available"|"inactive"|"blocked"|"unconfirmed"|"queued"|"preparing"|"reading"|"analyzing"|"awaiting_review"|"attention";
export type OverviewWorker={id:string;department_id:string;name:string;specialty:string;recorded_state:string;phase:string;assigned_tasks_in_sample:number;animation_until:string|null;job_id:string|null;task_id:string|null;task_title:string|null};
export type OfficeDepartment={id:string;name:string};
export type OfficeTask={id:string;department_id:string;assignee_worker_id:string|null;title:string;status:string;created_at:string};
export type TaskRequest={task_id:string;worker_id:string;department_id:string;title:string;request:string;deliverable:string|null;task_status:string;created_at:string};

/** Estado visible del agente, como en la lista «Tu equipo». */
export type AgentStatus="working"|"waiting"|"available"|"inactive";
export const STATUS_LABEL:Record<AgentStatus,string>={working:"Trabajando",waiting:"En espera",available:"Disponible",inactive:"Inactivo"};

const WORKING_PHASES=new Set(["queued","preparing","reading","analyzing"]);
const WAITING_PHASES=new Set(["awaiting_review","attention","blocked"]);
const OPEN_TASK=new Set(["pending","queued","running","blocked"]);

/** Progreso según la fase REAL del trabajo documental (queued→claimed→source_verified→provider_started→completado). */
export const PHASE_PROGRESS:Record<string,number>={queued:20,preparing:40,reading:60,analyzing:80,awaiting_review:100};
export const PHASE_STEP:Record<string,string>={
 queued:"Trabajo en cola",preparing:"Preparando el documento",reading:"Fuente verificada",analyzing:"Análisis en curso",
 awaiting_review:"Informe listo · pendiente de tu revisión",attention:"Requiere tu atención",blocked:"Bloqueado",unconfirmed:"Sin ejecución confirmada",
 available:"Sin tarea en curso",inactive:"Agente inactivo"};

export function phaseProgress(phase:string):number{return PHASE_PROGRESS[phase]??0;}

export function agentStatus(w:Pick<OverviewWorker,"phase"|"recorded_state">,openTasks=0):AgentStatus{
 if(w.recorded_state==="inactive"||w.phase==="inactive")return "inactive";
 if(WORKING_PHASES.has(w.phase))return "working";
 if(WAITING_PHASES.has(w.phase)||openTasks>0)return "waiting";
 return "available";
}

/** Tareas abiertas (pendientes, en cola, en curso o bloqueadas) asignadas a cada agente. */
export function openTasksByWorker(tasks:OfficeTask[]):Map<string,OfficeTask[]>{
 const m=new Map<string,OfficeTask[]>();
 for(const t of tasks){if(!t.assignee_worker_id||!OPEN_TASK.has(t.status))continue;const l=m.get(t.assignee_worker_id)??[];l.push(t);m.set(t.assignee_worker_id,l);}
 for(const l of m.values())l.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
 return m;
}
/** Última tarea registrada del agente (cualquiera), para «Tarea asignada hace X». */
export function lastTaskByWorker(tasks:OfficeTask[],requests:TaskRequest[]):Map<string,{title:string;created_at:string}>{
 const m=new Map<string,{title:string;created_at:string}>();
 const all=[...tasks.filter(t=>t.assignee_worker_id).map(t=>({w:t.assignee_worker_id as string,title:t.title,created_at:t.created_at})),...requests.map(r=>({w:r.worker_id,title:r.title,created_at:r.created_at}))];
 for(const x of all){if(!Number.isFinite(Date.parse(x.created_at)))continue;const prev=m.get(x.w);if(!prev||Date.parse(x.created_at)>Date.parse(prev.created_at))m.set(x.w,{title:x.title,created_at:x.created_at});}
 return m;
}

/** Algo de ese agente que espera al propietario: una tarea bloqueada, un informe por revisar o un aviso de atención. */
export type Need={id:string;title:string;kind:"blocked"|"review"|"attention"};
export const NEED_LABEL:Record<Need["kind"],string>={blocked:"Bloqueada: no puede seguir sin ti",review:"Informe listo para que lo revises",attention:"Necesita tu atención"};
/** Departamento que la empresa todavía no tiene (capacidad sin elegir): se enseña como agente «por crear». */
export type GhostSeat={capability:string;department:string;label:string};
export const GHOST="ghost:";
export const isGhostId=(id:string)=>id.startsWith(GHOST);
export function ghostDepartments(ghosts:GhostSeat[]):OfficeDepartment[]{return ghosts.map(g=>({id:GHOST+g.capability,name:g.department}));}
export function ghostAgents(ghosts:GhostSeat[]):Agent[]{
 return ghosts.map(g=>({id:GHOST+g.capability,name:"Agente de "+g.label,specialty:"Por crear",departmentId:GHOST+g.capability,departmentName:g.department,status:"inactive" as AgentStatus,phase:"inactive",progress:0,
  headline:"Agente por crear",step:"Añade «"+g.label+"» a la empresa y este agente empezará a trabajar",activity:"Por crear",lastAssignedAt:null,motionActive:false,needs:[],ghost:true}));
}
export const realAgents=(agents:Agent[])=>agents.filter(a=>!a.ghost);
/** Todo lo que espera al propietario en la oficina, agente por agente. */
export function inbox(agents:Agent[]):{agent:Agent;need:Need}[]{return realAgents(agents).flatMap(a=>a.needs.map(need=>({agent:a,need})));}
export const needsCount=(agents:Agent[])=>realAgents(agents).filter(a=>a.needs.length>0).length;
export function greeting(hour:number){return hour<6?"Buenas noches":hour<13?"Buenos días":hour<21?"Buenas tardes":"Buenas noches";}

export type Agent={id:string;name:string;/** Nombre de pila con el que se le conoce en la oficina (el «name» es su puesto). */ person?:string;specialty:string;departmentId:string;departmentName:string;status:AgentStatus;phase:string;progress:number;
 /** Título grande de la barra inferior. */ headline:string;/** Paso actual (subtítulo). */ step:string;/** Texto corto de la tarjeta flotante. */ activity:string;
 lastAssignedAt:string|null;motionActive:boolean;/** Lo que espera al propietario. */ needs:Need[];ghost?:boolean};

export function buildAgents(workers:OverviewWorker[],departments:OfficeDepartment[],tasks:OfficeTask[],requests:TaskRequest[],motion:(w:OverviewWorker)=>boolean=()=>false):Agent[]{
 const open=openTasksByWorker(tasks),last=lastTaskByWorker(tasks,requests),names=new Map(departments.map(d=>[d.id,d.name]));
 const openRequests=new Map<string,TaskRequest>();
 for(const r of [...requests].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)))if(OPEN_TASK.has(r.task_status)&&!openRequests.has(r.worker_id))openRequests.set(r.worker_id,r);
 const roles=assignCast(workers.map(w=>w.id));
 return workers.map(w=>{
  const mine=open.get(w.id)??[],status=agentStatus(w,mine.length),req=openRequests.get(w.id);
  let headline:string,step:string,activity:string;
  if(status==="working"){headline=w.task_title??"Trabajo en curso";step=PHASE_STEP[w.phase];activity=PHASE_STEP[w.phase];}
  else if(WAITING_PHASES.has(w.phase)){headline=w.task_title??PHASE_STEP[w.phase];step=PHASE_STEP[w.phase];activity=PHASE_STEP[w.phase];}
  else if(req||mine.length){headline=req?.title??mine[0].title;step=status==="inactive"?"Pendiente hasta que actives al agente":"Encargo pendiente de iniciar";activity=status==="inactive"?"Inactivo · encargo pendiente":"Encargo pendiente";}
  else if(status==="inactive"){headline="Agente inactivo";step="Actívalo desde Trabajadores IA para que reciba trabajo";activity="Inactivo";}
  else {headline="Listo para su próxima tarea";step="Puedes pedirle una tarea cuando quieras";activity="Sin tarea en curso";}
  const needs:Need[]=mine.filter(x=>x.status==="blocked").map(x=>({id:x.id,title:x.title,kind:"blocked" as const}));
  if((w.phase==="awaiting_review"||w.phase==="attention")&&!needs.some(n=>n.id===w.task_id))needs.unshift({id:w.task_id??w.id+":"+w.phase,title:w.task_title??PHASE_STEP[w.phase],kind:w.phase==="awaiting_review"?"review":"attention"});
  else if(w.phase==="blocked"&&!needs.length)needs.push({id:w.task_id??w.id+":blocked",title:w.task_title??PHASE_STEP.blocked,kind:"blocked"});
  return {id:w.id,name:w.name,person:roles.get(w.id)?.name,specialty:w.specialty,departmentId:w.department_id,departmentName:names.get(w.department_id)??"Departamento",status,phase:w.phase,
   progress:status==="working"||WAITING_PHASES.has(w.phase)?phaseProgress(w.phase):0,headline,step,activity,lastAssignedAt:last.get(w.id)?.created_at??null,motionActive:motion(w),needs};
 });
}

export const workingCount=(agents:Agent[])=>agents.filter(a=>a.status==="working").length;

export type TeamFilter="all"|"active"|"waiting"|"inactive";
export const FILTER_LABEL:Record<TeamFilter,string>={all:"Todos",active:"Activos",waiting:"En espera",inactive:"Inactivos"};
const fold=(s:string)=>s.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().trim();
export function filterAgents(agents:Agent[],filter:TeamFilter,query:string):Agent[]{
 const q=fold(query);
 return agents.filter(a=>!a.ghost&&(filter==="all"||(filter==="active"&&a.status==="working")||(filter==="waiting"&&a.status==="waiting")||(filter==="inactive"&&a.status==="inactive"))
  &&(!q||fold(a.name).includes(q)||fold(a.person??"").includes(q)||fold(a.specialty).includes(q)||fold(a.departmentName).includes(q)));
}

/** «hace X» en castellano a partir de una fecha ISO y el instante actual. */
export function timeAgo(iso:string|null,now=Date.now()):string|null{
 if(!iso)return null;const t=Date.parse(iso);if(!Number.isFinite(t))return null;
 const s=Math.max(0,Math.round((now-t)/1000));
 if(s<60)return "hace un momento";const m=Math.round(s/60);if(m<60)return m===1?"hace 1 minuto":`hace ${m} minutos`;
 const h=Math.round(m/60);if(h<24)return h===1?"hace 1 hora":`hace ${h} horas`;const d=Math.round(h/24);return d===1?"hace 1 día":`hace ${d} días`;
}

/* ---------- Salas ---------- */
export const ROOM_W=10,ROOM_D=7.2,CORRIDOR=2.2;
export type RoomLayout={key:string;departmentId:string|null;name:string;direction:boolean;/** Sala de Descanso: sin departamento; ahí va todo el equipo en modo descanso. */ lounge?:boolean;/** Oficina de Empleo. */ jobs?:boolean;x:number;z:number;col:number;row:number};
export const LOUNGE_KEY="descanso",LOUNGE_NAME="Sala de Descanso";
/** Oficina de Empleo: donde esperan los agentes inactivos hasta que el propietario los activa. */
export const JOBS_KEY="empleo",JOBS_NAME="Oficina de Empleo";
export const isDirection=(name:string)=>/^direcci[oó]n/i.test(name.trim());
/** Cuadrícula de salas: Dirección primero (arriba a la izquierda), luego los departamentos reales. */
export function roomLayout(departments:OfficeDepartment[],lounge=false):{rooms:RoomLayout[];cols:number;rows:number;width:number;depth:number}{
 const dir=departments.find(d=>isDirection(d.name));
 const list:{key:string;departmentId:string|null;name:string;direction:boolean;lounge?:boolean;jobs?:boolean}[]=[dir?{key:dir.id,departmentId:dir.id,name:dir.name,direction:true}:{key:"direccion",departmentId:null,name:"Dirección",direction:true},
  ...departments.filter(d=>d!==dir).map(d=>({key:d.id,departmentId:d.id,name:d.name,direction:false})),
  ...(lounge?[{key:LOUNGE_KEY,departmentId:null,name:LOUNGE_NAME,direction:false,lounge:true},{key:JOBS_KEY,departmentId:null,name:JOBS_NAME,direction:false,jobs:true}]:[])];
 const n=list.length,cols=n<=4?2:n<=9?3:4,rows=Math.ceil(n/cols);
 const width=cols*ROOM_W+(cols-1)*CORRIDOR,depth=rows*ROOM_D+(rows-1)*CORRIDOR;
 return {cols,rows,width,depth,rooms:list.map((r,i)=>{const col=i%cols,row=Math.floor(i/cols);return {...r,col,row,x:-width/2+ROOM_W/2+col*(ROOM_W+CORRIDOR),z:-depth/2+ROOM_D/2+row*(ROOM_D+CORRIDOR)};})};
}
/** Puestos de una sala (máx. 6, dos filas). En Dirección quedan libres la mesa grande, el propietario y Freddy. */
export const MAX_DESKS=6;
const ORDER2:[number,number][]=[[0,0],[1,1],[1,0],[0,1]],ORDER3:[number,number][]=[[0,0],[2,0],[1,1],[1,0],[0,1],[2,1]];
export function deskSlot(room:RoomLayout,index:number,total:number):[number,number,number]{
 if(room.direction)return [room.x+3.1,0,room.z-1.1+(index%2)*2.7];
 const three=total>4,[col,row]=(three?ORDER3:ORDER2)[index%(three?6:4)];
 return [room.x+(three?(col-1)*3.1:(col-.5)*4.2),0,room.z-1.1+row*2.7];
}

/** Sitio de cada agente en la pista de la Sala de Descanso (filas de 5, centradas). */
export function loungeSpot(room:{x:number;z:number},index:number,total:number):[number,number,number]{
 const per=5,row=Math.floor(index/per),inRow=Math.min(per,total-row*per),col=index%per,rows=Math.ceil(Math.max(1,total)/per);
 return [room.x+(col-(inRow-1)/2)*1.5+(row%2?.35:0),0,room.z+.7+(row-(rows-1)/2)*1.25];
}
/** Qué hace cada agente inactivo en la Oficina de Empleo y dónde: unos hacen cola, otros esperan sentados y otros pasean. */
export type JobsSpot={mode:"queue"|"seat"|"walk";at:[number,number,number];to?:[number,number,number];yaw:number};
export function jobsSpot(room:{x:number;z:number},index:number):JobsSpot{
 const k=Math.floor(index/3),mode=(["queue","seat","walk"] as const)[index%3];
 // La cola sale del mostrador (esquina del fondo a la izquierda) hacia la entrada; las sillas van contra la pared derecha.
 if(mode==="queue")return {mode,at:[room.x-2.35+(k%5)*1.1,0,room.z-1.15+Math.floor(k/5)*1.1],yaw:-Math.PI/2};
 if(mode==="seat")return {mode,at:[room.x+4.15,0,room.z-2.2+(k%5)*1.05],yaw:-Math.PI/2};
 const lane=room.z+1.5+(k%3)*.8;return {mode,at:[room.x-3.6+(k%2)*.8,0,lane],to:[room.x+2.6-(k%2)*.8,0,lane],yaw:0};
}
/** Estado del modo descanso de una empresa, tal como lo confirma el servidor. */
export type BreakState={organization_id:string;available:boolean;on_break:boolean;since:string|null};
export function validBreak(raw:unknown,org:string):raw is BreakState{
 const o=raw as Record<string,unknown>|null;
 return !!o&&typeof o==="object"&&o.organization_id===org&&typeof o.available==="boolean"&&typeof o.on_break==="boolean"&&(o.since===null||(typeof o.since==="string"&&Number.isFinite(Date.parse(o.since))))&&!(o.on_break&&!o.available);
}

/* ---------- Color de cada sala ---------- */
/** Cada sala tiene su propio suelo y su color de acento, como una maqueta de ciudad a plena luz: se distinguen de un vistazo. */
export const ROOM_TINTS=[{floor:"#f6e7c4",accent:"#e2574c"},{floor:"#dbe8fa",accent:"#3b82f6"},{floor:"#dff2d9",accent:"#22a06b"},{floor:"#f7dfee",accent:"#c2478f"},{floor:"#e9e1fa",accent:"#7c5cd6"},{floor:"#fde6cc",accent:"#f08a24"},{floor:"#d9f1ee",accent:"#12a3a3"},{floor:"#f5efcf",accent:"#b98f12"}];
const GHOST_TINT={floor:"#eceef2",accent:"#b3b9c6"};
export const LOUNGE_TINT={floor:"#3b2f6e",accent:"#c026d3"};
export const JOBS_TINT={floor:"#fdf3c4",accent:"#1f4fa3"};
export function roomTint(room:{key:string;col:number;row:number;direction:boolean}){return room.key===LOUNGE_KEY?LOUNGE_TINT:room.key===JOBS_KEY?JOBS_TINT:room.key.startsWith("ghost:")?GHOST_TINT:room.direction?{floor:"#f3d9d2",accent:"#b3261e"}:ROOM_TINTS[(room.row*3+room.col)%ROOM_TINTS.length];}

/* ---------- Textos por departamento ---------- */
type DeptCopy={match:RegExp;example:string;receive:string;title:string};
const COPY:DeptCopy[]=[
 {match:/seo|contenido/i,title:"Una mejora SEO",example:"Revisa los títulos y descripciones de las 10 páginas con más visitas y propón cambios para mejorar el posicionamiento local.",receive:"Un informe con los cambios propuestos página a página, listo para revisar antes de publicar."},
 {match:/pedido/i,title:"Un control de pedidos",example:"Revisa los pedidos de la última semana que siguen sin enviar y dime cuáles están retrasados y por qué.",receive:"La lista de pedidos afectados con su estado y la acción recomendada para cada uno."},
 {match:/monitori|fallo/i,title:"Una revisión de fallos",example:"Comprueba los errores registrados en la web estas últimas 24 horas y prioriza los que afectan a clientes.",receive:"Un resumen de incidencias ordenado por gravedad, con la causa probable y el siguiente paso."},
 {match:/atenci|email|correo/i,title:"Una respuesta a clientes",example:"Prepara respuestas para los correos de clientes sin contestar sobre plazos de entrega, con un tono cercano.",receive:"Borradores de respuesta listos para revisar; nada se envía sin tu aprobación."},
 {match:/automatiza/i,title:"Una automatización",example:"Diseña una automatización para que cuando entre un pedido nuevo se avise al equipo y se registre en la hoja de seguimiento.",receive:"El flujo propuesto paso a paso, listo para revisar antes de activarlo."},
 {match:/marketing|comercial|venta/i,title:"Una acción de marketing",example:"Propón tres ideas de campaña para el próximo mes dirigidas a clientes que no compran desde hace 90 días.",receive:"Las propuestas con público, mensaje y canal, listas para que elijas una."},
 {match:/desarroll|program|c[oó]digo/i,title:"Un cambio en el código",example:"Revisa el repositorio y explica qué haría falta para añadir un formulario de contacto en la página de inicio.",receive:"Un análisis del repositorio con los archivos implicados y los pasos propuestos."},
 {match:/calidad|qa|prueba/i,title:"Una revisión de calidad",example:"Revisa el proceso de compra de la web y enumera los fallos o pasos confusos que encuentres.",receive:"Un informe de calidad con cada problema, su impacto y cómo reproducirlo."},
 {match:/operaci/i,title:"Una mejora operativa",example:"Documenta el proceso actual de devoluciones y propón cómo simplificarlo en menos pasos.",receive:"El proceso documentado y una propuesta de mejora con los cambios necesarios."},
 {match:/administra|finanz|contab/i,title:"Una tarea administrativa",example:"Prepara un resumen de los gastos recurrentes del mes y señala los que podrían reducirse.",receive:"Un resumen ordenado con los importes y las recomendaciones de ahorro."},
 {match:/direcci/i,title:"Una decisión de dirección",example:"Resume el estado de todos los departamentos y propón las tres prioridades para esta semana.",receive:"Un informe de dirección con prioridades, responsables y próximos pasos."},
];
const DEFAULT_COPY={title:"Una tarea nueva",example:"Describe el trabajo que necesitas, para quién es y qué resultado esperas recibir.",receive:"El resultado del trabajo registrado en la tarea, listo para que lo revises."};
export function departmentCopy(departmentName:string){return COPY.find(c=>c.match.test(departmentName))??DEFAULT_COPY;}

/* ---------- Memoria compartida ---------- */
export const MEMORY_KEYS=["audience","pricing","value_proposition","brand_tone","products","faq"] as const;
export type MemoryKey=typeof MEMORY_KEYS[number];
export const MEMORY_LABEL:Record<MemoryKey,string>={audience:"A quién vendo",pricing:"Mis precios",value_proposition:"Propuesta de valor",brand_tone:"Tono de marca",products:"Productos y servicios",faq:"Preguntas frecuentes"};
export const MEMORY_HINT:Record<MemoryKey,string>={audience:"Tu cliente ideal: quién es, qué necesita y dónde está.",pricing:"Tarifas, planes, descuentos y condiciones.",value_proposition:"Por qué te eligen frente a otros.",brand_tone:"Cómo habla tu marca: cercano, formal, técnico…",products:"Qué vendes y qué incluye cada producto o servicio.",faq:"Las preguntas que más te hacen y sus respuestas."};

/* ---------- Validación de las respuestas nuevas ---------- */
const isObj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const str=(v:unknown)=>typeof v==="string";
const date=(v:unknown)=>typeof v==="string"&&Number.isFinite(Date.parse(v));
export function validTaskRequests(raw:unknown):raw is {enabled:boolean;requests:TaskRequest[]}{
 if(!isObj(raw)||typeof raw.enabled!=="boolean"||!Array.isArray(raw.requests)||raw.requests.length>50)return false;
 return raw.requests.every(r=>isObj(r)&&str(r.task_id)&&str(r.worker_id)&&str(r.department_id)&&str(r.title)&&str(r.request)&&(r.deliverable===null||str(r.deliverable))&&str(r.task_status)&&date(r.created_at));
}
export type MemoryItem={key:MemoryKey;content:string;updated_at:string|null};
export function validMemory(raw:unknown):raw is {enabled:boolean;items:MemoryItem[];keys:MemoryKey[]}{
 if(!isObj(raw)||typeof raw.enabled!=="boolean"||!Array.isArray(raw.items)||!Array.isArray(raw.keys))return false;
 if(raw.keys.length!==MEMORY_KEYS.length||!raw.keys.every((k,i)=>k===MEMORY_KEYS[i]))return false;
 const seen=new Set<string>();
 return raw.items.every(i=>{if(!isObj(i)||!(MEMORY_KEYS as readonly string[]).includes(i.key as string)||seen.has(i.key as string)||!str(i.content)||(i.content as string).length>2000||!(i.updated_at===null||date(i.updated_at)))return false;seen.add(i.key as string);return true;});
}
export type RequestAck={
 organization_id:string;worker_id:string;task_id:string;department_id:string;title:string;status:"pending";
 replayed:boolean;execution_started:boolean;
 run_status?:string|null;run_id?:string|null;auto_reason?:string|null;
};
export function validRequestAck(raw:unknown,org:string,worker:string):raw is RequestAck{
 return isObj(raw)&&raw.organization_id===org&&raw.worker_id===worker&&str(raw.task_id)&&str(raw.department_id)&&str(raw.title)
  &&raw.status==="pending"&&typeof raw.replayed==="boolean"&&typeof raw.execution_started==="boolean"
  &&(raw.run_status===undefined||raw.run_status===null||typeof raw.run_status==="string")
  &&(raw.run_id===undefined||raw.run_id===null||typeof raw.run_id==="string")
  &&(raw.auto_reason===undefined||raw.auto_reason===null||typeof raw.auto_reason==="string");
}

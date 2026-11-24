/**
 * Gestión de una empresa del holding (actualización 034): perfil, capacidades,
 * tareas recurrentes y mensajes entre agentes. Tipos y validadores puros.
 */
import {API_ROOT,CAPABILITIES,REPOSITORY_PATTERN,chars,validWebsite} from "./holdingApi";
import type {Capability} from "./holdingApi";

export const orgUrl=(org:string)=>API_ROOT+"/v1/me/organizations/"+encodeURIComponent(org);
export const urls={
 profile:(o:string)=>orgUrl(o)+"/profile",
 name:(o:string)=>orgUrl(o)+"/name",
 retire:(o:string)=>orgUrl(o)+"/retire",
 capability:(o:string,c:Capability)=>orgUrl(o)+"/capabilities/"+encodeURIComponent(c),
 routines:(o:string)=>orgUrl(o)+"/routines",
 routineControl:(o:string,id:string)=>orgUrl(o)+"/routines/"+encodeURIComponent(id)+"/control",
 runDue:(o:string)=>orgUrl(o)+"/routines/run-due",
 messages:(o:string)=>orgUrl(o)+"/agent-messages",
 departments:(o:string)=>orgUrl(o)+"/departments",
 workers:(o:string)=>orgUrl(o)+"/workers"
};
const obj=(v:unknown):v is Record<string,unknown>=>typeof v==="object"&&v!==null&&!Array.isArray(v);
const str=(v:unknown,min=1,max=10_000)=>typeof v==="string"&&chars(v)>=min&&chars(v)<=max;
const count=(v:unknown)=>Number.isInteger(v)&&(v as number)>=0&&(v as number)<=1_000_000;
const date=(v:unknown)=>typeof v==="string"&&Number.isFinite(Date.parse(v));
const isCap=(v:unknown):v is Capability=>(CAPABILITIES as readonly unknown[]).includes(v);

/* ---------- Perfil ---------- */
export type ProfileDraft={project_name:string;project_summary:string;repository:string;website_url:string};
export type ProfilePayload={project_name:string;project_summary:string;repository:string|null;website_url:string|null};
export function validateProfile(d:ProfileDraft):Partial<Record<keyof ProfileDraft,string>>{
 const e:Partial<Record<keyof ProfileDraft,string>>={};const n=chars(d.project_name.trim()),s=chars(d.project_summary.trim());
 if(n<2||n>120)e.project_name="El nombre del proyecto debe tener entre 2 y 120 caracteres.";
 if(s<10||s>600)e.project_summary="El resumen debe tener entre 10 y 600 caracteres.";
 if(d.repository.trim()&&!REPOSITORY_PATTERN.test(d.repository.trim()))e.repository="Usa el formato propietario/repositorio, por ejemplo nova/web.";
 if(d.website_url.trim()&&!validWebsite(d.website_url.trim()))e.website_url="Indica una dirección completa que empiece por https://";
 return e;
}
export const profilePayload=(d:ProfileDraft):ProfilePayload=>({project_name:d.project_name.trim(),project_summary:d.project_summary.trim(),repository:d.repository.trim()||null,website_url:d.website_url.trim()||null});
export const validProfileAck=(raw:unknown,org:string)=>obj(raw)&&raw.organization_id===org&&raw.updated===true;

/* ---------- Retirar la empresa (038) ---------- */
export const retirePayload=(name:string)=>({confirm_name:name.trim()});
export type RetireAck={organization_id:string;name:string;slot:number;retired:true;routines_paused:number};
export function validRetireAck(raw:unknown,org:string):raw is RetireAck{
 return obj(raw)&&raw.organization_id===org&&raw.retired===true&&typeof raw.name==="string"&&Number.isInteger(raw.slot)&&Number.isInteger(raw.routines_paused);
}

/* ---------- Nombre de la empresa (036) ---------- */
export function validateCompanyName(name:string):string|null{
 const n=name.trim();
 if(chars(n)<2||chars(n)>120)return "Entre 2 y 120 caracteres.";
 if(/[\u0000-\u001f\u007f]/.test(n))return "No puede contener saltos de línea ni caracteres de control.";
 return null;
}
export const companyNamePayload=(name:string)=>({name:name.trim()});
export function validRenameAck(raw:unknown,org:string,name:string):raw is {organization_id:string;name:string;renamed:boolean}{
 return obj(raw)&&raw.organization_id===org&&raw.name===name.trim()&&typeof raw.renamed==="boolean";
}

/* ---------- Capacidades ---------- */
export type CapabilityChange="planned"|"disabled";
export type CapabilityAck={organization_id:string;capability:Capability;state:CapabilityChange;departments_created:number;connector_enabled:false};
export function validCapabilityAck(raw:unknown,org:string,cap:Capability,state:CapabilityChange):raw is CapabilityAck{
 return obj(raw)&&raw.organization_id===org&&raw.capability===cap&&raw.state===state&&count(raw.departments_created)&&(raw.departments_created as number)<=1&&raw.connector_enabled===false
  &&(state==="planned"||raw.departments_created===0);
}

/* ---------- Tareas recurrentes ---------- */
export const CADENCES=["daily","weekly","monthly"] as const;
export type Cadence=typeof CADENCES[number];
export const CADENCE_LABEL:Record<Cadence,string>={daily:"Diaria",weekly:"Semanal",monthly:"Mensual"};
export type Routine={id:string;department_id:string;department:string;worker_id:string;worker:string;title:string;instructions:string;cadence:Cadence;capability:Capability|null;state:"active"|"paused";created_at:string;last_period:string|null;runs:number};
export type RoutineList={enabled:boolean;routines:Routine[]};
export function validRoutineList(raw:unknown):raw is RoutineList{
 if(!obj(raw)||typeof raw.enabled!=="boolean"||!Array.isArray(raw.routines)||raw.routines.length>500)return false;
 if(!raw.enabled&&raw.routines.length)return false;
 const ok=raw.routines.every(r=>obj(r)&&str(r.id,1,200)&&str(r.department_id,1,200)&&str(r.department,1,120)&&str(r.worker_id,1,200)&&str(r.worker,1,200)
  &&str(r.title,3,160)&&str(r.instructions,10,2000)&&(CADENCES as readonly unknown[]).includes(r.cadence)&&(r.capability===null||isCap(r.capability))
  &&(r.state==="active"||r.state==="paused")&&date(r.created_at)&&(r.last_period===null||str(r.last_period,1,64))&&count(r.runs));
 return ok&&new Set((raw.routines as Routine[]).map(r=>r.id)).size===raw.routines.length;
}
export type Department={id:string;name:string};
export type Worker={id:string;department_id:string;name:string;state:string};
export function validDepartments(raw:unknown):raw is Department[]{
 return Array.isArray(raw)&&raw.every(d=>obj(d)&&str(d.id,1,200)&&str(d.name,1,200))&&new Set(raw.map(d=>d.id)).size===raw.length;
}
export function validWorkers(raw:unknown,deps:Department[]):raw is Worker[]{
 const ids=new Set(deps.map(d=>d.id));
 return Array.isArray(raw)&&raw.every(w=>obj(w)&&str(w.id,1,200)&&typeof w.department_id==="string"&&ids.has(w.department_id)&&str(w.name,1,200)&&typeof w.state==="string")&&new Set(raw.map(w=>w.id)).size===raw.length;
}
export type RoutineDraft={department_id:string;worker_id:string;title:string;instructions:string;cadence:Cadence;capability:Capability|""};
export const emptyRoutine=():RoutineDraft=>({department_id:"",worker_id:"",title:"",instructions:"",cadence:"weekly",capability:""});
export function validateRoutine(d:RoutineDraft,workers:Worker[]):Partial<Record<keyof RoutineDraft,string>>{
 const e:Partial<Record<keyof RoutineDraft,string>>={};const t=chars(d.title.trim()),i=chars(d.instructions.trim());
 if(!d.department_id)e.department_id="Elige el departamento.";
 const w=workers.find(x=>x.id===d.worker_id);
 if(!w)e.worker_id="Elige el agente responsable.";else if(w.department_id!==d.department_id)e.worker_id="El agente debe pertenecer al departamento elegido.";
 if(t<3||t>160)e.title="El título debe tener entre 3 y 160 caracteres.";
 if(i<10||i>2000)e.instructions="Las instrucciones deben tener entre 10 y 2000 caracteres.";
 if(!(CADENCES as readonly string[]).includes(d.cadence))e.cadence="Frecuencia no válida.";
 if(d.capability!==""&&!isCap(d.capability))e.capability="Capacidad no válida.";
 return e;
}
export type RoutinePayload={department_id:string;worker_id:string;title:string;instructions:string;cadence:Cadence;capability:Capability|null;request_key:string};
export const routinePayload=(d:RoutineDraft,request_key:string):RoutinePayload=>({department_id:d.department_id,worker_id:d.worker_id,title:d.title.trim(),instructions:d.instructions.trim(),cadence:d.cadence,capability:d.capability||null,request_key});
export const validRoutineAck=(raw:unknown,org:string)=>obj(raw)&&raw.organization_id===org&&str(raw.routine_id,1,200)&&raw.execution_started===false;
export const validControlAck=(raw:unknown,org:string,id:string,state:"active"|"paused")=>obj(raw)&&raw.organization_id===org&&raw.routine_id===id&&raw.state===state;
export function validRunDueAck(raw:unknown,org:string):raw is {organization_id:string;tasks_created:number;execution_started:false}{
 return obj(raw)&&raw.organization_id===org&&count(raw.tasks_created)&&raw.execution_started===false;
}
/** Plantillas por nombre de departamento (los creados por la plantilla del holding). */
export const ROUTINE_TEMPLATES:{department:string;title:string;instructions:string;cadence:Cadence;capability:Capability|null}[]=[
 {department:"SEO y Contenidos",title:"Revisión SEO semanal",instructions:"Revisa posiciones, títulos y descripciones de las páginas principales y propone tres mejoras priorizadas.",cadence:"weekly",capability:"seo"},
 {department:"Monitorización y Fallos",title:"Control diario de fallos",instructions:"Revisa los errores y alertas registrados desde el último control y resume los que requieren acción.",cadence:"daily",capability:"monitoring"},
 {department:"Pedidos",title:"Revisión diaria de pedidos pendientes",instructions:"Lista los pedidos cobrados sin completar, los retrasados y los cobros fallidos. Señala los que necesitan intervención humana y propone el siguiente paso con cada referencia.",cadence:"daily",capability:"orders"},
 {department:"Pedidos",title:"Cierre diario de pedidos del día",instructions:"Resume cuántos pedidos se han cobrado hoy, cuántos se han enviado y cuántos quedan abiertos. Propón tres mejoras concretas para mañana.",cadence:"daily",capability:"orders"},
 {department:"Atención y Email",title:"Clasificación diaria del email",instructions:"Clasifica los correos y chats pendientes por urgencia y tema y propone respuestas para los más importantes.",cadence:"daily",capability:"email"},
 {department:"Atención y Email",title:"Seguimiento de chats abiertos",instructions:"Revisa conversaciones o tickets abiertos, marca los que llevan más de un día sin respuesta y propone cierre o escalado.",cadence:"daily",capability:"email"},
 {department:"Monitorización y Fallos",title:"Mejora continua de la tienda",instructions:"A partir de los fallos y avisos del día, propone un cambio pequeño en el proceso (pago, envío o atención) que reduzca repeticiones mañana.",cadence:"daily",capability:"monitoring"},
 {department:"Marketing",title:"Informe semanal de campañas",instructions:"Resume el rendimiento de las campañas activas de la semana y propone ajustes concretos.",cadence:"weekly",capability:"marketing"},
 {department:"Desarrollo",title:"Revisión semanal del repositorio",instructions:"Revisa los cambios de la semana en el repositorio y señala riesgos, deuda técnica y tareas pendientes.",cadence:"weekly",capability:"repository"},
 {department:"Automatizaciones",title:"Revisión semanal de automatizaciones",instructions:"Comprueba qué automatizaciones han fallado o se han quedado sin uso y propone correcciones.",cadence:"weekly",capability:"automation"}
];

/* ---------- Mensajes entre agentes ---------- */
export type AgentMessage={id:string;from_worker_id:string;from_worker:string;to_worker_id:string;to_worker:string;task_id:string|null;body:string;created_at:string};
export type MessageList={organization_id:string;enabled:boolean;messages:AgentMessage[];same_company_only:true};
export function validMessageList(raw:unknown,org:string):raw is MessageList{
 if(!obj(raw)||raw.organization_id!==org||typeof raw.enabled!=="boolean"||raw.same_company_only!==true||!Array.isArray(raw.messages)||raw.messages.length>500)return false;
 if(!raw.enabled&&raw.messages.length)return false;
 const ok=raw.messages.every(m=>obj(m)&&str(m.id,1,200)&&str(m.from_worker_id,1,200)&&str(m.from_worker,1,200)&&str(m.to_worker_id,1,200)&&str(m.to_worker,1,200)
  &&(m.task_id===null||str(m.task_id,1,200))&&typeof m.body==="string"&&chars(m.body)<=20_000&&date(m.created_at));
 return ok&&new Set((raw.messages as AgentMessage[]).map(m=>m.id)).size===raw.messages.length;
}
export const newestFirst=(list:AgentMessage[])=>[...list].sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));

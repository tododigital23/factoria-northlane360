/**
 * Datos simulados SOLO para la previsualización de desarrollo (preview-campus.html?view=office).
 * Empresa de ejemplo con 9 departamentos y 11 agentes; no se importa en el build de producción.
 */
export const MOCK_ORG="0a0a0a0a-1111-4111-8111-000000000001";
const id=(n:number,k="a")=>`${k.repeat(8)}-0000-4000-8000-${String(n).padStart(12,"0")}`;
const depNames=["Dirección IA","Desarrollo","Calidad","Operaciones","Marketing","Administración","SEO y Contenidos","Atención y Email","Pedidos"];
export const mockDepartments=depNames.map((name,i)=>({id:id(i+1,"d"),name}));
type W=[number,string,string,string,string,string|null];
const W:W[]=[
 [0,"Coordinador de dirección","Prioriza el trabajo y resume el estado de cada departamento","idle","available",null],
 [1,"Programador web","Cambios en la web y el repositorio de la tienda","working","analyzing","Revisar el formulario de pedidos"],
 [1,"Revisor de código","Revisa cada cambio antes de publicarlo","idle","available",null],
 [2,"Verificador QA","Prueba el proceso de compra de principio a fin","working","reading","Probar el proceso de compra"],
 [3,"Analista de procesos","Documenta y simplifica los procesos internos","idle","available",null],
 [4,"Estratega de campañas","Diseña campañas para recuperar clientes","working","preparing","Campaña de clientes inactivos"],
 [4,"Redactor de anuncios","Escribe anuncios y textos promocionales","idle","available",null],
 [5,"Asistente administrativo","Gastos, facturas y proveedores","inactive","inactive",null],
 [6,"Especialista SEO","Títulos, descripciones y posicionamiento local","working","queued","Auditoría de títulos y descripciones"],
 [6,"Redactor de blog","Artículos del blog con enfoque SEO","idle","awaiting_review","Guía de cuidado de la cerámica"],
 [7,"Agente de email","Clasifica y responde el correo de clientes","working","analyzing","Responder correos sobre plazos"],
 [8,"Gestor de pedidos","Seguimiento de pedidos y envíos","idle","available",null],
];
export function mockOverview(now=new Date()){
 const observed=now.toISOString(),until=new Date(now.getTime()+25000).toISOString();
 const workers=W.map(([d,name,specialty,state,phase,title],i)=>{const moving=["preparing","reading","analyzing"].includes(phase);const hasJob=title!==null;
  return {id:id(i+1,"b"),department_id:mockDepartments[d].id,name,specialty,recorded_state:state,phase,assigned_tasks_in_sample:hasJob?1:0,animation_until:moving?until:null,job_id:hasJob?id(i+1,"e"):null,task_id:hasJob?id(i+1,"c"):null,task_title:title};});
 return {organization_id:MOCK_ORG,read_only:true,provider_called:false,source_fetched:false,worker_online_verified:false,observed_at:observed,fresh_for_seconds:30,departments:mockDepartments,workers,
  sample:{task_limit:20,tasks_scanned:7,jobs_per_task_limit:20,worker_limit:120,department_limit:40,tasks_truncated:false,workers_truncated:false,departments_truncated:false,not_full_company_census:true,unattributed_job_records:0},
  task_counts_in_sample:{pending:1,running:5,completed:1},job_counts_in_sample:{queued:1,claimed:1,source_verified:1,provider_started:2,completed:1},attention_records_in_sample:0,recent_jobs:[],recent_tasks:[]};
}
export function mockTasks(now=Date.now()){
 return [
  ...W.map((w,i)=>w[5]?{id:id(i+1,"c"),department_id:mockDepartments[w[0]].id,assignee_worker_id:id(i+1,"b"),title:w[5],status:w[4]==="awaiting_review"?"completed":"running",created_at:new Date(now-(i+2)*17*60000).toISOString()}:null).filter(Boolean),
  {id:id(40,"c"),department_id:mockDepartments[3].id,assignee_worker_id:id(5,"b"),title:"Simplificar el proceso de devoluciones",status:"pending",created_at:new Date(now-50*60000).toISOString()},
 ];
}
export const mockRequests=(now=Date.now())=>({enabled:true,requests:[{task_id:id(40,"c"),worker_id:id(5,"b"),department_id:mockDepartments[3].id,title:"Simplificar el proceso de devoluciones",request:"Documenta el proceso actual de devoluciones y propón cómo simplificarlo.",deliverable:"Proceso en menos pasos",task_status:"pending",created_at:new Date(now-50*60000).toISOString()}]});
export const mockMemory={enabled:true,keys:["audience","pricing","value_proposition","brand_tone","products","faq"],items:[
 {key:"audience",content:"Particulares de 30 a 55 años que buscan cerámica artesanal para regalo o para su casa.",updated_at:"2026-11-10T10:00:00Z"},
 {key:"pricing",content:"Piezas de 18 a 120 €. Envío gratuito desde 60 €.",updated_at:"2026-11-10T10:00:00Z"},
 {key:"value_proposition",content:"Cerámica hecha a mano en Valencia, piezas únicas y envío cuidado.",updated_at:"2026-11-10T10:00:00Z"},
 {key:"brand_tone",content:"",updated_at:null}]};

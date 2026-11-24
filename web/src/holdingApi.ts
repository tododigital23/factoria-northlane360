/**
 * Holding (superempresa) de Freddy: tipos, validadores puros y cálculo de la guía.
 * Sin efectos: todo lo que aquí se decide es comprobable con pruebas unitarias.
 */
export const API_ROOT=(import.meta.env.VITE_API_ROOT ?? "https://api.tu-factoria.example").replace(/\/$/, "");
export const HOLDING_URL=API_ROOT+"/v1/me/holding";
export const holdingCompaniesUrl=(holdingId:string)=>HOLDING_URL+"/"+encodeURIComponent(holdingId)+"/companies";
export const MAX_COMPANIES=5;

export const CAPABILITIES=["repository","website","seo","marketing","email","orders","monitoring","automation"] as const;
export type Capability=typeof CAPABILITIES[number];
export const CAPABILITY_STATES=["planned","configured","enabled","disabled"] as const;
export type CapabilityState=typeof CAPABILITY_STATES[number];

export const BASE_DEPARTMENTS=["Dirección IA","Desarrollo","Calidad","Operaciones","Marketing","Administración"] as const;
export const CAPABILITY_INFO:Record<Capability,{label:string;short:string;department:string|null;explains:string}>={
 repository:{label:"Repositorio de código",short:"Repositorio",department:null,explains:"Lo gestiona Desarrollo (departamento base). Lectura del repositorio GitHub autorizado."},
 website:{label:"Sitio web",short:"Web",department:null,explains:"Lo gestionan Desarrollo y Marketing (departamentos base)."},
 seo:{label:"SEO y contenidos",short:"SEO",department:"SEO y Contenidos",explains:"Crea el departamento «SEO y Contenidos»."},
 marketing:{label:"Marketing digital",short:"Marketing",department:null,explains:"Lo gestiona Marketing (departamento base)."},
 email:{label:"Lectura y atención de email",short:"Email",department:"Atención y Email",explains:"Crea el departamento «Atención y Email»."},
 orders:{label:"Pedidos",short:"Pedidos",department:"Pedidos",explains:"Crea el departamento «Pedidos»."},
 monitoring:{label:"Control automático de fallos",short:"Fallos",department:"Monitorización y Fallos",explains:"Crea el departamento «Monitorización y Fallos»."},
 automation:{label:"Automatizaciones",short:"Automatizaciones",department:"Automatizaciones",explains:"Crea el departamento «Automatizaciones»."}
};
export const STATE_LABEL:Record<CapabilityState,string>={planned:"Planificada",configured:"Configurada",enabled:"Activa",disabled:"Desactivada"};

export type HoldingCompany={organization_id:string;name:string;slot:number;project_name:string;project_summary:string;repository:string|null;website_url:string|null;
 capabilities:{capability:Capability;state:CapabilityState}[];departments:number;workers:number;active_workers:number;
 tasks:{pending:number;blocked:number;completed:number;other:number};routines_active:number;missions:number;autopilots_active:number;created_at:string};
export type Holding={id:string;name:string;max_companies:5;is_owner:boolean;companies:HoldingCompany[]};
export type HoldingResponse={enabled:boolean;holdings:Holding[]};
export type CreateCompanyAck={holding_id:string;organization_id:string;slot:number;replayed:boolean;departments:{id:string;name:string}[];workers_created:number;provider_called:false};

const obj=(v:unknown):v is Record<string,unknown>=>typeof v==="object"&&v!==null&&!Array.isArray(v);
const count=(v:unknown)=>Number.isInteger(v)&&(v as number)>=0&&(v as number)<=1_000_000;
const str=(v:unknown,min=1,max=10_000)=>typeof v==="string"&&v.trim()===v&&chars(v)>=min&&chars(v)<=max;
const nullableStr=(v:unknown,max:number)=>v===null||str(v,1,max);
const date=(v:unknown)=>typeof v==="string"&&Number.isFinite(Date.parse(v));
export const chars=(s:string)=>Array.from(s).length;

export function validCompany(c:unknown,max=MAX_COMPANIES):c is HoldingCompany{
 if(!obj(c))return false;
 if(!str(c.organization_id,1,200)||!str(c.name,1,120)||!Number.isInteger(c.slot)||(c.slot as number)<1||(c.slot as number)>max)return false;
 if(typeof c.project_name!=="string"||chars(c.project_name)>120||typeof c.project_summary!=="string"||chars(c.project_summary)>600)return false;
 if(!nullableStr(c.repository,140)||!(c.website_url===null||(typeof c.website_url==="string"&&validWebsite(c.website_url))))return false;
 if(typeof c.repository==="string"&&!validRepository(c.repository))return false;
 if(!Array.isArray(c.capabilities)||c.capabilities.length>CAPABILITIES.length)return false;
 const seen=new Set<string>();
 for(const k of c.capabilities){if(!obj(k)||!(CAPABILITIES as readonly unknown[]).includes(k.capability)||!(CAPABILITY_STATES as readonly unknown[]).includes(k.state)||seen.has(k.capability as string))return false;seen.add(k.capability as string);}
 if(!count(c.departments)||!count(c.workers)||!count(c.active_workers)||(c.active_workers as number)>(c.workers as number))return false;
 if(!obj(c.tasks)||!["pending","blocked","completed","other"].every(k=>count((c.tasks as Record<string,unknown>)[k])))return false;
 return count(c.routines_active)&&count(c.missions)&&count(c.autopilots_active)&&date(c.created_at);
}
export function validHolding(h:unknown):h is Holding{
 if(!obj(h)||!str(h.id,1,200)||!str(h.name,1,120)||h.max_companies!==MAX_COMPANIES||typeof h.is_owner!=="boolean"||!Array.isArray(h.companies)||h.companies.length>MAX_COMPANIES)return false;
 if(!h.companies.every(c=>validCompany(c)))return false;
 const list=h.companies as HoldingCompany[];
 return new Set(list.map(c=>c.slot)).size===list.length&&new Set(list.map(c=>c.organization_id)).size===list.length;
}
/** Respuesta completa de GET /v1/me/holding. Cualquier incoherencia invalida todo. */
export function validHoldingResponse(raw:unknown):raw is HoldingResponse{
 if(!obj(raw)||typeof raw.enabled!=="boolean"||!Array.isArray(raw.holdings)||raw.holdings.length>20)return false;
 if(!raw.enabled&&raw.holdings.length!==0)return false;
 if(!raw.holdings.every(validHolding))return false;
 const list=raw.holdings as Holding[];
 if(new Set(list.map(h=>h.id)).size!==list.length)return false;
 // Las empresas están aisladas: una organización no puede aparecer en dos holdings.
 const orgs=list.flatMap(h=>h.companies.map(c=>c.organization_id));
 return new Set(orgs).size===orgs.length;
}

/* ---------- Asistente «Crear empresa» ---------- */
export type WizardDraft={name:string;project_name:string;project_summary:string;repository:string;website_url:string;capabilities:Capability[]};
export const emptyDraft=():WizardDraft=>({name:"",project_name:"",project_summary:"",repository:"",website_url:"",capabilities:[]});
/** Misma expresión que aplica el servidor (actualización 034): el servidor es la autoridad. */
export const REPOSITORY_PATTERN=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export function validRepository(v:string){return REPOSITORY_PATTERN.test(v);}
export function validWebsite(v:string){
 if(v.length>2048||/\s/.test(v))return false;
 try{const u=new URL(v);return u.protocol==="https:"&&!u.username&&!u.password&&u.hostname.includes(".")&&!u.hostname.endsWith(".")&&u.hostname!=="localhost";}catch{return false;}
}
export type DraftErrors=Partial<Record<keyof WizardDraft,string>>;
export function validateDraft(d:WizardDraft,existingNames:string[]=[]):DraftErrors{
 const e:DraftErrors={};const n=chars(d.name.trim()),pn=chars(d.project_name.trim()),ps=chars(d.project_summary.trim());
 if(n<2||n>120)e.name="El nombre debe tener entre 2 y 120 caracteres.";
 else if(existingNames.some(x=>x.trim().toLocaleLowerCase("es")===d.name.trim().toLocaleLowerCase("es")))e.name="Ya hay una empresa con ese nombre en el holding.";
 if(pn<2||pn>120)e.project_name="El nombre del proyecto debe tener entre 2 y 120 caracteres.";
 if(ps<10||ps>600)e.project_summary="El resumen debe tener entre 10 y 600 caracteres.";
 if(d.repository.trim()&&!validRepository(d.repository.trim()))e.repository="Usa el formato propietario/repositorio de GitHub, por ejemplo nova/web.";
 if(d.website_url.trim()&&!validWebsite(d.website_url.trim()))e.website_url="Indica una dirección completa que empiece por https://";
 if(d.capabilities.length===0)e.capabilities="Elige al menos una capacidad: así Freddy sabe qué departamentos preparar.";
 else if(new Set(d.capabilities).size!==d.capabilities.length||!d.capabilities.every(c=>(CAPABILITIES as readonly string[]).includes(c)))e.capabilities="Selección de capacidades no válida.";
 return e;
}
export const stepFields:(keyof WizardDraft)[][]=[["name"],["project_name","project_summary","repository","website_url"],["capabilities"],[]];
export function departmentsFor(caps:readonly Capability[]):string[]{
 return [...BASE_DEPARTMENTS,...CAPABILITIES.filter(c=>caps.includes(c)).map(c=>CAPABILITY_INFO[c].department).filter((d):d is string=>!!d)];
}
export type CreatePayload={name:string;project_name:string;project_summary:string;repository:string|null;website_url:string|null;capabilities:Capability[];confirm:true;request_key:string};
export function buildPayload(d:WizardDraft,request_key:string):CreatePayload{
 return {name:d.name.trim(),project_name:d.project_name.trim(),project_summary:d.project_summary.trim(),repository:d.repository.trim()||null,website_url:d.website_url.trim()||null,
  capabilities:CAPABILITIES.filter(c=>d.capabilities.includes(c)),confirm:true,request_key};
}
/** 201 de POST companies. Lo que no cuadre con lo enviado se trata como «no confirmado». */
export function validCreateAck(raw:unknown,holding:Holding,sent:CreatePayload):raw is CreateCompanyAck{
 if(!obj(raw)||raw.holding_id!==holding.id||!str(raw.organization_id,1,200)||typeof raw.replayed!=="boolean"||raw.provider_called!==false)return false;
 if(!Number.isInteger(raw.slot)||(raw.slot as number)<1||(raw.slot as number)>MAX_COMPANIES)return false;
 const occupant=holding.companies.find(c=>c.slot===raw.slot);
 if(occupant&&!(raw.replayed&&occupant.organization_id===raw.organization_id))return false;
 const other=holding.companies.find(c=>c.organization_id===raw.organization_id);
 if(other&&!(raw.replayed&&other.slot===raw.slot))return false;
 if(!Array.isArray(raw.departments))return false;
 const deps=raw.departments as unknown[];
 if(!deps.every(d=>obj(d)&&str(d.id,1,200)&&str(d.name,1,120)))return false;
 const list=deps as {id:string;name:string}[],expected=departmentsFor(sent.capabilities);
 if(new Set(list.map(d=>d.id)).size!==list.length||list.length!==expected.length)return false;
 const names=new Set(list.map(d=>d.name));
 if(names.size!==list.length||!expected.every(n=>names.has(n)))return false;
 return raw.workers_created===list.length;
}

/* ---------- Guía del proyecto ---------- */
export type ManageTab="profile"|"routines"|"messages"|"integration"|"hosting"|"tienda";
export type GuideAction={kind:"wizard"}|{kind:"manage";companyId:string;tab:ManageTab}|{kind:"section";section:"Documentos"|"Trabajadores IA"|"Tareas"|"Planes IA"|"Informes IA";companyId:string}|{kind:"select";slot:number}|{kind:"none"};
export type GuideStep={id:string;label:string;done:boolean;action:GuideAction;hint:string};
export type GuidePhase={id:string;title:string;steps:GuideStep[];done:number;total:number};
export type Guide={phases:GuidePhase[];done:number;total:number;percent:number;next:GuideStep|null;freddy:string};
const COMPANY_STEPS=6;
export function companySteps(c:HoldingCompany):GuideStep[]{
 const caps=new Set(c.capabilities.filter(k=>k.state!=="disabled").map(k=>k.capability));
 const profile=chars(c.project_name.trim())>=2&&chars(c.project_summary.trim())>=10&&(!caps.has("repository")||!!c.repository)&&(!caps.has("website")||!!c.website_url);
 const s=(id:string,label:string,done:boolean,action:GuideAction,hint:string):GuideStep=>({id:c.organization_id+":"+id,label,done,action,hint});
 const manage=(tab:ManageTab):GuideAction=>({kind:"manage",companyId:c.organization_id,tab});
 const go=(section:Extract<GuideAction,{kind:"section"}>["section"]):GuideAction=>({kind:"section",section,companyId:c.organization_id});
 return [
  s("profile","Perfil completo (proyecto, repositorio, web)",profile,manage("profile"),"Completa el proyecto e indica el repositorio o la web que hayas marcado como capacidad."),
  s("capabilities","Capacidades elegidas",caps.size>0,manage("profile"),"Revisa qué capacidades necesita el proyecto: cada una prepara su departamento."),
  s("team","Departamentos y agentes revisados",c.departments>0&&c.active_workers>0,go("Trabajadores IA"),"Los agentes se crean inactivos. Revisa cada departamento y activa al menos uno."),
  s("routines","Tareas recurrentes activadas",c.routines_active>0,manage("routines"),"Activa una tarea recurrente para que el trabajo diario no dependa de ti."),
  // Store missions hide GitHub autopilot on purpose; a saved mission is enough for this step.
  s("mission","Primera misión creada",c.missions>0,go("Planes IA"),"Crea una misión en Planes IA. Si es de tienda, prepara los pasos hacia Operación tienda; si es de repositorio GitHub, puedes conceder piloto automático con un presupuesto limitado."),
  s("report","Informe aceptado",c.tasks.completed>0,go("Informes IA"),"Revisa el primer informe y acéptalo o pide cambios.")
 ];
}
export function computeGuide(holding:Holding|null):Guide{
 const companies=holding?[...holding.companies].sort((a,b)=>a.slot-b.slot):[];
 const owner=!!holding?.is_owner;
 const create:GuideAction=owner?{kind:"wizard"}:{kind:"none"};
 const phase1:GuidePhase={id:"holding",title:"Fase 1 · Holding creado",steps:[{id:"holding",label:"Holding creado",done:!!holding,action:{kind:"none"},hint:"El holding se crea en el servidor; cuando esté disponible aparecerá aquí."}],done:holding?1:0,total:1};
 const created=companies.length;
 const phase2:GuidePhase={id:"companies",title:`Fase 2 · Crear las 5 empresas (${created}/5)`,steps:Array.from({length:MAX_COMPANIES},(_,i)=>{const c=companies[i];return {id:"company-"+(i+1),label:c?`Empresa ${i+1}: ${c.name}`:`Empresa ${i+1}: espacio libre`,done:!!c,action:c?{kind:"select",slot:c.slot} as GuideAction:create,hint:owner?"Crea la empresa con el asistente: nombre, proyecto y capacidades.":"Solo quien es propietario del holding puede crear empresas."};}),done:created,total:MAX_COMPANIES};
 const phase3:GuidePhase[]=companies.map(c=>{const steps=companySteps(c);return {id:"company:"+c.organization_id,title:`Fase 3 · ${c.name}`,steps,done:steps.filter(x=>x.done).length,total:COMPANY_STEPS};});
 const total=1+MAX_COMPANIES+MAX_COMPANIES*COMPANY_STEPS;
 const done=phase1.done+phase2.done+phase3.reduce((a,p)=>a+p.done,0);
 // Recomendación: sin empresas, crear la primera; después, terminar cada empresa antes de abrir la siguiente.
 let next:GuideStep|null=null;
 if(!holding)next=phase1.steps[0];
 else if(created===0)next=phase2.steps[0];
 else next=phase3.flatMap(p=>p.steps).find(s=>!s.done)??phase2.steps.find(s=>!s.done)??null;
 const freddy=freddyText(holding,next,companies);
 return {phases:[phase1,phase2,...phase3],done,total,percent:Math.round(done/total*100),next,freddy};
}
function freddyText(h:Holding|null,next:GuideStep|null,companies:HoldingCompany[]){
 if(!h)return "Aún no veo tu holding en el servidor. Mientras tanto, puedes seguir trabajando con las empresas a las que ya perteneces.";
 if(!next)return "Las cinco empresas están en marcha. Revisa los informes y deja que el piloto automático haga el resto.";
 if(next.id.startsWith("company-"))return companies.length===0
  ?(h.is_owner?"Empecemos: crea tu primera empresa. Dime cómo se llama, qué proyecto lleva y qué necesita; yo preparo los departamentos.":"Todavía no hay empresas y solo quien es propietario del holding puede crearlas.")
  :(h.is_owner?`Buen trabajo con ${companies.length===1?"tu empresa":"tus empresas"}. Cuando quieras, abre la siguiente parcela del campus.`:"Las empresas existentes ya están configuradas. Solo quien es propietario puede crear más.");
 const company=companies.find(c=>next.id.startsWith(c.organization_id+":"));
 return `${company?company.name+": ":""}${next.hint}`;
}
export type MemberCompany={id:string;name:string;role:string};
export type CampusPlot={slot:number;company:HoldingCompany|null;member?:MemberCompany};
/** Cinco parcelas fijas; las vacías quedan como espacio libre. */
export function campusPlots(companies:HoldingCompany[]):CampusPlot[]{
 return Array.from({length:MAX_COMPANIES},(_,i)=>({slot:i+1,company:companies.find(c=>c.slot===i+1)??null}));
}
/** Modo sin holding en el servidor: las empresas del selector ocupan parcelas, sin métricas. */
export function memberPlots(members:MemberCompany[]):CampusPlot[]{
 return Array.from({length:MAX_COMPANIES},(_,i)=>({slot:i+1,company:null,...(members[i]?{member:members[i]}:{})}));
}

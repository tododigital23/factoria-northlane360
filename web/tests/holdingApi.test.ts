import {describe,it,expect} from "vitest";
import {validHoldingResponse,validCompany,validRepository,validWebsite,validateDraft,buildPayload,departmentsFor,validCreateAck,computeGuide,campusPlots,memberPlots,emptyDraft} from "../src/holdingApi";
import type {Holding,HoldingCompany} from "../src/holdingApi";

export const company=(over:Partial<HoldingCompany>={}):HoldingCompany=>({organization_id:"org-1",name:"Tienda Aurora",slot:1,project_name:"Tienda online",project_summary:"Venta de cerámica con pedidos.",repository:"nova/aurora",website_url:"https://aurora.example.com",capabilities:[{capability:"repository",state:"enabled"},{capability:"orders",state:"planned"}],departments:7,workers:7,active_workers:2,tasks:{pending:3,blocked:1,completed:0,other:0},routines_active:0,missions:0,autopilots_active:0,created_at:"2026-11-01T10:00:00Z",...over});
const holding=(companies:HoldingCompany[]=[],over:Partial<Holding>={}):Holding=>({id:"h1",name:"Nova Holding",max_companies:5,is_owner:true,companies,...over});

describe("validadores del holding",()=>{
 it("acepta una respuesta coherente y enabled:false vacía",()=>{
  expect(validHoldingResponse({enabled:true,holdings:[holding([company()])]})).toBe(true);
  expect(validHoldingResponse({enabled:true,holdings:[]})).toBe(true);
  expect(validHoldingResponse({enabled:false,holdings:[]})).toBe(true);
 });
 it.each([
  ["enabled no booleano",{enabled:"yes",holdings:[]}],
  ["enabled:false con holdings",{enabled:false,holdings:[holding()]}],
  ["max_companies distinto de 5",{enabled:true,holdings:[holding([],{max_companies:6 as 5})]}],
  ["slot fuera de rango",{enabled:true,holdings:[holding([company({slot:6})])]}],
  ["slot cero",{enabled:true,holdings:[holding([company({slot:0})])]}],
  ["slots duplicados",{enabled:true,holdings:[holding([company(),company({organization_id:"org-2"})])]}],
  ["organización duplicada",{enabled:true,holdings:[holding([company(),company({slot:2})])]}],
  ["más de 5 empresas",{enabled:true,holdings:[holding([1,2,3,4,5,6].map(i=>company({slot:i,organization_id:"o"+i})))]}],
  ["activos > total",{enabled:true,holdings:[holding([company({active_workers:9})])]}],
  ["contador negativo",{enabled:true,holdings:[holding([company({departments:-1})])]}],
  ["contador decimal",{enabled:true,holdings:[holding([company({tasks:{pending:1.5,blocked:0,completed:0,other:0}})])]}],
  ["capacidad desconocida",{enabled:true,holdings:[holding([company({capabilities:[{capability:"crm" as "seo",state:"enabled"}]})])]}],
  ["estado desconocido",{enabled:true,holdings:[holding([company({capabilities:[{capability:"seo",state:"on" as "enabled"}]})])]}],
  ["capacidad duplicada",{enabled:true,holdings:[holding([company({capabilities:[{capability:"seo",state:"enabled"},{capability:"seo",state:"planned"}]})])]}],
  ["web sin https",{enabled:true,holdings:[holding([company({website_url:"http://a.example.com"})])]}],
  ["repositorio mal formado",{enabled:true,holdings:[holding([company({repository:"sin-barra"})])]}],
  ["fecha inválida",{enabled:true,holdings:[holding([company({created_at:"ayer"})])]}],
  ["is_owner ausente",{enabled:true,holdings:[{...holding(),is_owner:undefined}]}],
  ["empresa en dos holdings",{enabled:true,holdings:[holding([company()]),holding([company()],{id:"h2"})]}],
  ["no es objeto",null]
 ])("rechaza: %s",(_n,raw)=>{expect(validHoldingResponse(raw)).toBe(false);});
 it("valida empresas sueltas",()=>{expect(validCompany(company({repository:null,website_url:null}))).toBe(true);expect(validCompany({...company(),tasks:null})).toBe(false);});
 it("valida repositorios y webs",()=>{
  for(const ok of ["nova/web","a/b.c","Org-1/repo_2","my_org.x/r-1"])expect(validRepository(ok)).toBe(true);
  for(const bad of ["","owner","/repo","owner/","owner/repo/extra","https://github.com/o/r","own er/r","o/r?x","a".repeat(101)+"/r"])expect(validRepository(bad)).toBe(false);
  for(const ok of ["https://example.com","https://www.example.es/ruta?x=1"])expect(validWebsite(ok)).toBe(true);
  for(const bad of ["http://example.com","example.com","https://localhost","https://user:pw@example.com","javascript:alert(1)","https://exa mple.com"])expect(validWebsite(bad)).toBe(false);
 });
});

describe("borrador del asistente",()=>{
 const good={name:"Tienda",project_name:"Web",project_summary:"Resumen suficiente",repository:"",website_url:"",capabilities:["seo" as const]};
 it("acepta un borrador mínimo válido",()=>{expect(validateDraft(good)).toEqual({});});
 it("aplica rangos y formatos",()=>{
  const e=validateDraft({name:"A",project_name:"x".repeat(121),project_summary:"corto",repository:"mal",website_url:"http://x.com",capabilities:[]});
  expect(Object.keys(e).sort()).toEqual(["capabilities","name","project_name","project_summary","repository","website_url"]);
  expect(validateDraft({...good,name:"x".repeat(120)})).toEqual({});expect(validateDraft({...good,name:"x".repeat(121)}).name).toBeTruthy();
  expect(validateDraft({...good,project_summary:"x".repeat(600)})).toEqual({});expect(validateDraft({...good,project_summary:"x".repeat(601)}).project_summary).toBeTruthy();
 });
 it("detecta nombres duplicados sin distinguir mayúsculas",()=>{expect(validateDraft({...good,name:" tienda "},["TIENDA"]).name).toMatch(/Ya hay/);});
 it("construye el payload exacto con recortes, nulos y orden canónico",()=>{
  expect(buildPayload({...good,name:"  Tienda ",repository:" o/r ",capabilities:["orders","seo","repository"]},"k1")).toEqual({name:"Tienda",project_name:"Web",project_summary:"Resumen suficiente",repository:"o/r",website_url:null,capabilities:["repository","seo","orders"],confirm:true,request_key:"k1"});
  expect(emptyDraft().capabilities).toEqual([]);
 });
 it("calcula los departamentos base y por capacidad",()=>{
  expect(departmentsFor([])).toEqual(["Dirección IA","Desarrollo","Calidad","Operaciones","Marketing","Administración"]);
  expect(departmentsFor(["automation","seo","email","orders","monitoring","repository","website","marketing"]).slice(6)).toEqual(["SEO y Contenidos","Atención y Email","Pedidos","Monitorización y Fallos","Automatizaciones"]);
 });
});

describe("confirmación de creación",()=>{
 const sent=buildPayload({name:"Nueva",project_name:"P",project_summary:"Resumen largo",repository:"",website_url:"",capabilities:["seo"]},"k");
 const deps=departmentsFor(["seo"]).map((name,i)=>({id:"d"+i,name}));
 const ack=(over:object={})=>({holding_id:"h1",organization_id:"org-new",slot:2,replayed:false,departments:deps,workers_created:7,provider_called:false,...over});
 const h=holding([company()]);
 it("acepta una confirmación coherente",()=>{expect(validCreateAck(ack(),h,sent)).toBe(true);});
 it.each([
  ["otro holding",{holding_id:"h2"}],["slot ocupado",{slot:1}],["slot 6",{slot:6}],["provider_called",{provider_called:true}],
  ["agentes distintos",{workers_created:6}],["faltan departamentos",{departments:deps.slice(1),workers_created:6}],
  ["departamento inesperado",{departments:[...deps.slice(1),{id:"x",name:"Pedidos"}]}],["ids duplicados",{departments:deps.map(d=>({...d,id:"same"}))}],
  ["organización existente sin replay",{organization_id:"org-1"}],["replayed no booleano",{replayed:"no"}]
 ])("rechaza: %s",(_n,over)=>{expect(validCreateAck(ack(over),h,sent)).toBe(false);});
 it("admite un replay que apunta a la empresa ya creada",()=>{expect(validCreateAck(ack({replayed:true,slot:1,organization_id:"org-1"}),h,sent)).toBe(true);});
});

describe("guía del proyecto",()=>{
 it("sin holding recomienda esperar al servidor",()=>{const g=computeGuide(null);expect(g.next?.id).toBe("holding");expect(g.done).toBe(0);expect(g.total).toBe(36);expect(g.percent).toBe(0);});
 it("con holding vacío recomienda crear la primera empresa",()=>{
  const g=computeGuide(holding());expect(g.next?.id).toBe("company-1");expect(g.next?.action).toEqual({kind:"wizard"});expect(g.phases[1].title).toContain("(0/5)");expect(g.done).toBe(1);
  expect(computeGuide(holding([],{is_owner:false})).next?.action).toEqual({kind:"none"});
 });
 it("recorre los pasos de cada empresa en orden y enlaza al sitio correcto",()=>{
  const c=company();let g=computeGuide(holding([c]));
  expect(g.phases).toHaveLength(3);expect(g.phases[2].steps.map(s=>s.done)).toEqual([true,true,true,false,false,false]);
  expect(g.next?.label).toBe("Tareas recurrentes activadas");expect(g.next?.action).toEqual({kind:"manage",tab:"routines",companyId:"org-1"});
  g=computeGuide(holding([company({active_workers:0})]));expect(g.next?.action).toEqual({kind:"section",section:"Trabajadores IA",companyId:"org-1"});
  g=computeGuide(holding([company({repository:null})]));expect(g.next?.label).toMatch(/Perfil completo/);expect(g.next?.action).toEqual({kind:"manage",tab:"profile",companyId:"org-1"});
  g=computeGuide(holding([company({routines_active:1,missions:1,autopilots_active:1})]));expect(g.next?.action).toMatchObject({section:"Informes IA"});
  // Misión de tienda: sin piloto automático ni tareas completadas, el paso de misión ya cuenta.
  g=computeGuide(holding([company({routines_active:1,missions:1,autopilots_active:0})]));
  expect(g.phases[2].steps[4].done).toBe(true);expect(g.next?.label).toBe("Informe aceptado");
  g=computeGuide(holding([company({capabilities:[]})]));expect(g.phases[2].steps[1].done).toBe(false);expect(g.next?.action).toEqual({kind:"manage",tab:"profile",companyId:"org-1"});
  g=computeGuide(holding([company({routines_active:1})]));expect(g.phases[2].steps[3].done).toBe(true);
 });
 it("al completar una empresa propone crear la siguiente y cuenta el progreso",()=>{
  const full=company({routines_active:1,missions:1,autopilots_active:0,tasks:{pending:0,blocked:0,completed:2,other:0}});
  const g=computeGuide(holding([full]));expect(g.next?.id).toBe("company-2");expect(g.done).toBe(1+1+6);expect(g.percent).toBe(Math.round(8/36*100));expect(g.freddy).toMatch(/siguiente parcela/);
  const all=computeGuide(holding([1,2,3,4,5].map(i=>({...full,slot:i,organization_id:"o"+i}))));expect(all.next).toBeNull();expect(all.percent).toBe(100);
 });
 it("asigna cinco parcelas fijas",()=>{
  expect(campusPlots([company({slot:3})]).map(p=>!!p.company)).toEqual([false,false,true,false,false]);
  expect(memberPlots([{id:"a",name:"A",role:"owner"}]).map(p=>p.member?.id??null)).toEqual(["a",null,null,null,null]);
 });
});

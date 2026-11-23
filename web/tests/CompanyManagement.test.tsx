// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor,within} from "@testing-library/react";
import {CompanyManagement,MANAGEMENT_UNAVAILABLE,MANAGEMENT_UNCONFIRMED} from "../src/CompanyManagement";
import {urls,validRetireAck,retirePayload,validateCompanyName,validRenameAck,validateProfile,profilePayload,validCapabilityAck,validRoutineList,validateRoutine,routinePayload,validMessageList,newestFirst,validWorkers} from "../src/companyManagementApi";
import type {HoldingCompany,ManageTab} from "../src/holdingApi";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));

const org="org-1";
const company:HoldingCompany={organization_id:org,name:"Tienda Aurora",slot:1,project_name:"Tienda online",project_summary:"Venta de cerámica con pedidos.",repository:"nova/aurora",website_url:null,capabilities:[{capability:"seo",state:"enabled"},{capability:"orders",state:"planned"},{capability:"email",state:"disabled"}],departments:8,workers:8,active_workers:1,tasks:{pending:0,blocked:0,completed:0,other:0},routines_active:1,missions:0,autopilots_active:0,created_at:"2026-11-01T10:00:00Z"};
const deps=[{id:"d-seo",name:"SEO y Contenidos"},{id:"d-ped",name:"Pedidos"},{id:"d-dev",name:"Desarrollo"}];
const workers=[{id:"w-seo",department_id:"d-seo",name:"Analista SEO",specialty:"SEO",state:"inactive"},{id:"w-ped",department_id:"d-ped",name:"Gestor de pedidos",specialty:"Pedidos",state:"idle"},{id:"w-dev",department_id:"d-dev",name:"Programador",specialty:"Dev",state:"idle"}];
const routine=(over:object={})=>({id:"r1",department_id:"d-seo",department:"SEO y Contenidos",worker_id:"w-seo",worker:"Analista SEO",title:"Revisión SEO semanal",instructions:"Revisa posiciones y títulos.",cadence:"weekly",capability:"seo",state:"active",created_at:"2026-11-02T10:00:00Z",last_period:"2026-W46",runs:3,...over});
const msg=(over:object={})=>({id:"m1",from_worker_id:"w-dev",from_worker:"Programador",to_worker_id:"w-seo",to_worker:"Analista SEO",task_id:null,body:"Hola",created_at:"2026-11-15T09:00:00Z",...over});
const reply=(raw:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(raw),{status}));
let gets:Record<string,()=>Promise<Response>>,post:(url:string)=>Promise<Response>,posts:{url:string;body:any}[];
const server=vi.fn(),changed=vi.fn(),closed=vi.fn();
beforeEach(()=>{token.mockClear();changed.mockClear();closed.mockClear();posts=[];
 gets={[urls.routines(org)]:()=>reply({enabled:true,routines:[routine()]}),[urls.departments(org)]:()=>reply(deps),[urls.workers(org)]:()=>reply(workers),[urls.messages(org)]:()=>reply({organization_id:org,enabled:true,same_company_only:true,messages:[msg()]})};
 post=()=>reply({});
 server.mockReset();server.mockImplementation((url:string,o?:RequestInit)=>{if(o?.method==="POST"){posts.push({url,body:o.body===undefined?undefined:JSON.parse(String(o.body))});return post(url);}return (gets[url]??(()=>reply({},404)))();});
 vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function view(tab:ManageTab="profile",canEdit=true){
 let current=tab;const onTab=vi.fn((t:ManageTab)=>{current=t;r.rerender(el());});
 const el=()=><CompanyManagement company={company} canEdit={canEdit} tab={current} onTab={onTab} onClose={closed} onChanged={changed}/>;
 const r=render(el());return {onTab};
}

describe("validadores de gestión",()=>{
 it("perfil: rangos, formato del servidor y payload exacto",()=>{
  expect(validateProfile({project_name:"Ok",project_summary:"Resumen largo",repository:"a_b.c/x-y",website_url:""})).toEqual({});
  expect(Object.keys(validateProfile({project_name:"x",project_summary:"corto",repository:"no valido",website_url:"http://x.com"})).sort()).toEqual(["project_name","project_summary","repository","website_url"]);
  expect(profilePayload({project_name:" P ",project_summary:" Resumen largo ",repository:" ",website_url:" https://a.example.com "})).toEqual({project_name:"P",project_summary:"Resumen largo",repository:null,website_url:"https://a.example.com"});
 });
 it("capacidades: exige connector_enabled:false y coherencia",()=>{
  const ok={organization_id:org,capability:"seo",state:"planned",departments_created:1,connector_enabled:false};
  expect(validCapabilityAck(ok,org,"seo","planned")).toBe(true);
  for(const bad of [{...ok,connector_enabled:true},{...ok,capability:"email"},{...ok,state:"enabled"},{...ok,departments_created:2},{...ok,organization_id:"x"}])expect(validCapabilityAck(bad,org,"seo","planned")).toBe(false);
  expect(validCapabilityAck({...ok,state:"disabled",departments_created:1},org,"seo","disabled")).toBe(false);
 });
 it("rutinas y mensajes: estructuras estrictas",()=>{
  expect(validRoutineList({enabled:true,routines:[routine()]})).toBe(true);
  for(const bad of [{enabled:false,routines:[routine()]},{enabled:true,routines:[routine(),routine()]},{enabled:true,routines:[routine({cadence:"hourly"})]},{enabled:true,routines:[routine({title:"ab"})]},{enabled:true,routines:[routine({runs:-1})]},{enabled:true,routines:[routine({capability:"crm"})]}])expect(validRoutineList(bad)).toBe(false);
  expect(validWorkers(workers,deps)).toBe(true);expect(validWorkers([{...workers[0],department_id:"otro"}],deps)).toBe(false);
  expect(validateRoutine({department_id:"d-seo",worker_id:"w-ped",title:"abc",instructions:"0123456789",cadence:"daily",capability:""},workers).worker_id).toMatch(/departamento elegido/);
  expect(routinePayload({department_id:"d",worker_id:"w",title:" T ",instructions:" Instrucciones ",cadence:"daily",capability:""},"k")).toEqual({department_id:"d",worker_id:"w",title:"T",instructions:"Instrucciones",cadence:"daily",capability:null,request_key:"k"});
  const list={organization_id:org,enabled:true,same_company_only:true,messages:[msg()]};
  expect(validMessageList(list,org)).toBe(true);
  for(const bad of [{...list,same_company_only:false},{...list,organization_id:"x"},{...list,enabled:false},{...list,messages:[msg({created_at:"x"})]},{...list,messages:[msg(),msg()]}])expect(validMessageList(bad,org)).toBe(false);
  expect(newestFirst([msg({id:"a",created_at:"2026-01-01T00:00:00Z"}),msg({id:"b",created_at:"2026-02-01T00:00:00Z"})]).map(m=>m.id)).toEqual(["b","a"]);
 });
});

describe("panel Gestión de la empresa",()=>{
 it("es un diálogo con pestañas navegables por teclado",async()=>{
  const {onTab}=view();const tabs=within(screen.getByRole("tablist",{name:"Secciones de gestión"})).getAllByRole("tab");
  expect(tabs.map(t=>t.textContent)).toEqual(["Perfil y capacidades","Tareas recurrentes","Mensajes entre agentes","Integración"]);
  expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(tabs[0].id);
  fireEvent.keyDown(tabs[0],{key:"ArrowRight"});expect(onTab).toHaveBeenLastCalledWith("routines");
  fireEvent.keyDown(screen.getAllByRole("tab")[1],{key:"End"});expect(onTab).toHaveBeenLastCalledWith("integration");
  fireEvent.click(screen.getByRole("button",{name:"Cerrar"}));expect(closed).toHaveBeenCalled();
 });
 it.each([["503",()=>reply({},503)],["enabled:false",()=>reply({enabled:false,routines:[]})]])("%s deja una nota neutral sin controles en todas las pestañas",async(_n,r)=>{
  gets[urls.routines(org)]=r;gets[urls.messages(org)]=()=>reply({},503);view();
  expect(await screen.findByText(MANAGEMENT_UNAVAILABLE)).toBeTruthy();expect(screen.queryByRole("button",{name:"Guardar perfil"})).toBeNull();expect(screen.queryByRole("button",{name:/Añadir/})).toBeNull();
  fireEvent.click(screen.getByRole("tab",{name:"Tareas recurrentes"}));expect(await screen.findByText(MANAGEMENT_UNAVAILABLE)).toBeTruthy();expect(screen.queryByRole("button",{name:/Crear/})).toBeNull();
  fireEvent.click(screen.getByRole("tab",{name:"Mensajes entre agentes"}));expect(await screen.findByText(MANAGEMENT_UNAVAILABLE)).toBeTruthy();
 });
});

describe("Perfil y capacidades",()=>{
 const save=()=>screen.getByRole("button",{name:/Guardar perfil|Reintentar el mismo guardado|Guardando/}) as HTMLButtonElement;
 it("rellena con los datos del holding, valida y envía el payload exacto",async()=>{
  view();expect(((await screen.findByLabelText("Nombre del proyecto")) as HTMLInputElement).value).toBe("Tienda online");
  expect((screen.getByLabelText("Repositorio GitHub (opcional)") as HTMLInputElement).value).toBe("nova/aurora");
  fireEvent.change(screen.getByLabelText("Web del proyecto (opcional)"),{target:{value:"http://x.com"}});expect(save().disabled).toBe(true);expect(screen.getByText(/empiece por https/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Web del proyecto (opcional)"),{target:{value:" https://aurora.example.com "}});
  fireEvent.change(screen.getByLabelText("Repositorio GitHub (opcional)"),{target:{value:""}});
  post=()=>reply({organization_id:org,updated:true});fireEvent.click(save());
  expect(await screen.findByText("Perfil guardado.")).toBeTruthy();
  expect(posts).toEqual([{url:urls.profile(org),body:{project_name:"Tienda online",project_summary:"Venta de cerámica con pedidos.",repository:null,website_url:"https://aurora.example.com"}}]);expect(changed).toHaveBeenCalledTimes(1);
 });
 it("una respuesta inválida queda como no confirmada y el reintento es idéntico; editar lo descarta",async()=>{
  view();await screen.findByLabelText("Nombre del proyecto");post=()=>reply({organization_id:org,updated:false});fireEvent.click(save());
  expect(await screen.findByText(MANAGEMENT_UNCONFIRMED)).toBeTruthy();expect(save().textContent).toBe("Reintentar el mismo guardado");
  fireEvent.click(save());await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1].body).toEqual(posts[0].body);
  await screen.findByText(MANAGEMENT_UNCONFIRMED);fireEvent.change(screen.getByLabelText("Nombre del proyecto"),{target:{value:"Otro nombre"}});expect(save().textContent).toBe("Guardar perfil");expect(changed).not.toHaveBeenCalled();
 });
 it("409 muestra el motivo y 503 oculta los controles",async()=>{
  view();await screen.findByLabelText("Nombre del proyecto");post=()=>reply({},409);fireEvent.click(save());
  expect(await screen.findByText(/no ha guardado el perfil/)).toBeTruthy();expect(save().textContent).toBe("Guardar perfil");
  post=()=>reply({},503);fireEvent.click(save());expect(await screen.findByText(MANAGEMENT_UNAVAILABLE)).toBeTruthy();expect(screen.queryByLabelText("Nombre del proyecto")).toBeNull();
 });
 it("muestra cada capacidad con su estado y añade como planificada",async()=>{
  view();const caps=within(await screen.findByRole("region",{name:"Capacidades"}));
  expect(caps.getAllByRole("listitem")).toHaveLength(8);expect(caps.getByText(/aquí no se puede marcar como activa/)).toBeTruthy();expect(caps.getByText(/Desactivar nunca borra departamentos/)).toBeTruthy();
  expect(caps.getByRole("button",{name:"Añadir Lectura y atención de email"})).toBeTruthy();expect(caps.getByRole("button",{name:"Desactivar SEO y contenidos"})).toBeTruthy();
  post=()=>reply({organization_id:org,capability:"monitoring",state:"planned",departments_created:1,connector_enabled:false});
  fireEvent.click(caps.getByRole("button",{name:"Añadir Control automático de fallos"}));
  expect(await screen.findByText(/se ha creado su departamento con un agente inactivo/)).toBeTruthy();
  expect(posts[0]).toEqual({url:urls.capability(org,"monitoring"),body:{state:"planned"}});expect(changed).toHaveBeenCalled();
  expect(caps.getByRole("button",{name:"Desactivar Control automático de fallos"})).toBeTruthy();
 });
 it("desactivar pide confirmación, no borra departamentos y rechaza conectores activados",async()=>{
  view();const caps=within(await screen.findByRole("region",{name:"Capacidades"}));
  fireEvent.click(caps.getByRole("button",{name:"Desactivar Pedidos"}));expect(posts).toHaveLength(0);
  post=()=>reply({organization_id:org,capability:"orders",state:"disabled",departments_created:0,connector_enabled:true});
  fireEvent.click(caps.getByRole("button",{name:"Confirmar desactivar Pedidos"}));expect(await screen.findByText(/No se ha podido confirmar el cambio de «Pedidos»/)).toBeTruthy();
  expect(posts[0].body).toEqual({state:"disabled"});expect(changed).not.toHaveBeenCalled();
  post=()=>reply({organization_id:org,capability:"orders",state:"disabled",departments_created:0,connector_enabled:false});
  fireEvent.click(caps.getByRole("button",{name:"Desactivar Pedidos"}));fireEvent.click(caps.getByRole("button",{name:"Confirmar desactivar Pedidos"}));
  expect(await screen.findByText(/Sus departamentos y agentes se conservan/)).toBeTruthy();
 });
 it("sin permisos de propietario solo muestra los datos",async()=>{
  view("profile",false);expect(await screen.findByText(/Solo quien es propietario/)).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Guardar perfil"})).toBeNull();expect(screen.queryByRole("button",{name:/Añadir|Desactivar/})).toBeNull();
 });
});

describe("Tareas recurrentes",()=>{
 const createBtn=()=>screen.getByRole("button",{name:/Crear tarea recurrente|Reintentar la misma solicitud|Creando…/}) as HTMLButtonElement;
 async function ready(){view("routines");return within(await screen.findByRole("region",{name:"Nueva tarea recurrente"}));}
 it("lista rutinas reales y aclara que no ejecuta nada",async()=>{
  view("routines");const list=within(await screen.findByRole("region",{name:"Rutinas de la empresa"}));
  expect(list.getByText("Revisión SEO semanal")).toBeTruthy();expect(list.getByText(/SEO y Contenidos · Analista SEO · Semanal/)).toBeTruthy();expect(list.getByText("Activa")).toBeTruthy();
  expect(screen.getByText(/No ejecuta nada ni gasta cuota/)).toBeTruthy();
  expect(server.mock.calls.some(c=>c[0]===urls.routines(org)&&c[1].headers.Authorization==="Bearer opaque")).toBe(true);
 });
 it("las sugerencias rellenan el formulario y los agentes se filtran por departamento",async()=>{
  const form=await ready();const sugg=within(form.getByRole("group",{name:"Sugerencias rápidas"}));
  expect(sugg.getAllByRole("button").map(b=>b.textContent)).toEqual(["Revisión SEO semanal","Revisión diaria de pedidos pendientes","Revisión semanal del repositorio"]);
  fireEvent.click(sugg.getByRole("button",{name:"Revisión diaria de pedidos pendientes"}));
  expect((form.getByLabelText("Departamento") as HTMLSelectElement).value).toBe("d-ped");expect((form.getByLabelText("Agente responsable") as HTMLSelectElement).value).toBe("w-ped");
  expect((form.getByLabelText("Frecuencia") as HTMLSelectElement).value).toBe("daily");expect((form.getByLabelText("Título") as HTMLInputElement).value).toBe("Revisión diaria de pedidos pendientes");
  expect(within(form.getByLabelText("Agente responsable")).getAllByRole("option").map(o=>o.textContent)).toEqual(["Elige un agente","Gestor de pedidos"]);
 });
 it("valida antes de enviar",async()=>{
  const form=await ready();fireEvent.click(createBtn());expect(posts).toHaveLength(0);
  expect(form.getByText("Elige el departamento.")).toBeTruthy();expect(form.getByText("El título debe tener entre 3 y 160 caracteres.")).toBeTruthy();
 });
 it("envía el payload exacto y congela la clave para el reintento; editar crea otra",async()=>{
  const form=await ready();
  fireEvent.change(form.getByLabelText("Departamento"),{target:{value:"d-dev"}});
  fireEvent.change(form.getByLabelText("Título"),{target:{value:"  Revisión del código "}});fireEvent.change(form.getByLabelText("Instrucciones"),{target:{value:"Revisa los cambios de la semana."}});
  fireEvent.change(form.getByLabelText("Frecuencia"),{target:{value:"monthly"}});fireEvent.change(form.getByLabelText("Capacidad relacionada (opcional)"),{target:{value:"repository"}});
  post=()=>Promise.reject(new TypeError("red"));fireEvent.click(createBtn());
  expect(await screen.findByText(MANAGEMENT_UNCONFIRMED)).toBeTruthy();
  const {request_key,...rest}=posts[0].body;expect(request_key).toMatch(/^[0-9a-f-]{36}$/);
  expect(posts[0].url).toBe(urls.routines(org));expect(rest).toEqual({department_id:"d-dev",worker_id:"w-dev",title:"Revisión del código",instructions:"Revisa los cambios de la semana.",cadence:"monthly",capability:"repository"});
  expect(createBtn().textContent).toBe("Reintentar la misma solicitud");fireEvent.click(createBtn());await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1].body).toEqual(posts[0].body);
  await screen.findByText(MANAGEMENT_UNCONFIRMED);
  fireEvent.change(form.getByLabelText("Frecuencia"),{target:{value:"weekly"}});expect(createBtn().textContent).toBe("Crear tarea recurrente");
  post=()=>reply({organization_id:org,routine_id:"r2",execution_started:false},201);fireEvent.click(createBtn());
  expect(await screen.findByText(/Rutina creada/)).toBeTruthy();expect(posts[2].body.request_key).not.toBe(request_key);expect(posts[2].body.cadence).toBe("weekly");expect(changed).toHaveBeenCalledTimes(1);
 });
 it("rechaza confirmaciones que dicen haber ejecutado algo",async()=>{
  const form=await ready();fireEvent.click(within(form.getByRole("group",{name:"Sugerencias rápidas"})).getByRole("button",{name:"Revisión SEO semanal"}));
  post=()=>reply({organization_id:org,routine_id:"r2",execution_started:true},201);fireEvent.click(createBtn());
  expect(await screen.findByText(MANAGEMENT_UNCONFIRMED)).toBeTruthy();expect(changed).not.toHaveBeenCalled();
 });
 it.each([[409,/no ha creado la rutina/],[403,/No tienes permiso/],[422,/rechazado los datos/]])("%i explica el rechazo y no reintenta",async(status,text)=>{
  const form=await ready();fireEvent.click(within(form.getByRole("group",{name:"Sugerencias rápidas"})).getByRole("button",{name:"Revisión SEO semanal"}));
  post=()=>reply({},status);fireEvent.click(createBtn());expect(await screen.findByText(text)).toBeTruthy();expect(createBtn().textContent).toBe("Crear tarea recurrente");
  fireEvent.click(createBtn());await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1].body.request_key).not.toBe(posts[0].body.request_key);
 });
 it("503 al crear oculta los controles",async()=>{
  const form=await ready();fireEvent.click(within(form.getByRole("group",{name:"Sugerencias rápidas"})).getByRole("button",{name:"Revisión SEO semanal"}));
  post=()=>reply({},503);fireEvent.click(createBtn());expect(await screen.findByText(MANAGEMENT_UNAVAILABLE)).toBeTruthy();expect(screen.queryByRole("region",{name:"Nueva tarea recurrente"})).toBeNull();
 });
 it("pausa con validación de la respuesta y crea tareas vencidas sin cuerpo",async()=>{
  view("routines");const list=within(await screen.findByRole("region",{name:"Rutinas de la empresa"}));
  post=()=>reply({organization_id:org,routine_id:"r1",state:"active"});fireEvent.click(list.getByRole("button",{name:"Pausar Revisión SEO semanal"}));
  expect(await screen.findByText(/No se ha podido confirmar el cambio de la rutina/)).toBeTruthy();expect(posts[0]).toEqual({url:urls.routineControl(org,"r1"),body:{state:"paused"}});
  post=()=>reply({organization_id:org,routine_id:"r1",state:"paused"});fireEvent.click(list.getByRole("button",{name:"Pausar Revisión SEO semanal"}));expect(await screen.findByText("«Revisión SEO semanal» en pausa.")).toBeTruthy();
  post=()=>reply({organization_id:org,tasks_created:2,execution_started:false});fireEvent.click(screen.getByRole("button",{name:"Crear tareas vencidas ahora"}));
  expect(await screen.findByText("Se han creado 2 tareas pendientes. No se ha ejecutado nada.")).toBeTruthy();expect(posts[2]).toEqual({url:urls.runDue(org),body:undefined});
  post=()=>reply({organization_id:org,tasks_created:-1,execution_started:false});fireEvent.click(screen.getByRole("button",{name:"Crear tareas vencidas ahora"}));expect(await screen.findByText(/No se ha podido confirmar cuántas tareas/)).toBeTruthy();
 });
 it("no permite crear si los agentes no cuadran con los departamentos",async()=>{
  gets[urls.workers(org)]=()=>reply([{...workers[0],department_id:"ajeno"}]);view("routines");
  expect(await screen.findByText(/No se han podido verificar los departamentos y agentes/)).toBeTruthy();expect(screen.queryByRole("button",{name:"Crear tarea recurrente"})).toBeNull();
 });
 it("una lista inválida no muestra controles",async()=>{gets[urls.routines(org)]=()=>reply({enabled:true,routines:[routine({state:"running"})]});view("routines");expect(await screen.findByText(/No se han podido verificar las tareas recurrentes/)).toBeTruthy();expect(screen.queryByRole("button",{name:/Crear/})).toBeNull();});
});

describe("Mensajes entre agentes",()=>{
 it("lista de solo lectura, más recientes primero y en texto plano",async()=>{
  gets[urls.messages(org)]=()=>reply({organization_id:org,enabled:true,same_company_only:true,messages:[msg({id:"a",body:"Primero",created_at:"2026-11-10T09:00:00Z"}),msg({id:"b",body:"<img src=x onerror=alert(1)><b>negrita</b>",task_id:"t-9",created_at:"2026-11-16T09:00:00Z"})]});
  view("messages");expect(screen.getByText("Los agentes solo pueden comunicarse con agentes de esta misma empresa. Esta lista es de solo lectura.")).toBeTruthy();
  const list=await screen.findByRole("list",{name:"Mensajes, más recientes primero"});const items=within(list).getAllByRole("listitem");
  expect(items[0].textContent).toContain("<img src=x onerror=alert(1)><b>negrita</b>");expect(list.querySelector("img,b")).toBeNull();expect(items[0].textContent).toContain("Tarea t-9");
  expect(items[1].textContent).toContain("Primero");expect(screen.queryByRole("textbox")).toBeNull();expect(posts).toHaveLength(0);
 });
 it("una respuesta sin same_company_only no se muestra",async()=>{
  gets[urls.messages(org)]=()=>reply({organization_id:org,enabled:true,same_company_only:false,messages:[msg()]});view("messages");
  expect(await screen.findByText(/No se han podido verificar los mensajes/)).toBeTruthy();expect(screen.queryByText("Hola")).toBeNull();
 });
});

describe("nombre de la empresa (036)",()=>{
 const input=()=>screen.getByLabelText("Nombre") as HTMLInputElement;
 const boton=()=>screen.getByRole("button",{name:/Cambiar nombre|Reintentar el mismo cambio|Guardando/}) as HTMLButtonElement;
 it("valida el nombre y la confirmación del servidor",()=>{
  expect(validateCompanyName(" Nova Demo Portal ")).toBeNull();
  expect(validateCompanyName("X")).toBeTruthy();expect(validateCompanyName("x".repeat(121))).toBeTruthy();expect(validateCompanyName("Con\nsalto")).toBeTruthy();
  expect(validRenameAck({organization_id:org,name:"Nuevo",renamed:true},org," Nuevo ")).toBe(true);
  expect(validRenameAck({organization_id:"otra",name:"Nuevo",renamed:true},org,"Nuevo")).toBe(false);
  expect(validRenameAck({organization_id:org,name:"Distinto",renamed:true},org,"Nuevo")).toBe(false);
  expect(validRenameAck({organization_id:org,name:"Nuevo",renamed:"si"},org,"Nuevo")).toBe(false);
 });
 it("empieza con el nombre actual y no deja guardar sin cambios ni con un nombre inválido",async()=>{
  view();await screen.findByRole("heading",{name:"Nombre de la empresa"});
  expect(input().value).toBe("Tienda Aurora");expect(boton().disabled).toBe(true);
  fireEvent.change(input(),{target:{value:"X"}});expect(boton().disabled).toBe(true);expect(posts).toEqual([]);
 });
 it("envía el nombre recortado a la ruta exacta y avisa al terminar",async()=>{
  post=()=>reply({organization_id:org,name:"Nova Demo Portal",renamed:true});
  view();await screen.findByRole("heading",{name:"Nombre de la empresa"});
  fireEvent.change(input(),{target:{value:"  Nova Demo Portal "}});fireEvent.click(boton());
  expect(await screen.findByText("La empresa ahora se llama «Nova Demo Portal».")).toBeTruthy();
  expect(posts).toEqual([{url:urls.name(org),body:{name:"Nova Demo Portal"}}]);expect(changed).toHaveBeenCalledTimes(1);
 });
 it("Intro en el campo cambia el nombre",async()=>{
  post=()=>reply({organization_id:org,name:"Nova Demo Portal",renamed:true});
  view();await screen.findByRole("heading",{name:"Nombre de la empresa"});
  fireEvent.change(input(),{target:{value:"Nova Demo Portal"}});fireEvent.keyDown(input(),{key:"Enter"});
  expect(await screen.findByText("La empresa ahora se llama «Nova Demo Portal».")).toBeTruthy();expect(posts).toEqual([{url:urls.name(org),body:{name:"Nova Demo Portal"}}]);
 });
 it("409 explica que el nombre ya existe y no llama a onChanged",async()=>{
  post=()=>reply({},409);view();await screen.findByRole("heading",{name:"Nombre de la empresa"});
  fireEvent.change(input(),{target:{value:"Nova Demo LLC"}});fireEvent.click(boton());
  expect(await screen.findByText(/ya hay otra empresa con ese nombre/)).toBeTruthy();expect(changed).not.toHaveBeenCalled();
 });
 it("una respuesta que no cuadra queda sin confirmar y el reintento es idéntico",async()=>{
  post=()=>reply({organization_id:org,name:"Otro",renamed:true});view();await screen.findByRole("heading",{name:"Nombre de la empresa"});
  fireEvent.change(input(),{target:{value:"Nuevo Nombre"}});fireEvent.click(boton());
  await screen.findByText(MANAGEMENT_UNCONFIRMED);expect(boton().textContent).toBe("Reintentar el mismo cambio");expect(changed).not.toHaveBeenCalled();
  post=()=>reply({organization_id:org,name:"Nuevo Nombre",renamed:true});fireEvent.click(boton());
  await screen.findByText("La empresa ahora se llama «Nuevo Nombre».");expect(posts[1]).toEqual(posts[0]);
 });
 it("sin permisos de propietario no hay botón",async()=>{
  view("profile",false);await screen.findByRole("heading",{name:"Nombre de la empresa"});
  expect(screen.queryByRole("button",{name:"Cambiar nombre"})).toBeNull();expect(input().disabled).toBe(true);
 });
});

describe("retirar la empresa (038)",()=>{
 const abrir=async()=>{view();fireEvent.click(await screen.findByRole("button",{name:"Retirar esta empresa…"}));};
 const campo=()=>screen.getByLabelText(/Escribe el nombre exacto/) as HTMLInputElement;
 const boton=()=>screen.getByRole("button",{name:/Retirar y liberar la parcela 1|Retirando/}) as HTMLButtonElement;
 it("validador y payload",()=>{
  const ok={organization_id:org,name:"Tienda Aurora",slot:1,retired:true,routines_paused:2};
  expect(validRetireAck(ok,org)).toBe(true);expect(retirePayload(" Tienda Aurora ")).toEqual({confirm_name:"Tienda Aurora"});
  for(const bad of [{...ok,organization_id:"otra"},{...ok,retired:"si"},{...ok,slot:"1"},{...ok,routines_paused:null},null])expect(validRetireAck(bad,org)).toBe(false);
 });
 it("no envía nada hasta escribir el nombre exacto; al confirmar avisa al Campus",async()=>{
  await abrir();expect(boton().disabled).toBe(true);
  fireEvent.change(campo(),{target:{value:"tienda aurora"}});expect(boton().disabled).toBe(true);
  fireEvent.change(campo(),{target:{value:"Tienda Aurora"}});expect(boton().disabled).toBe(false);
  post=()=>reply({organization_id:org,name:"Tienda Aurora",slot:1,retired:true,routines_paused:1});
  fireEvent.click(boton());await waitFor(()=>expect(changed).toHaveBeenCalled());
  expect(posts).toEqual([{url:urls.retire(org),body:{confirm_name:"Tienda Aurora"}}]);
 });
 it("explica el rechazo y se puede cancelar; quien no es propietario no lo ve",async()=>{
  await abrir();fireEvent.change(campo(),{target:{value:"Tienda Aurora"}});
  post=()=>reply({},409);fireEvent.click(boton());
  expect((await screen.findByRole("alert")).textContent).toMatch(/pilotos automáticos/);expect(changed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Cancelar"}));expect(screen.getByRole("button",{name:"Retirar esta empresa…"})).toBeTruthy();
  cleanup();view("profile",false);await screen.findByRole("heading",{name:"Nombre de la empresa"});
  expect(screen.queryByRole("button",{name:"Retirar esta empresa…"})).toBeNull();
 });
 it("las flechas recorren las cuatro pestañas",async()=>{
  const {onTab}=view("messages");const tabs=screen.getAllByRole("tab");
  fireEvent.keyDown(tabs[2],{key:"ArrowRight"});expect(onTab).toHaveBeenLastCalledWith("integration");
  fireEvent.keyDown(tabs[0],{key:"ArrowLeft"});expect(onTab).toHaveBeenLastCalledWith("integration");
  fireEvent.keyDown(tabs[0],{key:"End"});expect(onTab).toHaveBeenLastCalledWith("integration");
 });
});

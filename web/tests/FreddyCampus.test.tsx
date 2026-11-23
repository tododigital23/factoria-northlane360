// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor,within} from "@testing-library/react";
import {FreddyCampus,plotPosition,CAMPUS_CENTER,presetPose} from "../src/FreddyCampus";
import {CreateCompanyWizard,WIZARD_UNCONFIRMED} from "../src/CreateCompanyWizard";
import {ProjectGuide} from "../src/ProjectGuide";
import {HOLDING_URL,computeGuide,departmentsFor} from "../src/holdingApi";
import type {Holding,HoldingCompany} from "../src/holdingApi";
import {holdingChanges} from "../src/fabrica/liveFeed";
import {factoryPose,toFactoryPlot} from "../src/fabrica/plots";
import {CompanyLogo,companyBrand,logoCandidates,monogram} from "../src/fabrica/CompanyLogo";
const {token,seen}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque"),seen:{canvas:null as any}}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
vi.mock("../src/fabrica/FactoryScene",()=>({FactoryScene:(p:any)=>{seen.canvas=p;return <div data-testid="webgl-surface"/>;}}));

const company=(i:number,over:Partial<HoldingCompany>={}):HoldingCompany=>({organization_id:"org-"+i,name:"Empresa "+["Uno","Dos","Tres","Cuatro","Cinco"][i-1],slot:i,project_name:"Proyecto "+i,project_summary:"Resumen del proyecto "+i,repository:null,website_url:null,capabilities:[{capability:"seo",state:"enabled"}],departments:7,workers:7,active_workers:3,tasks:{pending:4,blocked:i===1?2:0,completed:0,other:0},routines_active:0,missions:0,autopilots_active:0,created_at:"2026-11-01T10:00:00Z",...over});
const holding=(n:number,over:Partial<Holding>={}):Holding=>({id:"h1",name:"Nova Holding",max_companies:5,is_owner:true,companies:Array.from({length:n},(_,i)=>company(i+1)),...over});
const reply=(raw:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(raw),{status}));
let getReply:()=>Promise<Response>;const server=vi.fn();
const enter=vi.fn(),navigate=vi.fn(),loadCompanies=vi.fn();
beforeEach(()=>{token.mockClear();enter.mockClear();navigate.mockClear();loadCompanies.mockClear();seen.canvas=null;
 getReply=()=>reply({enabled:true,holdings:[holding(1)]});
 server.mockReset();server.mockImplementation((url:string,o?:RequestInit)=>o?.method==="POST"?reply({}):getReply());vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const campus=(props:Partial<React.ComponentProps<typeof FreddyCampus>>={})=>render(<FreddyCampus companies={[]} onEnterCompany={enter} onNavigate={navigate} onLoadCompanies={loadCompanies} webgl={false} {...props}/>);
const map=()=>screen.findByRole("group",{name:"Plano 2D del campus"});

describe("Campus Freddy",()=>{
 it("consulta el holding con token y muestra 0 empresas como cinco parcelas libres",async()=>{
  getReply=()=>reply({enabled:true,holdings:[holding(0)]});campus();
  const lots=within(await map()).getAllByRole("button");expect(lots).toHaveLength(5);
  await waitFor(()=>expect(lots.every(b=>/espacio libre, crea tu empresa/.test(b.getAttribute("aria-label")!))).toBe(true));
  expect(server.mock.calls[0][0]).toBe(HOLDING_URL);expect(server.mock.calls[0][1].headers.Authorization).toBe("Bearer opaque");
  expect(screen.getByText("Fase 2 · Crear las 5 empresas (0/5)")).toBeTruthy();
  const guide=screen.getByRole("complementary",{name:"Guía del proyecto"});
  fireEvent.click(within(within(guide).getByLabelText("Paso recomendado")).getByRole("button",{name:"Crear empresa"}));
  expect(await screen.findByRole("dialog",{name:"Crear empresa"})).toBeTruthy();
 });
 it("con 1 empresa muestra sus señales reales y 4 parcelas libres; Entrar abre su oficina",async()=>{
  campus();const lot=await screen.findByRole("button",{name:/Parcela 1: Empresa Uno\. 7 departamentos, 3 de 7 trabajadores activos, 4 tareas pendientes y 2 bloqueadas/});
  expect(within(await map()).getAllByRole("button",{name:/espacio libre/})).toHaveLength(4);
  fireEvent.click(lot);expect(lot.getAttribute("aria-pressed")).toBe("true");
  const detail=screen.getByRole("article",{name:"Empresa Empresa Uno"});
  expect(within(detail).getByText("Bloqueadas").nextSibling?.textContent).toBe("2");
  expect(within(detail).getByRole("list",{name:"Capacidades"}).textContent).toContain("SEOActiva");
  fireEvent.click(within(detail).getByRole("button",{name:"Entrar en la oficina"}));expect(enter).toHaveBeenCalledWith("org-1");
  fireEvent.click(within(detail).getByRole("button",{name:"Tareas"}));expect(navigate).toHaveBeenCalledWith("Tareas","org-1");
 });
 it("con 5 empresas no quedan parcelas libres ni botón de crear",async()=>{
  getReply=()=>reply({enabled:true,holdings:[holding(5)]});campus();
  await screen.findByRole("button",{name:/Parcela 5: Empresa Cinco/});
  expect(screen.queryAllByRole("button",{name:/espacio libre/})).toHaveLength(0);expect(screen.queryByRole("button",{name:"Crear empresa"})).toBeNull();
  expect(screen.getByText("5 de 5 empresas creadas · cada empresa es independiente y aislada")).toBeTruthy();
 });
 it("una parcela libre seleccionada invita a crear la empresa",async()=>{
  campus();fireEvent.click(await screen.findByRole("button",{name:/Parcela 3: espacio libre/}));
  const d=screen.getByRole("article",{name:"Parcela 3 libre"});expect(within(d).getByText("Espacio libre · crea tu empresa")).toBeTruthy();
  fireEvent.click(within(d).getByRole("button",{name:"Crear empresa en el campus"}));expect(screen.getByRole("dialog")).toBeTruthy();
 });
 it("sin WebGL detectado renderiza el plano 2D y desactiva la vista 3D",async()=>{
  const ctx=vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(null);
  campus({webgl:undefined});expect(await map()).toBeTruthy();expect(screen.queryByTestId("webgl-surface")).toBeNull();
  expect(screen.queryByRole("button",{name:"Vista 3D"})).toBeNull();expect(screen.queryByRole("button",{name:"Plano 2D"})).toBeNull();   // sin botones de vista: el plano sale solo
  expect(screen.getByText(/no ofrece WebGL/)).toBeTruthy();ctx.mockRestore();
 });
 it("con WebGL usa la escena 3D, conserva parcelas accesibles y la cámara sigue a la empresa elegida",async()=>{
  campus({webgl:true});expect(screen.getByTestId("webgl-surface")).toBeTruthy();expect(seen.canvas.paused).toBe(false);
  const strip=screen.getByRole("group",{name:"Parcelas del campus"});await waitFor(()=>expect(within(strip).getByRole("button",{name:/Parcela 1: Empresa Uno/})).toBeTruthy());
  expect(within(strip).getAllByRole("button")).toHaveLength(5);
  for(const fuera of ["Plano 2D","Cenital","Freddy","Pausar movimiento","Efectos","Menos movimiento"])expect(screen.queryByRole("button",{name:fuera})).toBeNull();
  expect(screen.queryByRole("button",{name:"⌖ Vista general"})).toBeNull();
  fireEvent.click(within(strip).getByRole("button",{name:/Parcela 1: Empresa Uno/}));expect(seen.canvas.preset).toBe("empresa");   // al elegir una empresa la cámara va a ella
  fireEvent.click(screen.getByRole("button",{name:"⌖ Vista general"}));expect(seen.canvas.preset).toBe("general");
 });
 it.each([["enabled:false",()=>reply({enabled:false,holdings:[]})],["404",()=>reply({},404)],["503",()=>reply({},503)]])("%s muestra el modo sin holding con las empresas del selector",async(_n,r)=>{
  getReply=r;campus({companies:[{id:"m1",name:"Nova Demo",role:"owner"}]});
  expect(await screen.findByText(/El holding aún no está disponible en el servidor/)).toBeTruthy();
  const lot=screen.getByRole("button",{name:"Parcela 1: Nova Demo. Sin métricas del holding."});fireEvent.click(lot);
  fireEvent.click(screen.getByRole("button",{name:"Entrar en la oficina"}));expect(enter).toHaveBeenCalledWith("m1");
  expect(screen.queryByRole("button",{name:"Crear empresa"})).toBeNull();expect(screen.getByText("Fase 1 · Holding creado")).toBeTruthy();
 });
 it("trata una respuesta incoherente como no verificada",async()=>{
  getReply=()=>reply({enabled:true,holdings:[holding(2,{companies:[company(1),company(2,{slot:1})]})]});campus();
  expect(await screen.findByText("La respuesta del holding no es coherente y no se muestra.")).toBeTruthy();expect(screen.queryByText(/Empresa Uno/)).toBeNull();
 });
 it("pide las empresas del usuario si el selector está vacío",async()=>{campus();await map();expect(loadCompanies).toHaveBeenCalledTimes(1);});
 it("la guía lleva al lugar donde se hace cada paso",async()=>{
  campus();await screen.findByRole("button",{name:/Parcela 1: Empresa Uno/});
  const guide=screen.getByRole("complementary",{name:"Guía del proyecto"});
  fireEvent.click(within(within(guide).getByLabelText("Paso recomendado")).getByRole("button",{name:"Abrir tareas recurrentes"}));
  const dialog=screen.getByRole("dialog",{name:"Empresa Uno"});expect(within(dialog).getByRole("tab",{name:"Tareas recurrentes"}).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(within(dialog).getByRole("button",{name:"Cerrar"}));fireEvent.click(screen.getByRole("button",{name:/Parcela 1: Empresa Uno/}));
  fireEvent.click(screen.getByRole("button",{name:"Agentes"}));expect(navigate).toHaveBeenCalledWith("Trabajadores IA","org-1");
  fireEvent.click(screen.getByRole("button",{name:"Gestionar empresa"}));expect(within(screen.getByRole("dialog",{name:"Empresa Uno"})).getByRole("tab",{name:"Perfil y capacidades"}).getAttribute("aria-selected")).toBe("true");
 });
});

describe("Guía del proyecto",()=>{
 it("es plegable con teclado y expone el progreso",()=>{
  const action=vi.fn();render(<ProjectGuide guide={computeGuide(holding(1))} onAction={action}/>);
  const bar=screen.getByRole("progressbar",{name:"Progreso global del holding"});expect(bar.getAttribute("aria-valuenow")).toBe("5");expect(bar.getAttribute("aria-valuemax")).toBe("36");
  const toggle=screen.getByRole("button",{name:/Plegar/});expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);expect(toggle.getAttribute("aria-expanded")).toBe("false");expect(document.getElementById(toggle.getAttribute("aria-controls")!)!.hidden).toBe(true);
  fireEvent.click(toggle);expect(screen.getByRole("button",{name:"Abrir tareas recurrentes: Tareas recurrentes activadas"}).closest("li")!.getAttribute("aria-current")).toBe("step");
  fireEvent.click(screen.getByRole("button",{name:"Abrir tareas recurrentes: Tareas recurrentes activadas"}));expect(action).toHaveBeenCalledWith({kind:"manage",tab:"routines",companyId:"org-1"});
 });
});

describe("Asistente Crear empresa",()=>{
 const h=holding(1);const created=vi.fn(),closed=vi.fn();
 const deps=departmentsFor(["repository","seo","orders"]).map((name,i)=>({id:"d"+i,name}));
 const ack=(over:object={})=>({holding_id:"h1",organization_id:"org-new",slot:2,replayed:false,departments:deps,workers_created:deps.length,provider_called:false,...over});
 let posts:any[];let post:()=>Promise<Response>;
 beforeEach(()=>{posts=[];created.mockClear();closed.mockClear();post=()=>reply(ack(),201);
  server.mockImplementation((url:string,o?:RequestInit)=>{if(o?.method==="POST"){posts.push({url,body:JSON.parse(String(o.body)),headers:o.headers});return post();}return getReply();});});
 const open=()=>render(<CreateCompanyWizard holding={h} onClose={closed} onCreated={created}/>);
 it("Intro en un campo avanza de paso, y con errores no avanza y lleva el foco al campo que falla",async()=>{
  open();const name=()=>screen.getByLabelText("Nombre de la empresa") as HTMLInputElement;
  fireEvent.keyDown(name(),{key:"Enter"});
  expect(screen.getByText("¿Cómo se llama la empresa?")).toBeTruthy();expect(name().getAttribute("aria-invalid")).toBe("true");
  await waitFor(()=>expect(document.activeElement).toBe(name()));
  fireEvent.change(name(),{target:{value:"JuguetesDemo.com"}});fireEvent.keyDown(name(),{key:"Enter"});
  expect(await screen.findByText("¿Qué proyecto gestiona?")).toBeTruthy();expect(posts).toEqual([]);
 });
 const next=()=>fireEvent.click(screen.getByRole("button",{name:"Siguiente"}));
 function fill(){
  fireEvent.change(screen.getByLabelText("Nombre de la empresa"),{target:{value:"  Tienda Nova "}});next();
  fireEvent.change(screen.getByLabelText("Nombre del proyecto"),{target:{value:"Tienda online"}});
  fireEvent.change(screen.getByLabelText("Resumen del proyecto"),{target:{value:"Venta online con pedidos y SEO."}});
  fireEvent.change(screen.getByLabelText("Repositorio GitHub (opcional)"),{target:{value:"nova/nova"}});next();
  for(const l of [/Pedidos/,/SEO y contenidos/,/Repositorio de código/])fireEvent.click(screen.getByLabelText(l));next();
 }
 const confirm=()=>fireEvent.click(screen.getByLabelText(/Confirmo crear esta empresa/));
 const createBtn=()=>screen.getByRole("button",{name:/Crear empresa|Reintentar la misma solicitud|Creando/}) as HTMLButtonElement;
 it("es un diálogo modal etiquetado que valida cada paso",()=>{
  open();expect(screen.getByRole("dialog",{name:"Crear empresa"}).getAttribute("aria-modal")).toBe("true");
  fireEvent.change(screen.getByLabelText("Nombre de la empresa"),{target:{value:"x"}});next();
  expect(screen.getByText("El nombre debe tener entre 2 y 120 caracteres.")).toBeTruthy();expect(screen.getByLabelText("Nombre de la empresa").getAttribute("aria-invalid")).toBe("true");
  fireEvent.change(screen.getByLabelText("Nombre de la empresa"),{target:{value:"empresa uno"}});next();expect(screen.getByText(/Ya hay una empresa/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Nombre de la empresa"),{target:{value:"Otra"}});next();
  fireEvent.change(screen.getByLabelText("Repositorio GitHub (opcional)"),{target:{value:"no-valido"}});fireEvent.change(screen.getByLabelText("Web del proyecto (opcional)"),{target:{value:"http://x.com"}});next();
  expect(screen.getByText(/formato propietario\/repositorio/)).toBeTruthy();expect(screen.getByText(/empiece por https/)).toBeTruthy();expect(screen.getByText(/Resumen del proyecto/)).toBeTruthy();
 });
 it("muestra el resumen, exige confirmación y envía el payload exacto",async()=>{
  open();fill();
  const summary=screen.getByRole("region",{name:"Resumen de lo que se creará"});
  expect(within(summary).getByText("Se crearán 8 departamentos y 8 agentes inactivos")).toBeTruthy();
  for(const d of ["Dirección IA","Desarrollo","Calidad","Operaciones","Marketing","Administración","SEO y Contenidos","Pedidos"])expect(within(summary).getByText(d)).toBeTruthy();
  expect(createBtn().disabled).toBe(true);confirm();expect(createBtn().disabled).toBe(false);fireEvent.click(createBtn());
  expect(await screen.findByText(/Empresa creada en la parcela 2/)).toBeTruthy();
  expect(posts).toHaveLength(1);expect(posts[0].url).toBe(HOLDING_URL+"/h1/companies");expect(posts[0].headers.Authorization).toBe("Bearer opaque");
  const {request_key,...rest}=posts[0].body;expect(request_key).toMatch(/^[0-9a-f-]{36}$/);
  expect(rest).toEqual({name:"Tienda Nova",project_name:"Tienda online",project_summary:"Venta online con pedidos y SEO.",repository:"nova/nova",website_url:null,capabilities:["repository","seo","orders"],confirm:true});
  expect(created).toHaveBeenCalledWith(ack());
 });
 it("tras un error de red reintenta con la misma clave y cuerpo; al editar genera una clave nueva",async()=>{
  post=()=>Promise.reject(new TypeError("red"));open();fill();confirm();fireEvent.click(createBtn());
  expect(await screen.findByText(WIZARD_UNCONFIRMED)).toBeTruthy();expect(createBtn().textContent).toBe("Reintentar la misma solicitud");
  fireEvent.click(createBtn());await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1].body).toEqual(posts[0].body);
  await screen.findByText(WIZARD_UNCONFIRMED);
  fireEvent.click(screen.getByRole("button",{name:"Atrás"}));fireEvent.click(screen.getByLabelText(/Automatizaciones/));next();
  expect(createBtn().textContent).toBe("Crear empresa");expect(createBtn().disabled).toBe(true);
  post=()=>reply(ack({departments:[...deps,{id:"d9",name:"Automatizaciones"}],workers_created:9}),201);confirm();fireEvent.click(createBtn());
  expect(await screen.findByText(/Empresa creada/)).toBeTruthy();expect(posts[2].body.request_key).not.toBe(posts[0].body.request_key);expect(posts[2].body.capabilities).toContain("automation");
 });
 it("una confirmación incoherente queda como no confirmada y permite el reintento idéntico",async()=>{
  post=()=>reply(ack({workers_created:3}),201);open();fill();confirm();fireEvent.click(createBtn());
  expect(await screen.findByText(WIZARD_UNCONFIRMED)).toBeTruthy();expect(created).not.toHaveBeenCalled();
  post=()=>reply(ack({replayed:true}),201);fireEvent.click(createBtn());expect(await screen.findByText(/solicitud ya registrada/)).toBeTruthy();expect(posts[1].body).toEqual(posts[0].body);
 });
 it.each([[409,/ya tiene 5 empresas, ya existe una con ese nombre/],[403,/No tienes permiso/],[422,/rechazado los datos/],[503,/aún no está disponible en el servidor/]])("%i muestra el motivo, no reintenta y exige nueva confirmación con otra clave",async(status,text)=>{
  post=()=>reply({},status);open();fill();confirm();fireEvent.click(createBtn());
  expect(await screen.findByText(text)).toBeTruthy();expect(createBtn().textContent).toBe("Crear empresa");expect(createBtn().disabled).toBe(true);
  expect((screen.getByLabelText(/Confirmo crear/) as HTMLInputElement).checked).toBe(false);
  confirm();fireEvent.click(createBtn());await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1].body.request_key).not.toBe(posts[0].body.request_key);
 });
});

describe("La Factoría en directo",()=>{
 const withTasks=(tasks:Partial<HoldingCompany["tasks"]>)=>({enabled:true,holdings:[holding(1,{companies:[company(1,{tasks:{pending:4,blocked:2,completed:0,other:0,...tasks}})]})]});
 it("la primera lectura no anima nada y explica que aún no hay cambios",async()=>{
  campus({webgl:true});const live=await screen.findByRole("region",{name:"En directo"});
  expect(within(live).getByText(/Todavía no ha cambiado nada/)).toBeTruthy();expect(within(live).getByRole("status").textContent).toContain("cada 8 segundos");
  expect(seen.canvas.events).toHaveLength(0);
 });
 it("al consultar de nuevo, un trabajo nuevo y uno terminado aparecen en la lista y llegan a la escena",async()=>{
  campus({webgl:true});const live=await screen.findByRole("region",{name:"En directo"});
  getReply=()=>reply(withTasks({pending:5,completed:1}));
  fireEvent.click(screen.getByRole("button",{name:"Actualizar datos"}));
  await waitFor(()=>expect(within(live).getAllByRole("listitem")).toHaveLength(2));
  expect(live.textContent).toContain("Empresa Uno recibe 2 trabajos nuevos.");expect(live.textContent).toContain("Empresa Uno termina un trabajo.");
  expect(seen.canvas.events.map((e:any)=>e.kind+e.slot)).toEqual(["arrived1","arrived1","done1"]);
 });
 it("una tarea que solo cambia de estado no cuenta como trabajo nuevo; una bloqueada nueva sí avisa",()=>{
  const a=[company(1)],b=[company(1,{tasks:{pending:3,blocked:3,completed:0,other:0}})];
  expect(holdingChanges(a,b).map(c=>c.kind)).toEqual(["blocked"]);expect(holdingChanges(a,a)).toEqual([]);
  expect(holdingChanges([],b)[0]).toMatchObject({kind:"created",slot:1});
 });
 it("el logo se pide solo a la web https de la propia empresa y, si no hay, quedan las iniciales",()=>{
  expect(logoCandidates("https://tienda.example.com/inicio?x=1")[0]).toBe("https://tienda.example.com/apple-touch-icon.png");
  expect(logoCandidates("https://tienda.example.com").every(u=>u.startsWith("https://tienda.example.com/"))).toBe(true);
  expect(logoCandidates("http://tienda.example.com")).toEqual([]);expect(logoCandidates(null)).toEqual([]);expect(logoCandidates("javascript:alert(1)")).toEqual([]);
  expect(monogram("Nova Demo Portal")).toBe("ND");expect(monogram("JuguetesDemo.com")).toBe("JU");
  const v=render(<CompanyLogo name="Tienda Aurora" website="https://aurora.example.com"/>);const img=v.container.querySelector("img")!;
  expect(img.getAttribute("src")).toBe("https://aurora.example.com/apple-touch-icon.png");expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  fireEvent.error(img);expect(v.container.querySelector("img")!.getAttribute("src")).toBe("https://aurora.example.com/images/icon.svg");
  expect(v.container.textContent).toBe("TA");
 });
 it("la matriz LLC usa el logo del Portal con la bandera detrás; las demás, el suyo sin bandera",()=>{
  const portal={name:"Nova Demo Portal",website_url:"https://portal.example.com"},llc={name:"Nova Demo LLC",website_url:null},otra={name:"JuguetesDemo.com",website_url:"https://juguetes.example.com"};
  expect(companyBrand(llc,[portal,llc,otra])).toEqual({website:"https://portal.example.com",flag:true});
  expect(companyBrand(portal,[portal,llc,otra])).toEqual({website:"https://portal.example.com",flag:false});
  expect(companyBrand(otra,[portal,llc,otra])).toEqual({website:"https://juguetes.example.com",flag:false});
  expect(companyBrand(llc,[llc])).toEqual({website:null,flag:true});
  const v=render(<CompanyLogo name="Nova Demo LLC" website={null} flag/>);expect(v.container.querySelector(".company-logo.us-flag")).toBeTruthy();
 });
 it("convierte los datos de cada parcela en plantas, luces y baliza, y los encuadres al tamaño de la escena",()=>{
  expect(toFactoryPlot({slot:1,company:company(1)})).toEqual({slot:1,kind:"company",floors:7,lit:3/7,blocked:true});
  expect(toFactoryPlot({slot:2,company:null})).toMatchObject({kind:"empty",floors:0});
  expect(toFactoryPlot({slot:3,company:null,member:{id:"m",name:"M",role:"owner"}})).toMatchObject({kind:"member",floors:2});
  const f=factoryPose("freddy",null,1.6);expect(f.target[0]).toBeCloseTo(0);expect(f.target[2]).toBeCloseTo(0);
  const e=factoryPose("empresa",2,1.6);expect(Math.hypot(e.target[0],e.target[2])).toBeCloseTo(16);
 });
});

describe("geometría del campus",()=>{
 it("reparte las cinco parcelas a la misma distancia de Freddy sin solaparse",()=>{
  const pts=[1,2,3,4,5].map(plotPosition);
  for(const p of pts)expect(Math.hypot(p[0]-CAMPUS_CENTER[0],p[2]-CAMPUS_CENTER[2])).toBeCloseTo(8.6);
  for(let i=0;i<5;i++)for(let j=i+1;j<5;j++)expect(Math.hypot(pts[i][0]-pts[j][0],pts[i][2]-pts[j][2])).toBeGreaterThan(9);
  expect(presetPose("empresa",2,1.6).target[0]).toBeCloseTo(pts[1][0]);
  const wide=presetPose("general",null,1.6),narrow=presetPose("general",null,.5);expect(narrow.pos[1]).toBeGreaterThan(wide.pos[1]);
 });
});

import {CompanyId} from "../src/fabrica/CompanyId";
it("enseña el identificador de la empresa y lo copia",async()=>{
 const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,"clipboard",{value:{writeText},configurable:true});
 render(<CompanyId id="22222222-3333-4444-8555-666666666666"/>);
 expect(screen.getByText("22222222-3333-4444-8555-666666666666")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Copiar el identificador de la empresa"}));
 await screen.findByText("Copiado ✓");expect(writeText).toHaveBeenCalledWith("22222222-3333-4444-8555-666666666666");
 writeText.mockRejectedValueOnce(new Error("x"));fireEvent.click(screen.getByRole("button",{name:"Copiar el identificador de la empresa"}));
 await screen.findByText(/No se pudo copiar/);
});

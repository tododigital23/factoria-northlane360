// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor,within} from "@testing-library/react";
import {CompanyOffice} from "../src/office/CompanyOffice";
import {TeamSidebar} from "../src/office/TeamSidebar";
import {AgentBar} from "../src/office/AgentBar";
import {buildAgents,ghostAgents,greeting,inbox,needsCount} from "../src/office/officeModel";
import {faceOf} from "../src/office/people";
import {MOCK_ORG,mockMemory,mockOverview,mockRequests,mockTasks} from "../src/dev/officeMock";

const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token,user:{name:"Laura"}})}));
vi.mock("@react-three/fiber",()=>({Canvas:()=><div data-testid="webgl-surface"/>,useFrame:vi.fn(),useThree:vi.fn()}));
const server=vi.fn(),navigate=vi.fn();let posts:{url:string;body:any}[]=[];
const companies=[{id:MOCK_ORG,name:"Tienda Aurora",role:"owner"}];
type Route=Record<string,()=>Response>;
function routes(over:Route={}){
 const json=(v:unknown,s=200)=>()=>new Response(JSON.stringify(v),{status:s});
 const base:Route={"execution/office-overview":json(mockOverview()),tasks:json(mockTasks()),"task-requests":json(mockRequests()),memory:json(mockMemory),...over};
 server.mockImplementation(async(url:string,init?:RequestInit)=>{if(init?.method==="POST")posts.push({url,body:JSON.parse(String(init.body))});const path=url.endsWith("/v1/me/holding")?"holding":url.split("/organizations/"+MOCK_ORG+"/")[1];const r=base[path];return r?r():new Response("{}",{status:404});});
}
beforeEach(()=>{posts=[];server.mockReset();navigate.mockReset();token.mockClear();vi.stubGlobal("fetch",server);routes();});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=(webgl=false,extra:Partial<React.ComponentProps<typeof CompanyOffice>>={})=>render(<CompanyOffice companyId={MOCK_ORG} companies={companies} onSelectCompany={vi.fn()} onLoadCompanies={vi.fn()} onNavigate={navigate} webgl={webgl} {...extra}/>);
const team=()=>screen.getByRole("complementary",{name:"Tu equipo"});

it("lee solo con GET autenticados y cuenta los agentes que trabajan de verdad",async()=>{
 view();await screen.findByText("5 trabajando");
 expect(screen.getByRole("heading",{name:"Tienda Aurora · Oficina"})).toBeTruthy();
 const paths=server.mock.calls.map(c=>String(c[0]).endsWith("/v1/me/holding")?"holding":String(c[0]).split(MOCK_ORG+"/")[1]).sort();
 expect(paths).toEqual(["break","execution/office-overview","holding","memory","portal-agents","task-requests","tasks"]);
 for(const c of server.mock.calls){expect(c[1].method).toBeUndefined();expect(c[1].headers.Authorization).toBe("Bearer opaque");}
 expect(screen.getByRole("tab",{name:"Toda la oficina"}).getAttribute("aria-selected")).toBe("true");
 for(const d of ["Dirección IA","Desarrollo","Calidad","Operaciones","Marketing","Administración","SEO y Contenidos","Atención y Email","Pedidos"])expect(screen.getByRole("tab",{name:d})).toBeTruthy();
});
it("sin WebGL muestra el plano 2D equivalente y accesible con las mismas salas y agentes",async()=>{
 view();await screen.findByText("5 trabajando");
 const map=screen.getByRole("group",{name:"Plano 2D de la oficina"});
 expect(within(map).getAllByRole("region").length).toBe(11);   // 9 departamentos + Sala de Descanso + Oficina de Empleo
 expect(within(map).getByRole("button",{name:/^Especialista SEO · Trabajando · Trabajo en cola/})).toBeTruthy();
 expect(screen.getByText(/no ofrece WebGL/)).toBeTruthy();expect(screen.queryByTestId("webgl-surface")).toBeNull();
});
it("selección sincronizada entre «Tu equipo», el plano y la barra inferior",async()=>{
 view();await screen.findByText("5 trabajando");
 fireEvent.click(within(team()).getByRole("button",{name:"Verificador QA · Trabajando"}));
 expect(within(team()).getByRole("button",{name:"Verificador QA · Trabajando"}).getAttribute("aria-pressed")).toBe("true");
 const map=screen.getByRole("group",{name:"Plano 2D de la oficina"});
 expect(within(map).getByRole("button",{name:/^Verificador QA/}).getAttribute("aria-pressed")).toBe("true");
 const bar=screen.getByRole("region",{name:"Agente seleccionado: Verificador QA"});
 expect(within(bar).getByText("Probar el proceso de compra")).toBeTruthy();expect(within(bar).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
 expect(screen.getByRole("tab",{name:"Calidad"}).getAttribute("aria-selected")).toBe("true");
 fireEvent.click(within(map).getByRole("button",{name:/^Gestor de pedidos/}));
 expect(within(team()).getByRole("button",{name:"Gestor de pedidos · Disponible"}).getAttribute("aria-pressed")).toBe("true");
 const bar2=screen.getByRole("region",{name:"Agente seleccionado: Gestor de pedidos"});
 expect(within(bar2).getByText("Listo para su próxima tarea")).toBeTruthy();expect(within(bar2).getByText("◷ Sin tarea registrada")).toBeTruthy();
 fireEvent.click(within(bar2).getByRole("button",{name:"Abrir módulo ↗"}));expect(navigate).toHaveBeenCalledWith("Asignaciones");
});
it("muestra el encargo actual registrado del agente",async()=>{
 view();await screen.findByText("5 trabajando");
 fireEvent.click(within(team()).getByRole("button",{name:"Analista de procesos · En espera"}));
 const bar=screen.getByRole("region",{name:"Agente seleccionado: Analista de procesos"});
 expect(within(bar).getByText("Simplificar el proceso de devoluciones")).toBeTruthy();expect(within(bar).getByText(/Tarea asignada hace/)).toBeTruthy();
});
it("filtros y búsqueda de «Tu equipo»",async()=>{
 view();await screen.findByText("5 trabajando");
 fireEvent.click(within(team()).getByRole("button",{name:"Activos"}));expect(within(team()).getAllByRole("listitem")).toHaveLength(5);
 fireEvent.click(within(team()).getByRole("button",{name:"Inactivos"}));expect(within(team()).getByRole("button",{name:"Asistente administrativo · Inactivo"})).toBeTruthy();expect(within(team()).getAllByRole("listitem")).toHaveLength(1);
 fireEvent.click(within(team()).getByRole("button",{name:"Todos"}));fireEvent.change(within(team()).getByRole("searchbox",{name:"Buscar agente"}),{target:{value:"seo"}});
 expect(within(team()).getAllByRole("listitem").map(li=>li.textContent)).toEqual([expect.stringContaining("Especialista SEO"),expect.stringContaining("Redactor de blog")]);
});
it("pestaña de departamento enfoca la sala y la vista Lista es accesible",async()=>{
 view();await screen.findByText("5 trabajando");
 fireEvent.click(screen.getByRole("tab",{name:"Marketing"}));expect(screen.getByRole("tab",{name:"Marketing"}).getAttribute("aria-selected")).toBe("true");
 expect(screen.getByRole("region",{name:"Sala Marketing"}).className).toContain("focused");
 fireEvent.click(screen.getByRole("button",{name:"≡ Lista"}));const list=screen.getByRole("region",{name:"Lista de la oficina"});
 expect(within(list).getAllByRole("table")).toHaveLength(1);expect(within(list).getByText("Campaña de clientes inactivos")).toBeTruthy();
 fireEvent.click(screen.getByRole("tab",{name:"Toda la oficina"}));expect(within(screen.getByRole("region",{name:"Lista de la oficina"})).getAllByRole("table").length).toBe(9);
});
it("sin actividad registrada no inventa trabajo",async()=>{
 const o=mockOverview();o.workers=o.workers.map(w=>({...w,phase:w.recorded_state==="inactive"?"inactive":"available",recorded_state:w.recorded_state==="working"?"idle":w.recorded_state,animation_until:null,job_id:null,task_id:null,task_title:null,assigned_tasks_in_sample:0}));
 routes({"execution/office-overview":()=>new Response(JSON.stringify(o)),tasks:()=>new Response("[]"),"task-requests":()=>new Response(JSON.stringify({enabled:true,requests:[]}))});
 view();await screen.findByText("0 trabajando");
 expect(within(team()).queryByText("Trabajando")).toBeNull();expect(within(team()).queryByText("En espera",{selector:".agent-status"})).toBeNull();
 const bar=screen.getByRole("region",{name:/Agente seleccionado/});expect(within(bar).getByText("Listo para su próxima tarea")).toBeTruthy();expect(within(bar).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
});
it("si el servidor aún no ofrece encargos ni memoria, deshabilita con nota neutral",async()=>{
 routes({"task-requests":()=>new Response("{}",{status:404}),memory:()=>new Response("{}",{status:503})});
 view();await screen.findByText("5 trabajando");
 const bar=screen.getByRole("region",{name:/Agente seleccionado/});
 await waitFor(()=>expect((within(bar).getByRole("button",{name:"Pedir una tarea →"}) as HTMLButtonElement).disabled).toBe(true));
 expect(within(bar).getByText(/disponible al actualizar el servidor/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Memoria compartida"}));expect(screen.getByRole("region",{name:"Skills del negocio"})).toBeTruthy();
 expect(screen.getByText(/La memoria compartida estará disponible al actualizar el servidor/)).toBeTruthy();
});
it("pedir una tarea abre el modal del agente seleccionado y refresca los encargos",async()=>{
 view();await screen.findByText("5 trabajando");
 fireEvent.click(within(team()).getByRole("button",{name:"Gestor de pedidos · Disponible"}));
 await waitFor(()=>expect((screen.getByRole("button",{name:"Pedir una tarea →"}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"Pedir una tarea →"}));
 const dlg=screen.getByRole("dialog",{name:"Gestor de pedidos"});expect(within(dlg).getByText("Pedidos")).toBeTruthy();
 server.mockImplementationOnce(async()=>new Response(JSON.stringify({organization_id:MOCK_ORG,worker_id:mockOverview().workers[11].id,task_id:"t",department_id:"d",title:"Pedidos retrasados",status:"pending",replayed:false,execution_started:false}),{status:201}));
 fireEvent.click(within(dlg).getByRole("button",{name:"Usar ejemplo"}));fireEvent.click(within(dlg).getByRole("button",{name:"Asignar a Gestor de pedidos →"}));
 await within(dlg).findByText("Encargo registrado");
 await waitFor(()=>expect(server.mock.calls.filter(c=>String(c[0]).endsWith("/task-requests")).length).toBe(2));
});
it("con WebGL la escena no lleva rótulos fijos: al elegir un agente sale su bocadillo con las acciones",async()=>{
 view(true);await screen.findByText("5 trabajando");
 expect(screen.getByTestId("webgl-surface")).toBeTruthy();expect(screen.queryByRole("group",{name:"Plano 2D de la oficina"})).toBeNull();
 expect(screen.queryByText("Laura · tú")).toBeNull();expect(screen.queryByText("Freddy · director")).toBeNull();          // sin globos de identificación
 expect(screen.queryByRole("dialog",{name:/^Hablando con /})).toBeNull();expect(screen.queryByRole("region",{name:/^Agente seleccionado/})).toBeNull();   // nadie elegido al entrar
 fireEvent.click(within(team()).getByRole("button",{name:"Agente de email · Trabajando"}));
 const b=screen.getByRole("dialog",{name:"Hablando con Agente de email"});
 expect(b.textContent).toMatch(/Estoy con «/);
 for(const n of ["Pedir una tarea →","💬 Hablar","Abrir módulo ↗"])expect(within(b).getByRole("button",{name:n})).toBeTruthy();
 fireEvent.click(within(b).getByRole("button",{name:"💬 Hablar"}));expect(screen.getByRole("dialog",{name:"Chat con Agente de email"})).toBeTruthy();
 fireEvent.click(within(screen.getByRole("dialog",{name:"Chat con Agente de email"})).getByRole("button",{name:"Cerrar"}));
 fireEvent.click(within(b).getByRole("button",{name:"Cerrar y volver a toda la oficina"}));expect(screen.queryByRole("dialog",{name:/^Hablando con /})).toBeNull();
 expect(screen.getByRole("button",{name:"Acercar"})).toBeTruthy();expect(screen.getByRole("button",{name:"Recentrar"})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"◇ Modo ambiente"}));expect(screen.getByText(/paseos decorativos, no es actividad real/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Memoria compartida"}));expect(screen.getByText("Lo que saben todos")).toBeTruthy();expect(screen.getByText("Memoria compartida",{selector:"strong"})).toBeTruthy();
});
it("no consulta la oficina en vivo si no es propietario",async()=>{
 view(false,{companies:[{id:MOCK_ORG,name:"Tienda Aurora",role:"member"}]});
 expect(await screen.findByText(/reservada al propietario/)).toBeTruthy();expect(server).not.toHaveBeenCalled();
});
it("rechaza una oficina incoherente sin mostrar agentes",async()=>{
 routes({"execution/office-overview":()=>new Response(JSON.stringify({...mockOverview(),worker_online_verified:true}))});
 view();expect((await screen.findByRole("alert")).textContent).toMatch(/No se pudo confirmar/);expect(screen.queryByText("Programador web")).toBeNull();
});

it("componentes sueltos: TeamSidebar y AgentBar sin datos",()=>{
 const agents=buildAgents([],[],[],[]);
 render(<TeamSidebar agents={agents} ownerName="Tú" selectedId={null} filter="all" query="" onFilter={vi.fn()} onQuery={vi.fn()} onSelect={vi.fn()}/>);
 expect(screen.getByText("Esta empresa todavía no tiene agentes registrados.")).toBeTruthy();
 render(<AgentBar agent={null} requestsAvailable canRequest onRequest={vi.fn()} onOpenModule={vi.fn()}/>);
 expect(screen.getByText(/Selecciona un agente/)).toBeTruthy();
});


/* ---------- Personajes: caras, «te necesita», «Te toca», agentes por crear y chat ---------- */
const holding=(caps:string[])=>({enabled:true,holdings:[{id:"h1",name:"Holding",max_companies:5,is_owner:true,companies:[{organization_id:MOCK_ORG,name:"Tienda Aurora",slot:1,project_name:"Tienda",project_summary:"Venta de cerámica con pedidos.",repository:null,website_url:null,
 capabilities:caps.map(c=>({capability:c,state:"enabled"})),departments:9,workers:9,active_workers:5,tasks:{pending:1,blocked:1,completed:2,other:0},routines_active:0,missions:0,autopilots_active:0,created_at:"2026-10-01T10:00:00Z"}]}]});
const json=(v:unknown,s=200)=>()=>new Response(JSON.stringify(v),{status:s});

it("modelo: cada agente sabe en qué necesita al propietario, y la cara es siempre la misma",()=>{
 const o=mockOverview(),w=o.workers[0],w2=o.workers[1];
 const tasks=[{id:"t1",department_id:w.department_id,assignee_worker_id:w.id,title:"Bloqueada A",status:"blocked",created_at:"2026-11-01T10:00:00Z"},{id:"t2",department_id:w.department_id,assignee_worker_id:w.id,title:"Normal",status:"pending",created_at:"2026-11-01T10:00:00Z"}];
 const agents=buildAgents([{...w,phase:"available",task_id:null,task_title:null},{...w2,phase:"awaiting_review",task_id:"t9",task_title:"Informe de octubre"}],o.departments,tasks,[]);
 expect(agents[0].needs).toEqual([{id:"t1",title:"Bloqueada A",kind:"blocked"}]);
 expect(agents[1].needs).toEqual([{id:"t9",title:"Informe de octubre",kind:"review"}]);
 const all=[...agents,...ghostAgents([{capability:"monitoring",department:"Monitorización y Fallos",label:"Fallos"}])];
 expect(needsCount(all)).toBe(2);expect(inbox(all).map(x=>x.need.id)).toEqual(["t1","t9"]);
 expect(all[2]).toMatchObject({id:"ghost:monitoring",ghost:true,name:"Agente de Fallos",needs:[]});
 expect(faceOf("abc")).toEqual(faceOf("abc"));expect([greeting(8),greeting(15),greeting(23)]).toEqual(["Buenos días","Buenas tardes","Buenas noches"]);
});

it("saluda con el recuento, enseña el globo rojo y «Te toca» lleva al agente",async()=>{
 const o=mockOverview(),w=o.workers[0];
 routes({tasks:json([...mockTasks(),{id:"tb",department_id:w.department_id,assignee_worker_id:w.id,title:"Decidir el presupuesto",status:"blocked",created_at:"2026-11-20T10:00:00Z"}])});
 view();await screen.findByText(/te necesita/);
 expect(screen.getByText(/Laura\. \d+ agentes? trabajando · \d+ te necesitan?\./)).toBeTruthy();
 const boton=screen.getByRole("button",{name:/Te toca/});expect(within(boton).getByText(/\d+/)).toBeTruthy();
 fireEvent.click(boton);const panel=screen.getByRole("region",{name:"Te toca"});
 const fila=within(panel).getByText("Decidir el presupuesto").closest("li")!;
 fireEvent.click(within(fila).getByRole("button",{name:"Ver"}));
 expect(screen.queryByRole("region",{name:"Te toca"})).toBeNull();
 const barra=screen.getByRole("region",{name:"Agente seleccionado: "+w.name});
 expect(within(within(barra).getByRole("list",{name:/necesita de ti/})).getByText("Decidir el presupuesto")).toBeTruthy();
 fireEvent.click(within(barra).getAllByRole("button",{name:"Ver"})[0]);expect(navigate).toHaveBeenCalledWith("Tareas");
});

it("los departamentos que faltan salen como agentes por crear, en gris y sin poder encargarles nada",async()=>{
 routes({holding:json(holding(["seo","email","orders"]))});
 view();const lista=await screen.findByRole("list",{name:"Agentes por crear"});
 expect(within(lista).getAllByRole("button").map(b=>b.getAttribute("aria-label"))).toEqual(["Agente de Fallos · por crear","Agente de Automatizaciones · por crear"]);
 expect(screen.getByRole("tab",{name:"Monitorización y Fallos"})).toBeTruthy();
 fireEvent.click(within(lista).getAllByRole("button")[0]);
 const barra=screen.getByRole("region",{name:"Agente por crear: Agente de Fallos"});
 expect(within(barra).queryByRole("button",{name:/Pedir una tarea/})).toBeNull();expect(within(barra).queryByRole("button",{name:/Hablar con/})).toBeNull();
 fireEvent.click(within(barra).getByRole("button",{name:/Añadirlo en el Campus/}));expect(navigate).toHaveBeenCalledWith("Campus");
 expect(screen.getByText(/\d+ trabajando$/).textContent).toBe("5 trabajando");                                 // los que no existen no cuentan
});

it("sin holding no se inventa ningún agente por crear",async()=>{
 view();await screen.findByText("5 trabajando");expect(screen.queryByRole("list",{name:"Agentes por crear"})).toBeNull();
});

it("chat con un agente: pregunta sugerida, respuesta suya y aviso si el servidor aún no lo ofrece",async()=>{
 const o=mockOverview();view();await screen.findByText("5 trabajando");
 const elegido=screen.getByRole("region",{name:/^Agente seleccionado: /});const nombre=elegido.getAttribute("aria-label")!.replace("Agente seleccionado: ","");
 const id=o.workers.find(x=>x.name===nombre)!.id;
 routes({"eliot/chat":json({answer:"Tengo dos tareas abiertas.",mode:"verified_data",read_only:true,organization_id:MOCK_ORG,worker_id:id})});
 fireEvent.click(within(elegido).getByRole("button",{name:/Hablar con/}));
 const chat=screen.getByRole("dialog",{name:"Chat con "+nombre});
 fireEvent.click(within(chat).getByRole("button",{name:"¿Qué tienes entre manos?"}));
 expect(await within(chat).findByText("Tengo dos tareas abiertas.")).toBeTruthy();
 expect(posts).toEqual([{url:expect.stringContaining("/eliot/chat"),body:{question:"¿Qué tienes entre manos?",worker_id:id}}]);
 routes({"eliot/chat":json({answer:"de otro",read_only:true,organization_id:MOCK_ORG,worker_id:"otro"})});
 fireEvent.change(within(chat).getByLabelText("Tu pregunta"),{target:{value:"¿y ahora?"}});fireEvent.click(within(chat).getByRole("button",{name:"Enviar"}));
 expect((await within(chat).findByRole("alert")).textContent).toMatch(/No he podido hablar/);                 // una respuesta de otro agente no se enseña
 expect(within(chat).queryByText("de otro")).toBeNull();
 fireEvent.click(within(chat).getByRole("button",{name:"Cerrar"}));expect(screen.queryByRole("dialog",{name:"Chat con "+nombre})).toBeNull();
});

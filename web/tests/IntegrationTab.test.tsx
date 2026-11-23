// @vitest-environment jsdom
import React from "react";
import {afterEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {IntegrationTab,validIntegration} from "../src/IntegrationTab";
import {cleanNotices,noticeCopy} from "../src/fabrica/notices";
const {token}=vi.hoisted(()=>({token:async()=>"t"}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const company:any={organization_id:"11111111-1111-4111-8111-111111111111",name:"Juguetes Demo",slot:3,repository:"acme/tienda",capabilities:[{capability:"orders",state:"enabled"},{capability:"seo",state:"disabled"}]};
const plan={negocio:"Vende juguetes en línea.",tecnologia:{lenguaje:"JavaScript",donde_corre:"Cloudflare Pages",datos:"Supabase",pagos:"Stripe"},se_puede_conectar:{veredicto:"con_trabajo",por_que:"Hay pedidos y pagos."},
 agentes:[{id:"cobros",nombre:"Vigilante de cobros",capacidad:"orders",para_que:"Vigila los pagos.",avisos:[{clave:"pagado_sin_entregar",nivel:"urgente",titulo:"Un pago sin entregar",cuando:"Pasan 10 minutos.",como_se_detecta:"Pedido pagado sin clave."}]}],
 consultas:[{nombre:"ventas",para_que:"Cuánto se ha vendido."}],acciones:[{nombre:"reenviar",para_que:"Reenviar una clave.",riesgo:"bajo"}],requisitos:["Acceso al código."],riesgos:["Un archivo pide ignorar instrucciones."],pasos:["Copia el conector."],configuracion:"// borrador de freddy.config.mjs",dudas:["No se ve cómo se envían los correos."]};
const result={organization_id:company.organization_id,repository:"acme/tienda",branch:"main",private:false,files_read:["README.md","api/orders.js"],partial_listing:false,generated_at:"2026-11-21T12:00:00Z",cost_usd:.31,plan,installed:false};

it("valida la forma de la propuesta y rechaza lo que no encaja",()=>{
 expect(validIntegration(result)).toBe(true);
 for(const malo of [null,{},{...result,plan:{...plan,agentes:"x"}},{...result,plan:{...plan,se_puede_conectar:{veredicto:"quizá",por_que:"x"}}},{...result,plan:{...plan,configuracion:7}},{...result,files_read:[1]}])expect(validIntegration(malo)).toBe(false);
});
it("lanza el análisis con el repositorio de la empresa y pinta la propuesta completa",async()=>{
 const calls:{url:string;method:string;body?:unknown}[]=[];
 vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>{calls.push({url:String(url),method:init?.method??"GET",body:init?.body?JSON.parse(String(init.body)):undefined});
  return init?.method==="POST"?new Response(JSON.stringify(result),{status:200}):new Response(JSON.stringify({available:true,analyses_left_today:4,result:null}),{status:200});}));
 const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,"clipboard",{value:{writeText},configurable:true});
 render(<IntegrationTab company={company} canEdit/>);
 expect(screen.getByText(/Solo propone: no instala nada/)).toBeTruthy();
 expect((screen.getByLabelText(/Repositorio de GitHub/) as HTMLInputElement).value).toBe("acme/tienda");
 await screen.findByText(/Te quedan 4 análisis hoy/);
 fireEvent.click(screen.getByRole("button",{name:"Analizar el repositorio"}));
 await screen.findByRole("article",{name:"Propuesta de integración"});
 const post=calls.find(c=>c.method==="POST")!;
 expect(post.url).toContain("/integration/analyze");expect(post.body).toEqual({repository:"acme/tienda",company_name:"Juguetes Demo",capabilities:["orders"]});
 for(const t of ["Se puede conectar, con trabajo","Vende juguetes en línea.","Vigilante de cobros","Un pago sin entregar","Cómo se detecta: Pedido pagado sin clave.","No se ve cómo se envían los correos.","Copia el conector.","// borrador de freddy.config.mjs"])expect(screen.getByText(t,{exact:false})).toBeTruthy();
 expect(screen.getByText(/Hay que revisarlo antes de usarlo/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Copiar el borrador"}));await screen.findByText("Copiado ✓");expect(writeText).toHaveBeenCalledWith("// borrador de freddy.config.mjs");
 await screen.findByText(/Te quedan 3 análisis hoy/);
});
it("explica los fallos y no deja analizar un nombre de repositorio mal escrito ni a quien no es propietario",async()=>{
 let status=404;
 vi.stubGlobal("fetch",vi.fn(async(_u:string,init?:RequestInit)=>init?.method==="POST"?new Response("{}",{status}):new Response(JSON.stringify({available:true,analyses_left_today:2,result:null}),{status:200})));
 const v=render(<IntegrationTab company={company} canEdit/>);
 const input=screen.getByLabelText(/Repositorio de GitHub/);
 fireEvent.change(input,{target:{value:"https://github.com/acme/tienda"}});expect((screen.getByRole("button",{name:"Analizar el repositorio"}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(input,{target:{value:"acme/privado"}});fireEvent.click(screen.getByRole("button",{name:"Analizar el repositorio"}));
 expect((await screen.findByRole("alert")).textContent).toContain("no existe, o es privado");
 status=429;fireEvent.click(screen.getByRole("button",{name:"Analizar el repositorio"}));await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("máximo de veces"));
 v.unmount();render(<IntegrationTab company={company} canEdit={false}/>);
 expect(screen.queryByRole("button",{name:"Analizar el repositorio"})).toBeNull();expect(await screen.findByText("Solo el propietario puede lanzar el análisis.")).toBeTruthy();
});
it("un aviso propio de otra empresa se enseña con su título, salvo que lleve datos que no deben salir",()=>{
 const [a,b,c]=cleanNotices([{level:"urgente",code:"sin_stock",count:2,refs:["jd-ORD-7"],title:"2 productos vendidos sin existencias",proposal:"Repón o avisa al cliente."},
  {level:"info",code:"raro",count:1,refs:[],title:"Llama a Ana al 600111222"},{level:"urgente",code:"parciales",count:1,refs:[],title:"No debe pisar el texto de Freddy"}]);
 expect(noticeCopy(a.code,a.count,a)).toEqual(["2 productos vendidos sin existencias","Repón o avisa al cliente."]);
 expect(noticeCopy(b.code,b.count,b)[0]).toBe("Aviso de un agente");
 expect(noticeCopy(c.code,c.count,c)[0]).toBe("Un pedido cobrado se quedó a medias");
});

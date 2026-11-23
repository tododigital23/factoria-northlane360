// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {cleanup,render,screen,waitFor} from "@testing-library/react";
import {PortalAgents,validPortalSummary} from "../src/office/PortalAgents";

const ORG="org-1",server=vi.fn(),token=vi.fn(async()=>"opaque");
const NOW=Date.parse("2026-11-17T14:00:00Z");
const summary=(over:Record<string,unknown>={})=>({organization_id:ORG,stored_in_freddy:false,configured:true,available:true,reason:null,
 panel_url:"https://clientes.ejemplo/admin/clients.html",generated_at:"2026-11-17T14:00:00.000Z",
 watch:{counting_since:"2026-11-17T10:00:00.000Z",last_scheduled_run:null},
 agents:[
  {id:"atencion",name:"Agente de atención al cliente",state:"activo",capability:"email",model:"claude-opus-5-5",
   last_24h:{respuestas:12,pasadas_al_dueno:3,graves:1,sin_respuesta:0,frenos:0,gestiones:2},
   month:{month:"2026-11",spent_usd:4.26,cap_usd:30,replies:71},last_activity:"2026-11-17T13:40:00Z"},
  {id:"cobros",name:"Vigilante de cobros",state:"alerta",capability:"orders",alerts:{urgentes:1,importantes:0,informativas:0}},
  {id:"seguridad",name:"Vigilante de seguridad",state:"ok",capability:"monitoring",alerts:{urgentes:0,importantes:0,informativas:0}}],...over});
const reply=(v:unknown,s=200)=>server.mockResolvedValue(new Response(JSON.stringify(v),{status:s}));
beforeEach(()=>{server.mockReset();token.mockClear();vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=()=>render(<PortalAgents organizationId={ORG} token={token} now={NOW}/>);

it("pide solo con GET autenticado el resumen de ESTA empresa",async()=>{
 reply(summary());view();await screen.findByRole("heading",{name:"Agentes del portal"});
 expect(server).toHaveBeenCalledTimes(1);const [url,init]=server.mock.calls[0];
 expect(String(url)).toMatch(/\/v1\/me\/organizations\/org-1\/portal-agents$/);
 expect(init.method).toBeUndefined();expect(init.headers.Authorization).toBe("Bearer opaque");
});
it("muestra cada agente con su estado, su departamento y sus cifras",async()=>{
 reply(summary());view();await screen.findByText("Agente de atención al cliente");
 expect(screen.getByText("3 de 3 en marcha")).toBeTruthy();
 expect(screen.getByText("Activo")).toBeTruthy();expect(screen.getByText("Alerta urgente")).toBeTruthy();expect(screen.getByText("Sin incidencias")).toBeTruthy();
 expect(screen.getByText(/Atención y Email · claude-opus-5-5/)).toBeTruthy();expect(screen.getByText("Pedidos")).toBeTruthy();expect(screen.getByText("Monitorización y Fallos")).toBeTruthy();
 const card=screen.getByText("Agente de atención al cliente").closest("li")!;
 expect(card.textContent).toContain("12 respuestas");expect(card.textContent).toContain("3 pasadas a ti");expect(card.textContent).toContain("1 graves");expect(card.textContent).toContain("2 gestiones");
 expect(card.textContent).toContain("4,26 $ de 30,00 $");expect(card.textContent).toContain("Última respuesta hace 20 min");
 expect(screen.getByText("Vigilante de cobros").closest("li")!.textContent).toContain("1 urgentes");
 expect(screen.getByText("Vigilante de seguridad").closest("li")!.textContent).toContain("Nada pendiente");
});
it("avisa de que los datos de clientes no salen del portal y enlaza a su panel en pestaña nueva",async()=>{
 reply(summary());view();await screen.findByRole("heading",{name:"Agentes del portal"});
 expect(screen.getByText(/los datos de tus clientes se quedan en el portal/)).toBeTruthy();
 const link=screen.getByRole("link",{name:/Abrir el panel del portal/}) as HTMLAnchorElement;
 expect(link.href).toBe("https://clientes.ejemplo/admin/clients.html");expect(link.target).toBe("_blank");expect(link.rel).toContain("noopener");
});
it("empresa sin portal conectado: no pinta nada",async()=>{
 reply(summary({configured:false,available:false,reason:"not_configured",panel_url:null,agents:[]}));const {container}=view();
 await waitFor(()=>expect(server).toHaveBeenCalled());await Promise.resolve();
 expect(container.innerHTML).toBe("");
});
it.each([404,503,500,403])("servidor sin esta lectura o sin permiso (%i): no pinta nada ni rompe la oficina",async status=>{
 reply({},status);const {container}=view();await waitFor(()=>expect(server).toHaveBeenCalled());await Promise.resolve();
 expect(container.innerHTML).toBe("");
});
it("portal caído: lo dice sin detalles técnicos y mantiene el botón del panel",async()=>{
 reply(summary({available:false,reason:"portal_unreachable",agents:[]}));view();
 expect((await screen.findByRole("alert")).textContent).toMatch(/No se ha podido contactar con el portal/);
 expect(screen.getByRole("link",{name:/Abrir el panel del portal/})).toBeTruthy();
});
it("clave rechazada por el portal: mensaje propio",async()=>{
 reply(summary({available:false,reason:"portal_rejected_key",agents:[]}));view();
 expect((await screen.findByRole("alert")).textContent).toMatch(/ha rechazado la clave de Freddy/);
});
it("agente apagado o frenado no cuenta como en marcha",async()=>{
 const s=summary();(s.agents as {state:string}[])[0].state="frenado";(s.agents as {state:string}[])[2].state="apagado";
 reply(s);view();expect(await screen.findByText("1 de 3 en marcha")).toBeTruthy();
 expect(screen.getByText("Frenado por tope de gasto")).toBeTruthy();expect(screen.getByText("Apagado")).toBeTruthy();
});
it("cifras que faltan se muestran con raya, sin inventar ceros",async()=>{
 const s=summary();(s.agents as Record<string,unknown>[])[0].last_24h={respuestas:null,pasadas_al_dueno:null,graves:null,sin_respuesta:null,frenos:null,gestiones:null};
 (s.agents as Record<string,unknown>[])[0].month={month:null,spent_usd:null,cap_usd:null,replies:null};
 reply(s);view();const card=(await screen.findByText("Agente de atención al cliente")).closest("li")!;
 expect(card.textContent).toContain("— respuestas");expect(card.textContent).toContain("— de —");
});
it("respuesta con forma inesperada o de otra empresa: se descarta entera",async()=>{
 for(const bad of [summary({organization_id:"otra"}),summary({agents:[{id:"x"}]}),summary({panel_url:"javascript:alert(1)"}),summary({agents:"no"}),
  summary({agents:[{id:"a",name:"Agente",state:"activo",capability:"email",last_24h:{respuestas:"muchas"}}]}),"texto",null]){
  expect(validPortalSummary(bad,ORG)).toBe(false);
 }
 expect(validPortalSummary(summary(),ORG)).toBe(true);
 reply(summary({organization_id:"otra"}));const {container}=view();await waitFor(()=>expect(server).toHaveBeenCalled());await Promise.resolve();
 expect(container.innerHTML).toBe("");
});
it("texto raro en un nombre se pinta como texto, nunca como HTML",async()=>{
 const s=summary();(s.agents as {name:string}[])[1].name="<img src=x onerror=alert(1)>";
 reply(s);const {container}=view();await screen.findByText("<img src=x onerror=alert(1)>");
 expect(container.querySelector("img")).toBeNull();
});

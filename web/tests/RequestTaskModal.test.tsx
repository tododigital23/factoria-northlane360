// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {RequestTaskModal} from "../src/office/RequestTaskModal";
import {departmentCopy} from "../src/office/officeModel";
import type {Agent} from "../src/office/officeModel";

const ORG="org-1",agent:Agent={id:"w-1",name:"Estratega de campañas",specialty:"Campañas",departmentId:"d-1",departmentName:"Marketing",status:"available",phase:"available",progress:0,headline:"Listo para su próxima tarea",step:"",activity:"Sin tarea en curso",lastAssignedAt:null,motionActive:false};
const ack={organization_id:ORG,worker_id:"w-1",task_id:"t-1",department_id:"d-1",title:"Ideas de campaña",status:"pending",replayed:false,execution_started:false};
const server=vi.fn(),token=vi.fn(async()=>"opaque"),created=vi.fn(),close=vi.fn();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
beforeEach(()=>{server.mockReset();created.mockReset();close.mockReset();vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=(p:Partial<React.ComponentProps<typeof RequestTaskModal>>={})=>render(<RequestTaskModal organizationId={ORG} agent={agent} available canRequest token={token} onClose={close} onCreated={created} {...p}/>);
const area=()=>screen.getByRole("textbox",{name:/Tu encargo/});
const submit=()=>screen.getByRole("button",{name:"Asignar a Estratega de campañas →"});
const body=(i:number)=>JSON.parse(server.mock.calls[i][1].body);

it("muestra la cabecera del agente, valida 10–2000 caracteres y cuenta caracteres",()=>{
 view();
 expect(screen.getByRole("dialog",{name:"Estratega de campañas"})).toBeTruthy();expect(screen.getByText("¿Qué necesitas?")).toBeTruthy();expect(screen.getByText("Marketing")).toBeTruthy();
 expect((submit() as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(area(),{target:{value:"Corto"}});expect(screen.getByText("5 / 2000")).toBeTruthy();expect((submit() as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText(/al menos 10 caracteres/)).toBeTruthy();
 fireEvent.change(area(),{target:{value:"Una campaña para clientes"}});expect((submit() as HTMLButtonElement).disabled).toBe(false);
 expect((area() as HTMLTextAreaElement).maxLength).toBe(2000);
 expect(screen.getByText("Qué vas a recibir")).toBeTruthy();expect(screen.getByText(departmentCopy("Marketing").receive)).toBeTruthy();
});
it("«Usar ejemplo» rellena el ejemplo del departamento",()=>{
 view();fireEvent.click(screen.getByRole("button",{name:"Usar ejemplo"}));expect((area() as HTMLTextAreaElement).value).toBe(departmentCopy("Marketing").example);
});
it("envía el payload exacto una sola vez aunque se pulse dos veces",async()=>{
 let finish!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>{finish=r;}));
 view();fireEvent.change(area(),{target:{value:"  Tres ideas de campaña  "}});fireEvent.change(screen.getByRole("textbox",{name:/Resultado que esperas/}),{target:{value:"Una lista"}});
 fireEvent.click(submit());fireEvent.click(screen.getByRole("button",{name:"Asignando…"}));
 await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));
 const [url,init]=server.mock.calls[0];
 expect(url).toBe("https://api.tu-factoria.example/v1/me/organizations/org-1/workers/w-1/requests");
 expect(init.method).toBe("POST");expect(init.headers.Authorization).toBe("Bearer opaque");
 const b=body(0);expect(Object.keys(b).sort()).toEqual(["deliverable","request","request_key"]);expect(b.request).toBe("Tres ideas de campaña");expect(b.deliverable).toBe("Una lista");expect(b.request_key).toMatch(uuid);
 finish(new Response(JSON.stringify(ack),{status:201}));
 await screen.findByText("Encargo registrado");expect(created).toHaveBeenCalledWith(ack);expect(screen.getByText(/No se ha iniciado ninguna ejecución/)).toBeTruthy();
});
it("sin resultado esperado envía deliverable null",async()=>{
 server.mockResolvedValue(new Response(JSON.stringify(ack),{status:201}));view();fireEvent.change(area(),{target:{value:"Tres ideas de campaña"}});fireEvent.click(submit());
 await screen.findByText("Encargo registrado");expect(body(0).deliverable).toBeNull();
});
it("tras un error de red reintenta con la MISMA clave y al editar genera una clave nueva",async()=>{
 server.mockRejectedValueOnce(new TypeError("red"));server.mockRejectedValueOnce(new TypeError("red"));server.mockResolvedValueOnce(new Response(JSON.stringify(ack),{status:201}));
 view();fireEvent.change(area(),{target:{value:"Tres ideas de campaña"}});
 fireEvent.click(submit());await screen.findByRole("alert");expect(screen.getByRole("alert").textContent).toMatch(/no se duplicará/);
 fireEvent.click(submit());await waitFor(()=>expect(server).toHaveBeenCalledTimes(2));await screen.findByRole("alert");
 expect(body(1).request_key).toBe(body(0).request_key);
 fireEvent.change(area(),{target:{value:"Tres ideas de campaña para enero"}});fireEvent.click(submit());
 await screen.findByText("Encargo registrado");expect(body(2).request_key).not.toBe(body(0).request_key);expect(body(2).request_key).toMatch(uuid);
});
it("409: explica que el agente no puede recibir encargos",async()=>{
 server.mockResolvedValue(new Response("{}",{status:409}));view();fireEvent.change(area(),{target:{value:"Tres ideas de campaña"}});fireEvent.click(submit());
 expect((await screen.findByRole("alert")).textContent).toMatch(/no puede recibir encargos/);expect(created).not.toHaveBeenCalled();
});
it("503/404: deshabilita con nota neutral de actualización del servidor",async()=>{
 server.mockResolvedValue(new Response("{}",{status:503}));view();fireEvent.change(area(),{target:{value:"Tres ideas de campaña"}});fireEvent.click(submit());
 await screen.findByRole("alert");expect(screen.getAllByText(/disponible al actualizar el servidor/).length).toBeGreaterThan(0);expect((submit() as HTMLButtonElement).disabled).toBe(true);
 cleanup();view({available:false});expect(screen.getByRole("note").textContent).toMatch(/disponible al actualizar el servidor/);fireEvent.change(area(),{target:{value:"Tres ideas de campaña"}});expect((submit() as HTMLButtonElement).disabled).toBe(true);
});
it("rechaza un acuse incoherente (ejecución iniciada) sin darlo por registrado",async()=>{
 server.mockResolvedValue(new Response(JSON.stringify({...ack,execution_started:true}),{status:201}));view();fireEvent.change(area(),{target:{value:"Tres ideas de campaña"}});fireEvent.click(submit());
 expect((await screen.findByRole("alert")).textContent).toMatch(/no es coherente/);expect(created).not.toHaveBeenCalled();
});
it("avisa de que con el agente inactivo la tarea queda pendiente",()=>{
 view({agent:{...agent,status:"inactive"}});expect(screen.getByText(/quedará pendiente hasta que lo actives/)).toBeTruthy();
});
it("se cierra con Escape y con el botón Cerrar",()=>{
 view();fireEvent.keyDown(window,{key:"Escape"});expect(close).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByRole("button",{name:"Cerrar"}));expect(close).toHaveBeenCalledTimes(2);
});

it("Ctrl+Intro o Cmd+Intro envían el encargo; Intro sola en el texto solo hace salto de línea",async()=>{
 server.mockImplementation(()=>Promise.resolve(new Response(JSON.stringify(ack),{status:201})));
 view();fireEvent.change(area(),{target:{value:"Una campaña para clientes"}});
 fireEvent.keyDown(area(),{key:"Enter"});expect(server).not.toHaveBeenCalled();
 fireEvent.keyDown(area(),{key:"Enter",ctrlKey:true});
 await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));expect(body(0).request).toBe("Una campaña para clientes");
});
it("el atajo no envía un encargo que aún no es válido",()=>{
 view();fireEvent.change(area(),{target:{value:"Corto"}});fireEvent.keyDown(area(),{key:"Enter",metaKey:true});expect(server).not.toHaveBeenCalled();
});

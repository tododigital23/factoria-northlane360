// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {SharedMemory,MemoryCore} from "../src/office/SharedMemory";
import type {MemoryItem} from "../src/office/officeModel";

const server=vi.fn(),token=vi.fn(async()=>"opaque"),saved=vi.fn(),close=vi.fn();
const items:MemoryItem[]=[{key:"audience",content:"Familias jóvenes",updated_at:"2026-11-10T10:00:00Z"},{key:"pricing",content:"   ",updated_at:null}];
beforeEach(()=>{server.mockReset();saved.mockReset();vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=(p:Partial<React.ComponentProps<typeof SharedMemory>>={})=>render(<SharedMemory organizationId="org-1" memory={{state:"ready",data:items}} canEdit token={token} onSaved={saved} onClose={close} {...p}/>);

it("muestra las seis skills y marca solo las que tienen contenido",()=>{
 view();render(<MemoryCore/>);
 expect(screen.getByText("Memoria compartida")).toBeTruthy();expect(screen.getByText("Todos los agentes de esta empresa saben lo que pasa")).toBeTruthy();
 expect(screen.getByText("Lo que saben todos")).toBeTruthy();
 expect(screen.getByRole("button",{name:"A quién vendo · con contenido"})).toBeTruthy();
 expect(screen.getByRole("button",{name:"Mis precios · vacío"})).toBeTruthy();
 for(const l of ["Propuesta de valor","Tono de marca","Productos y servicios","Preguntas frecuentes"])expect(screen.getByRole("button",{name:l+" · vacío"})).toBeTruthy();
 expect(screen.getByText(/1 de 6 completados/)).toBeTruthy();
});
it("el propietario edita un elemento con POST exacto y se confirma",async()=>{
 server.mockResolvedValue(new Response(JSON.stringify({organization_id:"org-1",key:"pricing",updated:true})));
 view();fireEvent.click(screen.getByRole("button",{name:"Mis precios · vacío"}));
 const box=screen.getByRole("textbox",{name:/Mis precios/}) as HTMLTextAreaElement;expect(box.maxLength).toBe(2000);
 fireEvent.change(box,{target:{value:"Desde 20 €"}});expect(screen.getByText("10 / 2000")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Guardar"}));fireEvent.click(screen.getByRole("button",{name:"Guardando…"}));
 await waitFor(()=>expect(saved).toHaveBeenCalledWith("pricing","Desde 20 €"));
 expect(server).toHaveBeenCalledTimes(1);const [url,init]=server.mock.calls[0];
 expect(url).toBe("https://api.tu-factoria.example/v1/me/organizations/org-1/memory/pricing");expect(init.method).toBe("POST");expect(JSON.parse(init.body)).toEqual({content:"Desde 20 €"});expect(init.headers.Authorization).toBe("Bearer opaque");
});
it("permite vaciar un elemento (0 caracteres)",async()=>{
 server.mockResolvedValue(new Response(JSON.stringify({organization_id:"org-1",key:"audience",updated:true})));
 view();fireEvent.click(screen.getByRole("button",{name:"A quién vendo · con contenido"}));fireEvent.change(screen.getByRole("textbox",{name:/A quién vendo/}),{target:{value:""}});
 fireEvent.click(screen.getByRole("button",{name:"Guardar"}));await waitFor(()=>expect(saved).toHaveBeenCalledWith("audience",""));
});
it("no da por guardada una respuesta incoherente ni un 403",async()=>{
 server.mockResolvedValueOnce(new Response(JSON.stringify({organization_id:"otra",key:"pricing",updated:true})));server.mockResolvedValueOnce(new Response("{}",{status:403}));
 view();fireEvent.click(screen.getByRole("button",{name:"Mis precios · vacío"}));fireEvent.change(screen.getByRole("textbox",{name:/Mis precios/}),{target:{value:"Desde 20 €"}});
 fireEvent.click(screen.getByRole("button",{name:"Guardar"}));expect((await screen.findByRole("alert")).textContent).toMatch(/no es coherente/);
 fireEvent.click(screen.getByRole("button",{name:"Guardar"}));await waitFor(()=>expect(screen.getByRole("alert").textContent).toMatch(/Solo el propietario/));expect(saved).not.toHaveBeenCalled();
});
it("quien no es propietario solo lee",()=>{
 view({canEdit:false});fireEvent.click(screen.getByRole("button",{name:"A quién vendo · con contenido"}));
 expect((screen.getByRole("textbox",{name:/A quién vendo/}) as HTMLTextAreaElement).readOnly).toBe(true);expect(screen.queryByRole("button",{name:"Guardar"})).toBeNull();expect(screen.getByText(/Solo lectura/)).toBeTruthy();
});
it("sin servidor actualizado queda deshabilitada con nota neutral",()=>{
 view({memory:{state:"unavailable"}});expect(screen.getByRole("note").textContent).toMatch(/disponible al actualizar el servidor/);
 expect((screen.getByRole("button",{name:"A quién vendo · vacío"}) as HTMLButtonElement).disabled).toBe(true);expect(server).not.toHaveBeenCalled();
});

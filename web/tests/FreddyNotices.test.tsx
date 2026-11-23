// @vitest-environment jsdom
import React from "react";
import {afterEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,waitFor,within,fireEvent} from "@testing-library/react";
import {FreddyNotices} from "../src/fabrica/FreddyNotices";
import {cleanNotices,collectNotices,noticeChanges,noticeCopy} from "../src/fabrica/notices";
import type {CompanyFeed} from "../src/fabrica/notices";

/** Los avisos viven detrás de la campana: se toca y se abre el panel. */
const abrir=async()=>{fireEvent.click(await screen.findByRole("button",{name:/^Avisos de Freddy: /}));return screen.getByRole("region",{name:"Avisos de Freddy"});};
const ORG="11111111-1111-4111-8111-111111111111";
const agent=(notices:unknown,id="cobros",name="Vigilante de cobros")=>({id,name,state:"alerta",capability:"orders",notices});
const summary=(agents:unknown[])=>({organization_id:ORG,configured:true,available:true,reason:null,panel_url:"https://portal.example.com/admin/clients.html",agents});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.useRealTimers();});

describe("avisos de Freddy · datos",()=>{
 it("solo acepta gravedad, clave, número y referencias de pedido; lo demás se descarta",()=>{
  expect(cleanNotices([{level:"urgente",code:"parciales",count:3,refs:["ab-ORD-1373","Pedro García","pedro@correo.es","+34 600 111 222","ab-ORD-1378-C","ab-ORD-1373",7,null],texto:"Pedro debe 65 €",cliente:"Pedro"},
   {level:"grave",code:"parciales",count:1,refs:[]},{level:"info",code:"Con espacios",count:1,refs:[]},"texto",null]))
   .toEqual([{level:"urgente",code:"parciales",count:3,refs:["ab-ORD-1373","ab-ORD-1378-C"]}]);
  expect(cleanNotices("nada")).toEqual([]);expect(cleanNotices(undefined)).toEqual([]);
  expect(cleanNotices([{level:"info",code:"chat",count:-2,refs:"x"}])).toEqual([{level:"info",code:"chat",count:null,refs:[]}]);
 });
 it("el texto se compone aquí a partir de la clave, en singular o plural",()=>{
  expect(noticeCopy("parciales",1)[0]).toBe("Un pedido cobrado se quedó a medias");
  expect(noticeCopy("parciales",3)[0]).toBe("3 pedidos cobrados se quedaron a medias");
  expect(noticeCopy("clave_nueva",2)[0]).toBe("Aviso de un agente");
  expect(noticeCopy("error_cobros",null)[0]).toBe("Un agente no pudo completar su revisión");
 });
 it("reúne los avisos de todas las empresas con los urgentes primero y detecta lo nuevo y lo resuelto",()=>{
  const feed=(org:string,company:string,notices:unknown):CompanyFeed=>({organizationId:org,company,slot:1,panelUrl:null,agents:[agent(notices) as never]});
  const antes=collectNotices([feed("a","Alfa",[{level:"info",code:"chat",count:1,refs:[]}]),feed("b","Beta",[{level:"urgente",code:"parciales",count:1,refs:["ab-ORD-1"]}])]);
  expect(antes.map(n=>n.company+":"+n.level)).toEqual(["Beta:urgente","Alfa:info"]);
  const despues=collectNotices([feed("a","Alfa",[]),feed("b","Beta",[{level:"urgente",code:"parciales",count:2,refs:["ab-ORD-1","ab-ORD-2"]},{level:"importante",code:"decision",count:1,refs:[]}])]);
  const ch=noticeChanges(antes,despues);
  expect(ch.resolved.map(n=>n.key)).toEqual(["a:cobros:chat"]);
  expect(ch.fresh.map(n=>n.code)).toEqual(["parciales","decision"]);
  expect(noticeChanges(despues,despues)).toEqual({fresh:[],resolved:[]});
 });
});

describe("avisos de Freddy · bandeja",()=>{
 const companies=[{organization_id:ORG,name:"Nova Demo Portal",slot:1}];
 it("muestra cada aviso con su empresa, su agente, sus pedidos y la propuesta, y avisa de lo resuelto",async()=>{
  let notices:unknown=[{level:"urgente",code:"parciales",count:3,refs:["ab-ORD-1373","ab-ORD-1378-C"]},{level:"importante",code:"decision",count:1,refs:[]}];
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(summary([agent(notices)])),{status:200})));
  vi.useFakeTimers({shouldAdvanceTime:true});
  const change=vi.fn(),select=vi.fn();
  render(<FreddyNotices companies={companies} token={async()=>"t"} onChange={change} onSelect={select}/>);
  const box=await abrir();
  expect(within(box).getAllByRole("status")[0].textContent).toContain("1 urgente · 1 importante");
  const items=within(box).getAllByRole("listitem");expect(items).toHaveLength(2);
  expect(within(box).getByText("Ver 1 aviso más")).toBeTruthy();
  expect(items[0].textContent).toContain("Nova Demo Portal · Vigilante de cobros");
  expect(items[0].textContent).toContain("3 pedidos cobrados se quedaron a medias");
  expect(items[0].textContent).toContain("ab-ORD-1373");expect(items[0].textContent).toContain("y 1 más");
  expect(within(items[0]).getByRole("link").getAttribute("href")).toBe("https://portal.example.com/admin/clients.html");
  fireEvent.click(within(items[0]).getByRole("button",{name:"Ver la empresa"}));expect(select).toHaveBeenCalledWith(1);
  expect(screen.queryByRole("region",{name:"Avisos de Freddy"})).toBeNull();                       // al ir a la empresa, el panel se recoge
  expect(change).toHaveBeenLastCalledWith(expect.any(Array),[],[]);
  notices=[{level:"importante",code:"decision",count:1,refs:[]}];
  await vi.advanceTimersByTimeAsync(60000);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Avisos de Freddy: 1 aviso"})).toBeTruthy());   // la campana cuenta lo que queda
  const again=await abrir();
  expect(within(again).getAllByRole("listitem").some(li=>li.textContent?.includes("✓ Nova Demo Portal · 3 pedidos"))).toBe(true);
  expect(change.mock.lastCall![2].map((n:{code:string})=>n.code)).toEqual(["parciales"]);
 });
 it("si ninguna empresa tiene agentes conectados, no pinta nada",async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify({organization_id:ORG,configured:false,available:false,reason:"not_configured",panel_url:null,agents:[]}),{status:200})));
  const v=render(<FreddyNotices companies={companies} token={async()=>"t"}/>);
  await new Promise(r=>setTimeout(r,30));expect(v.container.textContent).toBe("");
 });
 it("sin avisos dice que no hay nada pendiente",async()=>{
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(summary([agent([])])),{status:200})));
  render(<FreddyNotices companies={companies} token={async()=>"t"}/>);
  expect((await abrir()).textContent).toContain("no tienen nada pendiente");
 });
 it("«Olvidar» pide confirmación, avisa a la empresa y vuelve a preguntar; si falla, lo dice",async()=>{
  let notices:unknown=[{level:"urgente",code:"rescate_fallido",count:1,refs:["ab-ORD-1390-C"]}];
  const calls:{url:string;body:unknown}[]=[];let fails=true;
  vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>{
   if(init?.method==="POST"){calls.push({url:String(url),body:JSON.parse(String(init.body))});if(fails)return new Response("{}",{status:503});notices=[];return new Response(JSON.stringify({forgotten:true}),{status:200});}
   return new Response(JSON.stringify(summary([agent(notices)])),{status:200});}));
  render(<FreddyNotices companies={companies} token={async()=>"t"}/>);
  const box=await abrir();
  fireEvent.click(within(box).getByRole("button",{name:"Olvidar"}));
  expect(calls).toHaveLength(0);                                              // con un solo toque no pasa nada
  expect(within(box).getByText(/No cambia nada en la empresa/)).toBeTruthy();
  fireEvent.click(within(box).getByRole("button",{name:"Cancelar"}));expect(within(box).queryByRole("button",{name:"Sí, olvidar"})).toBeNull();expect(calls).toHaveLength(0);
  fireEvent.click(within(box).getByRole("button",{name:"Olvidar"}));fireEvent.click(within(box).getByRole("button",{name:"Sí, olvidar"}));
  await within(box).findByRole("alert");expect(within(box).getByText(/ab-ORD-1390-C/)).toBeTruthy();   // falló: el aviso sigue ahí
  fails=false;fireEvent.click(within(box).getByRole("button",{name:"Olvidar"}));fireEvent.click(within(box).getByRole("button",{name:"Sí, olvidar"}));
  await waitFor(()=>expect(within(box).queryByText(/ab-ORD-1390-C/)).toBeNull());
  expect(calls[1].url).toContain("/organizations/"+ORG+"/portal-agents/forget");expect(calls[1].body).toEqual({code:"rescate_fallido",refs:["ab-ORD-1390-C"]});
 });
});

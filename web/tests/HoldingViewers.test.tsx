// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {HoldingViewers} from "../src/HoldingViewers";
import {hasStashedInvite,inviteLink,redeemInvite,stashInviteFromUrl,takeStashedInvite,untilText,validLabel,validNewInvite,validViewerList,viewersUrls} from "../src/viewersApi";
import type {Holding} from "../src/holdingApi";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));

const H="h-1",TOKEN="A".repeat(43);
const holding:Holding={id:H,name:"Nova",max_companies:5,is_owner:true,companies:[]};
const reply=(raw:unknown,code=200)=>Promise.resolve(new Response(JSON.stringify(raw),{status:code}));
const list=(over:object={})=>({holding_id:H,invite_hours:72,viewers:[],invites:[],...over});
const memory=()=>{const m=new Map<string,string>();return{getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v);},removeItem:(k:string)=>{m.delete(k);}};};
let current:unknown,code:number,post:(url:string,body:any)=>Promise<Response>,posts:{url:string;body:any}[];
const server=vi.fn();
beforeEach(()=>{posts=[];current=list();code=200;post=()=>reply({});
 server.mockReset();server.mockImplementation((url:string,o?:RequestInit)=>{if(o?.method==="POST"){const body=o.body===undefined?undefined:JSON.parse(String(o.body));posts.push({url,body});return post(url,body);}return reply(current,code);});
 vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

describe("validadores y enlace",()=>{
 it("la lista y la invitación nueva se comprueban antes de usarse",()=>{
  expect(validViewerList(list({viewers:[{id:"v",label:"Gestor",since:"2026-11-21T10:00:00Z"}]}),H)).toBe(true);
  expect(validViewerList(list({holding_id:"otro"}),H)).toBe(false);
  expect(validViewerList(list({viewers:[{id:"v",label:"",since:"x"}]}),H)).toBe(false);
  const inv={holding_id:H,invite_id:"i",label:"Gestor",expires_at:"2026-11-24T10:00:00Z",token:TOKEN};
  expect(validNewInvite(inv,H)).toBe(true);
  expect(validNewInvite({...inv,token:"corto"},H)).toBe(false);
  expect(validNewInvite({...inv,holding_id:"otro"},H)).toBe(false);
 });
 it("etiqueta, enlace y caducidad",()=>{
  expect(validLabel(" Gestor ")).toBe(true);expect(validLabel("   ")).toBe(false);expect(validLabel("a\nb")).toBe(false);expect(validLabel("x".repeat(81))).toBe(false);
  expect(inviteLink("https://fabrica.example/",TOKEN)).toBe("https://fabrica.example/?invitacion="+TOKEN);
  const now=Date.parse("2026-11-21T10:00:00Z");
  expect(untilText("2026-11-24T10:00:00Z",now)).toBe("caduca en 3 días");expect(untilText("2026-11-21T15:00:00Z",now)).toBe("caduca en 5 h");expect(untilText("2026-11-20T10:00:00Z",now)).toBe("caducada");
 });
 it("el código sale de la dirección, se guarda en la pestaña y se usa una sola vez",()=>{
  const store=memory(),replace=vi.fn();
  expect(stashInviteFromUrl("https://f.example/?invitacion="+TOKEN+"&x=1#a",store,replace)).toBe(true);
  expect(replace).toHaveBeenCalledWith("/?x=1#a");                       // el código no se queda en la dirección ni en el historial
  expect(hasStashedInvite(store)).toBe(true);
  expect(takeStashedInvite(store)).toBe(TOKEN);expect(takeStashedInvite(store)).toBeNull();expect(hasStashedInvite(store)).toBe(false);
  const bad=memory(),replace2=vi.fn();
  expect(stashInviteFromUrl("https://f.example/?invitacion=<script>",bad,replace2)).toBe(false);
  expect(replace2).toHaveBeenCalled();expect(hasStashedInvite(bad)).toBe(false);
  expect(stashInviteFromUrl("https://f.example/",bad,replace2)).toBe(false);
 });
 it("canjear: bien, caducada y con fallo",async()=>{
  post=()=>reply({joined:true,holding:"Nova"});
  expect(await redeemInvite(TOKEN,async()=>"t")).toEqual({ok:true,holding:"Nova"});
  expect(posts[0]).toEqual({url:viewersUrls.redeem,body:{token:TOKEN}});
  post=()=>reply({detail:"La invitación no es válida: ha caducado"},409);
  expect(await redeemInvite(TOKEN,async()=>"t")).toEqual({ok:false,text:"La invitación no es válida: ha caducado"});
  post=()=>reply({},503);
  expect((await redeemInvite(TOKEN,async()=>"t")).ok).toBe(false);
  post=()=>Promise.reject(new Error("red"));
  expect((await redeemInvite(TOKEN,async()=>"t")).ok).toBe(false);
 });
});

describe("panel del propietario",()=>{
 it("crea la invitación, enseña el enlace una vez y lo copia",async()=>{
  const write=vi.fn(async()=>{});Object.defineProperty(navigator,"clipboard",{value:{writeText:write},configurable:true});
  post=(_u,b)=>reply({holding_id:H,invite_id:"i-1",label:b.label,expires_at:new Date(Date.now()+72*3600e3).toISOString(),token:TOKEN},201);
  render(<HoldingViewers holding={holding} origin="https://fabrica.example"/>);
  await screen.findByText("Ahora mismo nadie más tiene acceso.");
  const button=screen.getByRole("button",{name:"Crear enlace de invitación"}) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("¿Para quién es?"),{target:{value:" Gestor "}});
  fireEvent.click(button);
  await screen.findByText("https://fabrica.example/?invitacion="+TOKEN);
  expect(posts[0]).toEqual({url:viewersUrls.invite(H),body:{label:"Gestor"}});
  fireEvent.click(screen.getByRole("button",{name:"Copiar enlace"}));
  await screen.findByRole("button",{name:"✓ Copiado"});
  expect(write).toHaveBeenCalledWith("https://fabrica.example/?invitacion="+TOKEN);
 });
 it("quitar acceso pide confirmación",async()=>{
  current=list({viewers:[{id:"v-1",label:"Gestor",since:"2026-11-18T10:00:00Z"}]});post=()=>reply({holding_id:H,id:"v-1",kind:"viewer",revoked:true});
  render(<HoldingViewers holding={holding}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Quitar acceso"}));
  expect(posts).toEqual([]);
  fireEvent.click(screen.getByRole("button",{name:"Sí, quitar"}));
  await screen.findByText("Acceso de Gestor retirado. Ya no puede entrar.");
  expect(posts[0].url).toBe(viewersUrls.revoke(H,"v-1"));
 });
 it("un observador no ve el panel; un fallo se dice y se puede reintentar",async()=>{
  code=403;const {container}=render(<HoldingViewers holding={holding}/>);
  await waitFor(()=>expect(container.innerHTML).toBe(""));
  cleanup();code=503;render(<HoldingViewers holding={holding}/>);
  await screen.findByText(/No se pudo consultar la lista/);
  code=200;fireEvent.click(screen.getByRole("button",{name:"Reintentar"}));
  await screen.findByText("Ahora mismo nadie más tiene acceso.");
 });
 it("el tope de accesos se explica",async()=>{
  post=()=>reply({},409);render(<HoldingViewers holding={holding}/>);
  await screen.findByText("Ahora mismo nadie más tiene acceso.");
  fireEvent.change(screen.getByLabelText("¿Para quién es?"),{target:{value:"Otro"}});fireEvent.click(screen.getByRole("button",{name:"Crear enlace de invitación"}));
  await screen.findByText(/has llegado al máximo/);
 });
});

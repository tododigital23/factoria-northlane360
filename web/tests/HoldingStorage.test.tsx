// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {HoldingStorage} from "../src/HoldingStorage";
import {storageUrls,validStart,validStorageStatus,validTest,validateHoldingName,validHoldingRename} from "../src/storageApi";
import type {Holding} from "../src/holdingApi";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));

const H="h-1";
const holding:Holding={id:H,name:"Superempresa Freddy",max_companies:5,is_owner:true,companies:[]};
const GOOGLE="https://accounts.google.com/o/oauth2/v2/auth?client_id=x&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&state=s";
const status=(over:object={})=>({holding_id:H,provider:"google_drive",encrypted_before_upload:true,enabled:true,server_configured:true,connected:false,...over});
const reply=(raw:unknown,code=200)=>Promise.resolve(new Response(JSON.stringify(raw),{status:code}));
let current:object,post:(url:string)=>Promise<Response>,posts:{url:string;body:any}[];
const server=vi.fn(),changed=vi.fn(),go=vi.fn();
beforeEach(()=>{token.mockClear();changed.mockClear();go.mockClear();posts=[];current=status();post=()=>reply({});
 window.history.replaceState(null,"","/");
 server.mockReset();server.mockImplementation((url:string,o?:RequestInit)=>{if(o?.method==="POST"){posts.push({url,body:o.body===undefined?undefined:JSON.parse(String(o.body))});return post(url);}return reply(current);});
 vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=(h:Holding=holding)=>render(<HoldingStorage holding={h} onChanged={changed} go={go}/>);

describe("validadores del almacén",()=>{
 it("el estado exige cifrado antes de subir y no admite llaves",()=>{
  expect(validStorageStatus(status(),H)).toBe(true);
  expect(validStorageStatus(status({encrypted_before_upload:false}),H)).toBe(false);
  expect(validStorageStatus(status({holding_id:"otro"}),H)).toBe(false);
  expect(validStorageStatus(status({provider:"dropbox"}),H)).toBe(false);
  expect(validStorageStatus(status({connected_at:"no es fecha"}),H)).toBe(false);
 });
 it("solo se acepta ir a Google y con el permiso mínimo",()=>{
  expect(validStart({holding_id:H,authorization_url:GOOGLE},H)).toBe(true);
  for(const url of ["https://accounts.google.com.estafa.io/o/oauth2/v2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file","http://accounts.google.com/o/oauth2/v2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file",
   "https://accounts.google.com/o/oauth2/v2/auth?scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive","javascript:alert(1)","no es una url"])
   expect(validStart({holding_id:H,authorization_url:url},H)).toBe(false);
  expect(validStart({holding_id:"otro",authorization_url:GOOGLE},H)).toBe(false);
 });
 it("una prueba «ok» exige los cuatro pasos",()=>{
  const all={holding_id:H,ok:true,reason:null,uploaded:true,stored_unreadable:true,downloaded_and_verified:true,deleted:true};
  expect(validTest(all,H)).toBe(true);expect(validTest({...all,stored_unreadable:false},H)).toBe(false);
  expect(validTest({...all,ok:false,reason:"provider_denied",uploaded:false},H)).toBe(true);
 });
 it("nombre del holding",()=>{
  expect(validateHoldingName(" Northlane360 ")).toBeNull();expect(validateHoldingName("X")).toBeTruthy();expect(validateHoldingName("a\nb")).toBeTruthy();
  expect(validHoldingRename({holding_id:H,name:"Northlane360",renamed:true},H," Northlane360 ")).toBe(true);
  expect(validHoldingRename({holding_id:H,name:"Otro",renamed:true},H,"Northlane360")).toBe(false);
 });
});

describe("panel del almacén",()=>{
 it("sin conectar ofrece conectar y explica el cifrado",async()=>{
  view();expect(await screen.findByText("Sin conectar")).toBeTruthy();
  expect(screen.getByText(/se cifra aquí con la llave de su empresa/)).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Probar"})).toBeNull();
  post=()=>reply({holding_id:H,authorization_url:GOOGLE});
  fireEvent.click(screen.getByRole("button",{name:"Conectar Google Drive"}));
  await waitFor(()=>expect(go).toHaveBeenCalledWith(GOOGLE));expect(posts).toEqual([{url:storageUrls.start(H),body:undefined}]);
 });
 it("nunca navega a una dirección que no sea la de permisos de Google",async()=>{
  view();await screen.findByText("Sin conectar");
  post=()=>reply({holding_id:H,authorization_url:"https://malo.example/o/oauth2/v2/auth"});
  fireEvent.click(screen.getByRole("button",{name:"Conectar Google Drive"}));
  expect(await screen.findByText("No se ha podido iniciar la conexión con Google.")).toBeTruthy();expect(go).not.toHaveBeenCalled();
 });
 it("si falta la migración o la configuración no hay botones",async()=>{
  current=status({enabled:false});const a=view();expect(await screen.findByText("El almacén aún no está disponible en el servidor.")).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Conectar Google Drive"})).toBeNull();a.unmount();
  current=status({server_configured:false});view();expect(await screen.findByText(/Faltan en el servidor las credenciales/)).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Conectar Google Drive"})).toBeNull();
 });
 it("una respuesta de estado incoherente no muestra controles",async()=>{
  current={...status(),encrypted_before_upload:false};view();
  expect(await screen.findByText(/No se ha podido consultar el almacén/)).toBeTruthy();expect(screen.queryByRole("button",{name:"Conectar Google Drive"})).toBeNull();
 });
 it("conectado: la prueba muestra los cuatro pasos",async()=>{
  current=status({connected:true,companies_with_storage:2});view();
  expect(await screen.findByText("Conectado a Google Drive")).toBeTruthy();expect(screen.getByText(/2 empresa\(s\) con almacén propio/)).toBeTruthy();
  post=()=>reply({holding_id:H,ok:true,reason:null,uploaded:true,stored_unreadable:true,downloaded_and_verified:true,deleted:true});
  fireEvent.click(screen.getByRole("button",{name:"Probar"}));
  expect(await screen.findByText(/Prueba superada/)).toBeTruthy();
  expect(screen.getByLabelText("Resultado de la prueba").textContent).toBe("✓ Subido cifrado✓ Ilegible en Google✓ Descargado y verificado✓ Borrado");
  expect(posts).toEqual([{url:storageUrls.test(H),body:undefined}]);
 });
 it("una prueba fallida explica el motivo y marca el paso",async()=>{
  current=status({connected:true});view();await screen.findByText("Conectado a Google Drive");
  post=()=>reply({holding_id:H,ok:false,reason:"provider_denied",uploaded:false,stored_unreadable:false,downloaded_and_verified:false,deleted:false});
  fireEvent.click(screen.getByRole("button",{name:"Probar"}));
  expect(await screen.findByText("Google ha denegado el acceso. Vuelve a conectar la cuenta.")).toBeTruthy();
  expect(screen.getByLabelText("Resultado de la prueba").textContent).toContain("✗ Subido cifrado");
 });
 it("una prueba que dice «ok» sin los cuatro pasos no se acepta",async()=>{
  current=status({connected:true});view();await screen.findByText("Conectado a Google Drive");
  post=()=>reply({holding_id:H,ok:true,reason:null,uploaded:true,stored_unreadable:false,downloaded_and_verified:true,deleted:true});
  fireEvent.click(screen.getByRole("button",{name:"Probar"}));
  expect(await screen.findByText("No se ha podido completar la prueba.")).toBeTruthy();expect(screen.queryByLabelText("Resultado de la prueba")).toBeNull();
 });
 it("desconectar pide confirmación y avisa de que las llaves se conservan",async()=>{
  current=status({connected:true});view();await screen.findByText("Conectado a Google Drive");
  fireEvent.click(screen.getByRole("button",{name:"Desconectar"}));expect(posts).toEqual([]);
  post=()=>{current=status();return reply({holding_id:H,connected:false,removed:true});};
  fireEvent.click(screen.getByRole("button",{name:"Confirmar desconexión"}));
  expect(await screen.findByText(/Las llaves y carpetas de cada empresa se conservan/)).toBeTruthy();
  expect(await screen.findByText("Sin conectar")).toBeTruthy();expect(posts).toEqual([{url:storageUrls.disconnect(H),body:undefined}]);
 });
 it("al volver de Google muestra el resultado y limpia la dirección",async()=>{
  window.history.replaceState(null,"","/?almacen=conectado&otro=1");current=status({connected:true});view();
  expect(await screen.findByText(/Google Drive conectado/)).toBeTruthy();expect(window.location.search).toBe("?otro=1");
  cleanup();window.history.replaceState(null,"","/?almacen=<script>");view();
  expect(await screen.findByText(/No se ha podido completar la conexión/)).toBeTruthy();expect(document.body.innerHTML).not.toContain("<script>");
 });
 it("403 y 503 se explican",async()=>{
  view();await screen.findByText("Sin conectar");
  post=()=>reply({},403);fireEvent.click(screen.getByRole("button",{name:"Conectar Google Drive"}));
  expect(await screen.findByText("Solo el propietario del holding puede hacer esto.")).toBeTruthy();
  post=()=>reply({},503);fireEvent.click(screen.getByRole("button",{name:"Conectar Google Drive"}));
  expect(await screen.findByText("El almacén aún no está disponible en el servidor.")).toBeTruthy();expect(go).not.toHaveBeenCalled();
 });
});

describe("nombre del holding",()=>{
 const input=()=>screen.getByLabelText("Nombre") as HTMLInputElement;
 const boton=()=>screen.getByRole("button",{name:/Cambiar nombre|Guardando/}) as HTMLButtonElement;
 it("empieza con el nombre actual y solo deja guardar un nombre válido y distinto",async()=>{
  view();await screen.findByText("Sin conectar");expect(input().value).toBe("Superempresa Freddy");expect(boton().disabled).toBe(true);
  fireEvent.change(input(),{target:{value:"X"}});expect(boton().disabled).toBe(true);
 });
 it("envía el nombre recortado y avisa al terminar",async()=>{
  view();await screen.findByText("Sin conectar");
  post=()=>reply({holding_id:H,name:"Northlane360",renamed:true});
  fireEvent.change(input(),{target:{value:"  Northlane360 "}});fireEvent.click(boton());
  expect(await screen.findByText("El holding ahora se llama «Northlane360».")).toBeTruthy();
  expect(posts).toEqual([{url:storageUrls.name(H),body:{name:"Northlane360"}}]);expect(changed).toHaveBeenCalledTimes(1);
 });
 it("Intro en el campo guarda el nombre, y un nombre inválido no se envía",async()=>{
  view();await screen.findByText("Sin conectar");
  fireEvent.change(input(),{target:{value:"X"}});fireEvent.keyDown(input(),{key:"Enter"});expect(posts).toEqual([]);
  post=()=>reply({holding_id:H,name:"Northlane360",renamed:true});
  fireEvent.change(input(),{target:{value:"Northlane360"}});fireEvent.keyDown(input(),{key:"Enter"});
  expect(await screen.findByText("El holding ahora se llama «Northlane360».")).toBeTruthy();expect(posts).toEqual([{url:storageUrls.name(H),body:{name:"Northlane360"}}]);
 });
 it("si el servidor rechaza el nombre lo dice con claridad",async()=>{
  view();await screen.findByText("Sin conectar");post=()=>reply({},409);
  fireEvent.change(input(),{target:{value:"Otro nombre"}});fireEvent.click(boton());
  expect(await screen.findByText("El servidor no ha aceptado ese nombre. Prueba con otro.")).toBeTruthy();expect(changed).not.toHaveBeenCalled();
 });
 it("una confirmación que no cuadra no se da por buena",async()=>{
  view();await screen.findByText("Sin conectar");
  post=()=>reply({holding_id:H,name:"Otro",renamed:true});
  fireEvent.change(input(),{target:{value:"Northlane360"}});fireEvent.click(boton());
  expect(await screen.findByText("No se ha podido confirmar el cambio de nombre.")).toBeTruthy();expect(changed).not.toHaveBeenCalled();
 });
});

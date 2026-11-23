// @vitest-environment jsdom
import React from "react";
import {afterEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor,renderHook,act} from "@testing-library/react";
import {LoginIntro} from "../src/intro/LoginIntro";
import {AUTH_URL,OwnSessionProvider,loadOwnLogin,ownLogin,ownSignup,readSession,sessionFrom,useAuth0,validSession} from "../src/auth";
const {page}=vi.hoisted(()=>({page:{isAuthenticated:false,isLoading:false,error:undefined,user:undefined,getAccessTokenSilently:vi.fn(async()=>"de-auth0"),logout:vi.fn(),loginWithRedirect:vi.fn()}}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>page}));
afterEach(()=>{cleanup();vi.unstubAllGlobals();window.sessionStorage.clear();});
const reply=(raw:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(raw),{status}));
const GOOD={access_token:"permiso.firmado",expires_in:3600,user:{name:"Ana Ruiz",email:"ana@ejemplo.es"}};

describe("sesión propia",()=>{
 it("solo vale una sesión con buena forma y sin caducar",()=>{
  const s=sessionFrom(GOOD,1000)!;expect(s).toEqual({token:"permiso.firmado",exp:1000+3600_000,user:{name:"Ana Ruiz",email:"ana@ejemplo.es"}});
  expect(validSession(s,2000)).toBe(true);expect(validSession(s,s.exp+1)).toBe(false);expect(validSession({...s,token:""},0)).toBe(false);
  expect(sessionFrom({access_token:"x"})).toBeNull();expect(sessionFrom({...GOOD,expires_in:-1})).toBeNull();expect(sessionFrom(null)).toBeNull();
  expect(sessionFrom({...GOOD,user:{name:5}},0)!.user).toEqual({name:null,email:null});
  const store={getItem:()=>"no es json"};expect(readSession(store)).toBeNull();
 });
 it("entrar guarda la sesión en la pestaña y nunca la contraseña; un fallo devuelve el texto del servidor",async()=>{
  const f=vi.fn((_u:string,_o:RequestInit)=>reply(GOOD));vi.stubGlobal("fetch",f);const set=vi.fn();
  expect(await ownLogin(" ana@ejemplo.es ","Secreta-1234",set)).toEqual({ok:true});
  expect(f.mock.calls[0][0]).toBe(AUTH_URL+"/login");expect(JSON.parse(String(f.mock.calls[0][1].body))).toEqual({email:"ana@ejemplo.es",password:"Secreta-1234"});
  expect(JSON.stringify(set.mock.calls)).not.toContain("Secreta-1234");
  vi.stubGlobal("fetch",vi.fn(()=>reply({detail:"Usuario o contraseña incorrectos."},401)));
  expect(await ownLogin("a@b.es","x",set)).toEqual({ok:false,text:"Usuario o contraseña incorrectos.",secure:false});
  vi.stubGlobal("fetch",vi.fn(()=>reply({detail:"Esta cuenta tiene verificación en dos pasos"},409)));
  expect((await ownLogin("a@b.es","x",set) as {secure?:boolean}).secure).toBe(true);
  vi.stubGlobal("fetch",vi.fn(()=>Promise.reject(new Error("red"))));
  expect((await ownLogin("a@b.es","x",set)).ok).toBe(false);
  vi.stubGlobal("fetch",vi.fn(()=>reply({detail:[{loc:["body","password"]}]},422)));
  expect((await ownSignup({email:"a@b.es",password:"corta",name:"A",invite:"i"},set) as {text:string}).text).toMatch(/Revisa los datos/);
 });
 it("el servidor decide cómo se entra; si no contesta, por la página de Auth0",async()=>{
  vi.stubGlobal("fetch",vi.fn(()=>reply({own_login:true})));expect(await loadOwnLogin()).toBe(true);
  vi.stubGlobal("fetch",vi.fn(()=>reply({},404)));expect(await loadOwnLogin()).toBe(false);
  vi.stubGlobal("fetch",vi.fn(()=>Promise.reject(new Error("red"))));expect(await loadOwnLogin()).toBe(false);
 });
 it("con sesión propia las pantallas reciben ese permiso; sin ella, el de Auth0",async()=>{
  const none=renderHook(()=>useAuth0(),{wrapper:OwnSessionProvider});
  expect(none.result.current.isAuthenticated).toBe(false);expect(await none.result.current.getAccessTokenSilently()).toBe("de-auth0");
  cleanup();window.sessionStorage.setItem("nl_sesion",JSON.stringify(sessionFrom(GOOD)));
  const own=renderHook(()=>useAuth0(),{wrapper:OwnSessionProvider});
  expect(own.result.current.isAuthenticated).toBe(true);expect(own.result.current.user?.email).toBe("ana@ejemplo.es");expect(own.result.current.user?.given_name).toBe("Ana");
  expect(await own.result.current.getAccessTokenSilently({authorizationParams:{scope:"read:tasks"}})).toBe("permiso.firmado");
  const first=own.result.current.getAccessTokenSilently;own.rerender();expect(own.result.current.getAccessTokenSilently).toBe(first);   // estable: no relanza las cargas
  cleanup();window.sessionStorage.setItem("nl_sesion",JSON.stringify({...sessionFrom(GOOD),exp:Date.now()-1}));
  expect(renderHook(()=>useAuth0(),{wrapper:OwnSessionProvider}).result.current.isAuthenticated).toBe(false);                          // caducada: fuera
 });
});

describe("pantalla de acceso propio",()=>{
 const own=(over:object={})=>({login:vi.fn(async()=>({ok:true as const})),reset:vi.fn(async()=>{}),...over});
 it("pide usuario y contraseña aquí mismo y no deja la contraseña en pantalla tras enviar",async()=>{
  const o=own({login:vi.fn(async()=>({ok:false as const,text:"Usuario o contraseña incorrectos."}))}),redirect=vi.fn();
  render(<LoginIntro still own={o} onLogin={redirect}/>);
  const enter=screen.getByRole("button",{name:/^Entrar/}) as HTMLButtonElement;expect(enter.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Usuario (correo)"),{target:{value:"ana@ejemplo.es"}});
  const pass=screen.getByLabelText("Contraseña") as HTMLInputElement;expect(pass.type).toBe("password");expect(pass.autocomplete).toBe("current-password");
  fireEvent.change(pass,{target:{value:"Secreta-1234"}});fireEvent.click(enter);
  await screen.findByText("Usuario o contraseña incorrectos.");
  expect(o.login).toHaveBeenCalledWith("ana@ejemplo.es","Secreta-1234");expect(pass.value).toBe("");expect(redirect).not.toHaveBeenCalled();
 });
 it("recuperar contraseña contesta lo mismo exista o no la cuenta",async()=>{
  const o=own();render(<LoginIntro still own={o} onLogin={()=>{}}/>);
  fireEvent.click(screen.getByRole("button",{name:"¿Olvidaste la contraseña?"}));expect(screen.queryByLabelText("Contraseña")).toBeNull();
  fireEvent.change(screen.getByLabelText("Usuario (correo)"),{target:{value:"ana@ejemplo.es"}});fireEvent.click(screen.getByRole("button",{name:/Enviar mensaje/}));
  await screen.findByText(/Si hay una cuenta con ese correo/);expect(o.reset).toHaveBeenCalledWith("ana@ejemplo.es");
 });
 it("crear cuenta solo se ofrece con invitación, y exige nombre y contraseña larga",async()=>{
  render(<LoginIntro still own={own()} onLogin={()=>{}}/>);expect(screen.queryByRole("tab",{name:"Crear cuenta"})).toBeNull();cleanup();
  const signup=vi.fn(async()=>({ok:true as const}));render(<LoginIntro still invited own={own({signup})} onLogin={()=>{}}/>);
  const create=screen.getByRole("button",{name:/Crear cuenta y entrar/}) as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText("Tu nombre"),{target:{value:"Marta"}});fireEvent.change(screen.getByLabelText("Usuario (correo)"),{target:{value:"marta@ejemplo.es"}});
  fireEvent.change(screen.getByLabelText("Contraseña"),{target:{value:"corta"}});expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Contraseña"),{target:{value:"Larga-y-buena-1"}});expect((screen.getByLabelText("Contraseña") as HTMLInputElement).autocomplete).toBe("new-password");
  fireEvent.click(create);await waitFor(()=>expect(signup).toHaveBeenCalledWith({email:"marta@ejemplo.es",password:"Larga-y-buena-1",name:"Marta"}));
  fireEvent.click(screen.getByRole("tab",{name:"Ya tengo cuenta"}));expect(screen.queryByLabelText("Tu nombre")).toBeNull();
 });
 it("con verificación en dos pasos ofrece la página segura",async()=>{
  const redirect=vi.fn(),o=own({login:vi.fn(async()=>({ok:false as const,text:"Esta cuenta tiene verificación en dos pasos.",secure:true}))});
  render(<LoginIntro still own={o} onLogin={redirect}/>);
  fireEvent.change(screen.getByLabelText("Usuario (correo)"),{target:{value:"ana@ejemplo.es"}});fireEvent.change(screen.getByLabelText("Contraseña"),{target:{value:"x"}});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:/^Entrar/}));});
  fireEvent.click(await screen.findByRole("button",{name:"Entrar por la página segura"}));expect(redirect).toHaveBeenCalledWith("ana@ejemplo.es");
 });
});

describe("registros nuevos cerrados",()=>{
 it("si el servidor no lo ordena, no se admite ninguna cuenta nueva",async()=>{
  const {loadAccessConfig}=await import("../src/auth");
  vi.stubGlobal("fetch",vi.fn(()=>reply({own_login:true})));expect(await loadAccessConfig()).toEqual({own:true,signup:false});
  vi.stubGlobal("fetch",vi.fn(()=>reply({own_login:true,signup:"on"})));expect((await loadAccessConfig()).signup).toBe(false);
  vi.stubGlobal("fetch",vi.fn(()=>reply({own_login:false,signup:true})));expect(await loadAccessConfig()).toEqual({own:false,signup:true});
  vi.stubGlobal("fetch",vi.fn(()=>Promise.reject(new Error("red"))));expect(await loadAccessConfig()).toEqual({own:false,signup:false});
 });
 it("la pantalla no ofrece crear cuenta por ningún camino, ni con invitación",()=>{
  render(<LoginIntro still invited onLogin={()=>{}}/>);
  expect(screen.queryByRole("button",{name:"Crear una cuenta"})).toBeNull();expect(screen.getByText(/no se pueden crear cuentas nuevas/)).toBeTruthy();cleanup();
  render(<LoginIntro still invited own={{login:async()=>({ok:true as const}),reset:async()=>{}}} onLogin={()=>{}}/>);
  expect(screen.queryByRole("tab",{name:"Crear cuenta"})).toBeNull();expect(screen.queryByLabelText("Tu nombre")).toBeNull();
  expect(screen.getByText(/no se pueden crear cuentas nuevas/)).toBeTruthy();expect(screen.getByLabelText("Contraseña")).toBeTruthy();
 });
});

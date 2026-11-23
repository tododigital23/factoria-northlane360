// @vitest-environment jsdom
import React from "react";
import {afterEach,describe,it,expect,vi} from "vitest";
import {act,cleanup,render,screen,fireEvent} from "@testing-library/react";
import {DEMO_CITY,FLIGHT_MS,TITLE_AT,LoginIntro,flightPose,validLoginHint} from "../src/intro/LoginIntro";
afterEach(()=>{cleanup();vi.useRealTimers();});

describe("vuelo de entrada",()=>{
 it("baja desde muy arriba hasta el encuadre general, sin saltos",()=>{
  const a=flightPose(0,1.6),m=flightPose(.5,1.6),z=flightPose(1,1.6);
  expect(a.pos[1]).toBe(90);expect(z.pos[1]).toBeLessThan(40);expect(m.pos[1]).toBeLessThan(a.pos[1]);expect(m.pos[1]).toBeGreaterThan(z.pos[1]);
  expect(flightPose(-1,1.6)).toEqual(a);expect(flightPose(7,1.6)).toEqual(z);expect(a.target).toEqual(z.target);
  let prev=a.pos[1];for(let i=1;i<=50;i++){const y=flightPose(i/50,1.6).pos[1];expect(y).toBeLessThanOrEqual(prev+1e-9);prev=y;}
  expect(TITLE_AT).toBeLessThan(FLIGHT_MS);
 });
 it("la ciudad de la entrada no lleva datos de nadie",()=>{
  expect(DEMO_CITY.map(p=>p.slot)).toEqual([1,2,3,4,5]);
  for(const p of DEMO_CITY)expect(Object.keys(p).sort()).toEqual(["blocked","floors","kind","lit","slot"]);
 });
 it("el usuario escrito solo se pasa si tiene forma razonable",()=>{
  expect(validLoginHint(" jefe@ejemplo.com ")).toBe(true);
  for(const bad of ["","ab","a b@c.es","<x>@c.es","x".repeat(121)])expect(validLoginHint(bad)).toBe(false);
 });
});

describe("pantalla de entrada",()=>{
 it("sin WebGL sigue funcionando: rótulo, acceso y aviso de dónde va la contraseña",()=>{
  const login=vi.fn(),signup=vi.fn();
  render(<LoginIntro still onLogin={login} onSignup={signup}/>);
  expect(screen.getByRole("heading",{name:"Northlane360"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Saltar intro"})).toBeNull();
  expect(screen.getByText(/La contraseña se escribe en el paso siguiente/)).toBeTruthy();
  expect(document.querySelector("input[type=password]")).toBeNull();          // aquí no se pide ni se guarda la contraseña
  fireEvent.click(screen.getByRole("button",{name:/Continuar/}));
  expect(login).toHaveBeenLastCalledWith(undefined);
  fireEvent.change(screen.getByLabelText("Usuario (correo)"),{target:{value:" jefe@ejemplo.com "}});
  fireEvent.submit(screen.getByRole("form",{name:"Acceso"}));
  expect(login).toHaveBeenLastCalledWith("jefe@ejemplo.com");
  fireEvent.click(screen.getByRole("button",{name:"Crear una cuenta"}));expect(signup).toHaveBeenCalledTimes(1);
 });
 it("con animación se puede saltar, y termina sola",()=>{
  vi.useFakeTimers();
  const {container}=render(<LoginIntro onLogin={()=>{}}/>);
  expect(container.querySelector(".intro.ph-fly")).toBeTruthy();
  act(()=>{vi.advanceTimersByTime(TITLE_AT+10);});expect(container.querySelector(".intro.ph-title")).toBeTruthy();
  act(()=>{vi.advanceTimersByTime(FLIGHT_MS);});expect(container.querySelector(".intro.ph-ready")).toBeTruthy();
  cleanup();
  const again=render(<LoginIntro onLogin={()=>{}}/>);
  fireEvent.click(screen.getByRole("button",{name:"Saltar intro"}));
  expect(again.container.querySelector(".intro.ph-ready")).toBeTruthy();
 });
 it("avisa de la invitación y de un error de acceso",()=>{
  render(<LoginIntro still invited error="acceso denegado" onLogin={()=>{}}/>);
  expect(screen.getByText(/invitación de solo consulta/)).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("acceso denegado");
  expect(screen.getByRole("button",{name:/Entrar y activar la invitación/})).toBeTruthy();
 });
});

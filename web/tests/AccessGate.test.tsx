// @vitest-environment jsdom
import React from "react";
import {afterEach,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent} from "@testing-library/react";
import {AccessGate} from "../src/intro/AccessGate";
afterEach(cleanup);

it("sin acceso: lo dice, no enseña nada de dentro y solo deja cerrar sesión",()=>{
 const out=vi.fn(),retry=vi.fn();
 render(<AccessGate state="denied" account="ex@correo.com" note="La invitación ya se usó" onRetry={retry} onLogout={out}/>);
 expect(screen.getByRole("heading",{name:/No tienes acceso/})).toBeTruthy();
 expect(screen.getByText("ex@correo.com")).toBeTruthy();expect(screen.getByText("La invitación ya se usó")).toBeTruthy();
 expect(screen.getAllByRole("button").length).toBe(1);
 fireEvent.click(screen.getByRole("button",{name:"Cerrar sesión"}));expect(out).toHaveBeenCalledTimes(1);
 expect(document.querySelector("canvas,nav,.sidebar")).toBeNull();
});
it("fallo del servidor: se puede reintentar; comprobando: sin botones",()=>{
 const retry=vi.fn();
 render(<AccessGate state="error" account="" onRetry={retry} onLogout={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"Reintentar"}));expect(retry).toHaveBeenCalledTimes(1);
 cleanup();render(<AccessGate state="checking" account="" onRetry={retry} onLogout={()=>{}}/>);
 expect(screen.getByText("Comprobando tu acceso…")).toBeTruthy();expect(screen.queryAllByRole("button").length).toBe(0);
});

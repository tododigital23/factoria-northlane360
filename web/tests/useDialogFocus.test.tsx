// @vitest-environment jsdom
import React,{useRef,useState} from "react";
import {afterEach,describe,it,expect} from "vitest";
import {cleanup,render,screen,fireEvent} from "@testing-library/react";
import {useDialogFocus} from "../src/office/useDialogFocus";

function Dialog({onClose}:{onClose:()=>void}){
 const ref=useRef<HTMLDivElement>(null);useDialogFocus(ref);
 return <div role="dialog" aria-modal="true" aria-label="Prueba" ref={ref}><button>Primero</button><input aria-label="Campo"/><button disabled>Apagado</button><button onClick={onClose}>Último</button></div>;
}
function Page(){const [open,setOpen]=useState(false);return <><button onClick={()=>setOpen(true)}>Abrir</button><button>Detrás</button>{open&&<Dialog onClose={()=>setOpen(false)}/>}</>;}
// jsdom no calcula cajas: se simula que todo lo de la ventana es visible.
const visible=()=>{Element.prototype.getClientRects=function(){return [{}] as unknown as DOMRectList;};};
afterEach(cleanup);

describe("teclado de las ventanas",()=>{
 it("al abrir, el foco entra en la ventana",()=>{
  visible();render(<Page/>);const opener=screen.getByRole("button",{name:"Abrir"});opener.focus();fireEvent.click(opener);
  expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
 });
 it("el tabulador da la vuelta dentro y salta los controles apagados",()=>{
  visible();render(<Page/>);fireEvent.click(screen.getByRole("button",{name:"Abrir"}));const dialog=screen.getByRole("dialog");
  const last=screen.getByRole("button",{name:"Último"}),first=screen.getByRole("button",{name:"Primero"});
  last.focus();fireEvent.keyDown(dialog,{key:"Tab"});expect(document.activeElement).toBe(first);
  fireEvent.keyDown(dialog,{key:"Tab",shiftKey:true});expect(document.activeElement).toBe(last);
 });
 it("otras teclas no se tocan",()=>{
  visible();render(<Page/>);fireEvent.click(screen.getByRole("button",{name:"Abrir"}));const input=screen.getByLabelText("Campo");input.focus();
  fireEvent.keyDown(screen.getByRole("dialog"),{key:"a"});expect(document.activeElement).toBe(input);
 });
 it("al cerrar, el foco vuelve a quien abrió",()=>{
  visible();render(<Page/>);const opener=screen.getByRole("button",{name:"Abrir"});opener.focus();fireEvent.click(opener);
  fireEvent.click(screen.getByRole("button",{name:"Último"}));
  expect(screen.queryByRole("dialog")).toBeNull();expect(document.activeElement).toBe(opener);
 });
});

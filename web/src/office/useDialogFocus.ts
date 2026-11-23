import {useEffect} from "react";
import type {RefObject} from "react";

const FOCUSABLE='a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Comportamiento de teclado de una ventana modal:
 * - El tabulador da la vuelta dentro de la ventana (no se escapa a lo que queda detrás).
 * - Si al abrir el foco no está dentro, pasa a la ventana.
 * - Al cerrar, el foco vuelve al control que la abrió.
 */
export function useDialogFocus(ref:RefObject<HTMLElement|null>){
 useEffect(()=>{
  const node=ref.current;if(!node)return;
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;
  if(!node.contains(document.activeElement)){if(!node.hasAttribute("tabindex"))node.setAttribute("tabindex","-1");node.focus({preventScroll:true});}
  const visible=()=>Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el=>el.getClientRects().length>0||el===document.activeElement);
  const onKey=(e:KeyboardEvent)=>{
   if(e.key!=="Tab")return;
   const items=visible();if(!items.length){e.preventDefault();return;}
   const first=items[0],last=items[items.length-1],active=document.activeElement;
   if(e.shiftKey&&(active===first||active===node||!node.contains(active))){e.preventDefault();last.focus();}
   else if(!e.shiftKey&&(active===last||!node.contains(active))){e.preventDefault();first.focus();}
  };
  node.addEventListener("keydown",onKey);
  return()=>{node.removeEventListener("keydown",onKey);if(opener&&document.contains(opener))opener.focus({preventScroll:true});};
 },[ref]);
}

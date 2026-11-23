import {CAMPUS_CENTER,PLOT_RADIUS,presetPose} from "./layout";
import type {Preset} from "./layout";
import type {CampusPlot} from "../holdingApi";

export type FactoryPlot={slot:number;kind:"company"|"member"|"empty";
 /** Plantas = departamentos (1 a 10). */ floors:number;
 /** Proporción de trabajadores activos (0 a 1): cuántas plantas tienen las ventanas encendidas. */ lit:number;
 /** Hay tareas bloqueadas: la baliza parpadea en ámbar. */ blocked:boolean};
export type FactoryPose={pos:[number,number,number];target:[number,number,number]};
/** Radio del anillo de parcelas, en unidades de la escena. */
export const FACTORY_RADIUS=16;

export function toFactoryPlot(p:CampusPlot):FactoryPlot{
 const c=p.company;
 if(c)return {slot:p.slot,kind:"company",floors:Math.min(Math.max(c.departments,1),10),lit:c.workers>0?c.active_workers/c.workers:0,blocked:c.tasks.blocked>0};
 if(p.member)return {slot:p.slot,kind:"member",floors:2,lit:0,blocked:false};
 return {slot:p.slot,kind:"empty",floors:0,lit:0,blocked:false};
}
/** Encuadre del plano (unidades de layout.ts) convertido a las unidades del motor, con Freddy en el origen. */
export function factoryPose(preset:Preset,selected:number|null,aspect:number):FactoryPose{
 const k=FACTORY_RADIUS/PLOT_RADIUS,p=presetPose(preset,selected,aspect);
 const f=(v:[number,number,number]):[number,number,number]=>[(v[0]-CAMPUS_CENTER[0])*k,v[1]*k,(v[2]-CAMPUS_CENTER[2])*k];
 const pos=f(p.pos),target=f(p.target);
 // Las torres son más altas que los edificios del plano: la vista general y la de empresa se alejan para que quepan con su rótulo.
 const far=preset==="general"?1.22:preset==="empresa"?1.45:1;
 for(let i=0;i<3;i++)pos[i]=target[i]+(pos[i]-target[i])*far;
 return {pos,target};
}


/** Geometría compartida del campus: posiciones de parcela y encuadres de cámara (unidades «de plano»). */
export type V3=[number,number,number];
export type Preset="general"|"cenital"|"freddy"|"empresa";
/** Freddy queda en el mismo punto que en la oficina clásica. */
export const CAMPUS_CENTER:V3=[-5.2,0,-6];
export const PLOT_RADIUS=8.6;
export function plotPosition(slot:number):V3{
 const angle=Math.PI/2+Math.PI/5+(slot-1)*2*Math.PI/5;
 return [CAMPUS_CENTER[0]+Math.cos(angle)*PLOT_RADIUS,0,CAMPUS_CENTER[2]+Math.sin(angle)*PLOT_RADIUS];
}
export function presetPose(preset:Preset,selected:number|null,aspect:number):{pos:V3;target:V3}{
 const [cx,,cz]=CAMPUS_CENTER,fit=Math.max(1,1.2/Math.max(aspect,.3));
 const scale=(t:V3,p:V3,f:number):V3=>[t[0]+(p[0]-t[0])*f,t[1]+(p[1]-t[1])*f,t[2]+(p[2]-t[2])*f];
 if(preset==="empresa"&&selected){const [x,,z]=plotPosition(selected),dx=x-cx,dz=z-cz,l=Math.hypot(dx,dz);const t:V3=[x,2,z];return {target:t,pos:scale(t,[x+dx/l*10.5,8,z+dz/l*10.5],Math.min(fit,1.4))};}
 if(preset==="freddy"){const t:V3=[cx,2,cz];return {target:t,pos:scale(t,[cx,2.8,cz+7.5],Math.min(fit,1.3))};}
 if(preset==="cenital"){const t:V3=[cx,0,cz];return {target:t,pos:scale(t,[cx,27,cz+.5],fit)};}
 const t:V3=[cx,1,cz+.6];return {target:t,pos:scale(t,[cx+4,13,cz+19],fit)};
}

import {describe,it,expect} from "vitest";
import {JOBS_KEY,jobsSpot,LOUNGE_KEY,LOUNGE_NAME,loungeSpot,roomLayout,roomTint,validBreak,ROOM_W,ROOM_D} from "../src/office/officeModel";

describe("Sala de Descanso",()=>{
 it("es una sala más, la última, y solo cuando se pide",()=>{
  const deps=[{id:"a",name:"Dirección IA"},{id:"b",name:"Marketing"}];
  expect(roomLayout(deps).rooms.some(r=>r.lounge)).toBe(false);
  const l=roomLayout(deps,true),last=l.rooms[l.rooms.length-2],jobs=l.rooms[l.rooms.length-1];
  expect(l.rooms.length).toBe(4);expect(jobs).toMatchObject({key:JOBS_KEY,jobs:true,departmentId:null});expect(last).toMatchObject({key:LOUNGE_KEY,name:LOUNGE_NAME,lounge:true,departmentId:null,direction:false});
  expect(roomTint(last)).not.toEqual(roomTint(l.rooms[1]));
 });
 it("cada agente tiene su sitio en la pista, dentro de la sala y sin pisarse",()=>{
  const room={x:10,z:-4};
  for(const total of [1,4,5,9,14]){
   const spots=Array.from({length:total},(_,i)=>loungeSpot(room,i,total));
   for(const [x,,z] of spots){expect(Math.abs(x-room.x)).toBeLessThan(ROOM_W/2-.8);expect(Math.abs(z-room.z)).toBeLessThan(ROOM_D/2-.3);}
   for(let i=0;i<total;i++)for(let j=i+1;j<total;j++)expect(Math.hypot(spots[i][0]-spots[j][0],spots[i][2]-spots[j][2])).toBeGreaterThan(1);
  }
 });
 it("el estado del descanso se comprueba antes de usarse",()=>{
  const ok={organization_id:"o",available:true,on_break:true,since:"2026-11-21T16:00:00Z"};
  expect(validBreak(ok,"o")).toBe(true);expect(validBreak({...ok,on_break:false,since:null},"o")).toBe(true);
  expect(validBreak(ok,"otra")).toBe(false);expect(validBreak({...ok,since:"ayer"},"o")).toBe(false);
  expect(validBreak({...ok,available:false},"o")).toBe(false);expect(validBreak({...ok,on_break:"si"},"o")).toBe(false);expect(validBreak(null,"o")).toBe(false);
 });
 it("en la Oficina de Empleo unos hacen cola, otros esperan sentados y otros pasean, sin pisarse y dentro de la sala",()=>{
  const room={x:0,z:0},spots=Array.from({length:15},(_,i)=>jobsSpot(room,i));
  expect(new Set(spots.map(s=>s.mode))).toEqual(new Set(["queue","seat","walk"]));
  for(const s of spots){for(const p of [s.at,...(s.to?[s.to]:[])]){expect(Math.abs(p[0])).toBeLessThan(ROOM_W/2-.4);expect(Math.abs(p[2])).toBeLessThan(ROOM_D/2-.3);}expect(s.mode==="walk").toBe(!!s.to);}
  const fixed=spots.filter(s=>s.mode!=="walk");
  for(let i=0;i<fixed.length;i++)for(let j=i+1;j<fixed.length;j++)expect(Math.hypot(fixed[i].at[0]-fixed[j].at[0],fixed[i].at[2]-fixed[j].at[2])).toBeGreaterThan(.9);
 });
});

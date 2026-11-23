import {describe,it,expect} from "vitest";
import {NAMES,OUTFITS,assignCast,faceOf,roleOf} from "../src/office/people";
import {buildAgents} from "../src/office/officeModel";

describe("reparto de la oficina",()=>{
 it("en una empresa no se repiten ni el nombre ni la ropa, y siempre sale lo mismo",()=>{
  const ids=Array.from({length:OUTFITS.length},(_,i)=>"agente-"+i);
  const a=assignCast(ids),b=assignCast([...ids].reverse());
  expect(new Set([...a.values()].map(r=>r.name)).size).toBe(ids.length);
  expect(new Set([...a.values()].map(r=>r.outfit.key)).size).toBe(ids.length);
  for(const id of ids)expect(b.get(id)).toEqual(a.get(id));
  expect(roleOf(ids[0])).toEqual(a.get(ids[0]));expect(faceOf(ids[0]).outfit?.key).toBe(a.get(ids[0])!.outfit.key);
 });
 it("con más gente que estilos se repite ropa, pero nunca el nombre",()=>{
  const ids=Array.from({length:30},(_,i)=>"w"+i),c=assignCast(ids);
  expect(new Set([...c.values()].map(r=>r.name)).size).toBe(30);
 });
 it("hay variedad de sobra y ningún estilo lleva siglas ni banderas",()=>{
  expect(OUTFITS.length).toBeGreaterThanOrEqual(12);expect(new Set(NAMES).size).toBe(NAMES.length);expect(NAMES.length).toBeGreaterThanOrEqual(40);
  for(const o of OUTFITS)expect(o.label).not.toMatch(/partido|bandera|siglas|psoe|pp\b|vox|podemos/i);
 });
 it("cada agente lleva su nombre de pila además de su puesto",()=>{
  const w=(id:string,name:string)=>({id,department_id:"d",name,specialty:"x",recorded_state:"idle",phase:"available",assigned_tasks_in_sample:0,animation_until:null,job_id:null,task_id:null,task_title:null});
  const agents=buildAgents([w("a","Programador web"),w("b","Verificador QA")],[{id:"d",name:"Desarrollo"}],[],[]);
  expect(agents.map(a=>a.name)).toEqual(["Programador web","Verificador QA"]);
  expect(agents.every(a=>NAMES.includes(a.person!))).toBe(true);expect(agents[0].person).not.toBe(agents[1].person);
 });
});

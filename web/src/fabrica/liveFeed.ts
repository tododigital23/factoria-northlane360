import type {HoldingCompany} from "../holdingApi";

export type ChangeKind="arrived"|"done"|"blocked"|"created";
export type HoldingChange={kind:ChangeKind;slot:number;company:string;count:number;text:string};
export type FeedEntry={id:number;at:number;kind:ChangeKind;company:string;text:string};
const n=(count:number,one:string,many:string)=>count===1?one:`${count} ${many}`;

/** Compara dos lecturas consecutivas del holding y devuelve SOLO lo que ha cambiado de verdad. Sin datos personales: solo cifras por empresa. */
export function holdingChanges(prev:HoldingCompany[],next:HoldingCompany[]):HoldingChange[]{
 const before=new Map(prev.map(c=>[c.organization_id,c])),out:HoldingChange[]=[];
 for(const c of next){
  const p=before.get(c.organization_id);
  if(!p){out.push({kind:"created",slot:c.slot,company:c.name,count:1,text:"se ha incorporado a La Factoría."});continue;}
  const done=c.tasks.completed-p.tasks.completed,blocked=c.tasks.blocked-p.tasks.blocked;
  // Un trabajo nuevo sube el total de tareas; así no se confunde con una tarea que solo cambia de estado.
  const total=(x:HoldingCompany)=>x.tasks.pending+x.tasks.blocked+x.tasks.completed+x.tasks.other,arrived=total(c)-total(p);
  if(arrived>0)out.push({kind:"arrived",slot:c.slot,company:c.name,count:arrived,text:`recibe ${n(arrived,"un trabajo nuevo","trabajos nuevos")}.`});
  if(done>0)out.push({kind:"done",slot:c.slot,company:c.name,count:done,text:`termina ${n(done,"un trabajo","trabajos")}.`});
  if(blocked>0)out.push({kind:"blocked",slot:c.slot,company:c.name,count:blocked,text:`tiene ${n(blocked,"una tarea bloqueada nueva","tareas bloqueadas nuevas")}.`});
 }
 return out;
}

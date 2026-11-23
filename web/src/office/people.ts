/**
 * El aspecto y el nombre de pila de cada agente. No son fotos ni personajes de nadie: figuras dibujadas que salen siempre
 * igual para el mismo agente. Dentro de una empresa no se repiten ni el nombre ni la forma de vestir mientras queden libres.
 * Los estilos son de ropa (traje, chándal, cuero…): no llevan siglas, banderas ni símbolos de ningún partido.
 */
export type Hat="none"|"straw"|"cap"|"hood"|"mohawk"|"band"|"beret"|"helmet"|"beanie";
export type Neck="none"|"tie"|"bow"|"scarf"|"sweater"|"chain";
export type Outfit={key:string;/** Cómo se describe a quien no lo ve. */ label:string;top:string;/** Segundo color: forro, rayas o chaleco. */ top2?:string;trousers:string;
 hat:Hat;hatColor?:string;neck:Neck;neckColor?:string;shades?:boolean;glasses?:boolean;headset?:boolean;/** Chaqueta abierta sobre la camisa. */ jacket?:boolean;
 stripes?:boolean;dots?:boolean;emblem?:string;hair?:string;style?:0|1|2|3};
export const OUTFITS:Outfit[]=[
 {key:"hawaiana",label:"camisa hawaiana y sombrero de paja",top:"#ff7a59",top2:"#ffe08a",trousers:"#e9d9b0",hat:"straw",hatColor:"#e8c66a",neck:"none",dots:true},
 {key:"friki",label:"camiseta de videojuegos y gorra hacia atrás",top:"#1f2a44",trousers:"#3b4a6b",hat:"cap",hatColor:"#e2574c",neck:"none",glasses:true,emblem:"#7ee3a8"},
 {key:"informatico",label:"sudadera con capucha y cascos",top:"#3a3f55",top2:"#5cf08a",trousers:"#22252e",hat:"hood",neck:"none",headset:true,emblem:"#5cf08a"},
 {key:"empollon",label:"chaleco de punto, pajarita y gafas",top:"#f3f5ff",top2:"#8a5a35",trousers:"#6b5a45",hat:"none",neck:"bow",neckColor:"#b3261e",glasses:true,jacket:true,style:1},
 {key:"macarra",label:"cazadora de cuero, gafas de sol y cresta",top:"#f4f4f6",top2:"#16161c",trousers:"#1b1d2b",hat:"mohawk",hatColor:"#e11d48",neck:"chain",neckColor:"#c9ccd6",shades:true,jacket:true},
 {key:"traje",label:"traje azul marino y corbata",top:"#ffffff",top2:"#1e2a4a",trousers:"#1e2a4a",hat:"none",neck:"tie",neckColor:"#b3261e",jacket:true,style:1},
 {key:"pijo",label:"polo y jersey sobre los hombros",top:"#f7a8c0",trousers:"#e7dccd",hat:"none",neck:"sweater",neckColor:"#2f4a7a",style:0},
 {key:"alternativo",label:"camiseta de colores, cinta en el pelo y melena",top:"#22a06b",top2:"#f6c445",trousers:"#7a5a3a",hat:"band",hatColor:"#e2574c",neck:"scarf",neckColor:"#7c5cd6",stripes:true,style:2},
 {key:"deportista",label:"chándal con rayas y cinta de deporte",top:"#0ea5a4",top2:"#ffffff",trousers:"#0b6b6a",hat:"band",hatColor:"#ffffff",neck:"none",stripes:true},
 {key:"gotico",label:"todo de negro con el pelo morado",top:"#16161c",top2:"#7c3aed",trousers:"#16161c",hat:"none",neck:"chain",neckColor:"#c9ccd6",hair:"#7c3aed",style:2,emblem:"#7c3aed"},
 {key:"obrero",label:"mono de trabajo y casco",top:"#2f6fb5",top2:"#f6c445",trousers:"#2f6fb5",hat:"helmet",hatColor:"#f6c445",neck:"none",emblem:"#f6c445"},
 {key:"artista",label:"boina, jersey de rayas y bufanda",top:"#f4f1ec",top2:"#22252e",trousers:"#3a3f55",hat:"beret",hatColor:"#b3261e",neck:"scarf",neckColor:"#b3261e",stripes:true},
 {key:"surfero",label:"camiseta de tirantes, gorro de lana y bermudas",top:"#facc15",trousers:"#38bdf8",hat:"beanie",hatColor:"#f08a24",neck:"none",shades:true},
 {key:"clasico",label:"chaqueta de pana y pañuelo al cuello",top:"#e7dccd",top2:"#7a4a2a",trousers:"#4a3a2a",hat:"none",neck:"scarf",neckColor:"#16a34a",jacket:true,glasses:true,style:3},
];
export const NAMES=["Lucía","Hugo","Martina","Pablo","Carmen","Álvaro","Sofía","Manolo","Paula","Javier","Elena","Íker","Rocío","Sergio","Marta","Adrián","Nuria","Rubén","Alba","Gonzalo","Irene","Dani","Pilar","Óscar",
 "Lola","Marcos","Inés","Jorge","Candela","Raúl","Aitana","Nacho","Vega","Fran","Olivia","Curro","Noa","Quique","Jimena","Toño","Blanca","Chema","Ainhoa","Paco","Triana","Guille","Macarena","Kiko"];
export type Face={skin:string;hair:string;shirt:string;style:0|1|2|3;glasses:boolean;headset:boolean;outfit?:Outfit};
const SKIN=["#f6d7b8","#f1c9a5","#d9a47a","#b07a52","#8a5a3b"];
const HAIR=["#2b1d14","#5a3a1e","#101018","#8a6a3a","#b5522d","#6b6f7a"];
export function hash(id:string){let h=2166136261;for(const c of id)h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;return h;}

/** Reparto: a cada identificador, un nombre de pila y una forma de vestir. Sin repetir dentro del grupo mientras haya libres. */
export type Role={name:string;outfit:Outfit};
const cast=new Map<string,Role>();
export function assignCast(ids:string[]):Map<string,Role>{
 const out=new Map<string,Role>(),names=new Set<string>(),looks=new Set<string>();
 for(const id of [...new Set(ids)].sort()){
  const h=hash(id);let n=h%NAMES.length,o=(h>>>9)%OUTFITS.length;
  for(let k=0;k<NAMES.length&&names.has(NAMES[n]);k++)n=(n+1)%NAMES.length;
  for(let k=0;k<OUTFITS.length&&looks.has(OUTFITS[o].key);k++)o=(o+1)%OUTFITS.length;
  names.add(NAMES[n]);looks.add(OUTFITS[o].key);if(looks.size===OUTFITS.length)looks.clear();if(names.size===NAMES.length)names.clear();
  const role={name:NAMES[n],outfit:OUTFITS[o]};out.set(id,role);cast.set(id,role);
 }
 return out;
}
export function roleOf(id:string):Role{
 const known=cast.get(id);if(known)return known;const h=hash(id);return {name:NAMES[h%NAMES.length],outfit:OUTFITS[(h>>>9)%OUTFITS.length]};
}
export function faceOf(id:string):Face{
 const h=hash(id),o=roleOf(id).outfit;
 return {skin:SKIN[h%SKIN.length],hair:o.hair??HAIR[(h>>>3)%HAIR.length],shirt:o.top,style:o.style??(((h>>>11)%4) as Face["style"]),glasses:!!o.glasses,headset:!!o.headset,outfit:o};
}
/** Los que aún no existen: todo en gris claro, sin rasgos de color. */
export const GHOST_FACE:Face={skin:"#eceef4",hair:"#d3d7e2",shirt:"#dfe2ea",style:0,glasses:false,headset:false};

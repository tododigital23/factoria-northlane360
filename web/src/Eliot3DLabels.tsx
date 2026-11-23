import {useEffect,useMemo} from "react";
import {CanvasTexture,LinearFilter,SRGBColorSpace} from "three";

/** Camera-facing text derived solely from authorized scene props. */
export function SceneLabel({text,position,kind="department"}:{
 text:string;position:[number,number,number];
 kind?:"eliot"|"company"|"department"|"worker"|"sign"|"pill";
}){
 const texture=useMemo(()=>{
  const canvas=document.createElement("canvas");
  canvas.width=768;canvas.height=128;
  const ctx=canvas.getContext("2d");
  if(!ctx)return null;
  ctx.clearRect(0,0,768,128);
  const palette={
   eliot:{fill:"#49376e",border:"#c7a7ff",text:"#f8f1ff"},
   company:{fill:"#16414e",border:"#8adfe8",text:"#efffff"},
   department:{fill:"#332a50",border:"#9982c7",text:"#ffffff"},
   worker:{fill:"#292b40",border:"#727b98",text:"#e5e7f4"},
   sign:{fill:"#4f46e5",border:"#4f46e5",text:"#ffffff"},
   pill:{fill:"#ffffff",border:"#ffffff",text:"#12162b"}
  }[kind];
  ctx.fillStyle=palette.fill;
  ctx.strokeStyle=palette.border;
  ctx.lineWidth=4;
  ctx.beginPath();
  ctx.roundRect(10,12,748,102,30);
  ctx.fill();ctx.stroke();
  ctx.fillStyle=palette.text;
  ctx.font=kind==="worker"?"500 42px sans-serif":"bold 47px sans-serif";
  ctx.textAlign="center";ctx.textBaseline="middle";
  const trimmed=text.length>37?text.slice(0,34)+"…":text;
  ctx.fillText(trimmed,384,65,710);
  const map=new CanvasTexture(canvas);
  map.colorSpace=SRGBColorSpace;
  map.minFilter=LinearFilter;
  map.anisotropy=2;
  map.needsUpdate=true;
  return map;
 },[text,kind]);
 useEffect(()=>()=>{texture?.dispose()},[texture]);
 if(!texture)return null;
 const scale: [number,number,number]=kind==="worker"?[1.95,.33,1]:kind==="company"||kind==="sign"?[2.45,.4,1]:[2.05,.36,1];
 return <sprite position={position} scale={scale}>
  <spriteMaterial map={texture} transparent depthWrite={false} opacity={.97}/>
 </sprite>;
}

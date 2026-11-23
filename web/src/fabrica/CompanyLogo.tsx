import {useEffect,useMemo,useState} from "react";

/** Rutas habituales del icono de una web. Se piden a la PROPIA web de la empresa, nunca a un servicio de terceros. */
const ICON_PATHS=["/apple-touch-icon.png","/images/icon.svg","/favicon.svg","/icon.svg","/logo.svg","/logo.png","/favicon.ico"];
export function logoCandidates(website:string|null|undefined):string[]{
 if(!website)return [];
 try{const u=new URL(website);return u.protocol==="https:"?ICON_PATHS.map(p=>u.origin+p):[];}catch{return [];}
}
export function monogram(name:string):string{
 const words=name.replace(/\.(com|es|net|org|digital|io)$/i,"").split(/[\s._-]+/).filter(Boolean);
 const letters=words.length>1?words[0][0]+words[1][0]:(words[0]??"·").slice(0,2);
 return letters.toUpperCase();
}
/** Logo de la web de la empresa. Mientras no cargue (o si la web no ofrece ninguno), se ven sus iniciales. Es decorativo: el nombre va siempre al lado. */
/** Marca de una empresa dentro del holding. La matriz (Nova Demo LLC) usa el mismo logo que el Portal, con la bandera de EE. UU. detrás. */
export function companyBrand(company:{name:string;website_url?:string|null},all:{name:string;website_url?:string|null}[]):{website:string|null;flag:boolean}{
 if(!/\bLLC\b/i.test(company.name))return {website:company.website_url??null,flag:false};
 const portal=all.find(c=>c!==company&&/portal/i.test(c.name)&&c.website_url);
 return {website:company.website_url??portal?.website_url??null,flag:true};
}
export function CompanyLogo({name,website,className,flag=false}:{name:string;website:string|null|undefined;className?:string;flag?:boolean}){
 const list=useMemo(()=>logoCandidates(website),[website]);
 const [index,setIndex]=useState(0),[loaded,setLoaded]=useState(false);
 useEffect(()=>{setIndex(0);setLoaded(false);},[list]);
 const src=list[index];
 return <span className={"company-logo"+(loaded?" has-image":"")+(flag?" us-flag":"")+(className?" "+className:"")} aria-hidden="true">
  <span className="company-logo-letters">{monogram(name)}</span>
  {src&&<img key={src} src={src} alt="" decoding="async" referrerPolicy="no-referrer" draggable={false} onLoad={e=>{if(e.currentTarget.naturalWidth>1)setLoaded(true);else setIndex(i=>i+1);}} onError={()=>{setLoaded(false);setIndex(i=>i+1);}}/>}
 </span>;
}

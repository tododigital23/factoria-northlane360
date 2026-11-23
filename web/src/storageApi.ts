/* Almacén cifrado de Northlane360 (037). Contrato estricto: ninguna respuesta lleva llaves ni contenido. */
import {HOLDING_URL,chars} from "./holdingApi";

const holdingUrl=(h:string)=>HOLDING_URL+"/"+encodeURIComponent(h);
export const storageUrls={
 status:(h:string)=>holdingUrl(h)+"/storage",
 start:(h:string)=>holdingUrl(h)+"/storage/google/start",
 test:(h:string)=>holdingUrl(h)+"/storage/test",
 disconnect:(h:string)=>holdingUrl(h)+"/storage/disconnect",
 name:(h:string)=>holdingUrl(h)+"/name"
};
const obj=(v:unknown):v is Record<string,unknown>=>typeof v==="object"&&v!==null&&!Array.isArray(v);

export type StorageStatus={holding_id:string;provider:"google_drive";encrypted_before_upload:true;enabled:boolean;server_configured:boolean;connected:boolean;connected_at?:string|null;companies_with_storage?:number};
export function validStorageStatus(raw:unknown,holding:string):raw is StorageStatus{
 return obj(raw)&&raw.holding_id===holding&&raw.provider==="google_drive"&&raw.encrypted_before_upload===true
  &&typeof raw.enabled==="boolean"&&typeof raw.server_configured==="boolean"&&typeof raw.connected==="boolean"
  &&(raw.connected_at===undefined||raw.connected_at===null||(typeof raw.connected_at==="string"&&Number.isFinite(Date.parse(raw.connected_at))))
  &&(raw.companies_with_storage===undefined||(Number.isInteger(raw.companies_with_storage)&&(raw.companies_with_storage as number)>=0&&(raw.companies_with_storage as number)<=20));
}
/** Solo se acepta ir a la página de permisos de Google, con el permiso mínimo. */
export function validStart(raw:unknown,holding:string):raw is {holding_id:string;authorization_url:string}{
 if(!obj(raw)||raw.holding_id!==holding||typeof raw.authorization_url!=="string")return false;
 try{const u=new URL(raw.authorization_url);return u.protocol==="https:"&&u.hostname==="accounts.google.com"&&u.pathname==="/o/oauth2/v2/auth"&&u.searchParams.get("scope")==="https://www.googleapis.com/auth/drive.file";}
 catch{return false;}
}
export type StorageTest={holding_id:string;ok:boolean;reason:string|null;uploaded:boolean;stored_unreadable:boolean;downloaded_and_verified:boolean;deleted:boolean};
export function validTest(raw:unknown,holding:string):raw is StorageTest{
 return obj(raw)&&raw.holding_id===holding&&typeof raw.ok==="boolean"&&(raw.reason===null||typeof raw.reason==="string")
  &&(["uploaded","stored_unreadable","downloaded_and_verified","deleted"] as const).every(k=>typeof raw[k]==="boolean")
  &&(!raw.ok||(raw.uploaded===true&&raw.stored_unreadable===true&&raw.downloaded_and_verified===true&&raw.deleted===true));
}
export const validDisconnect=(raw:unknown,holding:string)=>obj(raw)&&raw.holding_id===holding&&raw.connected===false;
export function validateHoldingName(name:string):string|null{
 const n=name.trim();
 if(chars(n)<2||chars(n)>120)return "Entre 2 y 120 caracteres.";
 if(/[\u0000-\u001f\u007f]/.test(n))return "No puede contener saltos de línea ni caracteres de control.";
 return null;
}
export function validHoldingRename(raw:unknown,holding:string,name:string):raw is {holding_id:string;name:string;renamed:boolean}{
 return obj(raw)&&raw.holding_id===holding&&raw.name===name.trim()&&typeof raw.renamed==="boolean";
}
/** Lo que vuelve en la dirección tras pasar por Google (?almacen=…), traducido. Nunca lleva datos. */
export const RETURN_MESSAGES:Record<string,{ok:boolean;text:string}>={
 conectado:{ok:true,text:"Google Drive conectado. Pulsa «Probar» para comprobarlo de extremo a extremo."},
 cancelado:{ok:false,text:"Has cancelado el permiso en Google. No se ha conectado nada."},
 caducado:{ok:false,text:"El permiso de conexión ha caducado (dura 10 minutos). Vuelve a pulsar «Conectar Google Drive»."},
 rechazado:{ok:false,text:"Google no ha aceptado la conexión. Revisa las credenciales guardadas en el servidor."},
 otra_cuenta:{ok:false,text:"Esa cuenta de Google no es la que ya guarda las carpetas de tus empresas. Conecta con la cuenta original."},
 sin_permiso:{ok:false,text:"Solo el propietario del holding puede conectar el almacén."},
 error:{ok:false,text:"No se ha podido completar la conexión. No se ha guardado nada; vuelve a intentarlo."}
};
export const TEST_REASONS:Record<string,string>={
 provider_denied:"Google ha denegado el acceso. Vuelve a conectar la cuenta.",
 provider_unreachable:"No se ha podido llegar a Google. Inténtalo de nuevo en un momento.",
 provider_rejected_credentials:"Google ha rechazado las credenciales guardadas. Vuelve a conectar la cuenta.",
 verification_failed:"El archivo descargado no ha superado la verificación.",
 incomplete:"La prueba no se ha completado."
};

/**
 * Avisos de Freddy: lo que los agentes de cada empresa tienen que decirle al propietario, reunido en un solo sitio.
 * De cada aviso solo llegan su gravedad, su clave, cuántos casos son y las referencias de pedido. El texto se compone AQUÍ
 * a partir de la clave, así que ningún dato de clientes puede colarse en él.
 */
import type {PortalAgent} from "../office/PortalAgents";

export type NoticeLevel="urgente"|"importante"|"info";
export type RawNotice={level:NoticeLevel;code:string;count:number|null;refs:string[];ownTitle?:string;ownProposal?:string};
export type Notice=RawNotice&{key:string;organizationId:string;company:string;slot:number|null;agent:string;title:string;proposal:string|null;panelUrl:string|null};

const NOTICE_TEXT=/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .,:;()«»¿?¡!%€$/+'-]{3,140}$/;
const ORDER_REF=/^[a-z]{2,5}-[A-Z]{3}-[A-Za-z0-9]{1,16}(-[A-Z])?$/;
const LEVELS:readonly string[]=["urgente","importante","info"];
export const LEVEL_LABEL:Record<NoticeLevel,string>={urgente:"Urgente",importante:"Importante",info:"Para tu información"};
const RANK:Record<NoticeLevel,number>={urgente:0,importante:1,info:2};

/** Reduce a su forma segura lo que venga del servidor: lo que no encaje se descarta. */
export function cleanNotices(raw:unknown):RawNotice[]{
 if(!Array.isArray(raw))return [];
 const out:RawNotice[]=[];
 for(const x of raw.slice(0,12)){
  if(!x||typeof x!=="object")continue;const n=x as Record<string,unknown>;
  if(typeof n.level!=="string"||!LEVELS.includes(n.level)||typeof n.code!=="string"||!/^[a-z_]{2,30}$/.test(n.code))continue;
  const count=typeof n.count==="number"&&Number.isInteger(n.count)&&n.count>=0?n.count:null;
  const refs=Array.isArray(n.refs)?[...new Set(n.refs.filter((r):r is string=>typeof r==="string"&&ORDER_REF.test(r)))].slice(0,6):[];
  // Un aviso propio de otra empresa trae su título: una frase llana, sin correos ni números largos.
  const plain=(v:unknown)=>typeof v==="string"&&NOTICE_TEXT.test(v.trim())&&!/\d{7,}/.test(v)?v.trim():undefined;
  const title=plain(n.title),proposal=title?plain(n.proposal):undefined;
  out.push({level:n.level as NoticeLevel,code:n.code,count,refs,...(title?{ownTitle:title}:{}),...(proposal?{ownProposal:proposal}:{})});
 }
 return out;
}

const pl=(n:number|null,one:string,many:string)=>n===1?one:`${n??"Varios"} ${many}`;
type Copy=(n:number|null)=>[title:string,proposal:string|null];
const COPY:Record<string,Copy>={
 parciales:n=>[pl(n,"Un pedido cobrado se quedó a medias","pedidos cobrados se quedaron a medias"),"Al cliente le falta alguna plataforma que ha pagado. Rescátalo desde Reparaciones."],
 rescate_fallido:n=>[pl(n,"Un segundo intento de entrega ha fallado","segundos intentos de entrega han fallado"),"Al cliente le falta una plataforma que ha pagado. Hay que ponérsela a mano desde su ficha."],
 paquete_incompleto:n=>[pl(n,"Un pedido cobrado se cerró a mano y al cliente le sigue faltando una plataforma en la web","pedidos cobrados se cerraron a mano y a sus clientes les sigue faltando una plataforma en la web"),"Si ya la pusiste en el panel, márcalo como resuelto en Reparaciones para registrarla; si no, ponla."],
 sin_claves:n=>[pl(n,"Una compra pagada lleva más de 10 minutos sin entregar las claves","compras pagadas llevan más de 10 minutos sin entregar las claves"),"El cliente ha pagado y está esperando. Mira el pedido en Reparaciones y avísale."],
 agente_frenado:()=>["El asistente del chat ha llegado a su tope de gasto y ha dejado de contestar","Sube el tope o atiende el chat a mano."],
 telegram_aviso:n=>[pl(n,"Un aviso de caducidad no se ha podido entregar por Telegram","avisos de caducidad no se han podido entregar por Telegram"),"Avisa a esos clientes por otro medio."],
 dias_de_mas:n=>[pl(n,"El panel aplicó más días de los pagados en un pedido","pedidos en los que el panel aplicó más días de los pagados"),"La web ya guarda la fecha correcta. Corrige la caducidad también en el panel."],
 duplicados:n=>[pl(n,"Un posible cobro duplicado","posibles cobros duplicados"),"Compruébalo en Stripe y devuelve uno si se cobró dos veces."],
 sin_aviso:n=>[pl(n,"Una cuenta caduca en 3 días o menos sin aviso de renovación","cuentas caducan en 3 días o menos sin aviso de renovación"),"Revisa el envío de avisos y avisa a mano desde el panel."],
 cron_avisos:n=>[`Los avisos de caducidad llevan más de 36 horas sin enviarse${n?` y ${pl(n,"una cuenta caduca","cuentas caducan")} esta semana`:""}`,"Comprueba que el envío programado sigue activo."],
 decision:n=>[pl(n,"Una renovación espera tu decisión","renovaciones esperan tu decisión"),"El usuario no existe en el panel. Decide en Reparaciones si se crea una cuenta nueva."],
 caducidad_larga:n=>[pl(n,"Una cuenta nueva caduca a más de 400 días","cuentas nuevas caducan a más de 400 días"),"Comprueba si el cliente renovó con tiempo pendiente o si se sumaron días de más."],
 repetidos:n=>[pl(n,"Un pago o aviso de pago repetido en 24 horas","pagos o avisos de pago repetidos en 24 horas"),"Comprueba que no se sumaron días dos veces."],
 pruebas_vivas:n=>[pl(n,"Una prueba de 24 horas sigue activa pasadas 48 horas","pruebas de 24 horas siguen activas pasadas 48 horas"),"Revisa por qué no caducó."],
 duplicadas:n=>[pl(n,"Una cuenta nueva comparte usuario y plataforma con otro cliente","cuentas nuevas comparten usuario y plataforma con otro cliente"),"Revísalo antes de que dos clientes tengan la misma cuenta."],
 premio_sin_derecho:n=>[pl(n,"Un premio de referidos pendiente sin los 5 amigos pagados","premios de referidos pendientes sin los 5 amigos pagados"),"Revísalo antes de que lo canjeen."],
 cupones:n=>[pl(n,"Un cupón usado más veces de lo permitido","cupones usados más veces de lo permitido"),"Desactívalo y revisa las compras."],
 chat:n=>[pl(n,"Una conversación de chat espera respuesta desde hace más de 2 horas","conversaciones de chat esperan respuesta desde hace más de 2 horas"),null],
 whatsapp:n=>[pl(n,"Un aviso de WhatsApp lleva más de 24 horas sin enviarse","avisos de WhatsApp llevan más de 24 horas sin enviarse"),"Revisa el envío de WhatsApp."],
 claves_en_claro:n=>[pl(n,"Una cuenta nueva se guardó con la contraseña sin cifrar","cuentas nuevas se guardaron con la contraseña sin cifrar"),"Revisa la ruta que las crea y cifra las que falten."],
 login:n=>[`Pico de intentos de acceso${n?`: ${n} sobre una misma clave en una hora`:""}`,"Revisa si alguien está probando contraseñas."],
};
export function noticeCopy(code:string,count:number|null,own?:{ownTitle?:string;ownProposal?:string}):[string,string|null]{
 if(code.startsWith("error_"))return ["Un agente no pudo completar su revisión","Se reintentará en la próxima ronda."];
 if(COPY[code])return COPY[code](count);
 return own?.ownTitle?[own.ownTitle,own.ownProposal??null]:["Aviso de un agente","Ábrelo en el panel de la empresa."];
}

export type CompanyFeed={organizationId:string;company:string;slot:number|null;panelUrl:string|null;agents:PortalAgent[]};
/** Todos los avisos de todas las empresas, los urgentes primero. */
export function collectNotices(feeds:CompanyFeed[]):Notice[]{
 const out:Notice[]=[];
 for(const f of feeds)for(const a of f.agents)for(const n of cleanNotices((a as PortalAgent&{notices?:unknown}).notices)){
  const [title,proposal]=noticeCopy(n.code,n.count,n);
  out.push({...n,key:`${f.organizationId}:${a.id}:${n.code}`,organizationId:f.organizationId,company:f.company,slot:f.slot,agent:a.name,title,proposal,panelUrl:f.panelUrl});
 }
 return out.sort((a,b)=>RANK[a.level]-RANK[b.level]||a.company.localeCompare(b.company));
}
/** Qué ha cambiado entre dos lecturas: avisos nuevos (o que suben de gravedad o suman casos) y avisos que ya no están. */
export function noticeChanges(prev:Notice[],next:Notice[]):{fresh:Notice[];resolved:Notice[]}{
 const before=new Map(prev.map(n=>[n.key,n])),now=new Set(next.map(n=>n.key));
 return {fresh:next.filter(n=>{const p=before.get(n.key);return !p||RANK[n.level]<RANK[p.level]||n.refs.some(r=>!p.refs.includes(r));}),resolved:prev.filter(n=>!now.has(n.key))};
}

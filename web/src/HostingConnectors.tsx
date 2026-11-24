import {useCallback,useEffect,useId,useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";

const READ={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}};
const WRITE={authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks create:tasks"}};

type Kind="ftp"|"ftps"|"mysql"|"mariadb"|"postgresql"|"mssql"|"mongodb";
type Connector={id:string;organization_id:string;kind:Kind;label:string;host:string;port:number;username:string;
 remote_path:string|null;database_name:string|null;status:string;last_tested_at:string|null;last_error:string|null;has_secret:boolean};
type Manager={id:string;label:string;since:string};
type Invite={id:string;label:string;expires_at:string};

const KINDS: {value:Kind;label:string;group:"hosting"|"database"}[]=[
 {value:"ftp",label:"FTP (hosting / VPS)",group:"hosting"},
 {value:"ftps",label:"FTPS (hosting / VPS cifrado)",group:"hosting"},
 {value:"mysql",label:"MySQL",group:"database"},
 {value:"mariadb",label:"MariaDB",group:"database"},
 {value:"postgresql",label:"PostgreSQL",group:"database"},
 {value:"mssql",label:"SQL Server",group:"database"},
 {value:"mongodb",label:"MongoDB",group:"database"},
];
const emptyForm=()=>({kind:"ftp" as Kind,label:"",host:"",port:"",username:"",password:"",remote_path:"",database_name:""});

function isConnector(v:unknown):v is Connector{
 return typeof v==="object"&&v!==null&&typeof (v as Connector).id==="string"&&typeof (v as Connector).kind==="string"
  &&typeof (v as Connector).label==="string"&&typeof (v as Connector).host==="string";
}

export function HostingConnectors({organizationId,canEdit}:{organizationId:string;canEdit:boolean}){
 const {getAccessTokenSilently}=useAuth0();
 const uid=useId();
 const [items,setItems]=useState<Connector[]>([]);
 const [managers,setManagers]=useState<Manager[]>([]);
 const [invites,setInvites]=useState<Invite[]>([]);
 const [cryptoReady,setCryptoReady]=useState(true);
 const [form,setForm]=useState(emptyForm());
 const [busy,setBusy]=useState("");
 const [note,setNote]=useState<{ok:boolean;text:string}|null>(null);
 const [inviteLabel,setInviteLabel]=useState("");
 const [inviteToken,setInviteToken]=useState<string|null>(null);
 const base=API_ROOT+"/v1/me/organizations/"+encodeURIComponent(organizationId);
 const isFtp=form.kind==="ftp"||form.kind==="ftps";

 const load=useCallback(async(signal?:AbortSignal)=>{
  const token=await getAccessTokenSilently(READ);
  const r=await fetch(base+"/connectors",{headers:{Authorization:"Bearer "+token},signal});
  if(r.status===404||r.status===503){setNote({ok:false,text:"Los conectores aún no están disponibles en el servidor (actualización 042)."});return;}
  if(!r.ok){setNote({ok:false,text:"No se pudo cargar los conectores ("+r.status+")."});return;}
  const raw:unknown=await r.json();
  const list=typeof raw==="object"&&raw&&Array.isArray((raw as {connectors?:unknown}).connectors)?(raw as {connectors:unknown[]}).connectors:[];
  setItems(list.filter(isConnector));
  setCryptoReady(!(typeof raw==="object"&&raw&&(raw as {crypto_ready?:boolean}).crypto_ready===false));
  if(canEdit){
   const m=await fetch(base+"/managers",{headers:{Authorization:"Bearer "+token},signal});
   if(m.ok){
    const body:unknown=await m.json();
    if(typeof body==="object"&&body){
     const mgrs=(body as {managers?:unknown}).managers;const inv=(body as {invites?:unknown}).invites;
     setManagers(Array.isArray(mgrs)?mgrs.filter((x):x is Manager=>typeof x==="object"&&!!x&&typeof (x as Manager).id==="string"):[]);
     setInvites(Array.isArray(inv)?inv.filter((x):x is Invite=>typeof x==="object"&&!!x&&typeof (x as Invite).id==="string"):[]);
    }
   }
  }
 },[base,canEdit,getAccessTokenSilently]);

 useEffect(()=>{const a=new AbortController();void load(a.signal).catch(()=>{});return()=>a.abort();},[load]);

 async function save(){
  if(!canEdit||busy)return;
  setBusy("save");setNote(null);
  try{
   const token=await getAccessTokenSilently(WRITE);
   const body={
    kind:form.kind,label:form.label.trim(),host:form.host.trim(),
    port:form.port?Number(form.port):undefined,username:form.username.trim(),password:form.password,
    remote_path:isFtp?(form.remote_path.trim()||null):null,
    database_name:!isFtp?(form.database_name.trim()||null):null,
   };
   const r=await fetch(base+"/connectors",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(body)});
   if(r.status===403){setNote({ok:false,text:"No tienes permiso para conectar datos en esta empresa."});return;}
   if(r.status===422){setNote({ok:false,text:"Revisa host, usuario, contraseña y base/ruta."});return;}
   if(r.status===503){setNote({ok:false,text:!cryptoReady?"Falta ELIOT_STORAGE_MASTER_KEY en la API para cifrar contraseñas.":"El servidor no ha confirmado el conector."});return;}
   if(!r.ok){setNote({ok:false,text:"No se pudo guardar el conector ("+r.status+")."});return;}
   setForm(emptyForm());setNote({ok:true,text:"Conector guardado. La contraseña queda cifrada; no se vuelve a mostrar."});
   await load();
  }finally{setBusy("");}
 }

 async function testOne(id:string){
  if(!canEdit||busy)return;setBusy("test:"+id);setNote(null);
  try{
   const token=await getAccessTokenSilently(WRITE);
   const r=await fetch(base+"/connectors/"+encodeURIComponent(id)+"/test",{method:"POST",headers:{Authorization:"Bearer "+token}});
   const raw:unknown=r.ok?await r.json():null;
   if(r.ok&&typeof raw==="object"&&raw&&(raw as {ok?:boolean}).ok){setNote({ok:true,text:"Conexión correcta."});}
   else{const err=typeof raw==="object"&&raw&&typeof (raw as {error?:unknown}).error==="string"?(raw as {error:string}).error:"Prueba fallida ("+r.status+").";setNote({ok:false,text:err});}
   await load();
  }finally{setBusy("");}
 }

 async function removeOne(id:string){
  if(!canEdit||busy)return;setBusy("rm:"+id);setNote(null);
  try{
   const token=await getAccessTokenSilently(WRITE);
   const r=await fetch(base+"/connectors/"+encodeURIComponent(id)+"/remove",{method:"POST",headers:{Authorization:"Bearer "+token}});
   if(!r.ok){setNote({ok:false,text:"No se pudo quitar el conector."});return;}
   setNote({ok:true,text:"Conector eliminado."});await load();
  }finally{setBusy("");}
 }

 async function inviteManager(){
  if(!canEdit||busy||!inviteLabel.trim())return;setBusy("invite");setInviteToken(null);setNote(null);
  try{
   const token=await getAccessTokenSilently(WRITE);
   const r=await fetch(base+"/managers/invites",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({label:inviteLabel.trim()})});
   if(!r.ok){setNote({ok:false,text:"No se pudo crear la invitación de gestor."});return;}
   const raw:unknown=await r.json();
   const t=typeof raw==="object"&&raw&&typeof (raw as {token?:unknown}).token==="string"?(raw as {token:string}).token:"";
   if(!t){setNote({ok:false,text:"La invitación no devolvió enlace."});return;}
   setInviteToken(t);setInviteLabel("");await load();
   setNote({ok:true,text:"Invitación creada. Copia el enlace ahora: solo se muestra una vez."});
  }finally{setBusy("");}
 }

 async function revokeManager(id:string){
  if(!canEdit||busy)return;setBusy("rev:"+id);
  try{
   const token=await getAccessTokenSilently(WRITE);
   await fetch(base+"/managers/"+encodeURIComponent(id)+"/revoke",{method:"POST",headers:{Authorization:"Bearer "+token}});
   await load();
  }finally{setBusy("");}
 }

 const inviteUrl=inviteToken?window.location.origin+"/?manager_invite="+encodeURIComponent(inviteToken):"";

 return <div className="hosting-connectors">
  <p>Conecta el hosting (FTP/FTPS) y la base de datos de esta web. Con la base guardada, la pestaña <strong>Operación tienda</strong> vigila pedidos, problemas y chats, y el reporte diario sale por Telegram. Las contraseñas se cifran y no se muestran después.</p>
  <p>Si es WooCommerce, pon en el nombre algo como «WooCommerce tienda»; si es PrestaShop, «PrestaShop…». Así se eligen las consultas adecuadas.</p>
  {!cryptoReady&&<p className="wizard-error" role="alert">La API aún no tiene llave maestra de cifrado (<code>ELIOT_STORAGE_MASTER_KEY</code>). Sin ella no se pueden guardar secretos.</p>}
  {note&&<p className={note.ok?"invite-note ok":"invite-note bad"} role="status">{note.text}</p>}

  <h3>Conectores guardados</h3>
  {items.length===0?<p>Todavía no hay FTP ni bases conectadas en esta empresa.</p>:
   <ul className="integration-list">{items.map(c=><li key={c.id}>
    <b>{c.label}</b> · {c.kind} · {c.username}@{c.host}:{c.port}
    {c.database_name?" · BD "+c.database_name:""}{c.remote_path?" · "+c.remote_path:""}
    <small> · {c.status}{c.last_error?" · "+c.last_error:""}</small>
    {canEdit&&<span> <button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void testOne(c.id)}>Probar</button>
     <button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void removeOne(c.id)}>Quitar</button></span>}
   </li>)}</ul>}

  {canEdit&&<>
   <h3>Añadir o actualizar conector</h3>
   <div className="integration-form">
    <label htmlFor={uid+"kind"}>Tipo</label>
    <select id={uid+"kind"} value={form.kind} disabled={!!busy} onChange={e=>setForm(f=>({...f,kind:e.target.value as Kind}))}>
     <optgroup label="Hosting / VPS">{KINDS.filter(k=>k.group==="hosting").map(k=><option key={k.value} value={k.value}>{k.label}</option>)}</optgroup>
     <optgroup label="Base de datos de la web">{KINDS.filter(k=>k.group==="database").map(k=><option key={k.value} value={k.value}>{k.label}</option>)}</optgroup>
    </select>
    <label htmlFor={uid+"label"}>Nombre</label>
    <input id={uid+"label"} value={form.label} maxLength={80} disabled={!!busy} placeholder="Hosting producción" onChange={e=>setForm(f=>({...f,label:e.target.value}))}/>
    <label htmlFor={uid+"host"}>Host</label>
    <input id={uid+"host"} value={form.host} maxLength={253} disabled={!!busy} placeholder="ftp.tudominio.com" onChange={e=>setForm(f=>({...f,host:e.target.value}))}/>
    <label htmlFor={uid+"port"}>Puerto (opcional)</label>
    <input id={uid+"port"} value={form.port} disabled={!!busy} placeholder="por defecto según tipo" onChange={e=>setForm(f=>({...f,port:e.target.value}))}/>
    <label htmlFor={uid+"user"}>Usuario</label>
    <input id={uid+"user"} value={form.username} maxLength={120} disabled={!!busy} onChange={e=>setForm(f=>({...f,username:e.target.value}))}/>
    <label htmlFor={uid+"pass"}>Contraseña</label>
    <input id={uid+"pass"} type="password" value={form.password} maxLength={400} disabled={!!busy} autoComplete="new-password" onChange={e=>setForm(f=>({...f,password:e.target.value}))}/>
    {isFtp?<><label htmlFor={uid+"path"}>Ruta remota (opcional)</label>
     <input id={uid+"path"} value={form.remote_path} maxLength={400} disabled={!!busy} placeholder="/public_html" onChange={e=>setForm(f=>({...f,remote_path:e.target.value}))}/></>
     :<> <label htmlFor={uid+"db"}>Nombre de la base</label>
     <input id={uid+"db"} value={form.database_name} maxLength={120} disabled={!!busy} placeholder="nombre_bd" onChange={e=>setForm(f=>({...f,database_name:e.target.value}))}/></>}
    <button type="button" className="campus-primary" disabled={!!busy||!form.label.trim()||!form.host.trim()||!form.username.trim()||!form.password} onClick={()=>void save()}>{busy==="save"?"Guardando…":"Guardar conector"}</button>
   </div>

   <h3>Gestores de esta empresa</h3>
   <p>Crea un perfil para que otra persona conecte sola el FTP y la base de <strong>esta</strong> empresa, sin ver el resto del holding.</p>
   <ul className="integration-list">
    {managers.map(m=><li key={m.id}><b>{m.label}</b> · desde {m.since} <button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void revokeManager(m.id)}>Retirar</button></li>)}
    {invites.map(i=><li key={i.id}>Invitación pendiente: <b>{i.label}</b> · caduca {i.expires_at} <button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void revokeManager(i.id)}>Anular</button></li>)}
   </ul>
   <div className="integration-form">
    <label htmlFor={uid+"mgr"}>Nombre del gestor</label>
    <input id={uid+"mgr"} value={inviteLabel} maxLength={80} disabled={!!busy} placeholder="Ana · tienda online" onChange={e=>setInviteLabel(e.target.value)}/>
    <button type="button" className="campus-ghost" disabled={!!busy||!inviteLabel.trim()} onClick={()=>void inviteManager()}>Crear invitación</button>
   </div>
   {inviteUrl&&<p role="status">Enlace de un solo uso: <code className="integration-code">{inviteUrl}</code></p>}
  </>}
 </div>;
}

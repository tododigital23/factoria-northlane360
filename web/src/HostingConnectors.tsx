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
const DB_KINDS=new Set<Kind>(["mysql","mariadb","postgresql","mssql","mongodb"]);
const emptyForm=(kind:Kind="mysql")=>({kind,label:"",host:"",port:"",username:"",password:"",remote_path:"",database_name:""});

function isConnector(v:unknown):v is Connector{
 return typeof v==="object"&&v!==null&&typeof (v as Connector).id==="string"&&typeof (v as Connector).kind==="string"
  &&typeof (v as Connector).label==="string"&&typeof (v as Connector).host==="string";
}

function statusText(c:Connector){
 if(c.status==="configured"&&!c.last_error)return "listo";
 if(c.status==="failed")return "prueba fallida"+(c.last_error?": "+c.last_error:"");
 return c.status+(c.last_error?" · "+c.last_error:"");
}

export function HostingConnectors({organizationId,canEdit}:{organizationId:string;canEdit:boolean}){
 const {getAccessTokenSilently}=useAuth0();
 const uid=useId();
 const [items,setItems]=useState<Connector[]>([]);
 const [managers,setManagers]=useState<Manager[]>([]);
 const [invites,setInvites]=useState<Invite[]>([]);
 const [cryptoReady,setCryptoReady]=useState(true);
 const [form,setForm]=useState(emptyForm("mysql"));
 const [busy,setBusy]=useState("");
 const [note,setNote]=useState<{ok:boolean;text:string}|null>(null);
 const [inviteLabel,setInviteLabel]=useState("");
 const [inviteToken,setInviteToken]=useState<string|null>(null);
 const base=API_ROOT+"/v1/me/organizations/"+encodeURIComponent(organizationId);
 const isFtp=form.kind==="ftp"||form.kind==="ftps";
 const hasDb=items.some(c=>DB_KINDS.has(c.kind));
 const hasFtp=items.some(c=>c.kind==="ftp"||c.kind==="ftps");

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

 async function readError(r:Response){
  try{
   const raw:unknown=await r.json();
   if(typeof raw==="object"&&raw){
    const detail=(raw as {detail?:unknown}).detail;
    if(typeof detail==="string"&&detail.trim())return detail.trim();
    if(typeof (raw as {error?:unknown}).error==="string")return (raw as {error:string}).error;
   }
  }catch{/* ignore */}
  return "Error HTTP "+r.status;
 }

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
   if(r.status===422){setNote({ok:false,text:await readError(r)||"Revisa host, usuario, contraseña y nombre de la base."});return;}
   if(r.status===503){setNote({ok:false,text:!cryptoReady?"Falta ELIOT_STORAGE_MASTER_KEY en la API para cifrar contraseñas.":await readError(r)});return;}
   if(!r.ok){setNote({ok:false,text:await readError(r)});return;}
   const kindLabel=isFtp?"FTP":"base de datos";
   setForm(emptyForm(isFtp?"ftp":"mysql"));
   setNote({ok:true,text:"Conector de "+kindLabel+" guardado. La contraseña queda cifrada. Pulsa Probar en la lista."});
   await load();
  }catch(e){setNote({ok:false,text:e instanceof Error?e.message:"No se pudo guardar el conector."});}
  finally{setBusy("");}
 }

 async function discoverDb(id:string){
  if(!canEdit||busy)return;setBusy("discover:"+id);setNote(null);
  try{
   const token=await getAccessTokenSilently(WRITE);
   const r=await fetch(base+"/connectors/"+encodeURIComponent(id)+"/discover-database",{method:"POST",headers:{Authorization:"Bearer "+token}});
   let raw:unknown=null;
   try{raw=await r.json();}catch{raw=null;}
   if(r.ok&&typeof raw==="object"&&raw&&(raw as {saved?:boolean}).saved===true){
    const db=typeof (raw as {database_name?:unknown}).database_name==="string"?(raw as {database_name:string}).database_name:"";
    const host=typeof (raw as {host?:unknown}).host==="string"?(raw as {host:string}).host:"";
    const adjusted=(raw as {host_adjusted_from_localhost?:boolean}).host_adjusted_from_localhost===true;
    setNote({ok:true,text:"Base detectada desde wp-config y guardada"+(db?" («"+db+"» @ "+host+")":"")+"."+(adjusted?" Host localhost sustituido por el del FTP para poder conectar desde la nube.":"")+" Vuelve a Operación tienda → Actualizar estado."});
    await load();
   }else{
    const detail=typeof raw==="object"&&raw&&typeof (raw as {detail?:unknown}).detail==="string"?(raw as {detail:string}).detail:"";
    setNote({ok:false,text:detail||("No se pudo detectar la base ("+r.status+"). Rellena MySQL a mano desde cPanel.")});
   }
  }catch(e){
   const msg=e instanceof Error?e.message:"";
   setNote({ok:false,text:/NetworkError|Failed to fetch|network/i.test(msg)
    ?"La detección por FTP no respondió a tiempo (el hosting puede bloquear la nube). Usa el formulario MySQL con los datos de cPanel."
    :(msg?("Detección interrumpida: "+msg):"No se pudo detectar la base.")});
  }finally{setBusy("");}
 }

 async function testOne(id:string){
  if(!canEdit||busy)return;setBusy("test:"+id);setNote(null);
  try{
   const token=await getAccessTokenSilently(WRITE);
   const r=await fetch(base+"/connectors/"+encodeURIComponent(id)+"/test",{method:"POST",headers:{Authorization:"Bearer "+token}});
   let raw:unknown=null;
   try{raw=await r.json();}catch{raw=null;}
   if(r.ok&&typeof raw==="object"&&raw&&(raw as {ok?:boolean}).ok===true){
    setNote({ok:true,text:"Prueba OK: el servidor alcanzó el conector."});
   }else{
    const apiErr=typeof raw==="object"&&raw&&typeof (raw as {error?:unknown}).error==="string"?(raw as {error:string}).error:"";
    const detail=typeof raw==="object"&&raw&&typeof (raw as {detail?:unknown}).detail==="string"?(raw as {detail:string}).detail:"";
    setNote({ok:false,text:apiErr||detail||("Prueba fallida ("+r.status+"). Revisa host, usuario, contraseña o firewall del hosting.")});
   }
   await load();
  }catch(e){
   const msg=e instanceof Error?e.message:"";
   const network=/NetworkError|Failed to fetch|network/i.test(msg);
   setNote({ok:false,text:network
    ?"La prueba no llegó a completarse (red o tiempo de espera). Muchos hostings bloquean FTP/MySQL desde la nube: no pasa nada. Guarda la base MySQL abajo y sigue; Operación tienda no exige que Probar diga OK."
    :(msg?("Prueba interrumpida: "+msg):"No se pudo lanzar la prueba.")});
  }
  finally{setBusy("");}
 }

 async function removeOne(id:string){
  if(!canEdit||busy)return;setBusy("rm:"+id);setNote(null);
  try{
   const token=await getAccessTokenSilently(WRITE);
   const r=await fetch(base+"/connectors/"+encodeURIComponent(id)+"/remove",{method:"POST",headers:{Authorization:"Bearer "+token}});
   if(!r.ok){setNote({ok:false,text:await readError(r)});return;}
   setNote({ok:true,text:"Conector eliminado."});await load();
  }catch(e){setNote({ok:false,text:e instanceof Error?e.message:"No se pudo quitar el conector."});}
  finally{setBusy("");}
 }

 async function inviteManager(){
  if(!canEdit||busy||!inviteLabel.trim())return;setBusy("invite");setInviteToken(null);setNote(null);
  try{
   const token=await getAccessTokenSilently(WRITE);
   const r=await fetch(base+"/managers/invites",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({label:inviteLabel.trim()})});
   if(!r.ok){setNote({ok:false,text:await readError(r)});return;}
   const raw:unknown=await r.json();
   const t=typeof raw==="object"&&raw&&typeof (raw as {token?:unknown}).token==="string"?(raw as {token:string}).token:"";
   if(!t){setNote({ok:false,text:"La invitación no devolvió enlace."});return;}
   setInviteToken(t);setInviteLabel("");await load();
   setNote({ok:true,text:"Invitación creada. Copia el enlace ahora: solo se muestra una vez."});
  }catch(e){setNote({ok:false,text:e instanceof Error?e.message:"No se pudo crear la invitación."});}
  finally{setBusy("");}
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
 const canSave=!!form.label.trim()&&!!form.host.trim()&&!!form.username.trim()&&!!form.password&&(isFtp||!!form.database_name.trim());

 return <div className="hosting-connectors">
  <p>Necesitas <strong>dos conectores distintos</strong>: uno FTP/FTPS del hosting (archivos) y otro MySQL/MariaDB/PostgreSQL (la base de la tienda). Con la base guardada, <strong>Operación tienda</strong> y la planificación de Freddy pueden trabajar.</p>
  {!cryptoReady&&<p className="wizard-error" role="alert">La API aún no tiene llave maestra de cifrado (<code>ELIOT_STORAGE_MASTER_KEY</code>). Sin ella no se pueden guardar secretos.</p>}
  {hasFtp&&!hasDb&&<p className="wizard-error" role="alert">Solo tienes FTP. Pulsa <strong>Detectar base WooCommerce</strong> en el conector FTP (lee <code>wp-config.php</code>), o rellena MySQL a mano abajo.</p>}
  {note&&<p className={note.ok?"connector-note ok":"connector-note bad"} role={note.ok?"status":"alert"}>{note.text}</p>}

  <h3>Conectores guardados</h3>
  {items.length===0?<p>Todavía no hay FTP ni bases conectadas en esta empresa.</p>:
   <ul className="integration-list">{items.map(c=><li key={c.id}>
    <b>{c.label}</b> · {DB_KINDS.has(c.kind)?"Base de datos":"Hosting"} ({c.kind}) · {c.username}@{c.host}:{c.port}
    {c.database_name?" · BD «"+c.database_name+"»":""}{c.remote_path?" · "+c.remote_path:""}
    <small> · {statusText(c)}</small>
    {canEdit&&<span> {(c.kind==="ftp"||c.kind==="ftps")&&<button type="button" className="campus-primary" disabled={!!busy} onClick={()=>void discoverDb(c.id)}>{busy==="discover:"+c.id?"Detectando wp-config…":"Detectar base WooCommerce"}</button>}{" "}
     <button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void testOne(c.id)}>{busy==="test:"+c.id?"Probando…":"Probar"}</button>
     <button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>void removeOne(c.id)}>Quitar</button></span>}
   </li>)}</ul>}

  {canEdit&&<>
   <h3>Añadir o actualizar conector</h3>
   <p><button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>setForm(emptyForm("mysql"))}>Formulario base de datos</button>{" "}
    <button type="button" className="campus-ghost" disabled={!!busy} onClick={()=>setForm(emptyForm("ftp"))}>Formulario FTP</button></p>
   <div className="integration-form">
    <label htmlFor={uid+"kind"}>Tipo</label>
    <select id={uid+"kind"} value={form.kind} disabled={!!busy} onChange={e=>{
     const kind=e.target.value as Kind;
     setForm(f=>({...f,kind,remote_path:kind==="ftp"||kind==="ftps"?f.remote_path:"",database_name:kind==="ftp"||kind==="ftps"?"":f.database_name}));
    }}>
     <optgroup label="Base de datos de la web (obligatoria para tienda)">{KINDS.filter(k=>k.group==="database").map(k=><option key={k.value} value={k.value}>{k.label}</option>)}</optgroup>
     <optgroup label="Hosting / VPS">{KINDS.filter(k=>k.group==="hosting").map(k=><option key={k.value} value={k.value}>{k.label}</option>)}</optgroup>
    </select>
    <label htmlFor={uid+"label"}>Nombre</label>
    <input id={uid+"label"} value={form.label} maxLength={80} disabled={!!busy} placeholder={isFtp?"Hosting producción":"WooCommerce tienda online"} onChange={e=>setForm(f=>({...f,label:e.target.value}))}/>
    <label htmlFor={uid+"host"}>Host</label>
    <input id={uid+"host"} value={form.host} maxLength={253} disabled={!!busy} placeholder={isFtp?"ftp.tudominio.com":"mysql.tudominio.com"} onChange={e=>setForm(f=>({...f,host:e.target.value}))}/>
    <label htmlFor={uid+"port"}>Puerto (opcional)</label>
    <input id={uid+"port"} value={form.port} disabled={!!busy} placeholder={isFtp?"21":"3306"} onChange={e=>setForm(f=>({...f,port:e.target.value}))}/>
    <label htmlFor={uid+"user"}>Usuario</label>
    <input id={uid+"user"} value={form.username} maxLength={120} disabled={!!busy} placeholder={isFtp?"usuario FTP":"usuario MySQL"} onChange={e=>setForm(f=>({...f,username:e.target.value}))}/>
    <label htmlFor={uid+"pass"}>Contraseña</label>
    <input id={uid+"pass"} type="password" value={form.password} maxLength={400} disabled={!!busy} autoComplete="new-password" onChange={e=>setForm(f=>({...f,password:e.target.value}))}/>
    {isFtp?<>
     <label htmlFor={uid+"path"}>Ruta remota (opcional)</label>
     <input id={uid+"path"} value={form.remote_path} maxLength={400} disabled={!!busy} placeholder="/public_html" onChange={e=>setForm(f=>({...f,remote_path:e.target.value}))}/>
    </>:<>
     <label htmlFor={uid+"db"}>Nombre de la base de datos</label>
     <input id={uid+"db"} value={form.database_name} maxLength={120} disabled={!!busy} placeholder="nombre_exacto_de_la_bd" onChange={e=>setForm(f=>({...f,database_name:e.target.value}))}/>
     <small>Es el nombre que ves en cPanel/phpMyAdmin (no el de la web). Sin este campo no se guarda la base.</small>
    </>}
    <button type="button" className="campus-primary" disabled={!!busy||!canSave} onClick={()=>void save()}>{busy==="save"?"Guardando…":(isFtp?"Guardar FTP":"Guardar base de datos")}</button>
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

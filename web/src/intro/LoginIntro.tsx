import {useEffect,useId,useRef,useState} from "react";
import type {CSSProperties} from "react";
import {createFactory} from "../fabrica/factoryEngine";
import type {Factory,FactoryPlot} from "../fabrica/factoryEngine";
import {factoryPose} from "../fabrica/plots";
import type {AuthResult} from "../auth";
import "./intro.css";

/** Duración del vuelo (ms) y momento en que aparece el rótulo. */
export const FLIGHT_MS=5200,TITLE_AT=3600;
/** La ciudad de la entrada es la nuestra, pero sin datos de nadie: cinco edificios de adorno, sin nombres ni cifras. */
export const DEMO_CITY:FactoryPlot[]=[{slot:1,kind:"company",floors:7,lit:.7,blocked:false},{slot:2,kind:"company",floors:4,lit:.5,blocked:false},{slot:3,kind:"company",floors:9,lit:.8,blocked:false},
 {slot:4,kind:"company",floors:5,lit:.4,blocked:false},{slot:5,kind:"company",floors:6,lit:.6,blocked:false}];
const ease=(t:number)=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;
/** Posición de la cámara en el instante t (0 a 1): baja desde muy arriba hasta el encuadre general de la ciudad. */
export function flightPose(t:number,aspect:number){
 const end=factoryPose("general",null,aspect),k=ease(Math.min(1,Math.max(0,t))),start:[number,number,number]=[end.target[0]+2,90,end.target[2]+16];
 return {target:end.target,pos:start.map((s,i)=>s+(end.pos[i]-s)*k) as [number,number,number]};
}
export const validLoginHint=(s:string)=>{const v=s.trim();return v.length>=3&&v.length<=120&&!/[\s<>"']/.test(v);};

/** Acceso propio: usuario y contraseña en esta misma pantalla. Las funciones devuelven el error a mostrar, si lo hay. */
export type OwnAccess={login:(email:string,password:string)=>Promise<AuthResult>;signup?:(v:{email:string;password:string;name:string})=>Promise<AuthResult>;reset:(email:string)=>Promise<void>};
type Props={onLogin:(hint?:string)=>void;onSignup?:()=>void;error?:string;/** Si viene, se entra aquí mismo y no se sale a la página de Auth0. */ own?:OwnAccess;/** Llega con un enlace de invitación de solo consulta. */ invited?:boolean;
 /** Sin animación (pruebas o quien la quiera saltar siempre). */ still?:boolean;/** Solo desarrollo: deja la intro parada en ese punto (0 a 1). */ freezeAt?:number};

/** Pantalla de entrada: la cámara cruza las nubes y baja hasta la ciudad; aparece el rótulo con su anillo y, debajo, el acceso. */
export function LoginIntro({onLogin,onSignup,error,own,invited=false,still=false,freezeAt}:Props){
 const stage=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),uid=useId();
 const [reduced]=useState(()=>still||(typeof window!=="undefined"&&!!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));
 const frozen=freezeAt!==undefined;
 const [phase,setPhase]=useState<"fly"|"title"|"ready">(frozen?(freezeAt>=1?"ready":freezeAt*FLIGHT_MS>=TITLE_AT?"title":"fly"):reduced?"ready":"fly"),[city,setCity]=useState(true),[hint,setHint]=useState(""),skip=useRef(false);
 useEffect(()=>{
  if(!canvas.current||!stage.current)return;let f:Factory;
  try{f=createFactory({canvas:canvas.current,stage:stage.current,calm:reduced,onSelect:()=>{},onLost:()=>setCity(false)});}catch{setCity(false);if(!reduced){const t1=window.setTimeout(()=>setPhase("title"),TITLE_AT),t2=window.setTimeout(()=>setPhase("ready"),FLIGHT_MS);return()=>{window.clearTimeout(t1);window.clearTimeout(t2);};}return;}
  f.setPlots(DEMO_CITY);
  const aspect=()=>{const s=stage.current;return s&&s.clientHeight?s.clientWidth/s.clientHeight:1.6;};
  if(frozen){f.setPose(flightPose(freezeAt,aspect()),true);f.setCalm(true);return()=>f.dispose();}
  if(reduced){f.setPose(flightPose(1,aspect()),true);return()=>f.dispose();}
  let raf=0;const t0=performance.now();
  const tick=(now:number)=>{
   const ms=skip.current?FLIGHT_MS:now-t0;f.setPose(flightPose(ms/FLIGHT_MS,aspect()),true);
   if(ms>=TITLE_AT)setPhase(p=>p==="fly"?"title":p);
   if(ms>=FLIGHT_MS){setPhase("ready");return;}
   raf=requestAnimationFrame(tick);
  };
  raf=requestAnimationFrame(tick);
  return()=>{cancelAnimationFrame(raf);f.dispose();};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[reduced]);
 const done=phase==="ready";
 const submit=()=>onLogin(validLoginHint(hint)?hint.trim():undefined);
 // Acceso propio
 const [mode,setMode]=useState<"login"|"signup"|"reset">(own?.signup&&invited?"signup":"login"),[password,setPassword]=useState(""),[name,setName]=useState(""),[busy,setBusy]=useState(false);
 const [fail,setFail]=useState<{text:string;secure?:boolean}|null>(null),[sent,setSent]=useState(false);
 const emailOk=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(hint.trim()),canSend=!busy&&emailOk&&(mode==="reset"||(mode==="login"?password.length>=1:password.length>=10&&name.trim().length>=1));
 async function ownSubmit(){
  if(!own||!canSend)return;setBusy(true);setFail(null);setSent(false);
  if(mode==="reset"){await own.reset(hint);setBusy(false);setSent(true);return;}
  const r=mode==="signup"&&own.signup?await own.signup({email:hint,password,name}):await own.login(hint,password);
  setPassword("");setBusy(false);                                  // la contraseña no se queda en la pantalla
  if(!r.ok)setFail({text:r.text,secure:r.secure});
 }
 const go=(m:"login"|"signup"|"reset")=>{setMode(m);setFail(null);setSent(false);setPassword("");};
 return <main className={"intro ph-"+phase+(city?"":" intro-nocity")+(reduced?" intro-still":"")} ref={stage} data-freeze={frozen?"1":undefined} style={frozen?{"--at":(freezeAt*FLIGHT_MS/1000)+"s"} as CSSProperties:undefined}>
  <canvas ref={canvas} className="intro-city" aria-hidden="true"/>
  <div className="intro-sky" aria-hidden="true"/>
  <div className="intro-clouds" aria-hidden="true">{Array.from({length:9},(_,i)=><i key={i} className={"cloud c"+i}/>)}</div>
  <div className="intro-veil" aria-hidden="true"/>
  {!done&&<button type="button" className="intro-skip" onClick={()=>{skip.current=true;setPhase("ready");}}>Saltar intro</button>}
  <div className="intro-front">
   <div className="intro-title" aria-hidden={phase==="fly"}>
    <Halo part="back"/>
    <h1 aria-label="Northlane360"><span aria-hidden="true">Northlane</span><b aria-hidden="true">360</b></h1>
    <Halo part="front"/>
   </div>
   <p className="intro-tag">La Factoría · tu centro de mando</p>
   {own?<form className="intro-card" aria-label={mode==="signup"?"Crear cuenta":mode==="reset"?"Recuperar contraseña":"Acceso"} onSubmit={e=>{e.preventDefault();void ownSubmit();}}>
    {invited&&<p className="intro-invite" role="status">👁 Tienes una <strong>invitación de solo consulta</strong>. {mode==="signup"?"Crea tu cuenta y se activará sola.":own.signup?"Entra con tu cuenta y se activará sola.":"Entra con tu cuenta y se activará sola. Ahora mismo no se pueden crear cuentas nuevas."}</p>}
    {own.signup&&invited&&mode!=="reset"&&<div className="intro-tabs" role="tablist" aria-label="Qué quieres hacer"><button type="button" role="tab" aria-selected={mode==="signup"} onClick={()=>go("signup")}>Crear cuenta</button><button type="button" role="tab" aria-selected={mode==="login"} onClick={()=>go("login")}>Ya tengo cuenta</button></div>}
    {mode==="reset"&&<p className="intro-note first">Escribe tu correo y te enviaremos un mensaje para poner una contraseña nueva.</p>}
    {(error||fail)&&<p className="intro-error" role="alert">{fail?fail.text:"No se pudo iniciar sesión: "+error}{fail?.secure&&<button type="button" className="intro-link inline" onClick={()=>onLogin(validLoginHint(hint)?hint.trim():undefined)}>Entrar por la página segura</button>}</p>}
    {sent&&<p className="intro-ok" role="status">Si hay una cuenta con ese correo, te hemos enviado un mensaje para cambiar la contraseña.</p>}
    {mode==="signup"&&<><label htmlFor={uid+"n"}>Tu nombre</label><input id={uid+"n"} type="text" autoComplete="name" maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></>}
    <label htmlFor={uid+"u"}>Usuario (correo)</label>
    <input id={uid+"u"} type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="tu@correo.com" maxLength={120} value={hint} onChange={e=>setHint(e.target.value)}/>
    {mode!=="reset"&&<><label htmlFor={uid+"p"}>Contraseña</label>
     <input id={uid+"p"} type="password" autoComplete={mode==="signup"?"new-password":"current-password"} maxLength={200} value={password} onChange={e=>setPassword(e.target.value)} aria-describedby={mode==="signup"?uid+"ph":undefined}/>
     {mode==="signup"&&<small id={uid+"ph"} className="intro-hint">Al menos 10 caracteres, con letras y números.</small>}</>}
    <button type="submit" className="intro-enter" disabled={!canSend}>{busy?"Un momento…":mode==="signup"?"Crear cuenta y entrar":mode==="reset"?"Enviar mensaje":invited?"Entrar y activar la invitación":"Entrar"} {!busy&&<span aria-hidden="true">→</span>}</button>
    {mode==="login"&&<button type="button" className="intro-link" onClick={()=>go("reset")}>¿Olvidaste la contraseña?</button>}
    {mode==="reset"&&<button type="button" className="intro-link" onClick={()=>go("login")}>Volver a entrar</button>}
    <p className="intro-note">🔒 Tu contraseña viaja cifrada y no se guarda en este navegador.</p>
   </form>:
<form className="intro-card" aria-label="Acceso" onSubmit={e=>{e.preventDefault();submit();}}>
    {invited&&<p className="intro-invite" role="status">👁 Tienes una <strong>invitación de solo consulta</strong>. {onSignup?"Entra con tu cuenta (o crea una) y se activará sola.":"Entra con tu cuenta y se activará sola. Ahora mismo no se pueden crear cuentas nuevas."}</p>}
    {error&&<p className="intro-error" role="alert">No se pudo iniciar sesión: {error}</p>}
    <label htmlFor={uid+"u"}>Usuario (correo)</label>
    <input id={uid+"u"} type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="tu@correo.com" maxLength={120} value={hint} onChange={e=>setHint(e.target.value)}/>
    <button type="submit" className="intro-enter">{invited?"Entrar y activar la invitación":"Continuar"} <span aria-hidden="true">→</span></button>
    <p className="intro-note">🔒 La contraseña se escribe en el paso siguiente, en la página segura de acceso. Aquí nunca se guarda.</p>
    {onSignup&&<button type="button" className="intro-link" onClick={onSignup}>Crear una cuenta</button>}
   </form>}
  </div>
 </main>;
}

/** Anillo que envuelve el rótulo: la mitad de atrás pasa por detrás de las letras y la de delante por encima. */
function Halo({part}:{part:"back"|"front"}){
 const id=useId().replace(/:/g,"");
 const bands=[{rx:470,ry:92,w:10,o:.9},{rx:496,ry:99,w:3,o:.75},{rx:440,ry:84,w:5,o:.55},{rx:520,ry:106,w:1.6,o:.6}];
 return <svg className={"halo halo-"+part} viewBox="0 0 1100 300" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
  <defs><linearGradient id={id+"g"} x1="0" x2="1" y1="0" y2="0"><stop offset="0" stopColor="#ffd98a"/><stop offset=".28" stopColor="#fff6dc"/><stop offset=".5" stopColor="#f0a35e"/><stop offset=".74" stopColor="#ffe7b0"/><stop offset="1" stopColor="#c98a52"/></linearGradient></defs>
  <g transform="rotate(-7 550 150)">
   {bands.map((b,i)=><ellipse key={i} className={"band b"+i} cx="550" cy="150" rx={b.rx} ry={b.ry} fill="none" stroke={`url(#${id}g)`} strokeWidth={b.w} opacity={b.o} pathLength={1}/>)}
   <ellipse className="band sparks" cx="550" cy="150" rx="483" ry="95.5" fill="none" stroke="#ffffff" strokeWidth="3.4" strokeLinecap="round" pathLength={100}/>
  </g>
 </svg>;
}

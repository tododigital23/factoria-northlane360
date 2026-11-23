import "./intro.css";

type Props={state:"checking"|"denied"|"error";account:string;/** Por qué no valió una invitación, si venía con una. */ note?:string;onRetry:()=>void;onLogout:()=>void};

/** Puerta de entrada: quien ha iniciado sesión pero no tiene acceso a nada no ve la aplicación por dentro, ni vacía. */
export function AccessGate({state,account,note,onRetry,onLogout}:Props){
 return <main className="intro intro-still intro-nocity ph-ready gate">
  <div className="intro-sky" aria-hidden="true"/>
  <div className="intro-front">
   <div className="intro-card gate-card" role={state==="checking"?"status":"alert"} aria-live="polite">
    {state==="checking"&&<><h1>Comprobando tu acceso…</h1><p>Un momento.</p></>}
    {state==="denied"&&<><h1>🔒 No tienes acceso</h1>
     <p>Tu cuenta{account?<> <strong>{account}</strong></>:null} no tiene acceso a La Factoría. Si antes lo tenías, el propietario te lo ha retirado.</p>
     {note&&<p className="intro-error">{note}</p>}
     <p>Si crees que es un error, pide al propietario una invitación nueva.</p>
     <button type="button" className="intro-enter" onClick={onLogout}>Cerrar sesión</button></>}
    {state==="error"&&<><h1>No se pudo comprobar tu acceso</h1><p>El servidor no ha contestado. No es un problema de tu cuenta.</p>
     <button type="button" className="intro-enter" onClick={onRetry}>Reintentar</button>
     <button type="button" className="intro-link" onClick={onLogout}>Cerrar sesión</button></>}
   </div>
  </div>
 </main>;
}

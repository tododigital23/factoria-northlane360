import {useEffect,useRef,useState} from 'react';
import {useAuth0} from "./auth";
type Props={companyId:string;missionId:string;state:'active'|'paused';revision:number;disabled:boolean;onAttempted:()=>void;verifyRecorded:(state:string,revision:number,signal:AbortSignal)=>Promise<void>};
const names={pause:'Pausar próximos envíos',resume:'Reanudar próximos envíos',cancel:'Cancelar próximos envíos'};
export function DocumentMissionControl(p:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [action,setAction]=useState<'pause'|'resume'|'cancel'>(p.state==='paused'?'resume':'pause'),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[attempted,setAttempted]=useState(false),[error,setError]=useState('');
 const controller=useRef(new AbortController()),lock=useRef(false),key=useRef(crypto.randomUUID());
 useEffect(()=>{const c=new AbortController();controller.current=c;return()=>c.abort();},[p.companyId,p.missionId]);
 async function submit(){
  if(lock.current||attempted||p.disabled||!confirmed||reason.trim().length<10||Array.from(reason.trim()).length>500)return;
  lock.current=true;p.onAttempted();setBusy(true);setAttempted(true);setConfirmed(false);setError('');const signal=controller.current.signal;
  try{
   const token=await getAccessTokenSilently({authorizationParams:{audience:'https://api.eliot.internal',scope:'read:tasks create:tasks'}});if(signal.aborted)return;
   const r=await fetch('https://api.tu-factoria.example/v1/me/organizations/'+encodeURIComponent(p.companyId)+'/execution/document-missions/'+encodeURIComponent(p.missionId)+'/control',{method:'POST',signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({action,reason:reason.trim(),expected_revision:p.revision,request_key:key.current})});
   if(!r.ok)throw Error('Unconfirmed');const raw=await r.json(),state={pause:'paused',resume:'active',cancel:'cancelled'}[action];
   if(raw.organization_id!==p.companyId||raw.mission_id!==p.missionId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.action_id||'')||raw.recorded_state!==state||raw.recorded_revision!==p.revision+1||raw.provider_called!==false||raw.execution_started!==false||raw.existing_jobs_stopped!==false||raw.task_completed!==false)throw Error('Invalid acknowledgement');
   if(!signal.aborted)await p.verifyRecorded(state,p.revision+1,signal);
  }catch{if(!signal.aborted)setError('El cambio global no quedó confirmado. Actualiza los planes de varios trabajos antes de otra acción. No se reenviará automáticamente.');}
  finally{if(!signal.aborted)setBusy(false);}
 }
 return <section aria-label="Control global de próximos envíos">
  <p>Este control afecta a todos los pasos aún no enviados de este plan. Los trabajos ya en cola o iniciados conservan su estado y pueden terminar. Reanudar no envía ni autoriza nada; mantiene las pausas individuales, el alcance y las revisiones exigidas. Cancelar los próximos envíos es definitivo para este plan y conserva su historial.</p>
  <label>Acción global<select value={action} disabled={p.disabled||busy||attempted} onChange={e=>{setAction(e.target.value as typeof action);setConfirmed(false);}}>{p.state==='active'?<option value="pause">{names.pause}</option>:<option value="resume">{names.resume}</option>}<option value="cancel">{names.cancel}</option></select></label>
  <label>Motivo del control global<textarea value={reason} maxLength={1000} disabled={p.disabled||busy||attempted} onChange={e=>{setReason(e.target.value);setConfirmed(false);}}/></label>
  <label><input type="checkbox" checked={confirmed} disabled={p.disabled||busy||attempted} onChange={e=>setConfirmed(e.target.checked)}/>Confirmo: {names[action]} de este plan. Los trabajos enviados conservan su estado y pueden terminar.</label>
  <button type="button" disabled={p.disabled||busy||attempted||!confirmed||reason.trim().length<10||Array.from(reason.trim()).length>500} onClick={()=>void submit()}>{busy?'Registrando control global…':names[action]}</button>
  {error&&<p role="alert">{error}</p>}
 </section>;
}

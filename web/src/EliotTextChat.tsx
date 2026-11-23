import {useEliotServerVoice} from "./useEliotServerVoice";
import {EliotPortraitView} from "./EliotPortraitView";
import {EliotDocumentPlanner} from "./EliotDocumentPlanner";
import {EliotTaskDraft} from "./EliotTaskDraft";
import {EliotGenerativeSetup} from "./EliotGenerativeSetup";
import {useEliotBrowserVoice} from "./useEliotBrowserVoice";
import {useEffect,useState} from "react";
import {useAuth0} from "./auth";

type Company={id:string;name:string;role:string};
type ChatMessage={id:number;role:"user"|"eliot";text:string;companyId:string;speech_grant?:string;mode?:"verified_data"|"grounded_ai"};
type ChatReply={answer:string;speech_grant?:string;organization_id:string;mode:"verified_data"|"grounded_ai";read_only:boolean;intents:string[];context_intent:string|null};
type Props={preferredCompanyId:string};
const api="https://api.tu-factoria.example/v1/me";
const suggestions=[
 "Dame un resumen de esta empresa",
 "¿Qué tareas están bloqueadas?",
 "¿Qué departamentos tenemos?",
 "¿Qué trabajadores IA están inactivos?",
 "¿Qué actividad reciente hay?",
 "Crea una tarea: revisar documentación del proyecto",
 "Planifica una revisión documental"
];
export function EliotTextChat({preferredCompanyId}:Props){
 const {getAccessTokenSilently}=useAuth0();
 const [companies,setCompanies]=useState<Company[]>([]);
 const [companyId,setCompanyId]=useState("");
 const [question,setQuestion]=useState("");
 const [messages,setMessages]=useState<ChatMessage[]>([]);
 const [loading,setLoading]=useState(false);
 const [loadingCompanies,setLoadingCompanies]=useState(false);
 const [error,setError]=useState("");
 const [contextIntent,setContextIntent]=useState<string|null>(null);
 const [taskDraft,setTaskDraft]=useState<{companyId:string;title:string;key:number}|null>(null);
 const [documentPlan,setDocumentPlan]=useState<{companyId:string;key:number}|null>(null);
 const company=companies.find(c=>c.id===companyId);
 const voice=useEliotBrowserVoice(transcript=>setQuestion(transcript));
 const serverVoice=useEliotServerVoice(companyId,async()=>{const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});if(!token)throw Error("Sesión no disponible");return token;});
 const [serverConsent,setServerConsent]=useState(false);
 useEffect(()=>{
  let active=true;
  async function findCompanies(){
   setLoadingCompanies(true);setError("");
   try{
    const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
    const res=await fetch(api+"/organizations",{headers:{Authorization:"Bearer "+token}});
    if(!res.ok)throw Error("HTTP "+res.status);
    const data:unknown=await res.json();
    if(!Array.isArray(data)||!data.every(x=>typeof x==="object"&&x!==null&&
      typeof (x as Company).id==="string"&&typeof (x as Company).name==="string"&&typeof (x as Company).role==="string"))
      throw Error("Organizaciones no válidas");
    if(active){
      const verified=data as Company[];
      setCompanies(verified);
      setContextIntent(null);setMessages([]);setTaskDraft(null);setDocumentPlan(null);
      setCompanyId(verified.some(c=>c.id===preferredCompanyId)?preferredCompanyId:(verified[0]?.id||""));
    }
   }catch{if(active)setError("No puedo recuperar las empresas autorizadas. Comprueba la sesión de Auth0.")}
   finally{if(active)setLoadingCompanies(false)}
  }
  void findCompanies();
  return()=>{active=false};
 },[getAccessTokenSilently,preferredCompanyId]);

 function selectCompany(next:string){
   voice.stopListening();voice.stopSpeaking();serverVoice.stop();
   setServerConsent(false);setCompanyId(next);setMessages([]);setContextIntent(null);setTaskDraft(null);setDocumentPlan(null);setError("");setQuestion("");
 }
 async function sendMessage(text:string){
   const prompt=text.trim();
   if(!companyId||!prompt||prompt.length>500||loading)return;
   const requestedCompany=companyId;
   voice.stopListening();voice.stopSpeaking();serverVoice.stop();
   setMessages(current=>[...current,{id:Date.now(),role:"user",text:prompt,companyId:requestedCompany}]);
   setQuestion("");setError("");
   const documentaryCommand=/^(?:eliot[,:]?\s*)?(?:(?:planifica|prepara|organiza)\s+(?:(?:una|la)\s+)?(?:revisión|revision|tarea|análisis|analisis)\s+documental|revisa\s+la\s+documentación)(?:[\s:,.!?]|$)/i;
   if(documentaryCommand.test(prompt)){
     if(company?.role!=="owner"){
       setMessages(current=>[...current,{id:Date.now()+1,role:"eliot",text:"Solo el propietario puede preparar un plan documental para esta empresa.",companyId:requestedCompany}]);return;
     }
     setTaskDraft(null);setDocumentPlan({companyId:requestedCompany,key:Date.now()});
     setMessages(current=>[...current,{id:Date.now()+1,role:"eliot",text:"Prepararemos una revisión documental para "+company.name+". Elige la tarea real y revisa los pasos previstos. No he creado permisos, encolado trabajos ni llamado al modelo; cada acción requiere su confirmación.",companyId:requestedCompany}]);return;
   }
   const taskCommand=/^(?:eliot[,:]?\s*)?(?:crea|crear|prepara|preparar|añade|anota|asigna)\s+(?:(?:una|la)\s+)?tarea\b/i;
   if(taskCommand.test(prompt)){
     if(company?.role!=="owner"){
       setMessages(current=>[...current,{id:Date.now()+1,role:"eliot",text:"Solo el propietario puede preparar nuevas tareas para esta empresa. No he creado nada.",companyId:requestedCompany}]);
       return;
     }
     const tail=prompt.replace(taskCommand,"").trim();
     const detail=tail.includes(":")?tail.split(":").slice(1).join(":").trim():tail.replace(/^para\s+/i,"").trim();
     setDocumentPlan(null);setTaskDraft({companyId:requestedCompany,title:detail.slice(0,200),key:Date.now()});
     setMessages(current=>[...current,{id:Date.now()+1,role:"eliot",text:"He preparado un borrador para "+(company?.name||"la empresa")+". Selecciona el departamento, revisa el título y aprueba la creación. No se ha registrado ninguna tarea todavía.",companyId:requestedCompany}]);
     return;
   }
   setLoading(true);
   try{
    const token=await getAccessTokenSilently({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
    const response=await fetch(api+"/organizations/"+encodeURIComponent(requestedCompany)+"/eliot/chat",{
      method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
      body:JSON.stringify({question:prompt,context_intent:contextIntent})
    });
    if(!response.ok)throw Error("HTTP "+response.status);
    const data:ChatReply=await response.json();
    if(data.organization_id!==requestedCompany||data.read_only!==true||!["verified_data","grounded_ai"].includes(data.mode)||
       typeof data.answer!=="string"||!(data.context_intent===null||typeof data.context_intent==="string"))throw Error("Respuesta inválida");
    setContextIntent(data.context_intent);
    setMessages(current=>[...current,{id:Date.now()+1,role:"eliot",text:data.answer,companyId:requestedCompany,mode:data.mode,speech_grant:typeof data.speech_grant==="string"?data.speech_grant:undefined}]);
   }catch(err){
     setMessages(current=>[...current,{id:Date.now()+2,role:"eliot",
       text:"No he podido verificar esta consulta en la API ("+(err instanceof Error?err.message:"error de conexión")+"). No se ha ejecutado ninguna acción.",companyId:requestedCompany}]);
   }finally{setLoading(false)}
 }
 const visibleMessages=messages.filter(m=>m.companyId===companyId);
 return <div className="eliot-console">
  <div className="eliot-presentation">
    <EliotPortraitView speaking={voice.speaking||serverVoice.speaking} listening={voice.listening} queued={voice.queued||serverVoice.loading}/>
    <div className="eliot-presentation-copy"><span className="eliot-tag">DIRECTOR VIRTUAL · PRIMERA VERSIÓN</span><h2>Freddy</h2>
     <p>Pregúntame por tus empresas. Respondo utilizando registros autorizados de PostgreSQL.</p>
     <span className="eliot-mode">● Consultas verificadas · Voz experimental del navegador · Revisión documental guiada</span>
    </div>
  </div>
  <div className="eliot-chat-body">
   <div className="eliot-chat-toolbar"><label htmlFor="eliot-company">Empresa activa
     <select id="eliot-company" value={companyId} onChange={e=>selectCompany(e.target.value)} disabled={loading||loadingCompanies}>
      <option value="">Selecciona una empresa</option>
      {companies.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
     </select>
    </label><span>{company?"Rol: "+company.role:"Sin empresa seleccionada"}</span>
   </div>
   {loadingCompanies&&<p className="eliot-status">Consultando empresas autorizadas…</p>}
   {error&&<p role="alert" className="eliot-error">{error}</p>}
   {companies.length===0&&!loadingCompanies&&!error&&<p className="eliot-status">Todavía no tienes empresas autorizadas para consultar.</p>}
   <div className="eliot-chat-transcript" role="log" aria-label="Conversación con Freddy" aria-live="polite">
    {visibleMessages.length===0&&<div className="eliot-welcome"><strong>¿Qué quieres saber de {company?.name||"tu empresa"}?</strong>
     <p>Selecciona una pregunta o escríbela. También puedes preguntar varias cosas en un mensaje y continuar con «¿Y cuántas?». El contexto solo se conserva en esta sesión y se borra al cambiar de empresa.</p>
     <div className="eliot-quick-questions">{suggestions.map(q=><button key={q} disabled={!companyId||loading} onClick={()=>void sendMessage(q)}>{q}</button>)}</div>
    </div>}
    {visibleMessages.map(message=><div key={message.id} className={"eliot-message "+message.role}>
     <div className="eliot-message-head"><span>{message.role==="eliot"?"FREDDY":"TÚ"}{message.role==="eliot"&&message.mode==="grounded_ai"&&<em className="eliot-mode-label">IA · datos autorizados</em>}{message.role==="eliot"&&message.mode==="verified_data"&&<em className="eliot-mode-label">Respuesta guiada</em>}</span>{message.role==="eliot"&&voice.canSpeak&&<button type="button" className="eliot-speak-reply" onClick={()=>{serverVoice.stop();voice.speak(message.text);}} aria-label="Escuchar respuesta de Freddy">Escuchar</button>}</div>{message.role==="eliot"&&message.speech_grant&&<button type="button" disabled={!serverConsent||serverVoice.loading} onClick={()=>{voice.stopListening();voice.stopSpeaking();void serverVoice.play(message.text,message.speech_grant!);}}>Escuchar con voz de servidor</button>}<p>{message.text}</p>
    </div>)}
    {loading&&<p className="eliot-status" role="status">Freddy está consultando los datos autorizados…</p>}
   </div>
   {documentPlan&&documentPlan.companyId===companyId&&<EliotDocumentPlanner key={documentPlan.companyId+":"+documentPlan.key} companyId={companyId} companyName={company?.name||"Empresa autorizada"} role={company?.role||""} onClose={()=>setDocumentPlan(null)}/>}
   {taskDraft&&taskDraft.companyId===companyId&&<EliotTaskDraft key={taskDraft.key} companyId={companyId} companyName={company?.name||"Empresa autorizada"} initialText={taskDraft.title}
     onClose={()=>setTaskDraft(null)}
     onCreated={id=>{
       setTaskDraft(null);setDocumentPlan(null);
       setMessages(current=>[...current,{id:Date.now(),role:"eliot",text:"Tarea registrada correctamente como pendiente (ID "+id+"). Se ha creado el evento de auditoría. Ningún trabajador IA se ha ejecutado.",companyId}]);
     }}/>}
   <form className="eliot-chat-form" onSubmit={e=>{e.preventDefault();void sendMessage(question)}}>
    <label htmlFor="eliot-question">Tu pregunta</label>
    <div className="eliot-chat-entry"><textarea id="eliot-question" rows={2} maxLength={500} value={question}
      placeholder="Por ejemplo: ¿Qué tareas están bloqueadas?"
      disabled={loading||!companyId} onChange={e=>setQuestion(e.target.value)}
      onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void sendMessage(question)}}}/>
     {voice.canListen&&<button type="button" className={"eliot-voice-mic"+(voice.listening?" active":"")} onClick={()=>{serverVoice.stop();voice.listening?voice.stopListening():voice.startListening();}} disabled={!companyId||loading} aria-pressed={voice.listening} title={voice.listening?"Detener dictado":"Dictar pregunta en español"}>{voice.listening?"Detener micrófono":"🎙 Dictar"}</button>}<button type="submit" disabled={!companyId||!question.trim()||loading}>{loading?"Consultando…":"Enviar"}</button>
    </div>
   </form>
   {(voice.speaking||voice.queued)&&<button className="eliot-stop-voice" type="button" onClick={voice.stopSpeaking}>Detener voz de Freddy</button>}
   {voice.listening&&<p className="eliot-voice-status" role="status">Micrófono activo. Habla en español; revisa el texto antes de pulsar Enviar.</p>}
   {voice.voiceError&&<p className="eliot-voice-error" role="alert">{voice.voiceError}</p>}
   {visibleMessages.some(m=>m.speech_grant)&&<label><input type="checkbox" checked={serverConsent} onChange={e=>{setServerConsent(e.target.checked);if(!e.target.checked)serverVoice.stop();}}/>Usar voz generada por IA: al pulsar Escuchar con voz de servidor, enviar esta respuesta a OpenAI para generar audio. Consume cuota de la empresa.</label>}
   {(serverVoice.loading||serverVoice.speaking)&&<button type="button" onClick={serverVoice.stop}>Detener voz de servidor</button>}
   {serverVoice.error&&<p role="alert">{serverVoice.error}</p>}
   <div className="eliot-voice-status"><p>{voice.voiceStatus}</p><button type="button" onClick={voice.refreshVoices}>Actualizar voces disponibles</button></div>
   <EliotGenerativeSetup key={companyId} organizationId={companyId} role={company?.role||""}/>
   <p className="eliot-footnote">Las órdenes «Crea una tarea» generan un borrador para revisión; solo se guardan tras confirmar. Respuestas guiadas de forma predeterminada; la IA generativa solo se activa con consentimiento y configuración del servidor. Las respuestas generativas pueden contener errores y deben verificarse. El dictado y la lectura son opcionales y dependen de las funciones del navegador; el reconocimiento de voz puede utilizar servicios del proveedor del navegador. Pulsa el micrófono para autorizarlo y revisa el texto antes de enviarlo. La voz puede variar según el dispositivo. Los planes documentales guían acciones con confirmación explícita y registros persistentes. No se guardan grabaciones en Freddy ni se conserva el historial de conversación fuera de esta pantalla.</p>
  </div>
 </div>;
}


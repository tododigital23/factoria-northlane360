import {useEffect,useRef,useState} from "react";

type TranscriptResult={transcript:string};
type RecognitionResult={results:ArrayLike<ArrayLike<TranscriptResult>>};
type RecognitionError={error?:string};
interface SpeechRecognitionLike{
 lang:string;
 continuous:boolean;
 interimResults:boolean;
 maxAlternatives:number;
 onresult:((event:RecognitionResult)=>void)|null;
 onerror:((event:RecognitionError)=>void)|null;
 onend:(()=>void)|null;
 start:()=>void;
 stop:()=>void;
 abort:()=>void;
}
type SpeechRecognitionConstructor=new()=>SpeechRecognitionLike;
type VoiceWindow=Window & {
 SpeechRecognition?:SpeechRecognitionConstructor;
 webkitSpeechRecognition?:SpeechRecognitionConstructor;
};

export function useEliotBrowserVoice(onRecognized:(transcript:string)=>void){
 const [canListen,setCanListen]=useState(false);
 const [canSpeak,setCanSpeak]=useState(false);
 const [listening,setListening]=useState(false);
 const [speaking,setSpeaking]=useState(false);
 const [queued,setQueued]=useState(false);
 const [voiceStatus,setVoiceStatus]=useState("Comprobando voces del navegador…");
 const startTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 function clearStartTimer(){if(startTimer.current!==null){clearTimeout(startTimer.current);startTimer.current=null;}}
 function refreshVoices(){
  const supported="speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const voices=supported?window.speechSynthesis.getVoices():[];
  const spanish=voices.some(v=>v.lang.toLowerCase().startsWith("es"));
  setCanSpeak(supported&&spanish);
  setVoiceStatus(!supported?"Lectura de voz no disponible en este navegador.":spanish?"Voz en español disponible; la reproducción se inicia al pulsar Escuchar.":"No hay voces en español disponibles en este navegador. Puedes continuar por escrito.");
 }
 const [voiceError,setVoiceError]=useState("");
 const recognitionRef=useRef<SpeechRecognitionLike|null>(null);
 const callbackRef=useRef(onRecognized);
 const activeUtteranceRef=useRef<SpeechSynthesisUtterance|null>(null);
 useEffect(()=>{callbackRef.current=onRecognized},[onRecognized]);
 useEffect(()=>{
  const target=window as VoiceWindow;
  setCanListen(Boolean(target.SpeechRecognition||target.webkitSpeechRecognition));
  refreshVoices();
  window.speechSynthesis?.addEventListener?.("voiceschanged",refreshVoices);
  return ()=>{
   clearStartTimer();
   window.speechSynthesis?.removeEventListener?.("voiceschanged",refreshVoices);
   recognitionRef.current?.abort();
   recognitionRef.current=null;
   window.speechSynthesis?.cancel();
   activeUtteranceRef.current=null;
  };
 },[]);

 function stopListening(){
  const current=recognitionRef.current;
  recognitionRef.current=null;
  if(current){current.onresult=null;current.onerror=null;current.onend=null;current.abort();}
  setListening(false);
 }
 function stopSpeaking(){
  clearStartTimer();
  activeUtteranceRef.current=null;
  window.speechSynthesis?.cancel();
  setSpeaking(false);setQueued(false);
 }
 function startListening(){
  const target=window as VoiceWindow;
  const Constructor=target.SpeechRecognition||target.webkitSpeechRecognition;
  if(!Constructor){setVoiceError("Este navegador no permite dictar por voz. Puedes seguir escribiendo.");return;}
  stopSpeaking();
  stopListening();
  setVoiceError("");
  const recognition=new Constructor();
  recognition.lang="es-ES";
  recognition.continuous=false;
  recognition.interimResults=false;
  recognition.maxAlternatives=1;
  recognitionRef.current=recognition;
  recognition.onresult=event=>{
   if(recognitionRef.current!==recognition)return;
   const text=Array.from(event.results)
      .map(result=>result[0]?.transcript||"").join(" ").trim();
   if(text)callbackRef.current(text);
  };
  recognition.onerror=event=>{
   if(recognitionRef.current!==recognition)return;
   const code=event.error||"unknown";
   if(code==="not-allowed"||code==="service-not-allowed")
    setVoiceError("No hay permiso para usar el micrófono. Revisa los permisos del navegador.");
   else if(code==="no-speech")
    setVoiceError("No se detectó ninguna frase. Pulsa el micrófono para volver a intentarlo.");
   else if(code!=="aborted")
    setVoiceError("El reconocimiento del navegador no está disponible ("+code+").");
  };
  recognition.onend=()=>{
   if(recognitionRef.current!==recognition)return;
   recognitionRef.current=null;
   setListening(false);
  };
  try{
   recognition.start();
   setListening(true);
  }catch{
   recognitionRef.current=null;
   setListening(false);
   setVoiceError("No se pudo iniciar el micrófono. Prueba a escribir tu consulta.");
  }
 }
 function speak(text:string){
  if(!("speechSynthesis" in window)||!("SpeechSynthesisUtterance" in window)){
   setVoiceError("Este navegador no puede leer las respuestas en voz alta.");return;
  }
  stopListening();stopSpeaking();setVoiceError("");
  const voices=window.speechSynthesis.getVoices();
  const selected=voices.find(v=>v.lang.toLowerCase()==="es-es")||voices.find(v=>v.lang.toLowerCase().startsWith("es"));
  refreshVoices();
  if(!selected){setVoiceError("No hay una voz en español disponible. La respuesta escrita sigue disponible.");return;}
  const utterance=new SpeechSynthesisUtterance(text.slice(0,3500));
  utterance.lang="es-ES";
  utterance.rate=0.96;
  utterance.pitch=1.02;
  utterance.voice=selected;
  utterance.onend=()=>{if(activeUtteranceRef.current===utterance){
   clearStartTimer();activeUtteranceRef.current=null;setSpeaking(false);setQueued(false);
  }};
  utterance.onerror=event=>{if(activeUtteranceRef.current===utterance){
   clearStartTimer();activeUtteranceRef.current=null;setSpeaking(false);setQueued(false);
   setVoiceError(event.error==="not-allowed"?"El navegador ha bloqueado la reproducción. Pulsa Escuchar para volver a intentarlo.":event.error==="audio-busy"?"La salida de audio está ocupada. Intenta de nuevo cuando esté libre.":"No se pudo reproducir la voz. La respuesta escrita sigue disponible.");
  }};
  utterance.onstart=()=>{if(activeUtteranceRef.current===utterance){clearStartTimer();setQueued(false);setSpeaking(true);}};
  utterance.onpause=()=>{if(activeUtteranceRef.current===utterance)setSpeaking(false);};
  utterance.onresume=()=>{if(activeUtteranceRef.current===utterance)setSpeaking(true);};
  activeUtteranceRef.current=utterance;
  setQueued(true);
  startTimer.current=setTimeout(()=>{if(activeUtteranceRef.current!==utterance)return;stopSpeaking();setVoiceError("La lectura no ha comenzado. Puedes volver a pulsar Escuchar o continuar por escrito.");},8000);
  try{window.speechSynthesis.speak(utterance)}catch{
   clearStartTimer();activeUtteranceRef.current=null;setSpeaking(false);setQueued(false);
   setVoiceError("La reproducción de voz no está disponible.");
  }
 }
 return {canListen,canSpeak,listening,speaking,queued,voiceError,voiceStatus,refreshVoices,
         startListening,stopListening,speak,stopSpeaking};
}


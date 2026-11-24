import {useEffect,useRef,useState} from 'react';
import {API_ROOT} from "./holdingApi";
export function useEliotServerVoice(companyId:string,getToken:()=>Promise<string>){
 const [speaking,setSpeaking]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const playback=useRef<HTMLAudioElement|null>(null),request=useRef<AbortController|null>(null),objectUrl=useRef<string|null>(null),generation=useRef(0);
 function stop(){generation.current++;request.current?.abort();request.current=null;if(playback.current){playback.current.onplaying=null;playback.current.onpause=null;playback.current.onended=null;playback.current.onerror=null;playback.current.pause();playback.current.src='';playback.current=null;}if(objectUrl.current){URL.revokeObjectURL(objectUrl.current);objectUrl.current=null;}setSpeaking(false);setLoading(false);}
 useEffect(()=>{setError('');return stop;},[companyId]);
 async function play(text:string,grant:string){
  stop();setError('');setLoading(true);const id=generation.current,controller=new AbortController();request.current=controller;
  const timer=setTimeout(()=>{if(id===generation.current){stop();setError("La generación o reproducción de voz tardó demasiado. Puedes continuar por escrito.");}},40000);
  try{
   const token=await getToken();if(id!==generation.current)return;
   const response=await fetch(API_ROOT+'/v1/me/organizations/'+encodeURIComponent(companyId)+'/eliot/speech',{method:'POST',signal:controller.signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({text,speech_grant:grant,consent:true})});
   if(!response.ok)throw Error('HTTP '+response.status);
   if(!response.headers.get('Content-Type')?.startsWith('audio/mpeg'))throw Error('Formato de audio inválido');
   const blob=await response.blob();if(id!==generation.current)return;if(blob.size===0||blob.size>2000000)throw Error('Audio inválido');
   objectUrl.current=URL.createObjectURL(blob);const audio=new Audio(objectUrl.current);playback.current=audio;
   audio.onplaying=()=>{if(id===generation.current){setLoading(false);setSpeaking(true);}};
   audio.onpause=()=>{if(id===generation.current)setSpeaking(false);};
   audio.onended=()=>{if(id===generation.current)stop();};
   audio.onerror=()=>{if(id===generation.current){stop();setError('No se pudo reproducir la voz de servidor. La respuesta escrita sigue disponible.');}};
   await audio.play();
  }catch{if(id===generation.current){stop();setError('La voz de servidor no está disponible o ha caducado la autorización. Puedes consultar de nuevo o continuar por escrito.');}}
  finally{clearTimeout(timer);}
 }
 return {speaking,loading,error,play,stop};
}

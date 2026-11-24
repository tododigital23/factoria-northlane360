import {useState} from "react";
import {useAuth0} from "./auth";
import {API_ROOT} from "./holdingApi";

type Readiness={
 organization_id:string; organization_name:string; provider:string; model:string;
 model_supported:boolean;api_key_configured:boolean;company_opted_in:boolean;
 feature_enabled:boolean;ready:boolean;mode_when_unavailable:string;
 no_model_request_made:boolean;
};
export function EliotGenerativeSetup({organizationId,role}:{
 organizationId:string;role:string;
}){
 const {getAccessTokenSilently}=useAuth0();
 const [data,setData]=useState<Readiness|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 async function check(){
  setBusy(true);setData(null);setError("");
  try{
   const token=await getAccessTokenSilently({authorizationParams:{
    audience:"https://api.eliot.internal",scope:"read:tasks"
   }});
   const url=API_ROOT+"/v1/me/organizations/"+
    encodeURIComponent(organizationId)+"/eliot/generative/status";
   const response=await fetch(url,{headers:{Authorization:"Bearer "+token}});
   if(!response.ok){setError("No se pudo comprobar la configuración (HTTP "+response.status+").");return;}
   const result:Readiness=await response.json();
   if(result.organization_id!==organizationId||result.no_model_request_made!==true)
    throw Error("Respuesta de configuración inesperada");
   setData(result);
  }catch{
   setError("No se pudo comprobar el estado seguro de la integración generativa.");
  }finally{setBusy(false)}
 }
 if(!organizationId||role!=="owner")return null;
 return <section className="eliot-provider-setup" aria-label="Configuración de inteligencia generativa">
  <div className="eliot-provider-title"><div><strong>Modelo generativo opcional</strong><p>Consulta si esta empresa tiene habilitado el modelo generativo y su configuración actual.</p></div>
   <button type="button" disabled={busy} onClick={check}>{busy?"Comprobando…":"Comprobar preparación"}</button>
  </div>
  {error&&<p role="alert">{error}</p>}
  {data&&<div className="eliot-provider-result" role="status">
   <strong>{data.ready?"Modelo generativo preparado":"Modo verificado activo"}</strong>
   <p>Modelo previsto: {data.model}</p>
   <div className="eliot-provider-checks">
    <span>{data.api_key_configured?"✓":"○"} Clave privada configurada</span>
    <span>{data.company_opted_in?"✓":"○"} Empresa autorizada</span>
    <span>{data.feature_enabled?"✓":"○"} Activación habilitada</span>
    <span>{data.model_supported?"✓":"○"} Modelo admitido</span>
   </div>
   <p className="eliot-provider-disclosure">Esta comprobación no envía preguntas, documentos ni datos empresariales a OpenAI.</p>
  </div>}
 </section>;
}


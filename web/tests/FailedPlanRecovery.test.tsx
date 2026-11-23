// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {FailedPlanRecovery,type RecoverablePlan} from "../src/FailedPlanRecovery";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",plan="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",task="cccccccc-cccc-4ccc-8ccc-cccccccccccc",job="dddddddd-dddd-4ddd-8ddd-dddddddddddd",run="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const failed:RecoverablePlan={id:plan,task_id:task,job_id:job,job_state:"failed",control_state:"active",owner_is_creator:true,mission_id:null};
const ack=(over:object={})=>({organization_id:org,task_id:task,plan_id:plan,failed_job_id:job,attempt:1,replayed:false,provider_called:false,execution_started:false,approval_created:false,task_completed:false,next_steps:["review_previous_lease","approve_document_analysis","dispatch_plan"],...over});
const reply=(raw:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(raw),{status}));
let history:any,posts:any[],post:()=>Promise<Response>;
const server=vi.fn(),recovered=vi.fn();
beforeEach(()=>{
 history={enabled:true,attempts:[],provider_called:false};posts=[];post=()=>reply(ack());recovered.mockClear();token.mockReset();token.mockResolvedValue("opaque");
 server.mockReset();server.mockImplementation((url:string,options?:RequestInit)=>{
  if(options?.method==="POST"){posts.push({url,body:JSON.parse(String(options.body)),signal:options.signal});return post();}
  return reply(history);
 });vi.stubGlobal("fetch",server);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=(p:Partial<RecoverablePlan>={},company=org)=>render(<FailedPlanRecovery companyId={company} plan={{...failed,...p}} onRecovered={recovered}/>);
const button=()=>screen.queryByRole("button",{name:/Reabrir tras fallo|Reintentar la misma solicitud|Reabriendo/}) as HTMLButtonElement|null;
const reasonText="La fuente estaba caída durante el análisis";
async function prepare(reason=reasonText){
 view();const box=await screen.findByLabelText("Motivo de la reapertura");fireEvent.change(box,{target:{value:reason}});fireEvent.click(screen.getByRole("checkbox"));return button()!;
}
describe("reabrir plan tras fallo",()=>{
 it.each([
  ["no fallido",{job_state:"completed"}],["en cola",{job_state:"queued"}],["sin trabajo",{job_id:null,job_state:null}],
 ])("no muestra nada para un plan %s",(_n,p)=>{const v=view(p as Partial<RecoverablePlan>);expect(v.container.textContent).toBe("");expect(server).not.toHaveBeenCalled();});
 it("needs_review exige investigación humana y no ofrece reapertura",()=>{view({job_state:"needs_review"});expect(screen.getByText(/investigación humana/)).toBeTruthy();expect(button()).toBeNull();expect(server).not.toHaveBeenCalled();});
 it.each([
  ["de otro creador",{owner_is_creator:false}],["pausado",{control_state:"paused"}],["cancelado",{control_state:"cancelled"}],["sin control",{control_state:undefined}],
 ])("oculta el botón para un plan fallido %s",(_n,p)=>{view(p as Partial<RecoverablePlan>);expect(button()).toBeNull();expect(screen.queryByRole("textbox")).toBeNull();expect(server).not.toHaveBeenCalled();});
 it("exige motivo de 10 a 500 caracteres y confirmación explícita",async()=>{
  view();const box=await screen.findByLabelText("Motivo de la reapertura");expect(button()!.disabled).toBe(true);
  fireEvent.change(box,{target:{value:"corto"}});fireEvent.click(screen.getByRole("checkbox"));expect(button()!.disabled).toBe(true);
  fireEvent.change(box,{target:{value:"x".repeat(501)}});fireEvent.click(screen.getByRole("checkbox"));expect(button()!.disabled).toBe(true);
  fireEvent.change(box,{target:{value:reasonText}});expect(button()!.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));expect(button()!.disabled).toBe(false);expect(screen.getByText(/no ejecuta nada ni consume cuota/)).toBeTruthy();
  expect(posts).toHaveLength(0);
 });
 it("envía el cuerpo exacto una sola vez y muestra intento y próximos pasos",async()=>{
  const b=await prepare("  "+reasonText+"  ");fireEvent.click(b);fireEvent.click(b);
  expect(await screen.findByText(/Plan reabierto · intento 1 de 2/)).toBeTruthy();expect(posts).toHaveLength(1);
  expect(posts[0].url).toBe("https://api.tu-factoria.example/v1/me/organizations/"+org+"/tasks/"+task+"/execution/document-plans/"+plan+"/reopen");
  expect(Object.keys(posts[0].body).sort()).toEqual(["failed_job_id","reason","request_key"]);
  expect(posts[0].body.failed_job_id).toBe(job);expect(posts[0].body.reason).toBe(reasonText);expect(posts[0].body.request_key).toMatch(/^[0-9a-f-]{36}$/);
  expect(recovered).toHaveBeenCalledTimes(1);expect(screen.getByText(/nueva autorización de un solo uso/)).toBeTruthy();expect(screen.getByText(/Revisar la reserva del trabajo anterior/)).toBeTruthy();
  expect(token.mock.calls.some(c=>(c as any)[0].authorizationParams.scope.includes("create:tasks"))).toBe(true);
 });
 it("reintenta tras error de red con exactamente la misma clave y cuerpo",async()=>{
  post=()=>Promise.reject(new TypeError("Failed to fetch"));const b=await prepare();fireEvent.click(b);
  expect((await screen.findByRole("alert")).textContent).toMatch(/Resultado no confirmado, consulta el seguimiento/);expect(recovered).not.toHaveBeenCalled();
  post=()=>reply(ack({replayed:true}));const again=screen.getByRole("button",{name:"Reintentar la misma solicitud"});expect((again as HTMLButtonElement).disabled).toBe(false);fireEvent.click(again);
  expect(await screen.findByText(/solicitud ya registrada/)).toBeTruthy();expect(posts).toHaveLength(2);expect(posts[1].body).toEqual(posts[0].body);expect(recovered).toHaveBeenCalledTimes(1);
 });
 it("editar el motivo invalida la confirmación y genera una clave nueva",async()=>{
  post=()=>Promise.reject(new TypeError("Failed to fetch"));const b=await prepare();fireEvent.click(b);await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Motivo de la reapertura"),{target:{value:reasonText+" y otro detalle"}});
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);expect(button()!.disabled).toBe(true);expect(button()!.textContent).toBe("Reabrir tras fallo");
  fireEvent.click(screen.getByRole("checkbox"));post=()=>reply(ack());fireEvent.click(button()!);await screen.findByText(/Plan reabierto/);
  expect(posts).toHaveLength(2);expect(posts[1].body.request_key).not.toBe(posts[0].body.request_key);expect(posts[1].body.reason).toBe(reasonText+" y otro detalle");
 });
 it.each([
  ["otro plan",{plan_id:task}],["otro trabajo fallido",{failed_job_id:run}],["intento 3",{attempt:3}],["proveedor llamado",{provider_called:true}],["ejecución iniciada",{execution_started:true}],
  ["permiso creado",{approval_created:true}],["tarea completada",{task_completed:true}],["pasos distintos",{next_steps:["dispatch_plan"]}],["otra empresa",{organization_id:task}],
 ])("no presenta como éxito una respuesta con %s",async(_n,over)=>{
  post=()=>reply(ack(over));fireEvent.click(await prepare());expect((await screen.findByRole("alert")).textContent).toMatch(/Resultado no confirmado, consulta el seguimiento/);
  expect(screen.queryByText(/Plan reabierto/)).toBeNull();expect(recovered).not.toHaveBeenCalled();
 });
 it.each([
  [409,/no se puede reabrir.*límite de 2 reaperturas/],[403,/No tienes autorización/],[503,/aún no está disponible o confirmada en el servidor/],
 ])("traduce el estado %s a un mensaje claro y bloquea el reenvío",async(status,text)=>{
  post=()=>reply({detail:"x"},status as number);fireEvent.click(await prepare());expect((await screen.findByRole("alert")).textContent).toMatch(text);
  expect(button()!.disabled).toBe(true);expect(button()!.textContent).toBe("Reabrir tras fallo");expect(recovered).not.toHaveBeenCalled();expect(posts).toHaveLength(1);
 });
 it("con enabled:false muestra una nota neutral y oculta el botón",async()=>{
  history={enabled:false,attempts:[],provider_called:false};view();expect(await screen.findByText(/aún no está disponible en el servidor/)).toBeTruthy();expect(button()).toBeNull();
  expect(server.mock.calls[0][0]).toMatch(/\/document-plans\/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\/attempts$/);expect(server.mock.calls[0][1].method).toBeUndefined();
 });
 it("muestra el historial compacto y respeta el límite de dos reaperturas",async()=>{
  history={enabled:true,provider_called:false,attempts:[
   {plan_id:plan,attempt:1,failed_job_id:run,failed_run_id:run,failed_error_code:"provider_timeout",reason:"Tiempo de espera agotado",reopened_at:"2026-11-10T10:00:00Z",reopened_by_me:true},
   {plan_id:plan,attempt:2,failed_job_id:org,failed_run_id:null,failed_error_code:null,reason:"Segundo fallo de red",reopened_at:"2026-11-11T10:00:00Z",reopened_by_me:false}]};
  view();expect(await screen.findByText(/provider_timeout · Tiempo de espera agotado/)).toBeTruthy();expect(screen.getByText(/sin código · Segundo fallo de red/)).toBeTruthy();
  expect(screen.getByText(/límite de 2 reaperturas/)).toBeTruthy();expect(button()).toBeNull();
 });
 it("no ofrece reabrir si el historial no es válido",async()=>{history={enabled:true,attempts:[{plan_id:task}],provider_called:false};view();expect(await screen.findByText(/No se pudo verificar el historial/)).toBeTruthy();expect(button()).toBeNull();});
 it("no envía nada si se desmonta mientras obtiene el token",async()=>{
  let release!:(v:string)=>void;const b=await prepare();token.mockImplementationOnce(()=>new Promise<string>(r=>release=r));fireEvent.click(b);
  await waitFor(()=>expect(token).toHaveBeenCalledTimes(2));cleanup();release("opaque");await new Promise(r=>setTimeout(r,10));
  expect(posts).toHaveLength(0);expect(recovered).not.toHaveBeenCalled();
 });
 it("descarta una respuesta tardía tras cambiar de empresa",async()=>{
  let finish!:(r:Response)=>void;post=()=>new Promise<Response>(r=>finish=r);const v=view();
  fireEvent.change(await screen.findByLabelText("Motivo de la reapertura"),{target:{value:reasonText}});fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(button()!);
  await waitFor(()=>expect(posts).toHaveLength(1));
  v.rerender(<FailedPlanRecovery companyId={task} plan={failed} onRecovered={recovered}/>);expect(posts[0].signal.aborted).toBe(true);
  finish(new Response(JSON.stringify(ack())));await new Promise(r=>setTimeout(r,10));expect(recovered).not.toHaveBeenCalled();expect(screen.queryByText(/Plan reabierto/)).toBeNull();
 });
 it("acepta la respuesta aunque la lista ya muestre job_id null tras reabrir",async()=>{
  let finish!:(r:Response)=>void;post=()=>new Promise<Response>(r=>finish=r);const v=view();
  fireEvent.change(await screen.findByLabelText("Motivo de la reapertura"),{target:{value:reasonText}});fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(button()!);
  await waitFor(()=>expect(posts).toHaveLength(1));
  v.rerender(<FailedPlanRecovery companyId={org} plan={{...failed,job_id:null,job_state:null}} onRecovered={recovered}/>);expect(posts[0].signal.aborted).toBe(false);
  finish(new Response(JSON.stringify(ack())));expect(await screen.findByText(/Plan reabierto · intento 1 de 2/)).toBeTruthy();expect(recovered).toHaveBeenCalledTimes(1);
 });
 it("tras un error de red y una recarga con job_id null permite reintentar la misma solicitud",async()=>{
  post=()=>Promise.reject(new TypeError("Failed to fetch"));const v=view();
  fireEvent.change(await screen.findByLabelText("Motivo de la reapertura"),{target:{value:reasonText}});fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(button()!);await screen.findByRole("alert");
  v.rerender(<FailedPlanRecovery companyId={org} plan={{...failed,job_id:null,job_state:null}} onRecovered={recovered}/>);
  post=()=>reply(ack({replayed:true}));fireEvent.click(screen.getByRole("button",{name:"Reintentar la misma solicitud"}));
  expect(await screen.findByText(/solicitud ya registrada/)).toBeTruthy();expect(posts[1].body).toEqual(posts[0].body);expect(posts[1].body.failed_job_id).toBe(job);
  v.rerender(<FailedPlanRecovery companyId={org} plan={{...failed,job_id:null,job_state:null}} onRecovered={recovered}/>);expect(screen.getByText(/Plan reabierto/)).toBeTruthy();
 });
 it("sigue funcionando con StrictMode",async()=>{
  render(<React.StrictMode><FailedPlanRecovery companyId={org} plan={failed} onRecovered={recovered}/></React.StrictMode>);
  fireEvent.change(await screen.findByLabelText("Motivo de la reapertura"),{target:{value:reasonText}});fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(button()!);
  await waitFor(()=>expect(recovered).toHaveBeenCalledTimes(1));expect(posts).toHaveLength(1);
 });
});

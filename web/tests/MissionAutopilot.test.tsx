// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {MissionAutopilot,type AutopilotMission} from "../src/MissionAutopilot";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",mission="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",p1="cccccccc-cccc-4ccc-8ccc-cccccccccccc",p2="dddddddd-dddd-4ddd-8ddd-dddddddddddd",job="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",ap="ffffffff-ffff-4fff-8fff-ffffffffffff",other="99999999-9999-4999-8999-999999999999";
const base="https://api.tu-factoria.example/v1/me/organizations/"+org+"/execution/document-missions/"+mission+"/autopilot";
const m:AutopilotMission={id:mission,owner_is_creator:true,mission_control_state:"active",steps:[{position:1,plan_id:p1,job_state:null,review_decision:null},{position:2,plan_id:p2,job_state:null,review_decision:null}]};
const advance=(over:object={})=>({stopped:"job_in_progress",stopped_at_position:1,dispatched:[{position:1,plan_id:p1,job_id:job,kind:"dispatch"}],jobs_dispatched:1,max_jobs:3,...over});
const grantAck=(over:object={})=>({autopilot_id:ap,replayed:false,max_jobs:3,estimated_token_units:7500,advance:advance(),provider_called:false,task_completed:false,...over});
const activeAp=(over:object={})=>({autopilot_id:ap,state:"active",max_jobs:3,jobs_dispatched:1,estimated_token_units:7500,objective_consent:false,auto_retry:true,expires_at:"2026-11-17T22:00:00Z",created_at:"2026-11-16T22:00:00Z",revoked_at:null,granted_by_me:true,dispatches:[{seq:1,position:1,plan_id:p1,job_id:job,kind:"dispatch",created_at:"2026-11-16T22:00:01Z"}],...over});
const reply=(raw:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(raw),{status}));
let list:any,posts:{url:string;body:any;signal:AbortSignal}[],post:(url:string)=>Promise<Response>;
const server=vi.fn(),changed=vi.fn();
beforeEach(()=>{
 list={enabled:true,autopilots:[],token_units_per_job:2500,provider_called:false};posts=[];post=()=>reply(grantAck());changed.mockClear();token.mockReset();token.mockResolvedValue("opaque");
 server.mockReset();server.mockImplementation((url:string,o?:RequestInit)=>{
  if(o?.method==="POST"){posts.push({url,body:o.body===undefined?undefined:JSON.parse(String(o.body)),signal:o.signal!});return post(url);}
  return reply(list);
 });vi.stubGlobal("fetch",server);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=(mm:Partial<AutopilotMission>={},company=org)=>render(<MissionAutopilot companyId={company} mission={{...m,...mm}} onChanged={changed}/>);
const grantButton=()=>screen.queryByRole("button",{name:/Conceder piloto automático|Reintentar la misma concesión|Concediendo/}) as HTMLButtonElement|null;
const cost=()=>screen.getByLabelText(/Acepto el coste/) as HTMLInputElement;
async function ready(mm:Partial<AutopilotMission>={}){const v=view(mm);await screen.findByLabelText(/Máximo de trabajos/);return v;}
describe("piloto automático de Freddy",()=>{
 it("enabled:false muestra una nota neutral y oculta los controles",async()=>{
  list={enabled:false,autopilots:[],token_units_per_job:2500,provider_called:false};view();
  expect(await screen.findByText(/no está disponible aún en el servidor/)).toBeTruthy();expect(grantButton()).toBeNull();expect(screen.queryByRole("button",{name:"Freddy, continúa"})).toBeNull();
  expect(server.mock.calls[0][0]).toBe(base);expect(server.mock.calls[0][1].method).toBeUndefined();expect(posts).toHaveLength(0);
 });
 it.each([["de otro creador",{owner_is_creator:false}],["pausada",{mission_control_state:"paused" as const}],["cancelada",{mission_control_state:"cancelled" as const}],["sin control",{mission_control_state:undefined}]])("no permite conceder en una misión %s",async(_n,mm)=>{
  view(mm);expect(await screen.findByText(/Solo quien creó la misión/)).toBeTruthy();expect(grantButton()).toBeNull();
 });
 it("no presenta controles si la lista no es válida",async()=>{list={...list,provider_called:true};view();expect(await screen.findByText(/No se pudo verificar el piloto automático/)).toBeTruthy();expect(grantButton()).toBeNull();});
 it("rechaza un historial con envíos de otro plan",async()=>{list={...list,autopilots:[activeAp({dispatches:[{seq:1,position:1,plan_id:p2,job_id:job,kind:"dispatch",created_at:"2026-11-16T22:00:01Z"}]})]};view();expect(await screen.findByText(/No se pudo verificar/)).toBeTruthy();});
 it("usa valores por defecto y exige el consentimiento de coste",async()=>{
  await ready();expect((screen.getByLabelText(/Máximo de trabajos/) as HTMLInputElement).value).toBe("3");expect((screen.getByLabelText(/Duración en horas/) as HTMLInputElement).value).toBe("24");
  expect((screen.getByLabelText(/objetivo de cada plan/) as HTMLInputElement).checked).toBe(false);expect((screen.getByLabelText(/solo fallos conocidos/) as HTMLInputElement).checked).toBe(true);
  expect(cost().parentElement!.textContent).toMatch(/hasta 3 trabajos ≈ 3×2\.500 = 7\.500 unidades de cuota\. La aceptación de cada informe sigue siendo mía/);
  expect(grantButton()!.disabled).toBe(true);fireEvent.click(cost());expect(grantButton()!.disabled).toBe(false);
 });
 it.each([["1","24"],["7","24"],["3","0"],["3","169"],["2.5","24"]])("bloquea términos fuera de límites (%s trabajos, %s horas)",async(jobs,hours)=>{
  await ready();fireEvent.change(screen.getByLabelText(/Máximo de trabajos/),{target:{value:jobs}});fireEvent.change(screen.getByLabelText(/Duración en horas/),{target:{value:hours}});
  fireEvent.click(cost());expect(grantButton()!.disabled).toBe(true);
 });
 it("cambiar un término invalida el consentimiento",async()=>{
  await ready();fireEvent.click(cost());fireEvent.click(screen.getByLabelText(/solo fallos conocidos/));expect(cost().checked).toBe(false);expect(grantButton()!.disabled).toBe(true);
 });
 it("envía el cuerpo exacto una vez, muestra la parada y refresca",async()=>{
  await ready();fireEvent.change(screen.getByLabelText(/Máximo de trabajos/),{target:{value:"4"}});fireEvent.change(screen.getByLabelText(/Duración en horas/),{target:{value:"48"}});fireEvent.click(screen.getByLabelText(/objetivo de cada plan/));
  fireEvent.click(cost());post=()=>reply(grantAck({max_jobs:4,estimated_token_units:10000,advance:advance({max_jobs:4})}));const b=grantButton()!;fireEvent.click(b);fireEvent.click(b);
  expect(await screen.findByText(/Piloto automático concedido/)).toBeTruthy();expect(posts).toHaveLength(1);expect(posts[0].url).toBe(base);
  const {request_key,...rest}=posts[0].body;expect(rest).toEqual({max_jobs:4,objective_consent:true,auto_retry:true,hours:48,cost_consent:true});expect(request_key).toMatch(/^[0-9a-f-]{36}$/);
  expect(screen.getByText(/Trabajo en curso/)).toBeTruthy();expect(changed).toHaveBeenCalledTimes(1);await waitFor(()=>expect(server.mock.calls.filter(c=>!c[1]?.method).length).toBe(2));
 });
 it("reintenta tras error de red con la misma clave y genera otra al editar",async()=>{
  post=()=>Promise.reject(new TypeError("Failed to fetch"));await ready();fireEvent.click(cost());fireEvent.click(grantButton()!);
  expect((await screen.findByRole("alert")).textContent).toMatch(/Resultado no confirmado/);
  const again=screen.getByRole("button",{name:"Reintentar la misma concesión"}) as HTMLButtonElement;expect(again.disabled).toBe(false);fireEvent.click(again);
  await waitFor(()=>expect(posts).toHaveLength(2));expect(posts[1].body).toEqual(posts[0].body);await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText(/Duración en horas/),{target:{value:"12"}});expect(grantButton()!.textContent).toBe("Conceder piloto automático");expect(grantButton()!.disabled).toBe(true);
  fireEvent.click(cost());post=()=>reply(grantAck());fireEvent.click(grantButton()!);await screen.findByText(/Piloto automático concedido/);
  expect(posts[2].body.request_key).not.toBe(posts[0].body.request_key);expect(posts[2].body.hours).toBe(12);
 });
 it.each([
  ["parada desconocida",{advance:advance({stopped:"freddy_bored"})}],["envío de otro plan",{advance:advance({dispatched:[{position:1,plan_id:p2,job_id:job,kind:"dispatch"}]})}],
  ["envío con tipo inválido",{advance:advance({dispatched:[{position:1,plan_id:p1,job_id:job,kind:"magic"}]})}],["envío sin job_id",{advance:advance({dispatched:[{position:2,plan_id:p2,job_id:"x",kind:"dispatch"}]})}],
  ["provider_called true",{provider_called:true}],["task_completed true",{task_completed:true}],["otro máximo",{max_jobs:5}],["coste distinto",{estimated_token_units:1}],["sin autopilot_id",{autopilot_id:"x"}],["posición fuera de rango",{advance:advance({stopped_at_position:3})}],
 ])("no presenta como éxito una concesión con %s",async(_n,over)=>{
  post=()=>reply(grantAck(over));await ready();fireEvent.click(cost());fireEvent.click(grantButton()!);
  expect((await screen.findByRole("alert")).textContent).toMatch(/Resultado no confirmado/);expect(screen.queryByText(/concedido/)).toBeNull();expect(changed).not.toHaveBeenCalled();
 });
 it.each([[409,/dentro de los límites de la misión/],[503,/actualización 033/],[403,/No tienes autorización/]])("traduce %s y exige confirmar de nuevo",async(status,text)=>{
  post=()=>reply({detail:"x"},status as number);await ready();fireEvent.click(cost());fireEvent.click(grantButton()!);
  expect((await screen.findByRole("alert")).textContent).toMatch(text);expect(grantButton()!.textContent).toBe("Conceder piloto automático");expect(grantButton()!.disabled).toBe(true);expect(changed).not.toHaveBeenCalled();
 });
 describe("con autorización activa",()=>{
  beforeEach(()=>{list={...list,autopilots:[activeAp(),{...activeAp({autopilot_id:other,state:"revoked",revoked_at:"2026-11-15T10:00:00Z",dispatches:[]})}]};});
  it("muestra presupuesto, caducidad e historial, y oculta la concesión",async()=>{
   view();expect(await screen.findByText(/1\/3 trabajos enviados/)).toBeTruthy();expect((screen.getByLabelText("Presupuesto usado") as HTMLProgressElement).value).toBe(1);
   expect(screen.getByText(/caduca/)).toBeTruthy();expect(screen.getByText(/Paso 1 · envío · trabajo eeeeeeee/)).toBeTruthy();expect(grantButton()).toBeNull();
  });
  it("Freddy, continúa envía POST sin cuerpo y muestra la parada en español",async()=>{
   post=()=>reply({advance:advance({stopped:"awaiting_owner_review",stopped_at_position:2,dispatched:[]})});view();const b=await screen.findByRole("button",{name:"Freddy, continúa"});fireEvent.click(b);fireEvent.click(b);
   expect(await screen.findByText(/Última parada: Esperando tu revisión del informe\. \(paso 2\)/)).toBeTruthy();expect(posts).toHaveLength(1);expect(posts[0].url).toBe(base+"/advance");expect(posts[0].body).toBeUndefined();expect(changed).toHaveBeenCalledTimes(1);
  });
  it.each([["parada desconocida",{advance:advance({stopped:"other"})}],["provider_called true",{advance:advance(),provider_called:true}],["sin advance",{}]])("Freddy, continúa no acepta %s",async(_n,raw)=>{
   post=()=>reply(raw);view();fireEvent.click(await screen.findByRole("button",{name:"Freddy, continúa"}));expect((await screen.findByRole("alert")).textContent).toMatch(/Resultado no confirmado/);expect(changed).not.toHaveBeenCalled();
  });
  it("revoca con motivo y deja claro que la cola no se cancela",async()=>{
   post=()=>reply({revoked:true,queued_jobs_aborted:false});view();await screen.findByText(/Los trabajos ya en cola NO se cancelan/);
   const b=screen.getByRole("button",{name:"Revocar piloto automático"}) as HTMLButtonElement;expect(b.disabled).toBe(true);
   fireEvent.change(screen.getByLabelText("Motivo de la revocación"),{target:{value:"Prefiero revisar a mano"}});expect(b.disabled).toBe(true);fireEvent.click(screen.getByLabelText(/Confirmo revocar/));fireEvent.click(b);
   expect(await screen.findByText(/Autorización revocada\. Los trabajos ya en cola no se han cancelado/)).toBeTruthy();expect(posts[0]).toMatchObject({url:base+"/revoke",body:{reason:"Prefiero revisar a mano"}});expect(changed).toHaveBeenCalledTimes(1);
  });
  it("no acepta una revocación que diga haber abortado la cola",async()=>{
   post=()=>reply({revoked:true,queued_jobs_aborted:true});view();fireEvent.change(await screen.findByLabelText("Motivo de la revocación"),{target:{value:"Prefiero revisar a mano"}});fireEvent.click(screen.getByLabelText(/Confirmo revocar/));fireEvent.click(screen.getByRole("button",{name:"Revocar piloto automático"}));
   expect((await screen.findByRole("alert")).textContent).toMatch(/Resultado no confirmado/);post=()=>reply({revoked:true,queued_jobs_aborted:false});
   fireEvent.click(screen.getByRole("button",{name:"Reintentar la revocación"}));await screen.findByText(/Autorización revocada/);expect(posts[1].body).toEqual(posts[0].body);
  });
  it("oculta continuar y revocar a quien no creó la misión",async()=>{view({owner_is_creator:false});await screen.findByText(/1\/3 trabajos enviados/);expect(screen.queryByRole("button",{name:"Freddy, continúa"})).toBeNull();expect(screen.queryByLabelText("Motivo de la revocación")).toBeNull();});
  it("rechaza dos autorizaciones activas",async()=>{list={...list,autopilots:[activeAp(),activeAp({autopilot_id:other})]};view();expect(await screen.findByText(/No se pudo verificar/)).toBeTruthy();});
 });
 it("no envía nada si se desmonta mientras obtiene el token",async()=>{
  await ready();fireEvent.click(cost());let release!:(v:string)=>void;token.mockImplementationOnce(()=>new Promise<string>(r=>release=r));fireEvent.click(grantButton()!);
  await waitFor(()=>expect(token).toHaveBeenCalledTimes(2));cleanup();release("opaque");await new Promise(r=>setTimeout(r,10));expect(posts).toHaveLength(0);expect(changed).not.toHaveBeenCalled();
 });
 it("descarta una respuesta tardía tras cambiar de empresa",async()=>{
  let finish!:(r:Response)=>void;post=()=>new Promise<Response>(r=>finish=r);const v=await ready();fireEvent.click(cost());fireEvent.click(grantButton()!);await waitFor(()=>expect(posts).toHaveLength(1));
  v.rerender(<MissionAutopilot companyId={other} mission={m} onChanged={changed}/>);expect(posts[0].signal.aborted).toBe(true);
  finish(new Response(JSON.stringify(grantAck())));await new Promise(r=>setTimeout(r,10));expect(changed).not.toHaveBeenCalled();expect(screen.queryByText(/concedido/)).toBeNull();
 });
 it("descarta una respuesta tardía del listado tras desmontar",async()=>{
  let finish!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>finish=r));const v=view();await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));
  v.unmount();expect(server.mock.calls[0][1].signal.aborted).toBe(true);finish(new Response(JSON.stringify(list)));await new Promise(r=>setTimeout(r,10));
 });
 it("sigue funcionando con StrictMode",async()=>{
  render(<React.StrictMode><MissionAutopilot companyId={org} mission={m} onChanged={changed}/></React.StrictMode>);await screen.findByLabelText(/Máximo de trabajos/);fireEvent.click(cost());fireEvent.click(grantButton()!);
  await waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));expect(posts).toHaveLength(1);
 });
});

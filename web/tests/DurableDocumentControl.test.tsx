// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {DurableDocumentControl} from "../src/DurableDocumentControl";
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:async()=>"opaque"})}));
const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",task="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const worker="cccccccc-cccc-4ccc-8ccc-cccccccccccc",id="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const e={organization_id:org,task_id:task,worker_id:worker,repository:"tu-organizacion/factoria-northlane360",path:"docs/ARCHITECTURE.md",ref:"main",sha:"a".repeat(40)};
const callback=vi.fn();
let objectiveSupported=false;
let enabled=true,failPost=false,wrongOrg=false,jobs:unknown[]=[],posts:string[]=[];
const date=()=>new Date(Date.now()+600000).toISOString();
const job=(state="queued")=>({job_id:id,run_id:id,lease_id:id,state,created_at:new Date().toISOString(),valid_until:date(),cancel_requested:false,attention_required:false,error_code:null});
const reply=(x:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(x),{status}));
const server=vi.fn((input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
 const url=String(input);
 if(init?.method==="POST"){
  posts.push(url);
  if(failPost)return reply({},503);
  if(url.endsWith("/cancel")){
   jobs=[{...job("provider_started"),cancel_requested:true}];
   return reply({job_id:id,state:"cancellation_requested",provider_called:false,in_flight_request_may_continue:true});
  }
  jobs=[job()];
  return reply({job_id:id,provider_called:false,task_completed:false,consult_state:true});
 }
 if(url.endsWith("/durable-document-capability"))return reply({organization_id:wrongOrg?"other":org,enabled,capability:"durable_document_analysis_v1",requires_document_approval:true,requires_live_lease:true,provider_called:false,worker_online_verified:false,plan_objective_supported:objectiveSupported});
 if(url.endsWith("/lease"))return reply({organization_id:org,task_id:task,lease:{lease_id:id,worker_id:worker,state:"held",usable:true,expires_at:date()}});
 if(url.endsWith("/document-jobs"))return reply(jobs);
 return reply({},404);
});
const original=server.getMockImplementation()!;
beforeEach(()=>{enabled=true;objectiveSupported=false;failPost=false;wrongOrg=false;jobs=[];posts=[];callback.mockClear();server.mockImplementation(original);server.mockClear();vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const load=()=>fireEvent.click(screen.getByRole("button",{name:"Consultar ejecución en segundo plano"}));
const view=()=>render(<DurableDocumentControl evidence={e} approvalId={id} onQueued={callback}/>);
async function prepare(){
 view();load();
 fireEvent.click(await screen.findByRole("button",{name:"Preparar ejecución en segundo plano"}));
 return screen.getByRole("button",{name:"Confirmar y encolar informe"});
}
describe("durable document queue",()=>{
 it("keeps the unconfigured queue read-only with no writes",async()=>{
  enabled=false;view();load();
  expect(await screen.findByText(/todavía no está habilitado/)).toBeTruthy();
  expect(posts).toHaveLength(0);
  expect(server.mock.calls).toHaveLength(1);
 });
 it("requires explicit sending consent and enqueues without a browser model call",async()=>{
  const send=await prepare();
  expect(posts).toHaveLength(0);
  fireEvent.click(send);
  expect(await screen.findByText("En cola")).toBeTruthy();
  expect(posts).toHaveLength(1);
  expect(posts[0].endsWith("/document-jobs")).toBe(true);
  expect(callback).toHaveBeenCalledTimes(1);
 });
 it("sends only one request for duplicate clicks",async()=>{
  const send=await prepare();
  let finish!:(r:Response)=>void;
  server.mockImplementation((url,init)=>init?.method==="POST"?new Promise(resolve=>{finish=resolve;posts.push(String(url));}):original(url,init));
  fireEvent.click(send);fireEvent.click(send);
  await waitFor(()=>expect(posts).toHaveLength(1));
  jobs=[job()];finish(new Response(JSON.stringify({job_id:id,provider_called:false,task_completed:false,consult_state:true})));
  expect(await screen.findByText("En cola")).toBeTruthy();
 });
 it("does not retry a queue insertion with an uncertain result",async()=>{
  const send=await prepare();failPost=true;fireEvent.click(send);
  expect(await screen.findByText(/No se confirmó la operación/)).toBeTruthy();
  load();await waitFor(()=>expect(screen.queryByText("Consultando ejecución…")).toBeNull());
  expect(screen.queryByRole("button",{name:"Preparar ejecución en segundo plano"})).toBeNull();
  expect(posts).toHaveLength(1);
 });
 it("shows an old persisted job without creating a new one",async()=>{
  jobs=[job("needs_review")];view();load();
  expect(await screen.findByText("Resultado sin confirmar")).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Preparar ejecución en segundo plano"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Solicitar parada"})).toBeNull();
  expect(posts).toHaveLength(0);
 });
 it("does not describe an in-flight cancellation as an undone provider call",async()=>{
  jobs=[job("provider_started")];view();load();
  fireEvent.click(await screen.findByRole("button",{name:"Solicitar parada"}));
  expect(await screen.findByText(/Una solicitud que ya se haya enviado/)).toBeTruthy();
  expect(screen.getByText("Paso de IA iniciado")).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Solicitar parada"})).toBeNull();
  expect(posts).toHaveLength(1);
 });
 it("blocks actions for a mismatched capability scope",async()=>{
  wrongOrg=true;view();load();
  expect(await screen.findByText(/No se confirmó la operación/)).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Preparar ejecución en segundo plano"})).toBeNull();
  expect(posts).toHaveLength(0);
 });
 it("aborts old requests and clears history when the selected company changes",async()=>{
  let signal:AbortSignal|undefined;
  server.mockImplementation((_url,init)=>{signal=init?.signal as AbortSignal;return new Promise(()=>{});});
  const panel=view();load();
  await waitFor(()=>expect(signal).toBeTruthy());
  panel.rerender(<DurableDocumentControl evidence={{...e,organization_id:"other"}} onQueued={callback}/>);
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole("button",{name:"Confirmar y encolar informe"})).toBeNull();
  expect(posts).toHaveLength(0);
 });
});


it("binds an explicitly selected persistent plan in the confirmed queue request",async()=>{
 render(<DurableDocumentControl evidence={e} approvalId={id} planId={id} onQueued={callback}/>);
 load();fireEvent.click(await screen.findByRole("button",{name:"Preparar ejecución en segundo plano"}));
 fireEvent.click(screen.getByRole("button",{name:"Confirmar y encolar informe"}));
 await waitFor(()=>expect(posts).toHaveLength(1));
 const request=server.mock.calls.find(([,options])=>options?.method==="POST")!;
 expect(JSON.parse(request[1]!.body as string).plan_id).toBe(id);
});

it('never downgrades an objective job when its migration is unavailable',async()=>{
 render(<DurableDocumentControl evidence={e} approvalId={id} planId={id} includePlanObjective onQueued={callback}/>);load();await screen.findByText(/requiere activar la migración 029/);expect(screen.queryByRole('button',{name:'Preparar ejecución en segundo plano'})).toBeNull();expect(posts).toHaveLength(0);
});
it('requires explicit objective sending consent and binds it to the saved plan',async()=>{
 objectiveSupported=true;render(<DurableDocumentControl evidence={e} approvalId={id} planId={id} includePlanObjective onQueued={callback}/>);load();fireEvent.click(await screen.findByRole('button',{name:'Preparar ejecución en segundo plano'}));expect(screen.getByText(/Autorizas enviar también el objetivo/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Confirmar y encolar informe'}));await screen.findByText('En cola');const call=server.mock.calls.find(c=>c[1]?.method==='POST')!;expect(JSON.parse(call[1]!.body as string)).toMatchObject({plan_id:id,include_plan_objective:true});expect(posts).toHaveLength(1);
});

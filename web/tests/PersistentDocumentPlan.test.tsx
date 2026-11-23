// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {PersistentDocumentPlan} from "../src/PersistentDocumentPlan";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",task="cccccccc-cccc-4ccc-8ccc-cccccccccccc",worker="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const e={organization_id:org,task_id:task,worker_id:worker,repository:"Nova/project",path:"docs/CI.md",ref:"ci",sha:"a".repeat(40)};
const item=()=>({id,task_id:task,worker_id:worker,objective:"Revisar evidencia documental",request_key:id,repository:e.repository,path:e.path,ref:e.ref,sha:e.sha,version:"document_plan_v1",max_jobs:1,estimated_token_units:2500,steps:[{id:"verify_source",responsible:"worker",depends_on:[]},{id:"analyze_document",responsible:"worker",depends_on:["verify_source"]},{id:"review_result",responsible:"owner",depends_on:["analyze_document"]}],created_at:"2026-11-07T17:00:00Z",owner_is_creator:true,scope_current:true,job_id:null,run_id:null,job_state:null,source_verified_at:null,review_decision:null,task_status:"pending"});
let enabled=true,plans:any[]=[],posts:any[]=[],uncertain=false,wrongOrg=false;
const server=vi.fn(),select=vi.fn();const reply=(raw:unknown)=>Promise.resolve(new Response(JSON.stringify(raw),{status:200}));
beforeEach(()=>{enabled=true;plans=[];posts=[];uncertain=false;wrongOrg=false;select.mockClear();token.mockReset();token.mockResolvedValue("opaque");server.mockReset();server.mockImplementation((_url,options)=>{
 if(options?.method==="POST"){
  const body=JSON.parse(options.body);posts.push(body);plans=[{...item(),objective:body.objective,request_key:body.request_key}];
  return uncertain?Promise.reject(Error("Lost reply")):reply({organization_id:org,task_id:task,plan_id:id,provider_called:false,execution_started:false,source_verified:false});
 }
 return reply({organization_id:wrongOrg?"other":org,task_id:task,enabled,plans,provider_called:false,execution_started:false});
});vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=()=>render(<PersistentDocumentPlan evidence={e} onSelectPlan={select}/>);
const load=()=>fireEvent.click(screen.getByRole("button",{name:"Consultar planes guardados"}));
async function prepare(){view();load();await screen.findByLabelText("Objetivo del plan");fireEvent.change(screen.getByRole("textbox"),{target:{value:"Revisar evidencia documental"}});fireEvent.click(screen.getByRole("checkbox"));return screen.getByRole("button",{name:"Guardar plan sin ejecutar"});}
describe("persistent documentary plan",()=>{
 it("does not read or write until asked",()=>{view();expect(server).not.toHaveBeenCalled();expect(posts).toHaveLength(0);});
 it("keeps absent migration read-only",async()=>{enabled=false;view();load();expect(await screen.findByText(/actualización administrativa 027/)).toBeTruthy();expect(screen.queryByRole("checkbox")).toBeNull();});
 it("saves once with exact scope and confirms through persisted readback",async()=>{
  const button=await prepare();fireEvent.click(button);fireEvent.click(button);
  expect(await screen.findByText(/Plan guardado y recuperado/)).toBeTruthy();expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({worker_id:worker,repository:e.repository,path:e.path,ref:e.ref,sha:e.sha});
  expect(select).toHaveBeenLastCalledWith(id);expect(posts[0].steps).toBeUndefined();expect(posts[0].created_by).toBeUndefined();
 });
 it("locks uncertain saves and lets the owner recover through GET without resend",async()=>{
  uncertain=true;const button=await prepare();fireEvent.click(button);await screen.findByRole("alert");load();
  await screen.findByRole("option",{name:/Revisar evidencia documental/});expect(posts).toHaveLength(1);
  expect((screen.getByRole("button",{name:"Guardar plan sin ejecutar"}) as HTMLButtonElement).disabled).toBe(true);
 });
 it.each(["wrong_sha","different_worker","outdated","another_creator","already_linked"])("does not select a plan that is %s",async why=>{
  plans=[{...item(),...(why==="wrong_sha"?{sha:"b".repeat(40)}:why==="different_worker"?{worker_id:id}:why==="outdated"?{scope_current:false}:why==="another_creator"?{owner_is_creator:false}:{job_id:id,run_id:id,job_state:"queued"})}];
  view();load();const option=await screen.findByRole("option",{name:/Revisar evidencia documental/});expect((option as HTMLOptionElement).disabled).toBe(true);expect(select).not.toHaveBeenCalledWith(id);expect(posts).toHaveLength(0);
 });
 it("rejects a cross-company history",async()=>{wrongOrg=true;view();load();await screen.findByRole("alert");expect(screen.queryByRole("checkbox")).toBeNull();});
 it("never offers a plan with altered limits or dependencies",async()=>{plans=[{...item(),max_jobs:2}];view();load();await screen.findByRole("alert");expect(screen.queryByRole("checkbox")).toBeNull();});
 it("discards a late request after source changes",async()=>{
  let resolve!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>resolve=r));
  const v=view();load();await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));
  v.rerender(<PersistentDocumentPlan evidence={{...e,sha:"b".repeat(40)}} onSelectPlan={select}/>);
  resolve(new Response(JSON.stringify({organization_id:org,task_id:task,enabled:true,plans:[item()],provider_called:false,execution_started:false}),{status:200}));
  await waitFor(()=>expect(screen.queryByRole("option",{name:/Revisar evidencia documental/})).toBeNull());expect(server.mock.calls[0][1].signal.aborted).toBe(true);
 });
});
it.each(['paused','cancelled'])('keeps a %s plan unavailable for enqueue',async state=>{
 plans=[{...item(),control_available:true,control_state:state,control_revision:1}];view();load();const option=await screen.findByRole('option',{name:/Revisar evidencia documental/});expect((option as HTMLOptionElement).disabled).toBe(true);fireEvent.change(screen.getByRole('combobox'),{target:{value:id}});expect(select).not.toHaveBeenCalledWith(id);
});

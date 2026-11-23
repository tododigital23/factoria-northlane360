// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {EliotDocumentPlanner} from "../src/EliotDocumentPlanner";
import {EliotTextChat} from "../src/EliotTextChat";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
vi.mock("../src/DocumentEvidencePreflight",()=>({DocumentEvidencePreflight:(p:any)=><div>Documento para {p.taskId} · {p.workerId}</div>}));
vi.mock("../src/StoredReport",()=>({StoredReport:(p:any)=><div>Informe exacto {p.event.id} · {p.event.sha}</div>}));
vi.mock("../src/EliotTaskDraft",()=>({EliotTaskDraft:()=>null}));
vi.mock("../src/EliotGenerativeSetup",()=>({EliotGenerativeSetup:()=>null}));
vi.mock("../src/useEliotBrowserVoice",()=>({useEliotBrowserVoice:()=>({canListen:false,canSpeak:false,stopListening:()=>{},stopSpeaking:()=>{}})}));
const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",other="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",taskId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",workerId="dddddddd-dddd-4ddd-8ddd-dddddddddddd",runId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const task=()=>({id:taskId,title:"Revisar documentación",status:"pending",department_id:"dept",assignee_worker_id:workerId});
const worker=()=>({id:workerId,name:"Programador IA",department_id:"dept",state:"idle"});
const row=()=>({id:runId,state:"completed",started_at:"2026-11-07T16:00:28Z",repository:"Nova/project",path:"docs/ARCHITECTURE.md",ref:"live",sha:"a".repeat(40)});
const reply=(raw:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(raw),{status}));
let tasks:any[],workers:any[],departments:any[],runs:any[];
const server=vi.fn();const close=vi.fn();
beforeEach(()=>{tasks=[task()];workers=[worker()];departments=[{id:"dept",name:"Desarrollo"}];runs=[row()];server.mockReset();close.mockClear();token.mockReset();token.mockResolvedValue("opaque");server.mockImplementation((input)=>{
 const url=String(input);
 if(url.endsWith("/organizations"))return reply([{id:org,name:"Nova",role:"owner"}]);
 if(url.endsWith("/tasks"))return reply(tasks);
 if(url.endsWith("/workers"))return reply(workers);
 if(url.endsWith("/departments"))return reply(departments);
 if(url.endsWith("/document-runs"))return reply(runs);
 return reply({},404);
});vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=(role="owner")=>render(<EliotDocumentPlanner companyId={org} companyName="Nova" role={role} onClose={close}/>);
async function selectTask(){const select=await screen.findByLabelText("Tarea para revisar");fireEvent.change(select,{target:{value:taskId}});}
const writes=()=>server.mock.calls.filter(([,options])=>options?.method&&options.method!=="GET");
describe("document plan in Freddy",()=>{
 it("requires an explicit task and document choice and only reads company metadata",async()=>{
  view();await screen.findByLabelText("Tarea para revisar");
  expect(screen.queryByText(/Pasos previstos/)).toBeNull();await selectTask();
  expect(screen.getByText("Programador IA")).toBeTruthy();expect(screen.getByText("Desarrollo")).toBeTruthy();
  expect(screen.queryByText(/Documento para/)).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Elegir documento para este plan"}));
  expect(screen.getByText("Documento para "+taskId+" · "+workerId)).toBeTruthy();
  expect(server).toHaveBeenCalledTimes(3);expect(writes()).toHaveLength(0);
 });
 it.each(["member","viewer",""])("does not load owner planning data for role %s",async role=>{
  view(role);expect(await screen.findByRole("status")).toBeTruthy();expect(server).not.toHaveBeenCalled();
 });
 it.each(["blocked","completed","cancelled"])("keeps %s tasks available for report inspection without new execution",async status=>{
  tasks=[{...task(),status}];view();await selectTask();
  expect(screen.queryByRole("button",{name:"Elegir documento para este plan"})).toBeNull();
  expect(screen.getByRole("button",{name:"Consultar informes de esta tarea"})).toBeTruthy();
 });
 it.each(["inactive","wrong_department","missing"])("does not prepare with worker %s",async state=>{
  workers=state==="missing"?[]:[{...worker(),state:state==="inactive"?"inactive":"idle",department_id:state==="wrong_department"?"other":"dept"}];
  view();await selectTask();expect(screen.queryByRole("button",{name:"Elegir documento para este plan"})).toBeNull();
 });
 it("lets the owner choose an exact stored documentary run",async()=>{
  view();await selectTask();fireEvent.click(screen.getByRole("button",{name:"Consultar informes de esta tarea"}));
  const select=await screen.findByLabelText("Informe documental guardado");
  expect(screen.queryByText(/Informe exacto/)).toBeNull();fireEvent.change(select,{target:{value:runId}});
  expect(screen.getByText("Informe exacto "+runId+" · "+"a".repeat(40))).toBeTruthy();
  expect(server.mock.calls.at(-1)![0]).toContain("/"+org+"/tasks/"+taskId+"/execution/document-runs");expect(writes()).toHaveLength(0);
 });
 it("clears an old source and report when refreshing context",async()=>{
  view();await selectTask();fireEvent.click(screen.getByRole("button",{name:"Elegir documento para este plan"}));
  fireEvent.click(screen.getByRole("button",{name:"Actualizar tareas y responsables"}));
  await waitFor(()=>expect(server).toHaveBeenCalledTimes(6));
  expect(screen.queryByText(/Documento para/)).toBeNull();expect(screen.queryByRole("button",{name:"Consultar informes de esta tarea"})).toBeNull();
 });
 it("rejects malformed task metadata and duplicate identities",async()=>{
  tasks=[task(),task()];view();await screen.findByRole("alert");expect(screen.queryByLabelText("Tarea para revisar")).toBeNull();
 });
 it("discards a delayed old company snapshot",async()=>{
  let resolve!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>resolve=r));
  const v=view();await waitFor(()=>expect(server).toHaveBeenCalledTimes(3));
  tasks=[{...task(),title:"Nueva empresa"}];v.rerender(<EliotDocumentPlanner companyId={other} companyName="Otra" role="owner" onClose={close}/>);
  await screen.findByRole("option",{name:"Nueva empresa · Pendiente"});
  resolve(new Response(JSON.stringify([task()]),{status:200}));
  await waitFor(()=>expect(screen.queryByRole("option",{name:"Revisar documentación · Pendiente"})).toBeNull());
 });
 it("closes the temporary plan without mutations",async()=>{
  view();await screen.findByLabelText("Tarea para revisar");fireEvent.click(screen.getByRole("button",{name:"Cerrar plan documental"}));expect(close).toHaveBeenCalledTimes(1);expect(writes()).toHaveLength(0);
 });
 it("routes the conversational documentary request without a model request",async()=>{
  render(<EliotTextChat preferredCompanyId={org}/>);
  const button=await screen.findByRole("button",{name:"Planifica una revisión documental"});
  await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);await screen.findByLabelText("Tarea para revisar");
  expect(screen.getByRole("region",{name:"Plan documental de Freddy"})).toBeTruthy();
  expect(server.mock.calls.some(([url])=>String(url).includes("/eliot/chat"))).toBe(false);expect(writes()).toHaveLength(0);
 });
});

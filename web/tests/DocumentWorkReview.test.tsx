// @vitest-environment jsdom
import React from "react";
import {beforeEach,afterEach,describe,it,expect,vi} from "vitest";
import {render,screen,cleanup,fireEvent,waitFor} from "@testing-library/react";
import {DocumentWorkReview} from "../src/DocumentWorkReview";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const base=()=>({organization_id:"org",task_id:"task",run_id:"run",enabled:true,eligible:true,task_status:"pending",unavailable_reason:null,review:null,provider_called:false});
const reviewed=(body:any)=>({...base(),eligible:false,task_status:body.decision==="accepted"?"completed":"blocked",unavailable_reason:"already_reviewed",review:{...body,id:"review",reviewed_at:"2026-11-07T17:00:00Z",task_status_after:body.decision==="accepted"?"completed":"blocked"}});
const reply=(x:unknown)=>Promise.resolve(new Response(JSON.stringify(x),{status:200}));
let data:any,posts:any[],lost=false;
const server=vi.fn();
beforeEach(()=>{data=base();posts=[];lost=false;token.mockReset();token.mockResolvedValue("opaque");server.mockReset();server.mockImplementation((_url,options)=>{
 if(options?.method==="POST"){const body=JSON.parse(options.body);posts.push(body);data=reviewed(body);return lost?Promise.reject(Error("Connection lost")):reply(data);}
 return reply(data);
});vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=()=>render(<DocumentWorkReview companyId="org" taskId="task" runId="run"/>);
async function prepare(accept=false){
 view();const select=await screen.findByLabelText("Decisión");
 if(accept)fireEvent.change(select,{target:{value:"accepted"}});
 fireEvent.change(screen.getByRole("textbox"),{target:{value:"Revisado el alcance y las conclusiones del informe"}});
 fireEvent.click(screen.getByRole("checkbox"));
 return screen.getByRole("button",{name:accept?"Confirmar aceptación y cerrar tarea":"Confirmar correcciones y bloquear tarea"});
}
describe("document work review",()=>{
 it("does not write on mount or refresh",async()=>{
  view();await screen.findByLabelText("Decisión");
  fireEvent.click(screen.getByRole("button",{name:"Consultar revisión guardada"}));
  await waitFor(()=>expect(server).toHaveBeenCalledTimes(2));expect(posts).toHaveLength(0);
 });
 it("keeps missing migration read-only",async()=>{
  data={...base(),enabled:false,eligible:false};view();
  expect(await screen.findByText(/actualización administrativa 026/)).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();expect(posts).toHaveLength(0);
 });
 it("requires a reason and explicit confirmation, invalidating confirmation on edits",async()=>{
  view();await screen.findByLabelText("Decisión");
  const button=screen.getByRole("button",{name:"Confirmar correcciones y bloquear tarea"}) as HTMLButtonElement;
  expect(button.disabled).toBe(true);fireEvent.click(screen.getByRole("checkbox"));expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox"),{target:{value:"Reason for corrections"}});
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);expect(button.disabled).toBe(true);
 });
 it.each([false,true])("records an explicit decision and blocks double clicks (accept=%s)",async accept=>{
  const button=await prepare(accept);fireEvent.click(button);fireEvent.click(button);
  expect(await screen.findByText(accept?"Informe aceptado":"Correcciones solicitadas")).toBeTruthy();
  expect(posts).toHaveLength(1);expect(posts[0].decision).toBe(accept?"accepted":"changes_requested");
  expect(Object.keys(posts[0]).sort()).toEqual(["decision","reason","request_key"]);
 });
 it("reads after a lost reply and never resubmits the write",async()=>{
  lost=true;const button=await prepare(true);fireEvent.click(button);
  expect(await screen.findByText("Informe aceptado")).toBeTruthy();
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Consultar revisión guardada"}));
  await waitFor(()=>expect(server.mock.calls.length).toBeGreaterThanOrEqual(4));expect(posts).toHaveLength(1);
 });
 it("locks an uncertain submission even when readback finds no decision",async()=>{
  server.mockImplementation((_url,options)=>{if(options?.method==="POST"){posts.push(JSON.parse(options.body));return Promise.reject(Error("Lost"));}return reply(base());});
  const button=await prepare();fireEvent.click(button);
  await screen.findByRole("alert");
  await waitFor(()=>expect((screen.getByRole("button",{name:"Confirmar correcciones y bloquear tarea"}) as HTMLButtonElement).disabled).toBe(true));
  expect(posts).toHaveLength(1);
 });
 it.each(["task_changed","unconfirmed_execution","newer_attempt","task_not_pending"])("does not offer a decision for %s",async why=>{
  data={...base(),eligible:false,unavailable_reason:why};view();
  await screen.findByRole("status");expect(screen.queryByRole("checkbox")).toBeNull();expect(posts).toHaveLength(0);
 });
 it("rejects cross-company response context",async()=>{
  data={...base(),organization_id:"other"};view();await screen.findByRole("alert");
  expect(screen.queryByRole("checkbox")).toBeNull();
 });
 it("does not dispatch a pending authenticated write after unmount",async()=>{
  const button=await prepare(true);let resolve!:(s:string)=>void;
  token.mockImplementationOnce(()=>new Promise<string>(r=>resolve=r));
  fireEvent.click(button);cleanup();resolve("opaque");
  await waitFor(()=>expect(posts).toHaveLength(0));
 });
 it("discards a late company response",async()=>{
  let resolve!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>resolve=r));
  const v=view();await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));
  data={...base(),organization_id:"new-org",enabled:false,eligible:false};
  v.rerender(<DocumentWorkReview companyId="new-org" taskId="task" runId="run"/>);
  await screen.findByText(/actualización administrativa 026/);
  resolve(new Response(JSON.stringify(base()),{status:200}));
  await waitFor(()=>expect(screen.queryByLabelText("Decisión")).toBeNull());
 });
});

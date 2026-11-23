// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {StoredReport} from "../src/StoredReport";
import {AgentWorkOverview} from "../src/AgentWorkOverview";
vi.mock("../src/DocumentWorkReview",()=>({DocumentWorkReview:()=> <div>Control de revisión</div>}));
const {token}=vi.hoisted(()=>({token:vi.fn(async(_options?:unknown)=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const event={id:"run-1",task_id:"task-1",task_title:"Revisar arquitectura",kind:"document_analysis" as const,repository:"Nova/project",path:"docs/ARCHITECTURE.md",ref:"live",sha:"a".repeat(40)};
const row=()=>({...event,state:"completed",report:"Informe verificado",started_at:"2026-11-07T16:00:28Z",finished_at:"2026-11-07T16:00:47Z"});
const reply=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
const server=vi.fn();
beforeEach(()=>{server.mockReset();token.mockClear();server.mockResolvedValue(reply([row()]));vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe("stored report inspection",()=>{
 it("reads the exact run without mutation or model call",async()=>{
  render(<StoredReport companyId="org-1" event={event}/>);
  expect(await screen.findByText("Informe verificado")).toBeTruthy();
  expect(server).toHaveBeenCalledTimes(1);
  const [url,options]=server.mock.calls[0];
  expect(url).toContain("/org-1/tasks/task-1/execution/document-runs");
  expect(options.method).toBeUndefined();
  expect(token.mock.calls[0][0]).toEqual({authorizationParams:{audience:"https://api.eliot.internal",scope:"read:tasks"}});
  expect(screen.getByText(event.sha)).toBeTruthy();
 });
 it("renders the tail beyond 4000 characters and keeps HTML/links inert",async()=>{
  server.mockResolvedValue(reply([{...row(),report:"x".repeat(4100)+"\n\nFINAL DEL INFORME\n\n<script>alert(1)</script> [abrir](https://example.com)"}]));
  const {container}=render(<StoredReport companyId="org-1" event={event}/>);
  expect(await screen.findByText("FINAL DEL INFORME")).toBeTruthy();
  expect(container.querySelector("script,a,iframe,img")).toBeNull();
  expect(screen.getByText(/<script>/)).toBeTruthy();
 });
 it("counts Unicode characters consistently with PostgreSQL",async()=>{
  server.mockResolvedValue(reply([{...row(),report:"😀".repeat(1000)+"x".repeat(4500)+"\n\nFINAL UNICODE"}]));
  render(<StoredReport companyId="org-1" event={event}/>);
  expect(await screen.findByText("FINAL UNICODE")).toBeTruthy();
 });
 it.each([
  ["another run",()=>[{...row(),id:"different"}]],
  ["another SHA",()=>[{...row(),sha:"b".repeat(40)}]],
  ["another path",()=>[{...row(),path:"docs/other.md"}]],
  ["another ref",()=>[{...row(),ref:"other"}]],
  ["another repository",()=>[{...row(),repository:"other/repo"}]],
  ["duplicate run",()=>[row(),row()]],
  ["running attempt",()=>[{...row(),state:"running"}]],
  ["oversized report",()=>[{...row(),report:"x".repeat(6001)}]],
  ["missing timestamp",()=>[{...row(),finished_at:null}]],
 ])("rejects %s without substituting a different result",async(_label,rows)=>{
  server.mockResolvedValue(reply(rows()));
  render(<StoredReport companyId="org-1" event={event}/>);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Informe verificado")).toBeNull();
 });
 it("labels title-only drafts and uses their separate reader",async()=>{
  server.mockResolvedValue(reply([{...row(),draft_from_title_only:true}]));
  render(<StoredReport companyId="org-1" event={{...event,kind:"title_draft"}}/>);
  expect(await screen.findByText("Informe verificado")).toBeTruthy();
  expect(server.mock.calls[0][0]).toContain("/analysis-runs");
  expect(screen.getByText(/se basa solo en el título/)).toBeTruthy();
  expect(screen.queryByText(event.sha)).toBeNull();
 });
 it("discards late responses after a company switch, even if fetch ignores abort",async()=>{
  let resolve!:(r:Response)=>void;
  server.mockImplementationOnce(()=>new Promise<Response>(r=>{resolve=r}));
  const view=render(<StoredReport companyId="org-1" event={event}/>);
  await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));
  server.mockResolvedValue(reply([{...row(),report:"Informe de nueva empresa"}]));
  view.rerender(<StoredReport companyId="org-2" event={event}/>);
  expect(await screen.findByText("Informe de nueva empresa")).toBeTruthy();
  expect(server.mock.calls[0][1].signal.aborted).toBe(true);
  resolve(reply([{...row(),report:"Contenido antiguo"}]));
  await waitFor(()=>expect(screen.queryByText("Contenido antiguo")).toBeNull());
 });
 it("opens a report from the overview only after an explicit click",async()=>{
  const counts={completed:1,failed:0,running:0};
  const overview={organization_id:"org-1",read_only:true,contains_report_text:false,sample:{tasks_scanned:1,task_limit:40,run_limit_per_task_per_type:20,truncated:false,not_full_company_census:true},counts:{title_draft:counts,document_analysis:counts},attention_count_in_sample:0,events:[{...row(),kind:event.kind,needs_attention:false}]};
  server.mockImplementation((url:string)=>Promise.resolve(reply(url.endsWith("work-overview")?overview:[row()])));
  render(<AgentWorkOverview companyId="org-1" companies={[{id:"org-1",name:"Nova",role:"owner"}]} onSelectCompany={()=>{}} onLoadCompanies={()=>{}}/>);
  const open=await screen.findByRole("button",{name:"Ver informe completo"});
  expect(server).toHaveBeenCalledTimes(1);
  fireEvent.click(open);
  expect(await screen.findByText("Informe verificado")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Cerrar informe"}));
  expect(screen.queryByText("Informe verificado")).toBeNull();
  expect(server).toHaveBeenCalledTimes(2);
 });
});

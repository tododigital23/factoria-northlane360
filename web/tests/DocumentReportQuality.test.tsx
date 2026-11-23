// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {DocumentReportQuality} from "../src/DocumentReportQuality";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const e={companyId:"org",taskId:"task",runId:"run",repository:"Nova/project",path:"docs/CI.md",sourceRef:"live",sha:"a".repeat(40)};
const checkIds=["report_size","required_sections","nonempty_sections","citation_syntax","facts_cited","source_line_bounds","credential_patterns","control_characters"];
const result=()=>({organization_id:e.companyId,task_id:e.taskId,run_id:e.runId,repository:e.repository,path:e.path,ref:e.sourceRef,sha:e.sha,read_only:true,provider_called:false,source_fetched:false,task_completed:false,quality:{version:"document_quality_v1",status:"structural_checks_passed",semantic_correctness_verified:false,source_line_bounds_verified:false,human_review_required:true,checks:checkIds.map(id=>({id,state:id==="source_line_bounds"?"not_checked":"passed"}))}});
const reply=(raw:unknown)=>Promise.resolve(new Response(JSON.stringify(raw),{status:200}));
const server=vi.fn();
beforeEach(()=>{server.mockReset();server.mockImplementation(()=>reply(result()));token.mockReset();token.mockResolvedValue("opaque");vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const inspect=()=>fireEvent.click(screen.getByRole("button",{name:"Comprobar formato del informe"}));
describe("documentary quality inspection",()=>{
 it("requires an explicit click and reads only the exact report endpoint",async()=>{
  render(<DocumentReportQuality {...e}/>);expect(server).not.toHaveBeenCalled();inspect();
  expect(await screen.findByText("Comprobaciones de formato superadas")).toBeTruthy();
  expect(server).toHaveBeenCalledTimes(1);const [url,options]=server.mock.calls[0];
  expect(url).toContain("/org/tasks/task/execution/document-runs/run/quality");expect(options.method).toBeUndefined();expect(options.body).toBeUndefined();
  expect(screen.getByText(/No se vuelve a leer la fuente/)).toBeTruthy();expect(screen.getByText(/no certifican la verdad/)).toBeTruthy();
 });
 it("shows structural failures without accepting or retrying work",async()=>{
  const raw=result();raw.quality.status="requires_attention";raw.quality.checks[0].state="failed";server.mockImplementation(()=>reply(raw));
  render(<DocumentReportQuality {...e}/>);inspect();expect(await screen.findByText("Se han detectado puntos para revisar")).toBeTruthy();
  expect(server).toHaveBeenCalledTimes(1);expect(screen.queryByRole("button",{name:/aceptar/i})).toBeNull();
 });
 it.each(["organization_id","task_id","run_id","repository","path","ref","sha"])("rejects another %s",async key=>{
  server.mockImplementation(()=>reply({...result(),[key]:"other"}));render(<DocumentReportQuality {...e}/>);inspect();
  await screen.findByRole("alert");expect(screen.queryByText("Comprobaciones de formato superadas")).toBeNull();
 });
 it.each(["semantic_correctness_verified","source_line_bounds_verified"])("rejects an unsupported claim about %s",async key=>{
  const raw=result();(raw.quality as any)[key]=true;server.mockImplementation(()=>reply(raw));render(<DocumentReportQuality {...e}/>);inspect();await screen.findByRole("alert");
 });
 it("rejects missing, duplicate, unknown and contradictory checks",async()=>{
  const raw=result();raw.quality.checks[0]={id:"source_line_bounds",state:"passed"};server.mockImplementation(()=>reply(raw));
  render(<DocumentReportQuality {...e}/>);inspect();await screen.findByRole("alert");
 });
 it("discards a response from an old source context",async()=>{
  let resolve!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>resolve=r));
  const v=render(<DocumentReportQuality {...e}/>);inspect();await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));
  v.rerender(<DocumentReportQuality {...e} sha={"b".repeat(40)}/>);
  resolve(new Response(JSON.stringify(result()),{status:200}));
  await waitFor(()=>expect(screen.queryByText("Comprobaciones de formato superadas")).toBeNull());expect(server.mock.calls[0][1].signal.aborted).toBe(true);
 });
 it("guards double clicks without extra requests",async()=>{
  render(<DocumentReportQuality {...e}/>);const button=screen.getByRole("button",{name:"Comprobar formato del informe"});fireEvent.click(button);fireEvent.click(button);await screen.findByText("Comprobaciones de formato superadas");expect(server).toHaveBeenCalledTimes(1);
 });
});

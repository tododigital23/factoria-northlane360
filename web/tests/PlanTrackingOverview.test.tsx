// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {PlanTrackingOverview} from "../src/PlanTrackingOverview";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
vi.mock("../src/DocumentMissions",()=>({DocumentMissions:()=> <div>Planes de varios trabajos</div>}));
vi.mock("../src/ObjectivePlanning",()=>({ObjectivePlanning:()=>null}));
vi.mock("../src/SavedPlanDispatch",()=>({SavedPlanDispatch:(p:any)=><div>Preparación del plan {p.planId}</div>}));
vi.mock("../src/StoredReport",()=>({StoredReport:(p:any)=><div>Informe exacto {p.event.id} · {p.event.sha}</div>}));
const org="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",task="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",worker="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const states=["paused","prepared","outdated","queued","claimed","source_verified","provider_started","awaiting_review","accepted","changes_requested","failed","cancelled","needs_review"];
const item=(state="prepared")=>({plan_id:id,task_id:task,task_title:"Revisar documentación",department_id:"dept",department_name:"Desarrollo",worker_id:worker,worker_name:"Programador IA",objective:"Revisar fuente exacta",repository:"Nova/project",path:"docs/CI.md",ref:"live",sha:"a".repeat(40),created_at:"2026-11-07T17:00:00Z",state,steps:[{id:"verify_source",responsible:"worker",state:state==="awaiting_review"?"completed":"pending"},{id:"analyze_document",responsible:"worker",state:state==="awaiting_review"?"completed":"waiting"},{id:"review_result",responsible:"owner",state:state==="awaiting_review"?"awaiting_review":"waiting"}],job_id:state==="awaiting_review"?id:null,run_id:state==="awaiting_review"?id:null,job_state:state==="awaiting_review"?"completed":null,review_decision:null,task_status:"pending",scope_current:true,needs_attention:state==="awaiting_review"});
const overview=(plans:any[]=[])=>({plan_controls_available:true,organization_id:org,enabled:true,read_only:true,provider_called:false,source_fetched:false,task_completed:false,progress_basis:"persisted_plan_job_and_review",sample:{tasks_scanned:2,task_limit:40,plans_per_task_limit:20,visible_plan_limit:100,plans_in_task_sample:plans.length,plans_truncated:false,tasks_truncated:false,not_full_company_census:true},counts_in_visible_sample:Object.fromEntries(states.map(s=>[s,plans.filter(p=>p.state===s).length])),attention_in_visible_sample:plans.filter(p=>p.needs_attention).length,plans});
const reply=(raw:unknown)=>Promise.resolve(new Response(JSON.stringify(raw),{status:200}));
const server=vi.fn(),select=vi.fn(),load=vi.fn();
beforeEach(()=>{server.mockReset();server.mockImplementation(()=>reply(overview()));token.mockReset();token.mockResolvedValue("opaque");select.mockClear();load.mockClear();vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const props={companyId:org,companies:[{id:org,name:"Nova",role:"owner"}],onSelectCompany:select,onLoadCompanies:load};
describe("central plan tracking",()=>{
 it("shows a real empty sample without fabricating activity or posting",async()=>{
  render(<PlanTrackingOverview {...props}/>);await screen.findByText("0 planes en la muestra visible");
  expect(screen.getByText(/Guardar un plan no significa/)).toBeTruthy();expect(server).toHaveBeenCalledTimes(1);expect(server.mock.calls[0][1].method).toBeUndefined();
 });
 it("presents a saved plan as pending steps, not active work",async()=>{
  server.mockImplementation(()=>reply(overview([item()])));render(<PlanTrackingOverview {...props}/>);
  expect(await screen.findByText("Guardado · sin envío",{selector:"span"})).toBeTruthy();expect(screen.queryByRole("button",{name:"Ver informe y revisión del plan"})).toBeNull();
  expect(screen.getByText("Departamento: Desarrollo · Responsable: Programador IA")).toBeTruthy();
 });
 it("opens the exact completed report only on request",async()=>{
  server.mockImplementation(()=>reply(overview([item("awaiting_review")])));render(<PlanTrackingOverview {...props}/>);
  const button=await screen.findByRole("button",{name:"Ver informe y revisión del plan"});expect(screen.queryByText(/Informe exacto/)).toBeNull();fireEvent.click(button);
  expect(screen.getByText("Informe exacto "+id+" · "+"a".repeat(40))).toBeTruthy();expect(server).toHaveBeenCalledTimes(1);
 });
 it("filters saved plans and keeps the sample warning visible",async()=>{
  const raw=overview([item()]);raw.sample.tasks_truncated=true;server.mockImplementation(()=>reply(raw));render(<PlanTrackingOverview {...props}/>);
  await screen.findByText("Guardado · sin envío",{selector:"span"});fireEvent.change(screen.getByLabelText("Buscar plan, tarea o responsable"),{target:{value:"inexistente"}});
  expect(screen.getByText(/No hay planes con estos filtros/)).toBeTruthy();expect(screen.getByText(/Hay más registros/)).toBeTruthy();
 });
 it.each(["member","viewer"])("does not query the owner monitor for %s",async role=>{
  render(<PlanTrackingOverview {...props} companies={[{id:org,name:"Nova",role}]}/>);await screen.findByRole("status");expect(server).not.toHaveBeenCalled();
 });
 it("keeps missing storage distinct from zero plans",async()=>{
  server.mockImplementation(()=>reply({organization_id:org,enabled:false,read_only:true,provider_called:false,source_fetched:false,task_completed:false,plans:[]}));render(<PlanTrackingOverview {...props}/>);
  await screen.findByText(/almacenamiento de planes no está disponible/);expect(screen.queryByText("0 planes en la muestra visible")).toBeNull();
 });
 it.each(["wrong_org","duplicate_plan","invalid_dependencies","invented_acceptance"])("rejects %s",async why=>{
  const raw=overview([item()]);if(why==="wrong_org")raw.organization_id="other";if(why==="duplicate_plan"){raw.plans.push(item());raw.counts_in_visible_sample.prepared=2;}if(why==="invalid_dependencies")raw.plans[0].steps[0].id="invented";if(why==="invented_acceptance")raw.plans[0].state="accepted";
  server.mockImplementation(()=>reply(raw));render(<PlanTrackingOverview {...props}/>);await screen.findByRole("alert");expect(screen.queryByText("Revisar fuente exacta")).toBeNull();
 });
 it("discards a late company response",async()=>{
  let resolve!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>resolve=r));
  const v=render(<PlanTrackingOverview {...props}/>);await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));
  const other="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";server.mockImplementation(()=>reply({...overview(),organization_id:other}));
  v.rerender(<PlanTrackingOverview {...props} companyId={other} companies={[{id:other,name:"Otra",role:"owner"}]}/>);await screen.findByText("0 planes en la muestra visible");
  resolve(new Response(JSON.stringify(overview([item()])),{status:200}));await waitFor(()=>expect(screen.queryByText("Revisar fuente exacta")).toBeNull());expect(server.mock.calls[0][1].signal.aborted).toBe(true);
 });
});

it("shows controls only when the backend confirms their availability",async()=>{
 const p={...item(),control_available:true,control_state:"active",control_revision:0,can_control:true};server.mockImplementation(()=>reply(overview([p])));render(<PlanTrackingOverview {...props}/>);expect(await screen.findByRole("button",{name:"Pausar plan"})).toBeTruthy();expect(server).toHaveBeenCalledTimes(1);
});
it("keeps a paused plan visible without showing a started job",async()=>{
 const p={...item("paused"),control_available:true,control_state:"paused",control_revision:1,can_control:true};server.mockImplementation(()=>reply(overview([p])));render(<PlanTrackingOverview {...props}/>);expect(await screen.findByText("Plan pausado",{selector:"span"})).toBeTruthy();expect(screen.getByRole("button",{name:"Reanudar plan"})).toBeTruthy();expect(screen.queryByRole("button",{name:"Ver informe y revisión del plan"})).toBeNull();
});

it("opens dispatch only on request for an active owned plan",async()=>{
 const p={...item(),control_available:true,control_state:"active",control_revision:0,can_control:true};server.mockImplementation(()=>reply(overview([p])));render(<PlanTrackingOverview {...props}/>);const button=await screen.findByRole("button",{name:"Preparar envío de este plan"});expect(screen.queryByText(/Preparación del plan/)).toBeNull();fireEvent.click(button);expect(screen.getByText("Preparación del plan "+id)).toBeTruthy();
});

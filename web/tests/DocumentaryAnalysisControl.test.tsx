// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {DocumentaryAnalysisControl} from "../src/DocumentaryAnalysisControl";
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({
 getAccessTokenSilently:async()=>"opaque"
})}));
const evidence={organization_id:"org",task_id:"task",worker_id:"worker",
 repository:"tu-organizacion/factoria-northlane360",path:"docs/ARCHITECTURE.md",
 ref:"feature/auth0-organizations-endpoint",sha:"a".repeat(40),
 size_bytes:1207,source_verified:true};
let approvals:object[]=[],posts:string[]=[],failReadback=false,failRefresh=false;
const reply=(value:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(value),{status}));
const server=vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{
 const url=String(input);
 if(init?.method==="POST"){
  posts.push(url);
  if(url.endsWith("/document-approvals")){
   approvals=[{id:"approval",worker_id:evidence.worker_id,state:"approved",
    repository:evidence.repository,path:evidence.path,ref:evidence.ref,sha:evidence.sha,
    expires_at:new Date(Date.now()+15*60000).toISOString()}];
   return reply({approval_id:"approval",capability:"document_analysis_v1",
    sha:evidence.sha,provider_called:false});
  }
  return reply({},500);
 }
 if(failRefresh||(failReadback&&posts.length>0))return reply({},503);
 if(url.endsWith("/documentary-capability"))return reply({
  organization_id:evidence.organization_id,enabled:true,capability:"document_analysis_v1",
  source_scope:"one_github_file_exact_sha",requires_fresh_document_approval:true,
  external_tools_enabled:false,store_at_provider:false
 });
 if(url.endsWith("/document-approvals"))return reply(approvals);
 if(url.endsWith("/document-runs"))return reply([]);
 return reply({},404);
});
beforeEach(()=>{approvals=[];posts=[];failReadback=false;failRefresh=false;server.mockClear();vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const refresh=()=>fireEvent.click(screen.getByRole("button",{name:"Comprobar autorización documental"}));
async function prepare(){
 render(<DocumentaryAnalysisControl evidence={evidence}/>);
 refresh();
 fireEvent.click(await screen.findByRole("button",{name:"Preparar permiso para este SHA"}));
}
describe("document approval read-back",()=>{
 it("shows the server-confirmed permission immediately without starting an analysis",async()=>{
  await prepare();
  fireEvent.click(screen.getByRole("button",{name:"Confirmar autorización"}));
  expect(await screen.findByRole("button",{name:"Preparar análisis documental"})).toBeTruthy();
  expect(screen.getByText(/Permiso vigente para este documento hasta/)).toBeTruthy();
  expect(posts).toHaveLength(1);
  expect(posts[0].endsWith("/document-approvals")).toBe(true);
  expect(screen.queryByRole("button",{name:"Confirmar envío y generar informe"})).toBeNull();
 });
 it("keeps a separate sending confirmation after refreshing the permission",async()=>{
  await prepare();
  fireEvent.click(screen.getByRole("button",{name:"Confirmar autorización"}));
  fireEvent.click(await screen.findByRole("button",{name:"Preparar análisis documental"}));
  expect(screen.getByRole("button",{name:"Confirmar envío y generar informe"})).toBeTruthy();
  expect(posts).toHaveLength(1);
 });
 it("blocks actions after a failed read-back and recovers by GET without a second approval",async()=>{
  await prepare();failReadback=true;
  fireEvent.click(screen.getByRole("button",{name:"Confirmar autorización"}));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Preparar permiso para este SHA"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Preparar análisis documental"})).toBeNull();
  expect(posts).toHaveLength(1);
  failReadback=false;refresh();
  expect(await screen.findByRole("button",{name:"Preparar análisis documental"})).toBeTruthy();
  expect(posts).toHaveLength(1);
 });
 it("invalidates an old sending confirmation when a later refresh fails",async()=>{
  await prepare();
  fireEvent.click(screen.getByRole("button",{name:"Confirmar autorización"}));
  fireEvent.click(await screen.findByRole("button",{name:"Preparar análisis documental"}));
  failRefresh=true;refresh();
  await waitFor(()=>expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.queryByRole("button",{name:"Confirmar envío y generar informe"})).toBeNull();
  expect(posts).toHaveLength(1);
 });
});

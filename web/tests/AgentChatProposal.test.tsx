// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {AgentChat,validProposal} from "../src/office/AgentChat";
import type {Agent} from "../src/office/officeModel";

const ORG="org-1",W="w-1";
const agent:Agent={id:W,name:"Especialista SEO",person:"Lucía",specialty:"SEO",departmentId:"d",departmentName:"SEO y Contenidos",status:"available",phase:"available",progress:0,headline:"",step:"",activity:"",lastAssignedAt:null,motionActive:false,needs:[]};
const PROPOSAL={request:"Revisar los títulos de las 10 páginas más vistas y proponer cambios.",deliverable:"Un informe página a página"};
let posts:{url:string;body:any}[],created:ReturnType<typeof vi.fn>;
beforeEach(()=>{posts=[];created=vi.fn();
 vi.stubGlobal("fetch",vi.fn((url:string,o:RequestInit)=>{const body=JSON.parse(String(o.body));posts.push({url,body});
  if(url.endsWith("/eliot/chat"))return Promise.resolve(new Response(JSON.stringify({answer:"Te propongo este encargo.",mode:"grounded_ai",read_only:true,organization_id:ORG,worker_id:W,proposal:PROPOSAL})));
  return Promise.resolve(new Response(JSON.stringify({organization_id:ORG,worker_id:W,task_id:"t",department_id:"d",title:"x",status:"pending",replayed:false,execution_started:false}),{status:201}));}));});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const open=(can=true)=>render(<AgentChat organizationId={ORG} agent={agent} token={async()=>"t"} canRequest={can} onCreated={created} onClose={()=>{}}/>);

it("el agente propone y el encargo solo se crea al confirmar",async()=>{
 open();fireEvent.click(screen.getByRole("button",{name:"Quiero encargarte un trabajo"}));
 await screen.findByText(PROPOSAL.request);
 expect(posts.length).toBe(1);                                                    // proponer no crea nada
 fireEvent.click(screen.getByRole("button",{name:"Confirmar encargo"}));
 await screen.findByText("✓ Encargo creado");
 expect(posts[1].url).toContain("/workers/"+W+"/requests");expect(posts[1].body.request).toBe(PROPOSAL.request);expect(posts[1].body.deliverable).toBe(PROPOSAL.deliverable);
 expect(typeof posts[1].body.request_key).toBe("string");expect(created).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole("button",{name:"Confirmar encargo"})).toBeNull();          // no se puede crear dos veces
});
it("se puede descartar, y quien no es propietario no puede confirmar",async()=>{
 open();fireEvent.click(screen.getByRole("button",{name:"Quiero encargarte un trabajo"}));await screen.findByText(PROPOSAL.request);
 fireEvent.click(screen.getByRole("button",{name:"Descartar"}));await screen.findByText("Descartado");expect(posts.length).toBe(1);
 cleanup();open(false);fireEvent.click(screen.getByRole("button",{name:"Quiero encargarte un trabajo"}));await screen.findByText(PROPOSAL.request);
 await waitFor(()=>expect((screen.getByRole("button",{name:"Confirmar encargo"}) as HTMLButtonElement).disabled).toBe(true));
});
it("una propuesta mal formada no se enseña",()=>{
 expect(validProposal(PROPOSAL)).toBe(true);expect(validProposal({request:"corto",deliverable:null})).toBe(false);
 expect(validProposal({request:"x".repeat(700),deliverable:null})).toBe(false);expect(validProposal({request:PROPOSAL.request})).toBe(false);expect(validProposal(null)).toBe(false);
});

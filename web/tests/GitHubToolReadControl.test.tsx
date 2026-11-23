// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {GitHubToolReadControl} from '../src/GitHubToolReadControl';
const token=vi.hoisted(()=>vi.fn(async()=> 'opaque'));
vi.mock('@auth0/auth0-react',()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const e={organization_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',task_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',worker_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',repository:'tu-organizacion/factoria-northlane360',path:'docs/README.md',sha:'a'.repeat(40)};
const leaseId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const grantId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const invocation='ffffffff-ffff-4fff-8fff-ffffffffffff';
let enabled=true,lease:unknown=null,grants:unknown[]=[],history:unknown[]=[];
let posts:{url:string;body:Record<string,string>}[]=[];
let readError=false;
let reviewBlocked=false;
let reviewState="outcome_unconfirmed";
const expiry=()=>new Date(Date.now()+600000).toISOString();
const respond=(x:unknown,status=200)=>Promise.resolve(new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json'}}));
const server=vi.fn((input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
 const url=String(input);
 if(init?.method==='POST'){
  const body=JSON.parse(String(init.body));posts.push({url,body});
  if(url.endsWith('/lease')){lease={lease_id:leaseId,worker_id:e.worker_id,state:'held',usable:true,expires_at:expiry()};return respond({organization_id:e.organization_id,task_id:e.task_id,lease});}
  if(url.endsWith('/github-read-grants')){grants=[{grant_id:grantId,lease_id:leaseId,repository:e.repository,path:e.path,sha:e.sha,state:'approved',unexpired_approval:true,expires_at:expiry()}];return respond({organization_id:e.organization_id,task_id:e.task_id,grant_id:grantId,read_only:true,single_use:true});}
  if(url.endsWith('/github-reads')){
   if(readError)return respond({detail:{code:'completion_unconfirmed'}},503);
   grants=[];history=[{invocation_id:invocation,status:'completed',claimed_at:new Date().toISOString(),size_bytes:12,error_code:null}];
   return respond({invocation_id:invocation,status:'completed',sent_to_model:false,document:{repository:e.repository,path:e.path,sha:e.sha,source_verified:true,read_only:true,content:'<script>unsafe()</script>'}});
  }
  if(url.endsWith('/lease/review')){lease={lease_id:leaseId,worker_id:e.worker_id,state:'held',usable:true,expires_at:expiry()};reviewBlocked=false;return respond({organization_id:e.organization_id,task_id:e.task_id,previous_lease_id:body.previous_lease_id,lease_id:leaseId,execution_started:false,requires_fresh_tool_approval:true});}
  if(url.endsWith('/lease/release')){lease={lease_id:leaseId,worker_id:e.worker_id,state:'released',usable:false,expires_at:expiry()};return respond({lease_id:leaseId,state:'released'});}
 }
 if(url.endsWith('/github-read-review'))return respond({organization_id:e.organization_id,task_id:e.task_id,state:reviewBlocked?reviewState:'lease_held',message:reviewBlocked?'Resultado sin confirmar. Requiere revisión.':'Estado consultado.',suspend_new_actions:reviewBlocked,review_required:reviewBlocked,advisory_only:true});
 if(url.endsWith('/github-tool-capability'))return respond({organization_id:e.organization_id,enabled,storage_ready:true,source_configured:true,lease_review_ready:true});
 if(url.endsWith('/lease'))return respond({organization_id:e.organization_id,task_id:e.task_id,lease});
 if(url.endsWith('/github-read-grants'))return respond(grants);
 if(url.endsWith('/github-reads'))return respond(history);
 return respond({},404);
});
const defaultHandler=server.getMockImplementation()!;
beforeEach(()=>{server.mockImplementation(defaultHandler);enabled=true;lease=null;grants=[];history=[];posts=[];readError=false;reviewBlocked=false;reviewState="outcome_unconfirmed";server.mockClear();token.mockClear();vi.stubGlobal('fetch',server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const update=()=>fireEvent.click(screen.getByRole('button',{name:'Actualizar estado e historial'}));
async function reachGrant(){
 render(<GitHubToolReadControl evidence={e}/>);update();
 fireEvent.click(await screen.findByRole('button',{name:/1\. Reservar/}));
 fireEvent.click(await screen.findByRole('button',{name:/2\. Autorizar/}));
 return screen.findByRole('button',{name:/3\. Ejecutar/});
}
describe('owner document read flow',()=>{
 it('requires three explicit actions and renders untrusted text without HTML',async()=>{
  const button=await reachGrant();
  expect(posts.map(x=>x.url.split('/').at(-1))).toEqual(['lease','github-read-grants']);
  fireEvent.click(button);
  expect(await screen.findByText('<script>unsafe()</script>')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(posts.filter(x=>x.url.endsWith('/github-reads'))).toHaveLength(1);
  expect(posts.at(-1)?.body).toMatchObject({grant_id:grantId,lease_id:leaseId,worker_id:e.worker_id,repository:e.repository,path:e.path,expected_sha:e.sha});
  expect(token.mock.calls.some(args=>(args as unknown as [{authorizationParams:{scope:string}}])[0]?.authorizationParams.scope==='read:tasks create:tasks')).toBe(true);
  expect(screen.queryByRole('button',{name:/3\. Ejecutar/})).toBeNull();
 });
 it('does not mutate anything when the operator has not enabled the tool',async()=>{
  enabled=false;render(<GitHubToolReadControl evidence={e}/>);update();
  expect(await screen.findByText(/todavía no está habilitada/)).toBeTruthy();
  expect(posts).toHaveLength(0);
  expect(screen.queryByRole('button',{name:/1\. Reservar/})).toBeNull();
 });
 it('does not retry after an uncertain result, including after a state refresh',async()=>{
  const button=await reachGrant();readError=true;fireEvent.click(button);
  expect(await screen.findByText(/No se pudo confirmar la operación/)).toBeTruthy();
  update();await waitFor(()=>expect(screen.queryByText('Comprobando…')).toBeNull());
  expect(posts.filter(x=>x.url.endsWith('/github-reads'))).toHaveLength(1);
  expect(screen.queryByRole('button',{name:/3\. Ejecutar/})).toBeNull();
 });
 it('recovers an existing lease without trying to reserve the task again',async()=>{
  lease={lease_id:leaseId,worker_id:e.worker_id,state:'held',usable:true,expires_at:expiry()};
  render(<GitHubToolReadControl evidence={e}/>);update();
  expect(await screen.findByRole('button',{name:/2\. Autorizar/})).toBeTruthy();
  expect(posts).toHaveLength(0);
  expect(screen.queryByRole('button',{name:/1\. Reservar/})).toBeNull();
 });
 it('requires review of released or expired leases',async()=>{
  lease={lease_id:leaseId,worker_id:e.worker_id,state:'released',usable:false,expires_at:expiry()};
  render(<GitHubToolReadControl evidence={e}/>);update();
  expect(await screen.findByText(/requiere revisión/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:/2\. Autorizar/})).toBeNull();
 });
 it('suppresses duplicate clicks while dispatch is in progress',async()=>{
  const button=await reachGrant();
  let resolve!:(r:Response)=>void;
  const original=server.getMockImplementation()!;
  server.mockImplementation((url,init)=>init?.method==='POST'&&String(url).endsWith('/github-reads')?new Promise(r=>{resolve=r;posts.push({url:String(url),body:JSON.parse(String(init.body))});}):original(url,init));
  fireEvent.click(button);fireEvent.click(button);
  await waitFor(()=>expect(posts.filter(x=>x.url.endsWith('/github-reads'))).toHaveLength(1));
  resolve(new Response(JSON.stringify({detail:'failed'}),{status:502}));
  expect(await screen.findByText(/No se pudo confirmar/)).toBeTruthy();
 });
 it('blocks new actions for an unconfirmed result recovered from the journal',async()=>{
  reviewBlocked=true;lease={lease_id:leaseId,worker_id:e.worker_id,state:'held',usable:true,expires_at:expiry()};
  render(<GitHubToolReadControl evidence={e}/>);update();
  expect(await screen.findByText('Resultado sin confirmar. Requiere revisión.')).toBeTruthy();
  expect(screen.queryByRole('button',{name:/2\. Autorizar/})).toBeNull();
  expect(screen.queryByRole('button',{name:'Liberar reserva'})).toBeNull();
  expect(posts).toHaveLength(0);
 });
 it('clears action readiness when a review refresh cannot be confirmed',async()=>{
  await reachGrant();
  server.mockImplementation((url,init)=>String(url).endsWith('/github-read-review')?respond({},503):defaultHandler(url,init));
  update();
  expect(await screen.findByText(/No se pudo confirmar la operación/)).toBeTruthy();
  expect(screen.queryByRole('button',{name:/3\. Ejecutar/})).toBeNull();
  expect(posts.filter(x=>x.url.endsWith('/github-reads'))).toHaveLength(0);
 });
 it('requires a reason and explicit acknowledgement before a reviewed reservation',async()=>{
  reviewBlocked=true;reviewState='released_requires_review';lease={lease_id:leaseId,worker_id:e.worker_id,state:'released',usable:false,expires_at:expiry()};
  render(<GitHubToolReadControl evidence={e}/>);update();
  const renew=await screen.findByRole('button',{name:'Registrar revisión y crear nueva reserva'});
  expect((renew as HTMLButtonElement).disabled).toBe(true);expect(posts).toHaveLength(0);
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'Previous result confirmed; reserve again'}});
  expect((renew as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(renew);
  expect(await screen.findByRole('button',{name:/2\. Autorizar/})).toBeTruthy();
  expect(posts.map(x=>x.url.split('/').at(-1))).toEqual(['review']);
  expect(posts[0].body.previous_lease_id).toBe(leaseId);
  expect(screen.queryByRole('button',{name:/3\. Ejecutar/})).toBeNull();
 });
 it('does not offer renewal when an invocation outcome is unknown',async()=>{
  reviewBlocked=true;lease={lease_id:leaseId,worker_id:e.worker_id,state:'released',usable:false,expires_at:expiry()};
  render(<GitHubToolReadControl evidence={e}/>);update();
  expect(await screen.findByText('Resultado sin confirmar. Requiere revisión.')).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Registrar revisión y crear nueva reserva'})).toBeNull();
  expect(posts).toHaveLength(0);
 });
 it('aborts pending UI requests when the company/task panel unmounts',async()=>{
  let signal:AbortSignal|undefined;
  server.mockImplementation((_url,init)=>{signal=init?.signal as AbortSignal;return new Promise(()=>{});});
  const view=render(<GitHubToolReadControl evidence={e}/>);update();
  await waitFor(()=>expect(signal).toBeTruthy());view.unmount();
  expect(signal?.aborted).toBe(true);expect(posts).toHaveLength(0);
 });
});

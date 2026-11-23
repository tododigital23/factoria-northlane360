// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {SavedPlanDispatch} from '../src/SavedPlanDispatch';
const {token}=vi.hoisted(()=>({token:vi.fn(async()=> 'opaque')}));
vi.mock('@auth0/auth0-react',()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
vi.mock('../src/GitHubToolReadControl',()=>({GitHubToolReadControl:()=> <div>Control de reserva</div>}));
vi.mock('../src/DurableDocumentControl',()=>({DurableDocumentControl:(p:any)=> <div>Cola del plan {p.planId} permiso {p.approvalId||'ninguno'}</div>}));
const org='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',task='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id='cccccccc-cccc-4ccc-8ccc-cccccccccccc',worker='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const e={organization_id:org,task_id:task,worker_id:worker,repository:'Nova/project',path:'docs/CI.md',ref:'live',sha:'a'.repeat(40)};
const objective='Revisar la documentación';const queued=vi.fn(),server=vi.fn();
const props={evidence:e,planId:id,objective,onQueued:queued};
const plan=()=>({...e,id,objective,version:'document_plan_v1',max_jobs:1,estimated_token_units:2500,owner_is_creator:true,scope_current:true,control_available:true,control_state:'active',job_id:null,run_id:null,job_state:null});
let objectiveSupported=false;
let change:Record<string,unknown>,approvals:any[],posts:any[],lost:boolean;
const reply=(raw:unknown)=>Promise.resolve(new Response(JSON.stringify(raw),{status:200}));
beforeEach(()=>{change={};objectiveSupported=false;approvals=[];posts=[];lost=false;queued.mockClear();server.mockReset();server.mockImplementation((url:string,options:any)=>{
 if(options?.method==='POST'){
  posts.push({url,body:JSON.parse(options.body)});const approval={...e,id,worker_id:worker,state:'approved',expires_at:'2099-11-07T18:00:00Z'};approvals=[approval];
  return lost?Promise.reject(Error('lost')):reply({...approval,approval_id:id,organization_id:org,task_id:task,provider_called:false});
 }
 if(url.endsWith('/document-plans'))return reply({organization_id:org,task_id:task,enabled:true,provider_called:false,execution_started:false,plans:[{...plan(),...change}]});
 if(url.endsWith('/document-approvals'))return reply(approvals);
 if(url.endsWith('/durable-document-capability'))return reply({organization_id:org,capability:'durable_document_analysis_v1',provider_called:false,plan_objective_supported:objectiveSupported});
 if(url.endsWith('/documentary-capability'))return reply({organization_id:org,enabled:true,capability:'document_analysis_v1',source_scope:'one_github_file_exact_sha',requires_fresh_document_approval:true,external_tools_enabled:false,store_at_provider:false});
 throw Error('Unexpected endpoint');
 });vi.stubGlobal('fetch',server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
async function load(){render(<SavedPlanDispatch {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Comprobar plan y permisos actuales'}));await screen.findByText('Control de reserva');}
it('does nothing on mount, then reads only plan metadata and authorizations',async()=>{
 render(<SavedPlanDispatch {...props}/>);expect(server).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Comprobar plan y permisos actuales'}));await screen.findByText('Control de reserva');expect(posts).toHaveLength(0);expect(queued).not.toHaveBeenCalled();expect(screen.getByText(/no se enviará el objetivo del plan/)).toBeTruthy();
});
it.each([{control_state:'paused'},{control_state:'cancelled'},{scope_current:false},{owner_is_creator:false},{job_id:id},{sha:'b'.repeat(40)},{worker_id:id},{objective:'Objetivo diferente'},{task_id:id},{control_available:false}])('blocks unavailable or mismatched plans %j',async changed=>{
 change=changed;render(<SavedPlanDispatch {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Comprobar plan y permisos actuales'}));await screen.findByRole('alert');expect(screen.queryByText('Control de reserva')).toBeNull();expect(posts).toHaveLength(0);
});
it('prepares one exact authorization only after confirmation and recovers it before exposing queue controls',async()=>{
 await load();expect((screen.getByRole('button',{name:'Autorizar documento del plan'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('checkbox'));const b=screen.getByRole('button',{name:'Autorizar documento del plan'});fireEvent.click(b);fireEvent.click(b);
 await screen.findByText('Cola del plan '+id+' permiso '+id);expect(posts).toHaveLength(1);expect(posts[0].body).toMatchObject({worker_id:worker,repository:e.repository,path:e.path,expected_sha:e.sha});expect(posts[0].body.plan_id).toBeUndefined();expect(posts[0].url.endsWith('/document-approvals')).toBe(true);expect(queued).not.toHaveBeenCalled();
});
it('does not repeat an authorization after an uncertain response and can recover it through GET',async()=>{
 lost=true;await load();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Autorizar documento del plan'}));await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Comprobar plan y permisos actuales'}));await screen.findByText('Cola del plan '+id+' permiso '+id);expect(posts).toHaveLength(1);
});
it('rechecks persisted state immediately before authorization',async()=>{
 await load();change={control_state:'paused'};fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Autorizar documento del plan'}));await screen.findByRole('alert');expect(posts).toHaveLength(0);
});
it('does not use an authorization for another SHA',async()=>{
 approvals=[{...e,id,state:'approved',sha:'b'.repeat(40),expires_at:'2099-11-07T18:00:00Z'}];await load();expect(screen.getByText('Cola del plan '+id+' permiso ninguno')).toBeTruthy();
});
it('aborts reads and ignores stale results after unmount',async()=>{
 let finish!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>finish=r));const v=render(<SavedPlanDispatch {...props}/>);fireEvent.click(screen.getByRole('button',{name:'Comprobar plan y permisos actuales'}));await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));v.unmount();finish(new Response('{}'));await waitFor(()=>expect(server.mock.calls[0][1].signal.aborted).toBe(true));expect(queued).not.toHaveBeenCalled();expect(server).toHaveBeenCalledTimes(1);
});

it('offers optional objective consent only when the server confirms capability',async()=>{
 objectiveSupported=true;await load();const box=screen.getByRole('checkbox',{name:/Incluir el objetivo guardado/});expect((box as HTMLInputElement).checked).toBe(false);fireEvent.click(box);expect(screen.getByText('Modo elegido: informe orientado al objetivo aprobado.')).toBeTruthy();expect(posts).toHaveLength(0);
});

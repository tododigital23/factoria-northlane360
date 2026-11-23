// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {ObjectivePlanning} from '../src/ObjectivePlanning';
const {token}=vi.hoisted(()=>({token:vi.fn(async()=> 'opaque')}));
vi.mock('@auth0/auth0-react',()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const org='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',dept='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',worker='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
const mission='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const server=vi.fn(),saved=vi.fn();let posts:any[],lost:boolean,wrong:boolean,inactive:boolean,documentsBad:boolean;
let generative:boolean;
const response=(data:unknown)=>new Response(JSON.stringify(data));
function result(body:any){return {organization_id:org,request_key:body.request_key,mission_id:mission,atomic_save:true,provider_called:false,source_fetched:false,execution_started:false,permissions_granted:false,budget_reserved:false,steps:body.steps.map((s:any,i:number)=>({position:i+1,task_id:ids[i*2],plan_id:wrong?ids[1]:ids[i*2+1],worker_id:s.worker_id}))};}
beforeEach(()=>{
 posts=[];lost=false;wrong=false;inactive=false;documentsBad=false;generative=false;saved.mockClear();token.mockClear();server.mockReset();
 server.mockImplementation(async(url:string,options:any)=>{
  if(url.endsWith('/objective-planning/propose')){const body=JSON.parse(options.body);return response({organization_id:org,objective:body.objective,step_count:2,steps:[{title:'Analizar el objetivo',deliverable:'Preparar un diagnóstico documental',acceptance:'Cada punto debe citar evidencia'},{title:'Evaluar mejoras',deliverable:'Proponer mejoras documentales concretas',acceptance:'Cada propuesta incluye su límite'}],proposal_mode:'generative_documentary',provider_called:true,source_fetched:false,tasks_created:false,execution_started:false,requires_owner_review:true,quota_reserved_units:10000,quota_is_currency:false});}
  if(options?.method==='POST'){const body=JSON.parse(options.body);posts.push(body);if(lost)throw Error('lost');return response(result(body));}
  if(url.endsWith('/execution/objective-planning'))return response({organization_id:org,enabled:true,generative_proposal_available:generative,min_steps:2,max_steps:5,proposal_mode:'guided_documentary',provider_called:false,execution_started:false,sources:[{repository:'Nova/project',ref:'ci',prefix:'docs/'}]});
  if(url.endsWith('/departments'))return response([{id:dept,name:'Desarrollo'}]);
  if(url.endsWith('/workers'))return response([{id:worker,name:'Programador IA',department_id:dept,state:inactive?'inactive':'idle'}]);
  if(url.includes('/sources/github/documents'))return response({organization_id:org,repository:'Nova/project',read_only:true,sent_to_model:false,documents:[{path:documentsBad?'private/CI.md':'docs/CI.md',sha:'a'.repeat(40),name:'CI.md',size:45}]});
  throw Error('Unexpected URL '+url);
 });vi.stubGlobal('fetch',server);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=()=>render(<ObjectivePlanning companyId={org} role="owner" onSaved={saved}/>);
async function prepare(){
 view();const input=await screen.findByLabelText('Objetivo de la empresa');
 fireEvent.change(input,{target:{value:'Mejorar la documentación técnica del proyecto'}});
 fireEvent.click(screen.getByText('Preparar propuesta guiada'));
 fireEvent.change(screen.getByLabelText('Repositorio autorizado'),{target:{value:'0'}});
 fireEvent.click(screen.getByText('Consultar documentos autorizados'));
 await waitFor(()=>expect(screen.getAllByRole('option',{name:/docs\/CI.md/})).toHaveLength(2));
 for(const n of [1,2]){
  fireEvent.change(screen.getByLabelText('Departamento del paso '+n),{target:{value:dept}});
  fireEvent.change(screen.getByLabelText('Responsable del paso '+n),{target:{value:worker}});
  fireEvent.change(screen.getByLabelText('Documento del paso '+n),{target:{value:'docs/CI.md'}});
 }
 return screen.getByRole('button',{name:'Guardar tareas y misión'});
}
it('prepares only after owner input and never writes on mount or proposal',async()=>{
 const button=await prepare();expect(posts).toHaveLength(0);expect((button as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByText(/informes anteriores no se transfieren/)).toBeTruthy();
});
it('requires review, clears it on edits and saves exactly once with strict payload',async()=>{
 const button=await prepare();fireEvent.click(screen.getByRole('checkbox'));
 fireEvent.change(screen.getByLabelText('Título del paso 1'),{target:{value:'Diagnóstico revisado'}});
 expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('checkbox'));
 fireEvent.click(button);fireEvent.click(button);await screen.findByText(/Conjunto guardado/);
 expect(posts).toHaveLength(1);expect(saved).toHaveBeenCalledTimes(1);
 expect(posts[0].steps[0]).toMatchObject({title:'Diagnóstico revisado',worker_id:worker,department_id:dept,repository:'Nova/project',ref:'ci',path:'docs/CI.md',sha:'a'.repeat(40)});
 expect(Object.keys(posts[0].steps[0]).sort()).toEqual(['acceptance','deliverable','department_id','path','ref','repository','sha','title','worker_id']);
});
it('freezes an uncertain save and retries identical payload and request key',async()=>{
 lost=true;const button=await prepare();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(button);
 await screen.findByRole('alert');expect(screen.getByLabelText('Objetivo de la empresa').matches(':disabled')).toBe(true);
 lost=false;fireEvent.click(screen.getByText('Reintentar la misma solicitud'));await screen.findByText(/Conjunto guardado/);
 expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);
});
it('rejects duplicate or mismatched persisted references',async()=>{
 wrong=true;const button=await prepare();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(button);
 await screen.findByRole('alert');expect(saved).not.toHaveBeenCalled();expect(screen.queryByText(/Conjunto guardado/)).toBeNull();
});
it('does not offer inactive workers as execution-ready assignees',async()=>{
 inactive=true;view();fireEvent.change(await screen.findByLabelText('Objetivo de la empresa'),{target:{value:'Revisar un objetivo documental'}});fireEvent.click(screen.getByText('Preparar propuesta guiada'));
 fireEvent.change(screen.getByLabelText('Departamento del paso 1'),{target:{value:dept}});
 expect(screen.queryByRole('option',{name:'Programador IA'})).toBeNull();expect(posts).toHaveLength(0);
});
it('does not load or write for a non-owner',()=>{
 render(<ObjectivePlanning companyId={org} role="member" onSaved={saved}/>);expect(server).not.toHaveBeenCalled();
});
it('clears the company draft and ignores a late save after unmount',async()=>{
 const button=await prepare();let finish!:(r:Response)=>void;
 server.mockImplementationOnce((_url,options)=>{posts.push(JSON.parse(options.body));return new Promise<Response>(r=>finish=r);});
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(button);await waitFor(()=>expect(posts).toHaveLength(1));
 cleanup();finish(response(result(posts[0])));await new Promise(r=>setTimeout(r,0));expect(saved).not.toHaveBeenCalled();
 const last=server.mock.calls.at(-1)!;expect(last[1].signal.aborted).toBe(true);
});
it('rejects documents outside the configured folder before enabling save',async()=>{
 documentsBad=true;view();fireEvent.change(await screen.findByLabelText('Objetivo de la empresa'),{target:{value:'Revisar un objetivo documental'}});fireEvent.click(screen.getByText('Preparar propuesta guiada'));
 fireEvent.change(screen.getByLabelText('Repositorio autorizado'),{target:{value:'0'}});fireEvent.click(screen.getByText('Consultar documentos autorizados'));
 await screen.findByRole('alert');expect(posts).toHaveLength(0);expect((screen.getByText('Guardar tareas y misión') as HTMLButtonElement).disabled).toBe(true);
});
it('fills generated text but still requires real assignments, documents and separate save review',async()=>{
 generative=true;view();fireEvent.change(await screen.findByLabelText('Objetivo de la empresa'),{target:{value:'Mejorar la documentación técnica del proyecto'}});
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByText('Generar propuesta con IA'));
 await screen.findByDisplayValue('Analizar el objetivo');expect(posts).toHaveLength(0);expect(saved).not.toHaveBeenCalled();
 expect((screen.getByLabelText('Departamento del paso 1') as HTMLSelectElement).value).toBe('');
 expect((screen.getByLabelText('Responsable del paso 1') as HTMLSelectElement).value).toBe('');
 expect((screen.getByLabelText('Documento del paso 1') as HTMLSelectElement).value).toBe('');
 expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
 expect((screen.getByText('Guardar tareas y misión') as HTMLButtonElement).disabled).toBe(true);
});

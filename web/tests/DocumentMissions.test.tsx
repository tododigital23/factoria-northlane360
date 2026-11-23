// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {DocumentMissions} from '../src/DocumentMissions';
const {token}=vi.hoisted(()=>({token:vi.fn(async()=> 'opaque')}));
vi.mock('@auth0/auth0-react',()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
vi.mock('../src/SavedPlanDispatch',()=>({SavedPlanDispatch:(p:any)=><div>Preparación de {p.planId}</div>}));
vi.mock('../src/MissionDelivery',()=>({MissionDelivery:()=> <div>Expediente exacto consultado</div>}));
vi.mock('../src/StoredReport',()=>({StoredReport:()=> <div>Informe del paso</div>}));
const org='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',mid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const p1='cccccccc-cccc-4ccc-8ccc-cccccccccccc',p2='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const t1='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',t2='ffffffff-ffff-4fff-8fff-ffffffffffff';
const objective='Coordinar los documentos seleccionados';
const plans=[{plan_id:p1,task_id:t1,task_title:'Tarea uno',objective:'Objetivo uno',path:'docs/one.md',worker_name:'Trabajador uno',state:'prepared',can_control:true},{plan_id:p2,task_id:t2,task_title:'Tarea dos',objective:'Objetivo dos',path:'docs/two.md',worker_name:'Trabajador dos',state:'prepared',can_control:true}];
const make=()=>({id:mid,objective,created_at:'2026-11-08T10:00:00Z',owner_is_creator:true,max_jobs:2,estimated_token_units:5000,state:'prepared',accepted_steps:0,steps:plans.map((p,i)=>({position:i+1,...p,worker_id:p1,repository:'Nova/project',ref:'live',sha:'a'.repeat(40),job_id:null,run_id:null,job_state:null,review_decision:null,state:i===0?'ready':'waiting',can_prepare:i===0}))});
const response=(missions:any[]=[],enabled=true)=>({organization_id:org,enabled,read_only:true,provider_called:false,execution_started:false,limit:20,not_full_company_census:true,missions});
const server=vi.fn(),queued=vi.fn();let records:any[],enabled:boolean,lost:boolean,posts:any[];
beforeEach(()=>{records=[];enabled=true;lost=false;posts=[];server.mockReset();queued.mockClear();server.mockImplementation(async(_url,options)=>{
 if(options?.method==='POST'){posts.push(JSON.parse(options.body));records=[make()];if(lost)throw Error('lost');return new Response(JSON.stringify({organization_id:org,mission_id:mid,provider_called:false,execution_started:false,task_completed:false}));}
 return new Response(JSON.stringify(response(records,enabled)));
 });vi.stubGlobal('fetch',server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const view=()=>render(<DocumentMissions companyId={org} plans={plans} onQueued={queued}/>);
async function prepare(){view();await screen.findByText(/Últimos 0 planes/);fireEvent.click(screen.getByText('Preparar un plan de varios trabajos'));fireEvent.change(screen.getByLabelText('Objetivo global'),{target:{value:objective}});fireEvent.change(screen.getByLabelText('Paso 1'),{target:{value:p1}});fireEvent.change(screen.getByLabelText('Paso 2'),{target:{value:p2}});fireEvent.click(screen.getByRole('checkbox'));return screen.getByRole('button',{name:'Guardar plan de varios trabajos'});}
it('only reads on mount and distinguishes missing storage from empty activity',async()=>{
 enabled=false;view();await screen.findByText(/actualización administrativa 030/);expect(posts).toHaveLength(0);expect(screen.queryByText(/Últimos 0 planes/)).toBeNull();
});
it('requires ordered choices and confirmation, saves once and confirms through readback',async()=>{
 const b=await prepare();fireEvent.click(b);fireEvent.click(b);await screen.findByText(/guardado y recuperado/);expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({objective,plan_ids:[p1,p2]});expect(posts[0].request_key).toMatch(/^[0-9a-f-]{36}$/);expect(queued).not.toHaveBeenCalled();
});
it('does not select two plans from the same task',async()=>{
 render(<DocumentMissions companyId={org} plans={[plans[0],{...plans[1],task_id:t1}]} onQueued={queued}/>);await screen.findByText(/Últimos 0 planes/);fireEvent.click(screen.getByText('Preparar un plan de varios trabajos'));fireEvent.change(screen.getByLabelText('Objetivo global'),{target:{value:objective}});fireEvent.change(screen.getByLabelText('Paso 1'),{target:{value:p1}});fireEvent.change(screen.getByLabelText('Paso 2'),{target:{value:p2}});fireEvent.click(screen.getByRole('checkbox'));expect((screen.getByRole('button',{name:'Guardar plan de varios trabajos'}) as HTMLButtonElement).disabled).toBe(true);
});
it('does not retry an uncertain save and recovers persisted missions through GET',async()=>{
 lost=true;const b=await prepare();fireEvent.click(b);await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Actualizar planes de varios trabajos'}));await screen.findByRole('heading',{name:objective});expect(posts).toHaveLength(1);expect((screen.getByRole('button',{name:'Guardar plan de varios trabajos'}) as HTMLButtonElement).disabled).toBe(true);
});
it('only opens the eligible first step, without queueing',async()=>{
 records=[make()];view();const b=await screen.findByRole('button',{name:'Preparar paso 1'});expect(screen.queryByRole('button',{name:'Preparar paso 2'})).toBeNull();fireEvent.click(b);expect(screen.getByText('Preparación de '+p1)).toBeTruthy();expect(posts).toHaveLength(0);expect(queued).not.toHaveBeenCalled();
});
it('rejects an invented second-step readiness',async()=>{
 const m=make();m.steps[1].can_prepare=true;m.steps[1].state='ready';records=[m];view();await screen.findByRole('alert');expect(screen.queryByRole('button',{name:'Preparar paso 2'})).toBeNull();
});
it('rejects invented acceptance without a completed exact run',async()=>{
 const m=make();m.steps[0].state='accepted';m.accepted_steps=1;records=[m];view();await screen.findByRole('alert');expect(screen.queryByRole('heading',{name:objective})).toBeNull();
});
it('aborts late company responses on unmount',async()=>{
 let done!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>done=r));const v=view();await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));v.unmount();done(new Response(JSON.stringify(response([make()]))));await waitFor(()=>expect(server.mock.calls[0][1].signal.aborted).toBe(true));expect(queued).not.toHaveBeenCalled();
});

const withControl=(state:'active'|'paused'|'cancelled'='active',revision=0)=>{
 const m:any=make();Object.assign(m,{mission_control_available:true,mission_control_state:state,mission_control_revision:revision,last_control:revision?{action:state==='active'?'resume':state==='paused'?'pause':'cancel',reason:'Global mission control recorded','created_at':'2026-11-08T12:00:00Z'}:null,can_control:state!=='cancelled'});
 if(state!=='active'){m.state=state;m.steps.forEach((s:any)=>{if(s.job_id===null){s.state=state;s.can_prepare=false;}});}return m;
};
function controlServer({fail=false,wrong=false,readbackFail=false}={}){
 server.mockImplementation(async(url,options)=>{
  if(url.endsWith('/control')){const b=JSON.parse(options.body);posts.push(b);records=[withControl(b.action==='pause'?'paused':b.action==='resume'?'active':'cancelled',b.expected_revision+1)];if(fail)throw Error('lost');return new Response(JSON.stringify({organization_id:org,mission_id:mid,action_id:p1,recorded_state:records[0].mission_control_state,recorded_revision:records[0].mission_control_revision,provider_called:false,execution_started:false,existing_jobs_stopped:wrong,task_completed:false}));}
  if(readbackFail&&posts.length)throw Error('read unavailable');
  return new Response(JSON.stringify({...response(records),mission_controls_available:true}));
 });
}
async function fillControl(){
 fireEvent.click(await screen.findByText('Controlar próximos envíos del plan completo'));
 fireEvent.change(screen.getByLabelText('Motivo del control global'),{target:{value:'Pause future dispatches for review'}});
 fireEvent.click(screen.getByLabelText(/Confirmo: .* de este plan/));
}
it('shows missing global migration while preserving individual plan preparation',async()=>{
 records=[make()];view();await screen.findByText(/actualización administrativa 031/);expect(await screen.findByRole('button',{name:'Preparar paso 1'})).toBeTruthy();expect(screen.queryByText('Controlar próximos envíos del plan completo')).toBeNull();expect(posts).toHaveLength(0);
});
it('requires explicit global control consent and reads back the exact revision',async()=>{
 records=[withControl()];controlServer();view();await screen.findByText('Controlar próximos envíos del plan completo');
 fireEvent.click(screen.getByText('Controlar próximos envíos del plan completo'));const b=screen.getByRole('button',{name:'Pausar próximos envíos'});expect((b as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Motivo del control global'),{target:{value:'Pause future dispatches for review'}});fireEvent.click(screen.getByLabelText(/Confirmo: .* de este plan/));fireEvent.click(b);fireEvent.click(b);
 await screen.findByText(/Control global: Próximos envíos pausados/);expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({action:'pause',expected_revision:0,reason:'Pause future dispatches for review'});expect(screen.queryByRole('button',{name:'Preparar paso 1'})).toBeNull();expect(queued).not.toHaveBeenCalled();
});
it.each([{fail:true},{wrong:true},{readbackFail:true}])('does not retry an uncertain global control: %j',async opts=>{
 records=[withControl()];controlServer(opts);view();await fillControl();const b=screen.getByRole('button',{name:'Pausar próximos envíos'});fireEvent.click(b);await screen.findByRole('alert');expect(posts).toHaveLength(1);expect(screen.queryByRole('button',{name:'Preparar paso 1'})).toBeNull();expect((b as HTMLButtonElement).disabled).toBe(true);fireEvent.click(b);expect(posts).toHaveLength(1);expect(queued).not.toHaveBeenCalled();
});
it('cancellation preserves completed report access and disables future preparation',async()=>{
 const m=withControl('cancelled',1);m.steps[0].job_id=p1;m.steps[0].run_id=p2;m.steps[0].job_state='completed';m.steps[0].state='awaiting_review';records=[m];controlServer();view();await screen.findByText(/Próximos envíos cancelados/);expect(screen.queryByText('Controlar próximos envíos del plan completo')).toBeNull();expect(screen.queryByRole('button',{name:/Preparar paso/})).toBeNull();expect(screen.getByRole('button',{name:'Ver informe del paso 1'})).toBeTruthy();expect(posts).toHaveLength(0);
});
it('resume does not send or open step two before acceptance',async()=>{
 records=[withControl('paused',1)];controlServer();view();await fillControl();fireEvent.click(screen.getByRole('button',{name:'Reanudar próximos envíos'}));await screen.findByRole('button',{name:'Preparar paso 1'});expect(screen.queryByRole('button',{name:'Preparar paso 2'})).toBeNull();expect(posts).toHaveLength(1);expect(posts[0].action).toBe('resume');expect(queued).not.toHaveBeenCalled();
});
it('rejects forged readiness while global mission is paused',async()=>{
 const m=withControl('paused',1);m.steps[0].can_prepare=true;records=[m];controlServer();view();await screen.findByRole('alert');expect(screen.queryByRole('button',{name:/Preparar paso/})).toBeNull();expect(screen.queryByText('Controlar próximos envíos del plan completo')).toBeNull();
});
it('rejects global controls with missing immutable history',async()=>{
 const m=withControl('paused',1);m.last_control=null;records=[m];controlServer();view();await screen.findByRole('alert');expect(screen.queryByRole('heading',{name:objective})).toBeNull();
});

it('opens the delivery only after all exact reports are accepted, without sending work',async()=>{
 const m:any=make();m.state='accepted';m.accepted_steps=2;m.steps.forEach((s:any,i:number)=>Object.assign(s,{job_id:i?p2:p1,run_id:i?t2:t1,job_state:'completed',review_decision:'accepted',state:'accepted',can_prepare:false}));records=[m];view();const b=await screen.findByRole('button',{name:'Ver expediente de pasos aceptados'});expect(screen.queryByText('Expediente exacto consultado')).toBeNull();fireEvent.click(b);expect(screen.getByText('Expediente exacto consultado')).toBeTruthy();expect(posts).toHaveLength(0);expect(queued).not.toHaveBeenCalled();
});
it('does not offer joint delivery for an unaccepted generated report',async()=>{
 const m:any=make();m.steps[0].job_id=p1;m.steps[0].run_id=t1;m.steps[0].job_state='completed';m.steps[0].state='awaiting_review';m.steps[0].can_prepare=false;m.state='awaiting_review';records=[m];view();await screen.findByRole('heading',{name:objective});expect(screen.queryByRole('button',{name:'Ver expediente de pasos aceptados'})).toBeNull();
});

// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {OperationsOffice,officeMotion,validOffice} from '../src/OperationsOffice';
const {token}=vi.hoisted(()=>({token:vi.fn(async()=> 'opaque')}));
vi.mock('../src/ImmersiveOffice',()=>({ImmersiveOffice:(p:any)=><div>{p.workers.map((w:any)=><button key={w.id} data-moving={w.motionActive&&!p.paused&&p.visible} onClick={()=>p.onSelect('worker:'+w.id)}>{w.name+' · '+({available:'Disponible según configuración',preparing:'Preparando documento',reading:'Fuente verificada',analyzing:'Análisis iniciado'} as any)[w.phase]}</button>)}</div>}));
vi.mock('@auth0/auth0-react',()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const org='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',dept='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',wid='cccccccc-cccc-4ccc-8ccc-cccccccccccc',tid='dddddddd-dddd-4ddd-8ddd-dddddddddddd',jid='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
function snapshot(phase='available'){
 const observed=new Date().toISOString();const moving=['preparing','reading','analyzing'].includes(phase);
 return {organization_id:org,read_only:true,provider_called:false,source_fetched:false,worker_online_verified:false,observed_at:observed,fresh_for_seconds:30,sample:{task_limit:20,tasks_scanned:1,jobs_per_task_limit:20,worker_limit:120,department_limit:40,tasks_truncated:false,workers_truncated:false,departments_truncated:false,not_full_company_census:true,unattributed_job_records:0},departments:[{id:dept,name:'Desarrollo'}],workers:[{id:wid,department_id:dept,name:'Programador IA',specialty:'Documentación',recorded_state:'idle',phase,assigned_tasks_in_sample:1,animation_until:moving?new Date(Date.parse(observed)+30000).toISOString():null,job_id:moving?jid:null,task_id:moving?tid:null,task_title:moving?'Revisar documentación':null}],task_counts_in_sample:{pending:1},job_counts_in_sample:{queued:0,claimed:moving?1:0,source_verified:0,provider_started:0,completed:0,failed:0,cancelled:0,needs_review:0},attention_records_in_sample:0,recent_jobs:[],recent_tasks:[{id:tid,title:'Revisar documentación',status:'pending'}]};
}
const server=vi.fn(),select=vi.fn(),load=vi.fn(),navigate=vi.fn();
const props={companyId:org,companies:[{id:org,name:'Nova',role:'owner'}],onSelectCompany:select,onLoadCompanies:load,onNavigate:navigate,variant:'office' as const};
beforeEach(()=>{server.mockReset();server.mockResolvedValue(new Response(JSON.stringify(snapshot())));load.mockClear();navigate.mockClear();token.mockReset();token.mockResolvedValue('opaque');vi.stubGlobal('fetch',server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('uses only authenticated metadata GETs and shows real idle people without invented work',async()=>{
 const v=render(<OperationsOffice {...props}/>);await screen.findByText('Muestra consultada');expect(server).toHaveBeenCalledTimes(1);expect(server.mock.calls[0][0]).toContain(org+'/execution/office-overview');expect(server.mock.calls[0][1].method).toBeUndefined();expect(v.container.querySelector('[data-moving="true"]')).toBeNull();expect(screen.getByText('Conexión de los trabajadores no verificada')).toBeTruthy();expect(token.mock.calls[0][0].authorizationParams.scope).toBe('read:tasks');
});
it('animates only fresh recorded execution and stops on a failed refresh',async()=>{
 server.mockImplementationOnce(async()=>new Response(JSON.stringify(snapshot('preparing'))));const v=render(<OperationsOffice {...props}/>);await screen.findByText('Muestra consultada');expect(v.container.querySelector('[data-moving="true"]')).toBeTruthy();server.mockRejectedValue(new Error('lost'));fireEvent.click(screen.getByRole('button',{name:'Actualizar datos de la oficina'}));await screen.findByRole('alert');expect(v.container.querySelector('[data-moving="true"]')).toBeNull();expect(screen.getByText('Muestra sin actualización vigente')).toBeTruthy();
});
it('stops cosmetic motion when asked without issuing a worker command',async()=>{
 server.mockImplementationOnce(async()=>new Response(JSON.stringify(snapshot('analyzing'))));const v=render(<OperationsOffice {...props}/>);await screen.findByText('Muestra consultada');fireEvent.click(screen.getByRole('checkbox',{name:'Detener animaciones visuales'}));expect(v.container.querySelector('[data-moving="true"]')).toBeNull();expect(server).toHaveBeenCalledTimes(1);
});
it('can stop automatic reading without stopping real jobs',async()=>{
 server.mockImplementationOnce(async()=>new Response(JSON.stringify(snapshot('preparing'))));const v=render(<OperationsOffice {...props}/>);await screen.findByText('Muestra consultada');fireEvent.click(screen.getByRole('checkbox',{name:'Actualizar cada 20 segundos'}));expect(v.container.querySelector('[data-moving="true"]')).toBeNull();expect(server).toHaveBeenCalledTimes(1);
});
it('suppresses animation while the tab is hidden',async()=>{
 server.mockImplementationOnce(async()=>new Response(JSON.stringify(snapshot('reading'))));const v=render(<OperationsOffice {...props}/>);await screen.findByText('Muestra consultada');vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(v.container.querySelector('[data-moving="true"]')).toBeNull();
});
it('opens a worker inspector with exact metadata and never sends work',async()=>{
 render(<OperationsOffice {...props}/>);await screen.findByText('Muestra consultada');fireEvent.click(screen.getByRole('button',{name:'Programador IA · Disponible según configuración',exact:true}));expect(screen.getByRole('heading',{name:'Programador IA'})).toBeTruthy();expect(screen.getByText(/Estado administrativo: idle/)).toBeTruthy();expect(server).toHaveBeenCalledTimes(1);
});
it('routes the new summary to the office and reports without modifying anything',async()=>{
 render(<OperationsOffice {...props} variant="summary"/>);await screen.findByText('Muestra consultada');fireEvent.click(screen.getByRole('button',{name:'Abrir oficina 3D'}));expect(navigate).toHaveBeenCalledWith('Oficina 3D');expect(screen.queryByRole('group',{name:/Oficina en perspectiva/})).toBeNull();expect(screen.queryByText('En preparación')).toBeNull();
});
it.each(['member','viewer'])('does not query the owner snapshot for %s',async role=>{
 render(<OperationsOffice {...props} companies={[{id:org,name:'Nova',role}]}/>);await screen.findByText(/reservada al propietario/);expect(server).not.toHaveBeenCalled();
});
it('loads company membership once when the initial summary has no selected company',async()=>{
 render(<OperationsOffice {...props} companyId="" companies={[]}/>);await waitFor(()=>expect(load).toHaveBeenCalledTimes(1));expect(server).not.toHaveBeenCalled();
});
it.each(['wrong_company','invented_online','fake_counts','unbound_motion'])('rejects %s without exposing a worker record',async why=>{
 const r=snapshot('preparing');if(why==='wrong_company')r.organization_id=dept;if(why==='invented_online')(r as any).worker_online_verified=true;if(why==='fake_counts')r.task_counts_in_sample.pending=99;if(why==='unbound_motion')r.workers[0].job_id=null;
 server.mockResolvedValue(new Response(JSON.stringify(r)));render(<OperationsOffice {...props}/>);await screen.findByRole('alert');expect(screen.queryByText('Programador IA')).toBeNull();
});
it('aborts and ignores a late response after switching companies',async()=>{
 let finish!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>finish=r));const v=render(<OperationsOffice {...props}/>);await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));const other=dept;server.mockResolvedValue(new Response(JSON.stringify({...snapshot(),organization_id:other,workers:[],departments:[]})));v.rerender(<OperationsOffice {...props} companyId={other} companies={[{id:other,name:'Otra',role:'owner'}]}/>);await screen.findByText('Muestra consultada');finish(new Response(JSON.stringify(snapshot('preparing'))));await waitFor(()=>expect(screen.queryByText('Programador IA')).toBeNull());expect(server.mock.calls[0][1].signal.aborted).toBe(true);
});
it('bounds animation by both relative server expiry and elapsed observation time',()=>{
 const s=snapshot('preparing'),w=s.workers[0] as any;expect(officeMotion(w,s.observed_at,100,true)).toBe(true);expect(officeMotion(w,s.observed_at,30000,true)).toBe(false);expect(officeMotion(w,s.observed_at,100,false)).toBe(false);expect(officeMotion({...w,phase:'available'},s.observed_at,100,true)).toBe(false);expect(officeMotion({...w,animation_until:new Date(Date.parse(s.observed_at)+1000).toISOString()},s.observed_at,1000,true)).toBe(false);expect(validOffice(s,org)).toBe(true);
});

it('keeps the reference-style people rail grounded in real workers and selects without dispatch',async()=>{
 render(<OperationsOffice {...props}/>);await screen.findByText('Muestra consultada');expect(screen.getByText('PERSONAS Y SALAS')).toBeTruthy();expect(screen.getByText('ACTIVIDAD CONSULTADA')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Seleccionar agente Programador IA'}));expect(screen.getByRole('heading',{name:'Programador IA'})).toBeTruthy();expect(screen.getByText(/Estado administrativo: idle/)).toBeTruthy();expect(server).toHaveBeenCalledTimes(1);
});

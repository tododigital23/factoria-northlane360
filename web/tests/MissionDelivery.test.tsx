// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {MissionDelivery,validDelivery} from '../src/MissionDelivery';
vi.mock('@auth0/auth0-react',()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const token=vi.fn(async()=> 'opaque'),fetcher=vi.fn();
const id=(n:number)=>'aaaaaaaa-aaaa-4aaa-8aaa-'+String(n).padStart(12,'0');const org=id(1);
const steps=[1,2].map(i=>({position:i,plan_id:id(10+i),task_id:id(20+i),task_title:'Tarea '+i,worker_id:id(30+i),objective:'Objetivo del paso '+i,job_id:id(40+i),run_id:id(50+i),repository:'Nova/project',path:'docs/CI.md',ref:'live',sha:'a'.repeat(40)}));
const mission={id:id(2),objective:'Coordinar el análisis documental',steps};
const payload=()=>({organization_id:org,mission_id:mission.id,objective:mission.objective,delivery_kind:'accepted_step_reports_v1',global_objective_verified:false,read_only:true,provider_called:false,source_fetched:false,task_completed:false,observed_at:'2026-11-08T12:00:00Z',accepted_steps:2,history_limits:{missions:20,runs_per_task:20,not_full_company_census:true},reports:steps.map(s=>({...s,report:'Informe original del paso '+s.position,started_at:'2026-11-08T10:00:00Z',finished_at:'2026-11-08T10:01:00Z',review:{id:id(60+s.position),decision:'accepted',reason:'Aceptación humana registrada',reviewed_at:'2026-11-08T10:02:00Z'}}))});
beforeEach(()=>{fetcher.mockReset();fetcher.mockResolvedValue(new Response(JSON.stringify(payload())));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('only reads and displays exact original reports and human reviews without global success claims',async()=>{
 render(<MissionDelivery companyId={org} mission={mission}/>);await screen.findByText('Informe original del paso 1');expect(screen.getByText('Informe original del paso 2')).toBeTruthy();expect(screen.getByText(/no acredita por sí sola/)).toBeTruthy();expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][0]).toContain('/'+mission.id+'/delivery');expect(fetcher.mock.calls[0][1].method).toBeUndefined();expect(token).toHaveBeenCalledWith({authorizationParams:{audience:'https://api.eliot.internal',scope:'read:tasks'}});
});
it.each(['company','source','run','review','report','bounds','objective_success','order'])('rejects incompatible delivery evidence: %s',async bad=>{
 const p=payload();if(bad==='company')p.organization_id=id(99);if(bad==='source')p.reports[0].sha='b'.repeat(40);if(bad==='run')p.reports[0].run_id=id(99);if(bad==='review')p.reports[0].review.decision='changes_requested';if(bad==='report')p.reports[0].report='';if(bad==='bounds')p.history_limits.missions=100;if(bad==='objective_success')p.global_objective_verified=true;if(bad==='order')p.reports.reverse();fetcher.mockResolvedValue(new Response(JSON.stringify(p)));
 render(<MissionDelivery companyId={org} mission={mission}/>);await screen.findByRole('alert');expect(screen.queryByText('Informe original del paso 1')).toBeNull();expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not replace missing historical reports or retry automatically',async()=>{
 fetcher.mockResolvedValue(new Response('{}',{status:409}));render(<MissionDelivery companyId={org} mission={mission}/>);await screen.findByRole('alert');expect(fetcher).toHaveBeenCalledTimes(1);
});
it('aborts late delivery responses when leaving the company',async()=>{
 let done!:(r:Response)=>void;fetcher.mockImplementation(()=>new Promise<Response>(r=>done=r));const view=render(<MissionDelivery companyId={org} mission={mission}/>);await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));view.unmount();done(new Response(JSON.stringify(payload())));expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});
it('validates all sources and immutable decisions before rendering',()=>{
 expect(validDelivery(payload(),org,mission)).toBe(true);const p=payload();p.reports[1].review.reviewed_at='2026-11-08T09:00:00Z';expect(validDelivery(p,org,mission)).toBe(false);
});

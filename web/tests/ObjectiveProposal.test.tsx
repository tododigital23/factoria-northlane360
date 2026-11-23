// @vitest-environment jsdom
import React from 'react';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {ObjectiveProposal} from '../src/ObjectiveProposal';
const {token}=vi.hoisted(()=>({token:vi.fn(async()=> 'opaque')}));
vi.mock('@auth0/auth0-react',()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const org='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',objective='Mejorar la documentación del proyecto';
const steps=[{title:'Analizar el alcance',deliverable:'Entregable documental revisable',acceptance:'Criterio concreto y verificable'},{title:'Evaluar recomendaciones',deliverable:'Otro entregable documental',acceptance:'Otro criterio concreto y verificable'}];
const result=()=>({organization_id:org,objective,step_count:2,steps,proposal_mode:'generative_documentary',provider_called:true,source_fetched:false,tasks_created:false,execution_started:false,requires_owner_review:true,quota_reserved_units:10000,quota_is_currency:false});
const server=vi.fn(),proposed=vi.fn(),busy=vi.fn();
const view=()=>render(<ObjectiveProposal companyId={org} objective={objective} onProposed={proposed} onBusy={busy}/>);
beforeEach(()=>{server.mockReset();server.mockResolvedValue(new Response(JSON.stringify(result())));proposed.mockReset();busy.mockReset();token.mockClear();vi.stubGlobal('fetch',server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('does not call the provider on mount and requires separate consent',()=>{
 view();expect(server).not.toHaveBeenCalled();expect((screen.getByText('Generar propuesta con IA') as HTMLButtonElement).disabled).toBe(true);
});
it('sends only exact objective and count, then returns editable fields without saving',async()=>{
 view();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByText('Generar propuesta con IA'));fireEvent.click(screen.getByText('Generando propuesta…'));
 await waitFor(()=>expect(proposed).toHaveBeenCalledWith(steps));expect(server).toHaveBeenCalledTimes(1);
 const [url,options]=server.mock.calls[0];expect(url.endsWith('/objective-planning/propose')).toBe(true);
 expect(JSON.parse(options.body)).toEqual({objective,step_count:2,consent_openai:true});
 expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});
it('changing count or objective invalidates transfer consent',()=>{
 const v=view();fireEvent.click(screen.getByRole('checkbox'));fireEvent.change(screen.getByLabelText('Número de pasos de la propuesta'),{target:{value:'3'}});
 expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
 fireEvent.click(screen.getByRole('checkbox'));v.rerender(<ObjectiveProposal companyId={org} objective="Un objetivo distinto del anterior" onProposed={proposed} onBusy={busy}/>);
 expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);expect(server).not.toHaveBeenCalled();
});
it('does not retry uncertain failures, clears consent and preserves manual fallback',async()=>{
 server.mockRejectedValue(Error('lost'));view();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByText('Generar propuesta con IA'));
 await screen.findByRole('alert');expect(server).toHaveBeenCalledTimes(1);expect(proposed).not.toHaveBeenCalled();
 expect((screen.getByText('Generar propuesta con IA') as HTMLButtonElement).disabled).toBe(true);expect(busy).toHaveBeenLastCalledWith(false);
});
it('rejects foreign scope, unexpected assignment or execution claims',async()=>{
 for(const change of [{organization_id:'other'},{steps:[{...steps[0],worker_id:'invented'},steps[1]]},{tasks_created:true},{step_count:5}]){
  server.mockResolvedValueOnce(new Response(JSON.stringify({...result(),...change})));view();fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByText('Generar propuesta con IA'));
  await screen.findByRole('alert');expect(proposed).not.toHaveBeenCalled();cleanup();
 }
});
it('discards late output after the objective changes and aborts its request',async()=>{
 let resolve!:(r:Response)=>void;server.mockImplementationOnce(()=>new Promise<Response>(r=>resolve=r));const v=view();
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByText('Generar propuesta con IA'));await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));
 v.rerender(<ObjectiveProposal companyId={org} objective="Un objetivo distinto del anterior" onProposed={proposed} onBusy={busy}/>);
 resolve(new Response(JSON.stringify(result())));await new Promise(r=>setTimeout(r,0));expect(proposed).not.toHaveBeenCalled();expect(server.mock.calls[0][1].signal.aborted).toBe(true);
});

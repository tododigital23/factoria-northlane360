// @vitest-environment jsdom
import React from "react";
import {afterEach,beforeEach,it,expect,vi} from "vitest";
import {cleanup,render,screen,fireEvent,waitFor} from "@testing-library/react";
import {DocumentPlanControl} from "../src/DocumentPlanControl";
const {token}=vi.hoisted(()=>({token:vi.fn(async()=>"opaque")}));
vi.mock("@auth0/auth0-react",()=>({useAuth0:()=>({getAccessTokenSilently:token})}));
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",task="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",plan="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const recorded=vi.fn(),server=vi.fn();const props={companyId:id,taskId:task,planId:plan,state:"active" as const,revision:0,scopeCurrent:true,onRecorded:recorded};
const ack={organization_id:id,task_id:task,plan_id:plan,action_id:id,recorded_state:"paused",recorded_revision:1,provider_called:false,execution_started:false,task_completed:false};
beforeEach(()=>{server.mockReset();server.mockImplementation(async()=>new Response(JSON.stringify(ack)));recorded.mockClear();token.mockReset();token.mockResolvedValue("opaque");vi.stubGlobal("fetch",server);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function confirm(){fireEvent.change(screen.getByLabelText('Motivo del cambio'),{target:{value:'Necesitamos revisar el objetivo primero'}});fireEvent.click(screen.getByRole('checkbox'));}
it('never posts on mount and requires a reason plus explicit confirmation',()=>{
 render(<DocumentPlanControl {...props}/>);expect(server).not.toHaveBeenCalled();expect((screen.getByRole('button',{name:'Pausar plan'}) as HTMLButtonElement).disabled).toBe(true);confirm();expect((screen.getByRole('button',{name:'Pausar plan'}) as HTMLButtonElement).disabled).toBe(false);
});
it('posts the exact plan and revision once, then asks its parent to reload',async()=>{
 render(<DocumentPlanControl {...props}/>);confirm();const button=screen.getByRole('button',{name:'Pausar plan'});fireEvent.click(button);fireEvent.click(button);
 await waitFor(()=>expect(recorded).toHaveBeenCalledTimes(1));expect(server).toHaveBeenCalledTimes(1);
 const [url,opts]=server.mock.calls[0];expect(url).toContain('/tasks/'+task+'/execution/document-plans/'+plan+'/control');const body=JSON.parse(opts.body);expect(body.action).toBe('pause');expect(body.expected_revision).toBe(0);expect(body.request_key).toMatch(/^[0-9a-f-]{36}$/);expect(token.mock.calls[0][0].authorizationParams.scope).toContain('create:tasks');
});
it('does not retry an unconfirmed request or report success',async()=>{
 server.mockRejectedValue(new Error('connection lost'));render(<DocumentPlanControl {...props}/>);confirm();fireEvent.click(screen.getByRole('button',{name:'Pausar plan'}));await screen.findByRole('alert');expect(recorded).not.toHaveBeenCalled();expect(server).toHaveBeenCalledTimes(1);expect((screen.getByRole('button',{name:'Pausar plan'}) as HTMLButtonElement).disabled).toBe(true);
});
it('rejects acknowledgements from another plan',async()=>{
 server.mockResolvedValue(new Response(JSON.stringify({...ack,plan_id:task})));render(<DocumentPlanControl {...props}/>);confirm();fireEvent.click(screen.getByRole('button',{name:'Pausar plan'}));await screen.findByRole('alert');expect(recorded).not.toHaveBeenCalled();
});
it('clears confirmation when the selected action changes',()=>{
 render(<DocumentPlanControl {...props}/>);confirm();fireEvent.change(screen.getByLabelText('Acción del plan'),{target:{value:'cancel'}});expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);expect((screen.getByRole('button',{name:'Cancelar plan'}) as HTMLButtonElement).disabled).toBe(true);expect(screen.getByText(/Cancelar es definitivo/)).toBeTruthy();
});
it('prevents resume of a stale plan but still permits explicit cancellation',()=>{
 render(<DocumentPlanControl {...props} state="paused" scopeCurrent={false}/>);confirm();expect((screen.getByRole('button',{name:'Reanudar plan'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByLabelText('Acción del plan'),{target:{value:'cancel'}});fireEvent.click(screen.getByRole('checkbox'));expect((screen.getByRole('button',{name:'Cancelar plan'}) as HTMLButtonElement).disabled).toBe(false);
});
it('ignores a late response after the plan is unmounted',async()=>{
 let finish!:(r:Response)=>void;server.mockImplementation(()=>new Promise<Response>(r=>finish=r));const v=render(<DocumentPlanControl {...props}/>);confirm();fireEvent.click(screen.getByRole('button',{name:'Pausar plan'}));await waitFor(()=>expect(server).toHaveBeenCalledTimes(1));v.unmount();finish(new Response(JSON.stringify(ack)));await waitFor(()=>expect(server.mock.calls[0][1].signal.aborted).toBe(true));expect(recorded).not.toHaveBeenCalled();
});

it('keeps controls usable through StrictMode effect cleanup',async()=>{
 render(<React.StrictMode><DocumentPlanControl {...props}/></React.StrictMode>);confirm();fireEvent.click(screen.getByRole('button',{name:'Pausar plan'}));await waitFor(()=>expect(recorded).toHaveBeenCalledTimes(1));expect(server).toHaveBeenCalledTimes(1);
});

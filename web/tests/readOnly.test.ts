// @vitest-environment jsdom
import {afterEach,expect,it,vi} from "vitest";
import {ACCESS_URL,READ_ONLY_NOTE,blocksInReadOnly,installReadOnlyGuard,loadAccess,loadReadOnly} from "../src/readOnly";
import {API_ROOT} from "../src/holdingApi";
const ORG="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",org=API_ROOT+"/v1/me/organizations/"+ORG;
afterEach(()=>vi.unstubAllGlobals());
it("solo deja pasar las lecturas y las preguntas del chat",()=>{
 expect(blocksInReadOnly(org+"/tasks",undefined)).toBe(false);expect(blocksInReadOnly(org+"/tasks","get")).toBe(false);
 expect(blocksInReadOnly(org+"/eliot/chat","POST")).toBe(false);
 for(const [u,m] of [[org+"/retire","POST"],[org+"/name","POST"],[org+"/eliot/chat/x","POST"],[org+"/eliot/chat","DELETE"],[API_ROOT+"/v1/me/holding/h/companies","POST"]])expect(blocksInReadOnly(u,m)).toBe(true);
 expect(blocksInReadOnly("https://otra.example.com/x","POST")).toBe(false);                        // lo que no es de La Factoría no se toca
});
it("pregunta al servidor y, ante cualquier duda, no marca la sesión como de consulta",async()=>{
 const f=vi.fn(async()=>new Response(JSON.stringify({read_only:true}),{status:200}));vi.stubGlobal("fetch",f);
 expect(await loadReadOnly(async()=>"t")).toBe(true);expect(f.mock.calls[0][0]).toBe(ACCESS_URL);
 for(const r of [new Response("{}",{status:200}),new Response("{}",{status:503}),new Response(JSON.stringify({read_only:"si"}),{status:200})]){vi.stubGlobal("fetch",vi.fn(async()=>r));expect(await loadReadOnly(async()=>"t")).toBe(false);}
});
it("el freno contesta 403 sin enviar nada, avisa, y se puede retirar",async()=>{
 const real=vi.fn(async()=>new Response("{}",{status:200}));vi.stubGlobal("fetch",real);const aviso=vi.fn();
 const quitar=installReadOnlyGuard(aviso);
 const r=await fetch(org+"/retire",{method:"POST",body:"{}"});
 expect(r.status).toBe(403);expect((await r.json()).detail).toBe(READ_ONLY_NOTE);expect(real).not.toHaveBeenCalled();expect(aviso).toHaveBeenCalledTimes(1);
 await fetch(org+"/tasks");await fetch(org+"/eliot/chat",{method:"POST",body:"{}"});expect(real).toHaveBeenCalledTimes(2);
 quitar();await fetch(org+"/retire",{method:"POST"});expect(real).toHaveBeenCalledTimes(3);
});

it("la puerta: pasa quien el servidor dice, se queda fuera quien no, y un fallo no es ni lo uno ni lo otro",async()=>{
 const ask=async(r:Response|Error)=>{vi.stubGlobal("fetch",vi.fn(()=>r instanceof Error?Promise.reject(r):Promise.resolve(r)));const v=await loadAccess(async()=>"t");vi.unstubAllGlobals();return v;};
 const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
 expect(await ask(json({read_only:false,allowed:true}))).toEqual({gate:"allowed",readOnly:false});
 expect(await ask(json({read_only:true,allowed:true}))).toEqual({gate:"allowed",readOnly:true});
 expect(await ask(json({read_only:false,allowed:false}))).toEqual({gate:"denied"});          // p. ej. un observador expulsado
 expect(await ask(json({read_only:false}))).toEqual({gate:"allowed",readOnly:false});         // servidor antiguo: como antes
 expect(await ask(json({},403))).toEqual({gate:"denied"});expect(await ask(json({},401))).toEqual({gate:"denied"});
 expect(await ask(json({},503))).toEqual({gate:"error"});expect(await ask(new Error("red"))).toEqual({gate:"error"});
 expect(await ask(new Response("null",{status:200}))).toEqual({gate:"error"});
});

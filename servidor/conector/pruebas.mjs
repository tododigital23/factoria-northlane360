// Pruebas del conector estándar.   node conector/pruebas.mjs
import { crearConector, limpiarAviso, ref, huella } from './freddy-conector.mjs';
let bien = 0, mal = 0; const ok = (n, c) => { if (c) { bien++; console.log('OK  ', n); } else { mal++; console.log('MAL ', n); } };
const CLAVE = 'k'.repeat(32); const env = x => ({ FREDDY_SECRET: CLAVE, ...x });
const pedir = (ruta, cab = { Authorization: 'Bearer ' + CLAVE }, cuerpo) => new Request('https://empresa.example' + ruta, { method: cuerpo ? 'POST' : 'GET', headers: { ...cab, 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let pedidos = [{ id: 1042, cliente: 'Ana García', correo: 'ana@correo.es' }], tocado = 0;
const c = crearConector({ empresa: 'mi-tienda', panel: 'https://mi-tienda.example/admin',
  vigilantes: [
    { id: 'pedidos', nombre: 'Vigilante de pedidos', capacidad: 'orders', revisar: async () => pedidos.length ? [{ nivel: 'urgente', clave: 'atascados', n: pedidos.length, refs: pedidos.map(p => ref('mt', 'ORD', p.id)), titulo: 'Pedidos pagados sin enviar', propuesta: 'Revísalos en el panel.', cliente: pedidos[0].cliente, correo: pedidos[0].correo, texto: 'Ana García ana@correo.es' }] : [] },
    { id: 'roto', nombre: 'Vigilante que falla', capacidad: 'monitoring', revisar: async () => { throw new Error('SECRETO-INTERNO'); } }],
  consultas: { ventas: async p => ({ periodo: p.periodo || 'hoy', pedidos: 3 }) },
  acciones: { reenviar: { previa: async b => ({ ok: true, resumen: 'Reenviar ' + b.ref }), ejecutar: async b => { tocado++; return { ok: true, resumen: 'Hecho ' + b.ref }; } } } });

console.log('\n── acceso ──');
ok('sin clave → 401', (await c.resumen(pedir('/r', {}), env())).status === 401);
ok('clave equivocada → 401', (await c.resumen(pedir('/r', { Authorization: 'Bearer ' + 'x'.repeat(32) }), env())).status === 401);
ok('la clave en la dirección no vale', (await c.resumen(pedir('/r?key=' + CLAVE, {}), env())).status === 401);
ok('sin FREDDY_SECRET o demasiado corta → 500', (await c.resumen(pedir('/r'), {})).status === 500 && (await c.resumen(pedir('/r'), { FREDDY_SECRET: 'corta' })).status === 500);

console.log('\n── resumen ──');
const r = await c.resumen(pedir('/r'), env()); const txt = await r.text(); const d = JSON.parse(txt);
ok('tiene la forma que Freddy entiende', d.ok === true && d.version === 1 && d.empresa === 'mi-tienda' && d.agentes.length === 2 && d.consultas.join() === 'ventas' && d.acciones.join() === 'reenviar');
ok('el aviso lleva gravedad, clave, cuántos, referencia y su título', JSON.stringify(d.agentes[0].avisos[0]) === JSON.stringify({ nivel: 'urgente', clave: 'atascados', n: 1, refs: ['mt-ORD-1042'], titulo: 'Pedidos pagados sin enviar', propuesta: 'Revísalos en el panel.' }));
ok('NADA más sale del aviso: ni el nombre ni el correo del cliente', !/Ana|correo|SECRETO/.test(txt));
ok('el agente con avisos urgentes está en alerta', d.agentes[0].estado === 'alerta' && d.agentes[0].alertas.urgentes === 1);
ok('un vigilante que falla queda como «error» y no tumba a los demás', d.agentes[1].estado === 'error' && d.agentes[1].avisos.length === 0);

console.log('\n── lo que no puede salir en un aviso ──');
ok('nivel o clave inventados → se descarta', limpiarAviso({ nivel: 'crítico', clave: 'x' }) === null && limpiarAviso({ nivel: 'urgente', clave: 'DROP TABLE' }) === null);
ok('referencias que no son referencias (correo, teléfono) → fuera', limpiarAviso({ nivel: 'info', clave: 'cosa', refs: ['ana@correo.es', '600111222', 'mt-ORD-7'] }).refs.join() === 'mt-ORD-7');
ok('un título con un teléfono o un correo → no sale', !('titulo' in limpiarAviso({ nivel: 'info', clave: 'cosa', titulo: 'Llama al 600111222' })) && !('titulo' in limpiarAviso({ nivel: 'info', clave: 'cosa', titulo: 'Escribe a ana@correo.es' })));
ok('ref() da forma de referencia y rechaza lo raro', ref('jd', 'ord', 15) === 'jd-ORD-15' && ref('demasiadolargo', 'ORD', 1) === null);

console.log('\n── consultas ──');
let q = await c.consulta(pedir('/c?tipo=ventas&periodo=ayer'), env()); let qd = await q.json();
ok('responde la consulta definida', q.status === 200 && qd.tipo === 'ventas' && qd.datos.periodo === 'ayer' && qd.datos.pedidos === 3);
q = await c.consulta(pedir('/c?tipo=clientes'), env()); ok('una consulta que no existe → 400 y dice cuáles hay', q.status === 400 && (await q.json()).tipos.join() === 'ventas');
ok('«constructor» y similares no cuelan', (await c.consulta(pedir('/c?tipo=constructor'), env())).status === 400);
ok('sin clave no hay consulta', (await c.consulta(pedir('/c?tipo=ventas', {}), env())).status === 401);

console.log('\n── acciones en dos pasos ──');
let a = await c.accion(pedir('/a', undefined, { accion: 'reenviar', modo: 'ejecutar', ref: 'mt-ORD-1' }), env());
ok('apagadas sin FREDDY_ACCIONES=on', a.status === 403 && tocado === 0);
const on = env({ FREDDY_ACCIONES: 'on' });
a = await (await c.accion(pedir('/a', undefined, { accion: 'reenviar', modo: 'previa', ref: 'mt-ORD-1' }), on)).json();
ok('la previa explica y no toca nada', a.ok === true && a.hecho === false && a.resumen === 'Reenviar mt-ORD-1' && tocado === 0);
a = await (await c.accion(pedir('/a', undefined, { accion: 'reenviar', modo: 'ejecutar', ref: 'mt-ORD-1' }), on)).json();
ok('ejecutar lo hace una vez', a.hecho === true && tocado === 1);
ok('acción desconocida o modo raro → 400', (await c.accion(pedir('/a', undefined, { accion: 'borrar', modo: 'ejecutar' }), on)).status === 400 && (await c.accion(pedir('/a', undefined, { accion: 'reenviar', modo: 'ya' }), on)).status === 400);

console.log('\n── avisar a Freddy cuando algo cambia ──');
const enviados = []; const real = globalThis.fetch; globalThis.fetch = async (u, o) => { enviados.push({ u: String(u), b: JSON.parse(o.body), auth: o.headers.Authorization }); return new Response('{}'); };
let guardado = null; const memoria = { leer: async () => guardado, guardar: async t => { guardado = t; } }; const push = env({ FREDDY_PUSH_URL: 'https://freddy.example/v1/portal-push' });
let t0 = Date.now();
ok('sin FREDDY_PUSH_URL está apagado', (await c.avisarSiCambia(env(), memoria)).motivo === 'apagado' && enviados.length === 0);
ok('la primera vez envía', (await c.avisarSiCambia(push, memoria, { ahora: t0 })).enviado === true && enviados.length === 1 && enviados[0].auth === 'Bearer ' + CLAVE);
ok('no revisa más de una vez cada 2 minutos', (await c.avisarSiCambia(push, memoria, { ahora: t0 + 1000 })).motivo === 'pausa');
ok('sin cambios no envía', (await c.avisarSiCambia(push, memoria, { ahora: t0 + 130000 })).motivo === 'sin_cambios' && enviados.length === 1);
pedidos = [];
ok('al resolverse, avisa también', (await c.avisarSiCambia(push, memoria, { ahora: t0 + 260000 })).enviado === true && enviados.length === 2 && enviados[1].b.agentes[0].avisos.length === 0);
globalThis.fetch = real;
ok('la huella no depende de la hora', huella({ agentes: [{ id: 'a', estado: 'ok', avisos: [] }], generado: 'x' }) === huella({ agentes: [{ id: 'a', estado: 'ok', avisos: [] }], generado: 'y' }));

console.log('\n── configuración mal escrita ──');
const falla = f => { try { f(); return false; } catch (_) { return true; } };
ok('empresa sin identificador válido', falla(() => crearConector({ empresa: 'Mi Tienda S.L.' })));
ok('vigilante sin función o con capacidad inventada', falla(() => crearConector({ empresa: 'x1', vigilantes: [{ id: 'a', nombre: 'Vigilante', capacidad: 'orders' }] })) && falla(() => crearConector({ empresa: 'x1', vigilantes: [{ id: 'ab', nombre: 'Vigilante', capacidad: 'magia', revisar() {} }] })));
ok('acción sin vista previa', falla(() => crearConector({ empresa: 'x1', acciones: { borrar: { ejecutar() {} } } })));
console.log(`\n${bien} bien · ${mal} mal`); process.exit(mal ? 1 : 0);

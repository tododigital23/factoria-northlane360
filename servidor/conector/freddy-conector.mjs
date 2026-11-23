// ═══ CONECTOR ESTÁNDAR DE FREDDY ═══
// Una sola pieza que se instala en la web de una empresa para que sus agentes hablen con Freddy (La Factoría Northlane360).
// No depende de ningún proveedor: usa Request y Response estándar, así que sirve en Cloudflare Pages/Workers, Node 18+, Deno y Bun.
//
// La empresa escribe un archivo de configuración (freddy.config.mjs) con:
//   · vigilantes  → funciones que miran SUS datos y devuelven avisos
//   · consultas   → lo que el dueño puede preguntar a Freddy (opcional)
//   · acciones    → lo que el dueño puede mandar hacer, siempre en dos pasos (opcional)
// y este conector se encarga de lo demás: comprobar la clave, dar a todo la forma que Freddy entiende, no dejar pasar lo que
// no debe salir, y avisar a Freddy cuando algo cambia.
//
// Variables del servidor de la empresa:
//   FREDDY_SECRET     clave compartida con Freddy (24 caracteres o más). Sin ella, todo responde 500.
//   FREDDY_PUSH_URL   dirección de Freddy para avisarle al momento (opcional; sin ella Freddy pregunta cada 30 minutos).
//   FREDDY_ACCIONES   «on» para permitir acciones. Sin ella, las acciones están apagadas.

export const VERSION = 1;
export const NIVELES = ['urgente', 'importante', 'info'];
export const ESTADOS = ['activo', 'apagado', 'frenado', 'ok', 'aviso', 'alerta', 'error'];
export const CAPACIDADES = ['repository', 'website', 'seo', 'marketing', 'email', 'orders', 'monitoring', 'automation'];
const ID = /^[a-z][a-z_]{1,29}$/, NOMBRE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]{3,60}$/, CLAVE = /^[a-z_]{2,30}$/, EMPRESA = /^[a-z0-9-]{2,40}$/;
const REF = /^[a-z]{2,5}-[A-Z]{3}-[A-Za-z0-9]{1,16}(-[A-Z])?$/;
const TEXTO = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .,:;()«»¿?¡!%€$/+'-]{3,140}$/;

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
function igual(a, b) { a = String(a || ''); b = String(b || ''); if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
const texto = v => { const s = typeof v === 'string' ? v.trim() : ''; return TEXTO.test(s) && !/\d{7,}/.test(s) ? s : null; };

/** Da forma de referencia a un caso de la empresa: ref('jd', 'ORD', 1042) → «jd-ORD-1042». Es lo único de un caso concreto que viaja en un aviso. */
export function ref(prefijo, tipo, id) {
  const r = `${String(prefijo).toLowerCase()}-${String(tipo).toUpperCase()}-${String(id).replace(/[^A-Za-z0-9]/g, '')}`;
  return REF.test(r) ? r : null;
}

/** Un aviso tal como lo devolvió un vigilante → solo lo que puede salir: gravedad, clave, cuántos, referencias y un título llano. */
export function limpiarAviso(a) {
  if (!a || !NIVELES.includes(a.nivel) || !CLAVE.test(String(a.clave || ''))) return null;
  const refs = [...new Set((Array.isArray(a.refs) ? a.refs : []).map(String).filter(r => REF.test(r)))].slice(0, 6);
  const n = Number.isInteger(a.n) && a.n >= 0 && a.n <= 100000 ? a.n : (refs.length || null);
  const out = { nivel: a.nivel, clave: a.clave, n, refs };
  const titulo = texto(a.titulo), propuesta = texto(a.propuesta);
  if (titulo) { out.titulo = titulo; if (propuesta) out.propuesta = propuesta; }
  return out;
}

/** Lo que distingue una situación de otra: el estado de cada agente y sus avisos. Las horas no cuentan. */
export function huella(resumen) {
  return JSON.stringify((resumen.agentes || []).map(a => [a.id, a.estado, (a.avisos || []).map(v => [v.nivel, v.clave, v.n, (v.refs || []).join(',')].join(':')).sort()]));
}

export function crearConector(config) {
  const { empresa, panel = null, vigilantes = [], consultas = {}, acciones = {} } = config || {};
  if (!EMPRESA.test(String(empresa || ''))) throw new Error('freddy.config: «empresa» debe ser un identificador corto en minúsculas, por ejemplo «mi-tienda-demo»');
  const vistos = new Set();
  for (const v of vigilantes) {
    if (!v || !ID.test(String(v.id || '')) || !NOMBRE.test(String(v.nombre || '')) || !CAPACIDADES.includes(v.capacidad) || typeof v.revisar !== 'function') throw new Error(`freddy.config: vigilante mal definido (${v && v.id})`);
    if (vistos.has(v.id)) throw new Error(`freddy.config: vigilante repetido (${v.id})`);
    vistos.add(v.id);
  }
  for (const [k, c] of Object.entries(consultas)) if (!CLAVE.test(k) || typeof c !== 'function') throw new Error(`freddy.config: consulta mal definida (${k})`);
  for (const [k, a] of Object.entries(acciones)) if (!CLAVE.test(k) || !a || typeof a.previa !== 'function' || typeof a.ejecutar !== 'function') throw new Error(`freddy.config: la acción «${k}» necesita «previa» y «ejecutar»`);

  function autorizado(request, env) {
    if (!env || !env.FREDDY_SECRET) return json({ ok: false, error: 'Configuración incompleta' }, 500);
    if (String(env.FREDDY_SECRET).length < 24) return json({ ok: false, error: 'FREDDY_SECRET demasiado corta' }, 500);
    const dada = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');   // siempre en la cabecera, nunca en la dirección
    return igual(dada, env.FREDDY_SECRET) ? null : json({ ok: false, error: 'No autorizado' }, 401);
  }

  /** Ejecuta todos los vigilantes. Uno que falla no tumba a los demás: queda como «error». */
  async function construirResumen(env, ahora = Date.now()) {
    const agentes = [];
    for (const v of vigilantes) {
      let avisos = [], fallo = false;
      try { avisos = ((await v.revisar({ env, ahora })) || []).map(limpiarAviso).filter(Boolean).slice(0, 12); } catch (_) { fallo = true; }
      const cuenta = nivel => avisos.filter(a => a.nivel === nivel).length;
      agentes.push({ id: v.id, nombre: v.nombre, capacidad: v.capacidad,
        estado: fallo ? 'error' : (cuenta('urgente') ? 'alerta' : (cuenta('importante') ? 'aviso' : 'ok')),
        alertas: { urgentes: cuenta('urgente'), importantes: cuenta('importante'), informativas: cuenta('info') }, avisos });
    }
    // «consultas» y «acciones» le dicen a Freddy qué puede preguntar y qué puede mandar hacer en esta empresa.
    return { ok: true, version: VERSION, empresa, generado: new Date(ahora).toISOString(), agentes, panel, consultas: Object.keys(consultas), acciones: Object.keys(acciones) };
  }

  /** GET  → el resumen que Freddy lee. */
  async function resumen(request, env) {
    const no = autorizado(request, env); if (no) return no;
    return json(await construirResumen(env));
  }

  /** GET ?tipo=…  → una consulta del dueño. Lo que devuelve cada consulta lo decide la empresa en su configuración. */
  async function consulta(request, env) {
    const no = autorizado(request, env); if (no) return no;
    const u = new URL(request.url), tipo = u.searchParams.get('tipo');
    if (!Object.prototype.hasOwnProperty.call(consultas, tipo)) return json({ ok: false, error: 'Consulta no disponible', tipos: Object.keys(consultas) }, 400);
    let datos; try { datos = await consultas[tipo](Object.fromEntries(u.searchParams), { env, ahora: Date.now() }); } catch (_) { return json({ ok: false, error: 'La consulta ha fallado' }, 500); }
    return json({ ok: true, version: VERSION, empresa, tipo, generado: new Date().toISOString(), datos });
  }

  /** POST {accion, modo:'previa'|'ejecutar', …}  → una acción en dos pasos. «previa» nunca debe tocar nada. */
  async function accion(request, env) {
    const no = autorizado(request, env); if (no) return no;
    if (String(env.FREDDY_ACCIONES || '').toLowerCase() !== 'on') return json({ ok: false, motivo: 'acciones_apagadas', resumen: 'Las acciones de Freddy están apagadas en esta empresa.' }, 403);
    const b = await request.json().catch(() => null);
    if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ ok: false, error: 'Petición no válida' }, 400);
    const hacer = Object.prototype.hasOwnProperty.call(acciones, b.accion) ? acciones[b.accion] : null;
    if (!hacer || !['previa', 'ejecutar'].includes(b.modo)) return json({ ok: false, error: 'Acción no disponible', acciones: Object.keys(acciones) }, 400);
    let r; try { r = await (b.modo === 'ejecutar' ? hacer.ejecutar : hacer.previa)(b, { env, ahora: Date.now() }); } catch (_) { r = null; }
    if (!r || typeof r.resumen !== 'string') r = { ok: false, resumen: 'Algo ha fallado al intentarlo. No se da nada por hecho.' };
    return json({ version: VERSION, accion: b.accion, modo: b.modo, ok: r.ok === true, hecho: b.modo === 'ejecutar' && r.ok === true && r.hecho !== false, resumen: String(r.resumen).slice(0, 900) });
  }

  /**
   * Avisa a Freddy si la situación ha cambiado desde la última vez. Llámalo después de cada operación que cambie algo
   * (un pedido, un pago, un mensaje), sin hacer esperar al cliente (en Cloudflare: context.waitUntil).
   * «memoria» son dos funciones que tú das para recordar la última huella: { leer: async () => texto|null, guardar: async texto => {} }.
   */
  async function avisarSiCambia(env, memoria, { ahora = Date.now(), pausaMs = 120000 } = {}) {
    const url = String((env && env.FREDDY_PUSH_URL) || '');
    if (!/^https:\/\/[a-z0-9.-]+\/[\w\/-]*$/i.test(url) || !env.FREDDY_SECRET || !memoria) return { enviado: false, motivo: 'apagado' };
    let previo = {}; try { previo = JSON.parse((await memoria.leer()) || '{}') || {}; } catch (_) { previo = {}; }
    if (ahora - (Number(previo.t) || 0) < pausaMs) return { enviado: false, motivo: 'pausa' };
    const r = await construirResumen(env, ahora), h = huella(r);
    if (h === previo.huella) { await memoria.guardar(JSON.stringify({ t: ahora, huella: h })); return { enviado: false, motivo: 'sin_cambios' }; }
    let ok = false;
    try { ok = (await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + env.FREDDY_SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify(r) })).ok; } catch (_) { ok = false; }
    await memoria.guardar(JSON.stringify({ t: ahora, huella: ok ? h : (previo.huella || '') }));
    return { enviado: ok, motivo: ok ? 'cambio' : 'freddy_no_contesta' };
  }

  return { resumen, consulta, accion, avisarSiCambia, construirResumen };
}

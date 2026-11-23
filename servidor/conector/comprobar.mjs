// Comprueba que el conector de una empresa responde como Freddy espera.
//   node conector/comprobar.mjs https://mi-empresa.example/api/cron/resumen-freddy
// La clave se lee de la variable FREDDY_SECRET (no la escribas en la orden, para que no quede en el historial):
//   FREDDY_SECRET=… node conector/comprobar.mjs https://…
// Solo LEE el resumen. No ejecuta consultas ni acciones.
import { NIVELES, ESTADOS, CAPACIDADES } from './freddy-conector.mjs';
const url = process.argv[2], clave = process.env.FREDDY_SECRET || '';
const fin = (ok, lineas) => { for (const l of lineas) console.log(l); process.exit(ok ? 0 : 1); };
if (!/^https:\/\//.test(String(url || ''))) fin(false, ['Uso: FREDDY_SECRET=… node conector/comprobar.mjs https://empresa/api/cron/resumen-freddy']);
if (clave.length < 24) fin(false, ['Falta FREDDY_SECRET (24 caracteres o más) en el entorno.']);
const errores = [], avisos = [];
const sinClave = await fetch(url).catch(() => null);
if (!sinClave) fin(false, ['No se puede conectar con ' + url]);
if (sinClave.status !== 401) errores.push(`Sin clave debería responder 401 y responde ${sinClave.status}: cualquiera podría leer el resumen.`);
const r = await fetch(url, { headers: { Authorization: 'Bearer ' + clave } });
if (r.status !== 200) fin(false, [`Con la clave responde ${r.status} en vez de 200. ¿Es la misma clave que tiene la empresa?`]);
const d = await r.json().catch(() => null);
if (!d || d.ok !== true || d.version !== 1) errores.push('La respuesta no trae «ok: true» y «version: 1».');
if (!/^[a-z0-9-]{2,40}$/.test(String(d && d.empresa || ''))) errores.push('«empresa» debe ser un identificador corto en minúsculas.');
const agentes = Array.isArray(d && d.agentes) ? d.agentes : [];
if (!agentes.length) errores.push('No hay ningún agente: Freddy no tendría nada que vigilar.');
for (const a of agentes) {
  const quien = `Agente «${a && a.id}»`;
  if (!/^[a-z][a-z_]{1,29}$/.test(String(a.id || ''))) errores.push(`${quien}: «id» no válido.`);
  if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]{3,60}$/.test(String(a.nombre || ''))) errores.push(`${quien}: «nombre» solo puede llevar letras y espacios (3 a 60).`);
  if (!ESTADOS.includes(a.estado)) errores.push(`${quien}: estado «${a.estado}» desconocido.`);
  if (!CAPACIDADES.includes(a.capacidad)) errores.push(`${quien}: capacidad «${a.capacidad}» desconocida. Valen: ${CAPACIDADES.join(', ')}.`);
  for (const v of (Array.isArray(a.avisos) ? a.avisos : [])) {
    if (!NIVELES.includes(v.nivel) || !/^[a-z_]{2,30}$/.test(String(v.clave || ''))) errores.push(`${quien}: aviso con nivel o clave no válidos.`);
    for (const ref of (v.refs || [])) if (!/^[a-z]{2,5}-[A-Z]{3}-[A-Za-z0-9]{1,16}(-[A-Z])?$/.test(String(ref))) errores.push(`${quien}: la referencia «${String(ref).slice(0, 20)}» no tiene la forma xx-AAA-123 y Freddy la descartará.`);
    if (!v.titulo) avisos.push(`${quien}: el aviso «${v.clave}» no trae título; Freddy dirá solo «Aviso de un agente».`);
    for (const campo of Object.keys(v)) if (!['nivel', 'clave', 'n', 'refs', 'titulo', 'propuesta'].includes(campo)) errores.push(`${quien}: el aviso «${v.clave}» lleva un campo de más («${campo}»). Puede ser un dato de cliente escapándose.`);
  }
}
const texto = JSON.stringify(d || {});
if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(texto)) errores.push('En el resumen aparece algo con forma de correo electrónico. No debe salir ningún dato de cliente.');
if (/\b\d{9,}\b/.test(texto.replace(/"generado":"[^"]*"/, ''))) avisos.push('En el resumen aparece un número largo (¿un teléfono?). Revísalo.');
fin(!errores.length, [
  `Empresa: ${d && d.empresa} · ${agentes.length} agente(s) · consultas: ${(d && d.consultas || []).join(', ') || 'ninguna'} · acciones: ${(d && d.acciones || []).join(', ') || 'ninguna'}`,
  ...errores.map(e => 'MAL   ' + e), ...avisos.map(a => 'OJO   ' + a), errores.length ? `\n${errores.length} problema(s). Freddy no leerá bien esta empresa hasta arreglarlos.` : '\nCORRECTO: Freddy puede leer esta empresa.']);

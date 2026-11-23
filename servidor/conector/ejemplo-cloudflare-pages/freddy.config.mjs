// EJEMPLO de configuración para una tienda. Cópialo a tu proyecto y cámbialo por lo que tu negocio necesite vigilar.
// Aquí defines QUÉ mira cada vigilante; el conector se ocupa de entregárselo a Freddy con la forma correcta.
import { crearConector, ref } from '../freddy-conector.mjs';

// «db» es TU forma de leer tus datos (aquí, una función de ejemplo). Cámbiala por la de tu proyecto.
async function db(env, consulta) { return env.MIS_DATOS ? env.MIS_DATOS(consulta) : []; }

export const conector = crearConector({
  empresa: 'mi-tienda',                         // identificador corto, en minúsculas
  panel: 'https://mi-tienda.example/admin',     // adónde ir a arreglar las cosas
  vigilantes: [
    {
      id: 'pedidos', nombre: 'Vigilante de pedidos', capacidad: 'orders',
      async revisar({ env, ahora }) {
        const avisos = [];
        // Regla 1: pedidos pagados que llevan más de 30 minutos sin enviarse.
        const atascados = await db(env, { que: 'pedidos_pagados_sin_enviar', desde_minutos: 30 });
        if (atascados.length) avisos.push({
          nivel: 'urgente', clave: 'pedidos_atascados', n: atascados.length,
          refs: atascados.map(p => ref('mt', 'ORD', p.id)),            // solo la referencia: nunca el nombre ni el correo del cliente
          titulo: atascados.length === 1 ? 'Un pedido pagado lleva más de 30 minutos sin enviarse' : `${atascados.length} pedidos pagados llevan más de 30 minutos sin enviarse`,
          propuesta: 'Revísalos en el panel y avisa a los clientes.' });
        return avisos;
      },
    },
  ],
  consultas: {
    // Lo que el dueño puede preguntarle a Freddy. Devuelve cifras; los datos de clientes, solo si tú decides exponerlos.
    async ventas(params, { env }) { const filas = await db(env, { que: 'ventas', periodo: params.periodo || 'hoy' }); return { periodo: params.periodo || 'hoy', pedidos: filas.length, importe_eur: filas.reduce((a, f) => a + (Number(f.importe) || 0), 0) }; },
  },
  acciones: {
    // Siempre en dos pasos. «previa» explica qué se hará y NO toca nada; «ejecutar» lo hace.
    reenviar: {
      async previa(b) { return { ok: true, resumen: `Reenviar el pedido ${b.ref}.` }; },
      async ejecutar(b, { env }) { await db(env, { que: 'reenviar', ref: b.ref }); return { ok: true, resumen: `Hecho: pedido ${b.ref} reenviado.` }; },
    },
  },
});

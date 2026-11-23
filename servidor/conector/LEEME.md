# Conector estándar de Freddy

Una pieza que se instala en la web de una empresa para que sus agentes hablen con Freddy, el director de
La Factoría Northlane360. Con él, conectar una empresa nueva es escribir **un archivo de configuración**, no
construirlo todo desde cero.

## Qué necesitas
- Poder modificar el código de la empresa y desplegarlo. Sin eso no se puede conectar.
- Que la web corra en algo que entienda JavaScript moderno: Cloudflare Pages o Workers, Node 18+, Deno o Bun.
  Si está en otro lenguaje, mira «Otro lenguaje» al final.

## Pasos
1. **Copia** `freddy-conector.mjs` a tu proyecto.
2. **Escribe** `freddy.config.mjs` partiendo de `ejemplo-cloudflare-pages/freddy.config.mjs`. Ahí decides:
   - **vigilantes**: qué mira cada uno y cuándo avisa;
   - **consultas**: qué puede preguntar el dueño (opcional);
   - **acciones**: qué puede mandar hacer, siempre en dos pasos (opcional).
3. **Publica tres rutas**, las tres en la misma carpeta y con estos nombres exactos:
   - `GET  …/resumen-freddy`
   - `GET  …/consulta-freddy`
   - `POST …/accion-freddy`
   En `ejemplo-cloudflare-pages/functions/api/cron/` tienes las tres ya hechas (tres líneas cada una).
4. **Pon las variables** en el servidor de la empresa:
   - `FREDDY_SECRET` — una clave larga e inventada (24 caracteres o más). Tipo secreto.
   - `FREDDY_ACCIONES` — `on` solo si quieres permitir acciones.
   - `FREDDY_PUSH_URL` — la dirección de Freddy terminada en `/v1/portal-push`, para que le avise al momento.
5. **Compruébalo** antes de conectarlo:
   ```bash
   FREDDY_SECRET=… node conector/comprobar.mjs https://tu-empresa/api/cron/resumen-freddy
   ```
   Tiene que terminar en «CORRECTO».
6. **Dáselo a conocer a Freddy**: en su servidor, añade la empresa a `ELIOT_PORTAL_FEEDS` (con el identificador de la
   empresa en La Factoría, la dirección del resumen y el nombre de la variable que guarda la clave) y pon esa clave.

## Las tres reglas que no se negocian
1. **De un caso concreto solo sale su referencia** (`xx-AAA-123`, con `ref('xx', 'ORD', id)`). Nunca el nombre, el
   correo ni el teléfono de un cliente en un aviso. El conector descarta lo que no tenga esa forma.
2. **Un aviso es algo que cuesta dinero o un cliente si nadie lo ve.** No métricas ni curiosidades.
3. **Las acciones van en dos pasos.** `previa` explica qué se hará y no toca nada; `ejecutar` lo hace. Freddy solo
   pide `ejecutar` cuando el dueño ha leído la previa y ha contestado «sí».

## Qué forma tiene un aviso
```js
{ nivel: 'urgente' | 'importante' | 'info',
  clave: 'pedidos_atascados',          // minúsculas y guiones bajos
  n: 3,                                // cuántos casos
  refs: ['mt-ORD-1042', 'mt-ORD-1043'],// hasta 6 referencias
  titulo: '3 pedidos pagados llevan más de 30 minutos sin enviarse',
  propuesta: 'Revísalos en el panel y avisa a los clientes.' }
```
El título y la propuesta son frases llanas, sin correos ni números largos.

## Avisar a Freddy al momento
Después de cada operación que cambie algo (un pedido, un pago), llama a `conector.avisarSiCambia(env, memoria)` sin
hacer esperar al cliente. Solo envía si la situación es distinta de la última vez, y como mucho cada 2 minutos.
`memoria` son dos funciones tuyas para recordar un texto: `{ leer, guardar }`.
Sin esto, Freddy se entera igual, pero en su comprobación de cada 30 minutos.

## Base de datos de la empresa (cualquier motor)

Si la empresa no puede publicar esas tres rutas, hay dos caminos:

1. **Puente en su VPS** (`conector/db/`): lee PostgreSQL, MySQL, MariaDB, SQLite, SQL Server o MongoDB y habla el
   contrato de Freddy. La base no se abre a internet.
   ```bash
   FREDDY_SECRET=… FREDDY_DB_URL=mysql://… FREDDY_DB_CONFIG=conector/db/empresa.ejemplo.json \
     python conector/db/servidor.py
   ```
2. **Desde La Factoría**: en `ELIOT_PORTAL_FEEDS` pon `"kind": "database"` y `db_url_env` (una variable
   `ELIOT_COMPANY_DB_…`). Los vigilantes son `SELECT` fijos; las escrituras solo si `ELIOT_COMPANY_DB_WRITES=on`.

## Otro lenguaje
El conector es solo una forma cómoda de cumplir un contrato. Si tu web está en PHP, Python u otro, publica las mismas
tres rutas, con la clave en la cabecera `Authorization: Bearer …`, y devuelve el mismo JSON. `comprobar.mjs` te dice
si lo has hecho bien, esté escrito en lo que esté.

## Probar el conector
```bash
node conector/pruebas.mjs
```

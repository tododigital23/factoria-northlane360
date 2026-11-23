# La Factoría Northlane360

**Un centro de mando para dirigir varias empresas con agentes de inteligencia artificial, y un director —Freddy— que vigila
todo y habla contigo por Telegram.**

Este paquete contiene el producto completo tal y como funciona hoy: el servidor, la web, la base de datos, el conector
para enganchar una empresa, las pruebas automáticas y esta explicación.

> **Qué NO hay aquí.** Ningún dato de ninguna empresa conectada ni de sus clientes: ni nombres, ni direcciones, ni
> identificadores, ni claves. Los nombres de empresa que aparecen en ejemplos y pruebas («Nova Demo», «Juguetes Demo»,
> «Tienda Aurora»…) son inventados. Las direcciones del tipo `api.tu-factoria.example` son huecos que rellena quien lo instala.

---

## Índice

1. [La idea en dos minutos](#1-la-idea-en-dos-minutos)
2. [Qué hay en el paquete](#2-qué-hay-en-el-paquete)
3. [Los conceptos](#3-los-conceptos)
4. [La web, pantalla a pantalla](#4-la-web-pantalla-a-pantalla)
5. [Los agentes](#5-los-agentes)
6. [Freddy y el administrador](#6-freddy-y-el-administrador)
7. [Memoria y cerebro](#7-memoria-y-cerebro)
8. [Cómo se conecta una empresa](#8-cómo-se-conecta-una-empresa)
9. [Seguridad](#9-seguridad)
10. [El servidor por dentro](#10-el-servidor-por-dentro)
11. [La base de datos](#11-la-base-de-datos)
12. [Puesta en marcha](#12-puesta-en-marcha)
13. [Interruptores](#13-interruptores)
14. [Pruebas](#14-pruebas)
15. [Estado real y límites](#15-estado-real-y-límites)
16. [Antes de venderlo](#16-antes-de-venderlo)

---

## 1. La idea en dos minutos

Un empresario con varias empresas no puede mirar cinco paneles distintos. La Factoría las reúne en **una ciudad**: cada
empresa es un edificio, cada edificio tiene **oficinas** (departamentos) y en cada oficina trabajan **agentes de IA**.

- Entras, ves la ciudad y de un vistazo sabes qué empresa necesita atención.
- Entras en una empresa y ves a sus agentes trabajando, esperando o levantando la mano porque te necesitan.
- Hablas con cualquier agente, le encargas trabajo conversando y revisas lo que entrega.
- **Freddy**, el director, vigila a los agentes de todas las empresas y te escribe por Telegram cuando pasa algo, te contesta
  cuando preguntas y cada noche te manda el resumen del día.

Tres reglas atraviesan todo el producto:

1. **Nada trabaja sin que tú lo decidas.** Los agentes nacen inactivos, los encargos se confirman, las acciones piden un «sí».
2. **Cada empresa está aislada.** Lo de una no se ve desde otra, y lo comprueba la base de datos, no solo la pantalla.
3. **Los datos de los clientes se quedan en la empresa.** A La Factoría llegan cifras, estados y referencias; no fichas.

---

## 2. Qué hay en el paquete

```
factoria-northlane360/
├── README.md                  ← este documento
├── docker-compose.yml         ← VPS: Postgres + API + web en un dominio
├── deploy/                    ← nginx, systemd, variables y roles de Postgres
├── servidor/                  ← el servidor (Python, FastAPI)
│   ├── app/                   ← todo el código: rutas, Freddy, agentes, seguridad
│   ├── db/eliot/              ← la base de datos, migración a migración (PostgreSQL)
│   │   ├── base/              ← los cimientos: identidad, departamentos, agentes, tareas
│   │   └── bootstrap/         ← arranque del primer holding
│   ├── conector/              ← la pieza que se instala en la web de cada empresa
│   ├── ops/                   ← aplicación controlada de migraciones
│   ├── scripts/               ← batería de pruebas de base de datos en local
│   └── tests/                 ← pruebas automáticas (851)
└── web/                       ← la aplicación web (React, TypeScript, Three.js)
    ├── src/                   ← pantallas, ciudad 3D, oficina 3D, acceso
    ├── public/                ← imágenes (ver nota sobre el avatar de Freddy)
    └── tests/                 ← pruebas automáticas (583)
```

En el código verás a menudo la palabra **ELIOT**: es el nombre interno del motor. Para quien lo usa, el producto se llama
La Factoría Northlane360 y el director se llama Freddy.

---

## 3. Los conceptos

| Concepto | Qué es |
|---|---|
| **Holding** | El grupo del propietario. Tiene hasta **5 parcelas**, una por empresa. |
| **Empresa** | Una parcela ocupada. Tiene nombre, proyecto, web y repositorio opcionales, y sus capacidades. |
| **Capacidad** | Algo que la empresa quiere que se le lleve: repositorio, web, SEO, marketing, email, pedidos, control de fallos, automatizaciones. Algunas crean departamento propio. |
| **Departamento** | Una oficina dentro de la empresa. Seis vienen siempre; el resto aparece al elegir capacidades. |
| **Agente** | Un trabajador de IA con nombre, puesto y especialidad, sentado en su departamento. |
| **Tarea** | Un trabajo concreto, con estado (pendiente, en cola, en curso, bloqueada, terminada) y responsable. |
| **Encargo** | Lo que el propietario le pide a un agente, hablando o con un formulario. Al confirmarlo se convierte en tarea. |
| **Memoria compartida** | Seis fichas por empresa que todos sus agentes conocen (ver [§7](#7-memoria-y-cerebro)). |
| **Plan / Misión** | Trabajo documental en varios pasos, con alcance fijo y revisión del propietario en cada entrega. |
| **Agente del portal** | Un agente que no vive en La Factoría sino en la web de la empresa (atención, cobros, entregas…). Se ve desde aquí por el conector. |
| **Observador** | Una persona invitada que puede verlo todo y no puede cambiar nada. |

**Departamentos y agentes que trae cada empresa**

| Departamento | Agente | Se crea |
|---|---|---|
| Dirección IA | Director de empresa IA | siempre |
| Desarrollo | Programador IA | siempre |
| Calidad | Verificador QA | siempre |
| Operaciones | Coordinador operativo IA | siempre |
| Marketing | Especialista de marketing IA | siempre |
| Administración | Analista administrativo IA | siempre |
| SEO y Contenidos | Especialista SEO IA | con la capacidad «SEO» |
| Atención y Email | Gestor de email IA | con la capacidad «email» |
| Pedidos | Gestor de pedidos IA | con la capacidad «pedidos» |
| Monitorización y Fallos | Vigilante de fallos IA | con la capacidad «control de fallos» |
| Automatizaciones | Ingeniero de automatizaciones IA | con la capacidad «automatizaciones» |

Los que la empresa aún no ha elegido se ven en la oficina como **puestos «por crear»**: una figura en blanco en una sala gris,
que invita a añadir esa capacidad.

---

## 4. La web, pantalla a pantalla

### Entrada
Una intro de unos cinco segundos: cielo azul, la cámara atraviesa las nubes y baja hasta la ciudad. Aparece el rótulo
**Northlane360** envuelto en un anillo dorado y, debajo, el acceso. Se puede saltar, y respeta a quien tiene el movimiento
reducido en su sistema.

Hay dos formas de entrar, y el servidor decide cuál ofrece:
- **Acceso propio**: usuario y contraseña en esa misma pantalla.
- **Página del proveedor de identidad**: se escribe el usuario y se continúa allí.

Los **registros nuevos están cerrados por defecto**: nadie puede crearse una cuenta hasta que el propietario lo ordene.

Tras entrar hay una **puerta**: si la cuenta no tiene acceso a nada (por ejemplo, un observador al que se le retiró), ve
«No tienes acceso» y solo puede cerrar sesión. No llega a ver la aplicación, ni vacía.

### La ciudad (Campus)
Vista 3D del holding: una rotonda con Freddy en el centro y cinco parcelas alrededor.
- Parcela ocupada: un edificio cuya altura depende de sus departamentos y cuyas ventanas se encienden según cuántos agentes
  están activos. Si tiene tareas bloqueadas, una baliza parpadea.
- Parcela libre: una obra con grúa, operarios y cartel de «Se vende». Desde ahí se da de alta una empresa nueva.
- **Campana de avisos**: lo que los agentes de las empresas tienen que decirte, sin ocupar la pantalla.
- Debajo: gestión de cada empresa (renombrar, perfil, capacidades, integración, retirar), almacén cifrado y accesos de solo consulta.

### La oficina de una empresa
La planta de la empresa en 3D, a plena luz, con una sala por departamento, cada una con su color y su mobiliario.

- **Agentes**: cada uno en su mesa, con una placa con su nombre y su puesto. Tienen nombre de pila, cara y forma de vestir
  propias (catorce estilos), siempre las mismas para el mismo agente y sin repetirse dentro de una empresa.
- **Te necesita**: el agente levanta la mano y la agita, y lleva un punto rojo con el número de cosas pendientes.
- **Al pulsar un agente**: la cámara se acerca y sale un bocadillo como si hablaras con él, con sus acciones: pedir una tarea,
  hablar, abrir su módulo, activarlo.
- **Lista del equipo** a la izquierda, con buscador y filtros (todos, activos, en espera, inactivos).
- **«Te toca»**: una sola bandeja con todo lo que espera al propietario: tareas bloqueadas, informes por revisar y avisos de
  los agentes del portal.
- **Memoria compartida**: las fichas que conocen todos los agentes de la empresa.
- **Controles**: zoom, recentrar, «toda la oficina», pausar la animación, y vista de lista o plano 2D para quien no tiene 3D.

Tres salas especiales:

| Sala | Para qué |
|---|---|
| **Dirección** | El propietario y Freddy. |
| **Oficina de Empleo** | Donde esperan los agentes **inactivos**: en cola, sentados o paseando. El propietario está en el mostrador «en modo reclutación». Al activar a uno, se va a su mesa. |
| **Sala de Descanso** | Con el botón «Modo descanso», todo el equipo camina hasta allí y baila bajo una bola de discoteca. Mientras dura, los agentes de esa empresa están **apagados de verdad** (ver [§9](#9-seguridad)). |

### Hablar con un agente
Un chat con un agente concreto. El agente:
- contesta en primera persona con lo que La Factoría tiene verificado de él (sus tareas y su estado), sin inventar;
- explica **qué sabe hacer** su departamento y cuáles son sus límites;
- si le pides algo que no es de lo suyo, lo dice y señala qué departamento encaja;
- pregunta lo que le falte y, cuando está claro, **propone un encargo** en una tarjeta.

El encargo solo se crea cuando pulsas **«Confirmar encargo»**.

### Resto de pantallas
Hablar con Freddy, Tareas, Agentes, Resumen, Asignaciones, Documentos, Informes, Misiones, Actividad, Supervisión, Organigrama,
Empresas, Departamentos y Configuración. Las cinco primeras están siempre a la vista; el resto se pliega en «Más herramientas».

---

## 5. Los agentes

Hay dos familias, y conviene no confundirlas.

### 5.1 Agentes de la oficina
Viven en La Factoría. Son los de la tabla del [§3](#3-los-conceptos).

**Ciclo de vida**
1. Nacen **inactivos**, en la Oficina de Empleo.
2. El propietario los **activa**. Pasan a «disponible».
3. Reciben **encargos**, que se convierten en tareas.
4. Trabajan dentro de los límites aprobados y **entregan para revisión**: el propietario acepta o devuelve.

**Qué hacen hoy de verdad**
- Conversar sobre su trabajo y proponer encargos.
- **Trabajo documental**: leer documentos de un repositorio autorizado y entregar un informe con citas línea a línea.
  Va por permisos explícitos: el propietario aprueba qué documento, qué agente y con qué presupuesto.
- **Planes y misiones**: encadenar varios pasos documentales, con control (pausar, reanudar, cancelar) y, si se autoriza,
  un piloto automático que avanza dentro de un presupuesto aprobado una vez.
- **Tareas recurrentes** por departamento.

**Qué no hacen**: no publican cambios, no envían nada al exterior y no dan un trabajo por bueno ellos mismos.

### 5.2 Agentes del portal
Viven **en la web de la empresa**, no en La Factoría. Son los que tocan el día a día del negocio: atender el chat de
clientes, vigilar cobros y entregas, avisar de caducidades. Cada empresa define los suyos con el conector ([§8](#8-cómo-se-conecta-una-empresa)).

Cada agente del portal tiene tres cosas:

| Pieza | Qué es | Ejemplo |
|---|---|---|
| **Vigilancia** | Reglas que revisa cada pocos minutos; si algo va mal, levanta un aviso. | «Un pedido pagado lleva 30 minutos sin enviarse». |
| **Consultas** | Preguntas que el propietario puede hacerle a través de Freddy. | «¿Cuánto se ha vendido hoy?» |
| **Acciones** | Cosas que puede hacer, siempre en dos pasos y con confirmación. | «Reenviar el pedido X». |

Los avisos tienen tres niveles: **urgente**, **importante** e **informativo**.

Desde La Factoría, de un agente del portal se ve: su estado (activo, con avisos, en alerta, frenado por tope de gasto,
apagado), su actividad de las últimas 24 horas, su gasto del mes frente a su tope, y sus avisos abiertos.

---

## 6. Freddy y el administrador

Freddy es el director del holding. No pertenece a ninguna empresa: las vigila a todas. Con el administrador habla por
**un bot de Telegram privado**.

### 6.1 Quién puede hablar con Freddy
Solo el administrador, desde su chat y su cuenta. Se configura con el identificador de ese chat.

Si **otra persona** escribe al bot:
- recibe un mensaje fijo diciendo que es un asistente privado y que no se le puede atender;
- el administrador recibe un aviso con lo que escribió, su usuario de Telegram, su identificador y un botón para abrir su chat;
- hay tope de avisos por hora para que nadie pueda inundar al administrador.

### 6.2 Lo que Freddy dice por iniciativa propia

| Cuándo | Qué envía |
|---|---|
| Aparece un aviso nuevo, sube de gravedad o suma casos | El aviso, con la empresa resaltada, el agente, qué pasa y qué propone. |
| Un aviso deja de existir | «✅ Resuelto». |
| Algo urgente sigue abierto | Un recordatorio cada 6 horas. |
| El portal de una empresa lleva 15 minutos sin contestar | Un aviso, una vez; y otro cuando vuelve. |
| Un cliente pide hablar con el administrador, o el agente de atención no sabe contestar o llega a su tope | Un aviso inmediato con el caso. |
| **Cada noche a las 21:00** | El resumen del día. |

**La empresa va siempre resaltada**, en su propia línea (`🏢 NOMBRE`), para saber de cuál se habla.

**El resumen diario** lleva, por empresa: ventas del día, importe facturado ese día, clientes nuevos, renovaciones, las
incidencias leves o medias que quedan «para mañana» y cuántas urgentes siguen abiertas. Si hay varias empresas, un total.
Solo cifras: ni nombres, ni teléfonos, ni referencias de pedido.

Lo urgente, además, puede llegar **de viva voz** como nota de audio.

### 6.3 Lo que el administrador puede pedirle

**Órdenes fijas** (instantáneas y sin coste):

| Orden | Respuesta |
|---|---|
| `avisos` | Lo que los agentes tienen pendiente. |
| `estado` | Cómo está cada agente de cada empresa. |
| `empresas` | Las empresas que vigila. |
| `pedido <referencia>` | Si ese pedido sale en algún aviso. |
| `ayuda` | La lista. |

**Con sus palabras**, por escrito o con una **nota de voz**: «¿cuánto se ha vendido hoy?», «¿cómo va el pedido tal?».
Freddy entiende la pregunta, decide a qué empresa preguntar, consulta a sus agentes y contesta. Recuerda el hilo de la
conversación durante 30 minutos.

### 6.4 Niveles de información
- **Cifras y estados**: ventas, cuentas, caducidades, estado de un pedido. Es lo normal.
- **Datos de clientes**: la ficha de un cliente, su conversación con atención, los casos que el agente ha pasado al
  administrador. Solo en el chat privado del administrador, solo si la empresa lo expone en su conector, y **cada consulta
  queda registrada en la empresa**. Tiene tope diario.

Freddy habla de cada caso **por su cliente**, no por el número de pedido, cuando puede saberlo.

### 6.5 Acciones
Freddy puede **proponer** una acción en una empresa (por ejemplo, reintentar una entrega). Nunca la ejecuta directamente:
1. explica exactamente qué va a hacer;
2. espera a que el administrador conteste **«sí»**;
3. la ejecuta y dice el resultado.

Se apaga entero con un interruptor, y además cada empresa decide si acepta acciones.

### 6.6 Freddy en la web
En «Hablar con Freddy» se le puede preguntar por una empresa y contesta con datos verificados. Un observador recibe una
versión que no incluye datos de clientes ni voz.

---

## 7. Memoria y cerebro

### 7.1 Memoria

| Memoria | Dónde vive | Qué guarda | Cuánto dura |
|---|---|---|---|
| **Memoria compartida de la empresa** | Base de datos | Seis fichas que escribe el propietario: *a quién vendo*, *mis precios*, *propuesta de valor*, *tono de marca*, *productos y servicios*, *preguntas frecuentes*. | Hasta que se cambia. |
| **Historial de trabajo** | Base de datos | Tareas, eventos, encargos, informes, revisiones, planes, misiones y auditoría. | Permanente. |
| **Conversación con un agente** | Memoria del servidor | Los últimos 6 mensajes de cada conversación. | Hasta reiniciar. |
| **Conversación con Freddy** | Memoria del servidor | Los últimos mensajes, 30 minutos. | 30 minutos. |
| **Estado de avisos** | Memoria del servidor | Qué avisos están abiertos y cuándo se avisó. | Hasta reiniciar; al arrancar manda un resumen de lo abierto. |

Las conversaciones **no se guardan en disco** a propósito. La memoria compartida es la que hace que todos los agentes de
una empresa hablen de lo mismo.

### 7.2 Cerebro
Cada pieza que «piensa» está en un archivo, con sus instrucciones escritas en castellano y sus límites:

| Quién | Archivo | Modelo | Límites |
|---|---|---|---|
| Agente de oficina (chat y encargos) | `servidor/app/eliot_agent_chat.py` | rápido y económico | 40 preguntas por persona y hora; solo ve sus propios datos. |
| Freddy (conversación) | `servidor/app/eliot_freddy_chat.py` | el más capaz | 80 preguntas al día, tope mensual de gasto compartido, 6 idas y vueltas por pregunta. |
| Freddy (voz) | `servidor/app/eliot_freddy_voice.py` | transcripción y voz | Solo lo urgente se dice en voz alta. |
| Asistente de integración | `servidor/app/eliot_integration_assistant.py` | — | Lee un repositorio y propone cómo conectar la empresa; tope diario por empresa. No instala nada. |
| Trabajo documental | `servidor/app/eliot_document_analysis.py`, `eliot_document_worker.py` | — | Solo con aprobación expresa y presupuesto. |

Principios que comparten todas:
- **Solo lo verificado.** Si un dato no está, el agente dice que no lo tiene; no lo inventa.
- **Lo que viene de fuera son datos, no órdenes.** El título de una tarea o el texto de un documento nunca se obedece.
- **Nunca se queda mudo.** Si la IA falla, se niega o se pasa del tope, contesta un texto fijo construido con los mismos datos.
- **Proponer no es hacer.** Un agente propone; el propietario confirma.

---

## 8. Cómo se conecta una empresa

Hay dos niveles, y el primero no necesita programar.

### Nivel 1 — Darla de alta
Desde una parcela libre: nombre, proyecto, web, repositorio y capacidades. Se crean al momento sus departamentos y sus
agentes, inactivos. Con eso ya tiene oficina, tareas, encargos y memoria.

### Nivel 2 — Conectar su web (el conector)
Para que Freddy vigile el negocio real de la empresa, se instala en su web la pieza de `servidor/conector/`:

1. Copiar `freddy-conector.mjs` al proyecto de la empresa.
2. Escribir **un archivo de configuración** con sus vigilantes, sus consultas y sus acciones
   (hay un ejemplo de una tienda en `conector/ejemplo-cloudflare-pages/`).
3. Publicar tres rutas: `resumen-freddy`, `consulta-freddy` y `accion-freddy`.
4. Poner una clave compartida entre la empresa y La Factoría.
5. Comprobarlo con `conector/comprobar.mjs`.

El conector garantiza que lo que sale de la empresa tiene la forma correcta: niveles, claves, cifras y **referencias**, y
descarta lo que parezca un nombre, un correo o un teléfono. Las instrucciones completas están en `servidor/conector/LEEME.md`.

En el lado de La Factoría, cada empresa conectada es una entrada de configuración con la dirección de su resumen, su clave
y la dirección de su panel.

### El asistente de integración
En la gestión de cada empresa, pestaña «Integración»: lee su repositorio y propone qué vigilantes, consultas y acciones
tendría sentido conectar. Solo propone.

---

## 9. Seguridad

**Identidad.** Las cuentas y sus contraseñas las guarda un proveedor de identidad (Auth0). El servidor comprueba en cada
petición la firma del permiso, quién lo emitió, para quién es y qué alcance tiene. Cambiar cosas exige un alcance mayor
que leerlas.

**Aislamiento entre empresas.** Está en la base de datos: las tablas tienen seguridad por filas, la aplicación entra con un
rol que no puede leerlas directamente y solo puede llamar a funciones que comprueban quién pregunta. Una prueba automática
recorre todas esas funciones haciéndose pasar por un intruso de otra empresa.

**Solo consulta (observadores).** El propietario crea un enlace de invitación de un solo uso, que caduca a las 72 horas.
Quien lo canjea ve lo mismo que el propietario y no puede cambiar nada: el servidor rechaza cualquier petición que no sea
leer —salvo preguntar en el chat— en un único punto. Máximo diez. Se retira al momento, y a quien se le retira se le cierra
la puerta. El enlace solo se muestra una vez; en la base se guarda su huella, no el código.

**Acceso propio.** Si se enciende, usuario y contraseña se escriben en la pantalla de La Factoría. La contraseña solo viaja
al proveedor de identidad: no se guarda ni se registra. Hay tope de intentos por cuenta y por dirección, y los errores no
revelan si un correo existe.

**Registros cerrados.** Por defecto no se puede crear ninguna cuenta. Si el propietario los abre, sigue haciendo falta una
invitación viva.

**Modo descanso.** Mientras está encendido en una empresa, el servidor rechaza el arranque de cualquier trabajo de IA de
esa empresa: chat, análisis, documentos, planificación, integrador, cola y piloto automático; y el trabajador en segundo
plano no toma trabajos ni crea tareas recurrentes. Lo que ya estaba en marcha termina. Afecta solo a esa empresa.

**Agentes inactivos por defecto.** Nada trabaja ni gasta hasta que el propietario lo activa.

**Datos de clientes.** No se guardan en La Factoría. Del portal llegan cifras, claves de aviso y referencias. La excepción
—fichas de cliente para el administrador por Telegram— es opcional, la decide cada empresa y queda registrada allí.

**Almacén cifrado.** Los documentos que se guardan fuera (Google Drive) se cifran en el servidor antes de salir. El
proveedor solo ve bloques ilegibles.

**Secretos.** Ninguna clave está en el código. Todas son variables del servidor. Los textos de documentos se revisan para
no enviar a un modelo algo que parezca una clave.

**Gasto.** Cada pieza con IA tiene su tope: por hora, por día o por mes.

---

## 10. El servidor por dentro

Python con FastAPI. Todo está en `servidor/app/`. Los archivos principales:

| Archivo | Qué hace |
|---|---|
| `main.py` | Arranque, orígenes permitidos y montaje de las rutas. |
| `organizations_api.py` | Identidad, empresas, departamentos, agentes, tareas, chat, y las rutas de análisis. |
| `eliot_holding_api.py` | Holding: altas de empresa, perfil, capacidades, encargos, memoria y rutinas. |
| `eliot_office_api.py`, `eliot_office_overview.py` | La foto de la oficina que pinta la web. |
| `eliot_agent_chat.py` | Chat con un agente y propuesta de encargos. |
| `eliot_notifier.py` | Freddy: vigilancia, avisos por Telegram y órdenes fijas. |
| `eliot_freddy_chat.py` | Freddy: conversación, consultas a las empresas y acciones con confirmación. |
| `eliot_freddy_voice.py` | Freddy: notas de voz. |
| `eliot_daily_report.py` | Resumen diario. |
| `eliot_portal_agents_api.py` | Lectura de los agentes del portal y recepción de sus avisos al momento. |
| `eliot_integration_assistant.py` | Asistente de integración. |
| `eliot_break.py` | Modo descanso. |
| `eliot_readonly.py`, `eliot_viewers_api.py` | Solo consulta e invitaciones. |
| `eliot_auth_api.py` | Acceso propio, alta y recuperación de contraseña. |
| `eliot_storage_*.py` | Almacén cifrado. |
| `eliot_document_*.py`, `eliot_mission_*.py`, `eliot_plan_*.py`, `eliot_objective_*.py` | Trabajo documental, planes, misiones y revisiones. |
| `eliot_github_*.py`, `eliot_tool_*.py` | Lectura de repositorios con permisos por empresa. |
| `eliot_document_worker.py` | Trabajador en segundo plano (proceso aparte). |
| `eliot_*_budget*.py`, `eliot_model_limits.py` | Topes de gasto. |

Cada archivo empieza con un comentario que explica qué hace y qué no puede hacer.

---

## 11. La base de datos

PostgreSQL. Las migraciones están numeradas y se aplican en orden.

| Migraciones | Qué añaden |
|---|---|
| `base/001`–`008` | Identidad (usuarios, empresas, pertenencias), departamentos, agentes, tareas y eventos. |
| `004`–`015` | Lectores por empresa, creación y estado de tareas, actividad, asignación y disponibilidad de agentes. |
| `016`–`024` | Aprobaciones, análisis, presupuesto, permisos de ejecución y lectura de repositorios. |
| `025`–`033` | Cola de trabajos, revisiones, planes, misiones y piloto automático. |
| `034` | Holding: empresas, capacidades, plantilla de departamentos y rutinas. |
| `035` | Encargos a agentes y memoria compartida. |
| `036`–`038` | Renombrar empresa, almacén cifrado y retirar una empresa. |
| `039` | Observadores e invitaciones. |
| `040` | Modo descanso. |
| `041` | Comprobación de invitación para el alta de cuentas. |

Roles: uno para migrar, otro para la aplicación (sin acceso directo a las tablas) y otro para el trabajador en segundo plano.

`servidor/ops/install_schema.py` instala el esquema completo en un VPS (Postgres nativo o almacén portable).
`servidor/ops/apply_migrations_once.py` aplica las migraciones nuevas una sola vez, comprobando antes que cada una no esté
ya puesta y exigiendo una confirmación expresa.

La base **propia** de La Factoría puede ser PostgreSQL (recomendado: aislamiento por filas y trabajo documental),
MySQL, MariaDB, SQLite o SQL Server. MongoDB no vale para esa base; sí vale para **conectar la base de una empresa**
al conector de Freddy. Con `DATABASE_URL` se elige el motor:

```
postgresql://eliot_identity_app:clave@127.0.0.1:5432/eliot_dev
mysql://factoria:clave@127.0.0.1:3306/factoria
mariadb://factoria:clave@127.0.0.1:3306/factoria
sqlite:////var/lib/factoria/factoria.db
mssql://factoria:clave@127.0.0.1:1433/factoria
```

En MySQL, MariaDB, SQLite y SQL Server el aislamiento entre empresas lo hace el servidor, no la base. El trabajo
documental, las misiones y GitHub siguen pidiendo PostgreSQL nativo.

---

## 12. Puesta en marcha

### Qué necesitas

| Pieza | Para qué | ¿Obligatoria? |
|---|---|---|
| Un VPS, o hosting con aplicación Python 3.12 (Passenger / cPanel) | El API. | Sí |
| PostgreSQL 16+ (recomendado) u otro SQL | La base de La Factoría. | Sí |
| Hosting estático o nginx en el VPS | La web. | Sí |
| Cuenta de Auth0 | Identidad. | Sí |
| Clave de Anthropic | El cerebro de los agentes y de Freddy. | Para que piensen |
| Bot de Telegram | El canal de Freddy. | Para Freddy |
| Clave de OpenAI | Voz de Freddy y parte del trabajo documental. | No |
| Google Drive | Almacén cifrado. | No |
| App de GitHub | Lectura de repositorios. | No |

### Camino: un clic en un PaaS (Railway)

Si quieres **montar La Factoría y luego enganchar tus webs/tiendas** sin administrar un VPS: **Railway** (alternativa: Render).

En railway.com/new **no elijas Docker Image**. Eso es una imagen ya publicada, no este código.
Pulsa **Empty Project** → dentro, **Database → PostgreSQL** → dos servicios **GitHub Repository** (`servidor` y `web`).

Tus tiendas **no se migran** ahí. WooCommerce, PrestaShop o tu PHP siguen en su hosting; La Factoría las vigila con el conector o con su MySQL. Shopify, sin base propia, solo por HTTP.

Cuentas previas: Railway, Auth0 y (para que piensen) Anthropic. Clicks: `deploy/plataforma/LEEME.md`.

### Camino rápido: VPS con Docker

1. Copia `deploy/env.vps.example` a `.env` en la raíz del paquete y rellénalo (dominio, Auth0, claves de Postgres).
2. `docker compose up -d --build`
3. La web queda en el puerto `FACTORIA_HTTP_PORT` (80 por defecto). nginx enruta `/v1` al API: deja `VITE_API_ROOT` vacío.
4. Pon TLS (Caddy, nginx+certbot o el panel del VPS) delante.

### Camino: solo hosting, sin VPS

Sí, si el panel deja **una aplicación Python 3.12** (cPanel «Setup Python App», Passenger, Plesk, PythonAnywhere).
Un hosting que solo tiene PHP no puede correr el API.

1. MySQL o MariaDB del panel → `DATABASE_URL=mysql://…` y `ELIOT_DB_STRICT_ACCOUNTS=off`.
2. API: sube `servidor/`, arranque `passenger_wsgi.py`, variables de `deploy/env.hosting.example`.
3. `python ops/install_schema.py` una vez.
4. Web: `npm run build` con `VITE_API_ROOT=https://api.tu-dominio.com` y sube `web/dist` al `public_html`.

Pasos, límites (Passenger hiberna, sin trabajo documental) y ejemplo de variables: `deploy/hosting/LEEME.md`.

### Camino: web en hosting estático + API en VPS

1. En el VPS: API con Docker o `uvicorn`, Postgres o la base que tengas, `ELIOT_FRONTEND_ORIGINS` = la URL pública de la web.
2. En el hosting (Cloudflare Pages, Netlify, nginx estático): `npm run build` con `VITE_API_ROOT=https://api.tu-dominio.com`.
3. Publica la carpeta `web/dist`.

### Camino: VPS sin Docker

Unidades en `deploy/factoria-api.service` y `deploy/nginx-host.conf`. Instala el esquema con
`python ops/install_schema.py` desde `servidor/`.

### Pasos (detalle)

1. **Base de datos**: en Postgres, crear la base y los roles (`deploy/postgres/init.sh`) y aplicar el esquema
   (`python ops/install_schema.py`). `scripts/local_pg_pipeline.sh` es la referencia del orden exacto sobre una base
   desechable. En MySQL/MariaDB/SQLite/SQL Server el mismo comando crea el almacén portable.
2. **Servidor**: `pip install -r requirements.txt` y `uvicorn app.main:app`. Hay `Dockerfile`.
3. **Variables del servidor**: las de identidad, `DATABASE_URL` o `ELIOT_IDENTITY_DB_*`, los orígenes de la web
   (`ELIOT_FRONTEND_ORIGINS` y `ELIOT_FRONTEND_ORIGIN`) y las que quieras encender ([§13](#13-interruptores)).
4. **Web**: copiar `.env.example` a `.env.local`, rellenarlo (`VITE_API_ROOT` incluido), `npm install` y `npm run build`.
5. **Primer holding**: `db/eliot/bootstrap/034_holding_bootstrap.sql` (Postgres) o `ELIOT_BOOTSTRAP_SUBJECT` (portable).
6. **Freddy**: crear el bot en Telegram y poner su clave y el identificador de tu chat.

### Conectar la base de una empresa (cualquier motor)

Además del conector HTTP (`servidor/conector/`), una empresa puede dejar que Freddy lea **su** base, sin copiar fichas:

- **Desde La Factoría**, en `ELIOT_PORTAL_FEEDS`, `"kind": "database"` y `db_url_env` apuntando a una variable
  `ELIOT_COMPANY_DB_…` con la URL (`postgresql://`, `mysql://`, `mariadb://`, `sqlite://`, `mssql://`, `mongodb://`).
  Los vigilantes son consultas `SELECT` escritas por el operador; no se acepta SQL que llegue por la red.
- **En el VPS de la empresa** (recomendado: la base no se abre a internet): `python conector/db/servidor.py` con
  `FREDDY_DB_URL` y `conector/db/empresa.ejemplo.json`. Publica las tres rutas de siempre hacia Freddy.

---

## 13. Interruptores

Todo lo delicado viene **apagado** y se enciende con una variable del servidor.

| Variable | Qué hace | Por defecto |
|---|---|---|
| `ELIOT_ENABLE_ORGANIZATIONS_API` | Monta las rutas de empresas. | apagado |
| `DATABASE_URL` / `ELIOT_DB_ENGINE` | Motor de la base propia (postgres, mysql, mariadb, sqlite, mssql). | postgres |
| `ELIOT_FRONTEND_ORIGINS` | Lista blanca de orígenes de la web (hosting o VPS). | `https://app.tu-factoria.example` |
| `ELIOT_DB_STRICT_ACCOUNTS=off` | Permite otro usuario/nombre de base (VPS, MySQL, SQLite). | cuentas fijas `eliot_identity_app` / `eliot_dev` |
| `ELIOT_AUTO_PROVISION_USER=on` | Crea el usuario al primer acceso (almacén portable). | apagado |
| `ELIOT_COMPANY_DB_WRITES=on` | Permite acciones SQL en la base de una empresa. | apagado |
| `ELIOT_TELEGRAM_BOT_TOKEN`, `ELIOT_TELEGRAM_CHAT_ID` | Freddy por Telegram. | sin ellas, no hace nada |
| `ELIOT_NOTIFIER=off` | Apaga los avisos. | encendido si hay Telegram |
| `ELIOT_FREDDY_CHAT=off` | Apaga la conversación con IA; quedan las órdenes fijas. | encendido si hay clave |
| `ELIOT_FREDDY_ACTIONS=off` | Freddy no propone acciones. | encendido |
| `ELIOT_FREDDY_VOICE=off` | Sin notas de voz. | encendido si hay clave |
| `ELIOT_DAILY_REPORT=off` / `ELIOT_DAILY_REPORT_HOUR` | Resumen diario y su hora. | encendido, 21 |
| `ELIOT_AGENT_CHAT=off` | Los agentes contestan solo con texto fijo. | encendido si hay clave |
| `ELIOT_PORTAL_FEEDS` | Empresas conectadas por el conector. | ninguna |
| `ELIOT_OWN_LOGIN=on` (+ datos de Auth0) | Acceso propio. | apagado |
| `ELIOT_SIGNUP=on` | Permite crear cuentas (con invitación). | **cerrado** |
| `ELIOT_READONLY_VIEWERS` | Observadores fijados por configuración. | ninguno |
| `ELIOT_INTEGRATOR=off` | Apaga el asistente de integración. | encendido si hay clave |
| `ELIOT_DOCUMENT_WORKER_ENABLED`, `ELIOT_DURABLE_DOCUMENT_ENABLED` | Trabajo documental en segundo plano. | apagado |
| `ELIOT_GITHUB_TOOL_ENABLED` | Lectura de repositorios. | apagado |
| `ELIOT_STORAGE_MASTER_KEY` (+ datos de Drive) | Almacén cifrado. | apagado |

---

## 14. Pruebas

| Dónde | Cuántas | Cómo |
|---|---|---|
| Servidor | 851 | `cd servidor && python -m pytest tests -q` |
| Web | 583 | `cd web && npm install && npx vitest run` |
| Base de datos | batería completa | `SCHEMA_DIR=db/eliot/base scripts/local_pg_pipeline.sh --with-new` sobre una base **desechable** |

Las tres baterías se ejecutaron sobre **este mismo paquete**, ya limpio, y pasan.

Las pruebas son también documentación: cada una lleva por nombre una frase que dice qué garantiza
(por ejemplo, «el observador consulta como el propietario y no puede cambiar nada»).

---

## 15. Estado real y límites

Para vender bien hay que saber qué está maduro y qué no.

**Funciona y está probado**
- Ciudad, oficinas, agentes, tareas, encargos, memoria compartida.
- Freddy por Telegram: avisos, órdenes, conversación, acciones con confirmación, desconocidos.
- Conector de empresas.
- Solo consulta e invitaciones, puerta de entrada, modo descanso.

**Construido y con pruebas automáticas, pero sin rodaje real todavía**
- Acceso propio (usuario y contraseña en nuestra pantalla).
- Resumen diario.
- Encargos por diálogo con la IA real.

**Límites conocidos**
- **Un holding, hasta cinco empresas.** Para vender a muchos empresarios hay dos caminos: una instalación por cliente (lo
  que este paquete permite hoy) o convertirlo en un servicio compartido, que es trabajo por hacer.
- El estado de Freddy y las conversaciones viven en la memoria del servidor: se pierden al reiniciar.
- El resumen diario solo incluye empresas con conector.
- Los agentes de oficina hoy hacen sobre todo trabajo documental y de análisis; no ejecutan acciones sobre sistemas externos.
- Los textos de avisos que trae la web están pensados para un negocio de venta en línea; cada empresa puede traer los suyos
  desde su conector.
- La interfaz está solo en castellano.
- El trabajo documental con modelos de OpenAI y la conversación con modelos de Anthropic conviven; unificar proveedor es opcional.

---

## 16. Antes de venderlo

Cosas que este paquete no resuelve y que conviene cerrar con un profesional:

1. **Avatar de Freddy.** El modelo 3D y las imágenes originales **no van en el paquete**: se han sustituido por una figura
   neutra. El personaje original recuerda a la imagen de un artista real y venderlo así puede traer problemas de derechos de
   imagen. Hay que encargar un personaje propio. El código ya lo admite: basta poner el modelo en `web/public/freddy-3d/` y
   las imágenes en `web/public/freddy-views/`; si no hay modelo, se pinta una figura sencilla.
2. **Marca.** Comprobar que «Northlane360», «La Factoría» y «Freddy» se pueden registrar y usar comercialmente.
3. **Licencias de terceros.** El producto usa librerías de código abierto (React, Three.js, FastAPI y otras): revisar sus
   licencias antes de redistribuir.
4. **Protección de datos.** Quien lo instale trata datos de sus clientes: hará falta contrato de encargo de tratamiento,
   política de privacidad y decidir qué expone cada empresa a Freddy. Las notas de voz y parte del trabajo documental viajan
   a un proveedor externo.
5. **Proveedores.** Cada cliente necesita sus propias cuentas (identidad, modelos de IA, Telegram) y paga su propio consumo.
6. **Soporte y actualizaciones.** Definir cómo se entregan las mejoras a quien ya lo tiene instalado.

# Railway — qué pulsar en railway.com/new

En esa pantalla **no elijas Docker Image**. Eso pide una imagen ya publicada (nginx, postgres…), no este proyecto.

## Orden

### 1. GitHub Repository
Elige el repo `tododigital23/factoria-northlane360` (no Docker Image).
Ese primer servicio es el **API**. Si el build dice «Railpack failed», Settings → Build → Builder = Dockerfile, o espera al `Dockerfile` de la raíz.

### 1b. Empty Project (alternativa)
Abre el proyecto vacío. Ahí montas las tres piezas.

### 2. Database
En el proyecto: **+ Create** → **Database** → **PostgreSQL**.
Railway crea `DATABASE_URL`. No toques la base de tus tiendas: esta es solo la de La Factoría.

### 3. API
**+ Create** → **GitHub Repository** (el código tiene que estar en GitHub).

- Root directory: `servidor`
- Dockerfile: se detecta solo
- Variables (Variables → el servicio api):

```
ELIOT_ENABLE_ORGANIZATIONS_API=true
ELIOT_DB_STRICT_ACCOUNTS=off
ELIOT_AUTO_PROVISION_USER=on
DATABASE_URL=${{Postgres.DATABASE_URL}}
ELIOT_FRONTEND_ORIGINS=https://TU-WEB.up.railway.app
ELIOT_FRONTEND_ORIGIN=https://TU-WEB.up.railway.app
ELIOT_OIDC_JWKS_URL=https://tu-tenant.eu.auth0.com/.well-known/jwks.json
ELIOT_OIDC_ISSUER=https://tu-tenant.eu.auth0.com/
ELIOT_OIDC_AUDIENCE=https://api.eliot.internal
```

Al arrancar corre `ops/start.sh`: instala el esquema y levanta el API. Generate Domain en el servicio api.

Si el log dice `KeyError: 'PGHOST'` o `falta DATABASE_URL`: el Postgres está en el proyecto pero **no está enganchado** al API. Servicio de la API → **Variables** → New Variable → **Add a variable reference** → Postgres → `DATABASE_URL` → Redeploy.

### 4. Web
**+ Create** → **GitHub Repository** otra vez, mismo repo.

- Root directory: `web`
- Variables de **build**:

```
VITE_API_ROOT=https://TU-API.up.railway.app
VITE_AUTH0_DOMAIN=tu-tenant.eu.auth0.com
VITE_AUTH0_CLIENT_ID=…
VITE_AUTH0_AUDIENCE=https://api.eliot.internal
```

Generate Domain. Copia esa URL a `ELIOT_FRONTEND_ORIGINS` del API y redespliega el API una vez.

En Auth0: Allowed Callback / Logout / Web Origins = la URL de la web.

Lista completa: `deploy/env.railway.example`.

## Si aún no tienes el código en GitHub

Railway no puede construir desde tu disco con «Docker Image». Sube el repo a GitHub y en el paso 3 elige **GitHub Repository**.

## Tus tiendas

Siguen en su hosting. Cuando La Factoría esté en marcha, cada una se engancha con el conector o con su MySQL (`ELIOT_PORTAL_FEEDS`). No las des de alta como Database en Railway.

# Solo hosting, sin VPS

Sí es posible **si el hosting puede correr Python 3.12 como aplicación** (cPanel «Setup Python App» /
Passenger, DirectAdmin, Plesk, PythonAnywhere). No vale el hosting que solo ofrece PHP y MySQL.

La web es estática. El API es un proceso Python. MySQL o MariaDB del panel sustituyen a Postgres:
oficina, empresas, agentes y Freddy por Telegram funcionan; el trabajo documental y GitHub no
(esas piezas piden Postgres nativo).

## Piezas

| Pieza | Dónde |
|---|---|
| Web (`web/dist`) | Subdominio estático, p. ej. `https://app.tu-dominio.com` |
| API (`servidor/`) | Aplicación Python, p. ej. `https://api.tu-dominio.com` |
| Base | MySQL/MariaDB del panel |

Dos subdominios. No hace falta VPS.

## 1. Base MySQL

En el panel: crea una base, un usuario y dale todos los privilegios sobre esa base.
Anota host (`localhost` casi siempre), nombre, usuario y clave.

## 2. API (aplicación Python)

1. Sube la carpeta `servidor/` al hosting.
2. Panel → **Setup Python App** (o Passenger):
   - Python 3.12
   - directorio de la aplicación = `servidor`
   - archivo de arranque = `passenger_wsgi.py`
3. En el entorno virtual del panel:
   ```bash
   pip install -r requirements.txt
   ```
4. Copia `deploy/env.hosting.example` a `servidor/.env` y rellénalo.
   `ELIOT_FRONTEND_ORIGINS` es la URL **https** de la web, sin barra al final.
5. Instala el esquema una vez:
   ```bash
   cd servidor
   python ops/install_schema.py
   ```
6. Reinicia la aplicación Python en el panel. Prueba `https://api.tu-dominio.com/health`.

Passenger duerme el proceso si nadie entra. Freddy por Telegram puede callar hasta la
siguiente visita a la web. En hosting no hay trabajador en segundo plano.

## 3. Web

En el ordenador:

```bash
cd web
cp .env.example .env.local
```

En `.env.local`:

```
VITE_API_ROOT=https://api.tu-dominio.com
VITE_AUTH0_DOMAIN=…
VITE_AUTH0_CLIENT_ID=…
VITE_AUTH0_AUDIENCE=https://api.eliot.internal
```

```bash
npm install
npm run build
```

Sube el contenido de `web/dist` al `public_html` del subdominio de la web (incluye `.htaccess`).

## Qué no cubre este camino

- Hosting **solo PHP** (no hay proceso Python): el API no arranca.
- Trabajo documental, misiones y lectura de GitHub: hace falta PostgreSQL.
- Freddy 24/7 sin que nadie abra la web: Passenger hiberna. Eso pide un VPS o un PaaS que no duerma.

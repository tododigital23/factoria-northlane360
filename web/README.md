# Web de La Factoría Northlane360

React + TypeScript + Three.js. La explicación completa está en el `README.md` de la carpeta superior.

```bash
cp .env.example .env.local   # y rellénalo
npm install
npm run dev
npx vitest run
npm run build
```

- La dirección del servidor es `VITE_API_ROOT` (vacío = mismo dominio; si no, `https://api.tu-dominio.com`).
- `preview-campus.html` abre una vista previa con datos de ejemplo, sin servidor ni cuentas:
  `?view=office`, `?view=intro`, `?view=app`.
- El avatar de Freddy de `public/` es una figura neutra de sustitución.

# FlexPOS — Microservicio de facturación ARCA

Servidor Node.js que emite comprobantes electrónicos contra AFIP/ARCA usando
`@arcasdk/core`. Existe porque el SDK necesita Node.js (no Deno/Edge) para
firmar correctamente la autenticación WSAA contra los servidores de AFIP.

## Endpoints

- `GET  /`         → health check
- `POST /test`     → prueba conexión y certificado contra AFIP
- `POST /emitir`   → emite un comprobante, devuelve el CAE

Ambos POST esperan header `Authorization: Bearer <token de Supabase>` y
`{ tenant_id, ... }` en el body.

## Probar en local

```sh
cd flexpos-arca-server
npm install
cp .env.example .env     # completar las claves de Supabase
npm run dev
```

Luego: `curl http://localhost:8080/` debería responder `{ ok: true, ... }`.

## Desplegar en Railway (recomendado)

1. Crear cuenta en railway.app
2. Subir este proyecto a un repo de GitHub (o usar `railway up` con el CLI)
3. En Railway: New Project → Deploy from GitHub repo → elegir este repo
4. En la pestaña **Variables**, cargar:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   (el `PORT` lo setea Railway solo)
5. Railway detecta Node, corre `npm install` y `npm start`
6. En **Settings → Networking**, generar un dominio público
   (algo como `flexpos-arca-server-production.up.railway.app`)
7. Esa URL es la que va en el frontend (variable `VITE_ARCA_API`)

## Alternativa: Render

1. render.com → New → Web Service → conectar el repo
2. Build: `npm install` · Start: `npm start`
3. Cargar las mismas variables de entorno
4. Usar la URL `onrender.com` que te da

## Seguridad

- El `SERVICE_ROLE_KEY` solo vive acá (variables de entorno del servidor),
  nunca en el frontend.
- Cada request valida que el usuario sea miembro del tenant antes de tocar
  el certificado (vía el JWT que manda el navegador).
- Los certificados se leen del bucket privado `arca-certs` de Supabase.

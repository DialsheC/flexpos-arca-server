// ── Helper: validación de tenant + cliente ARCA ──────────────────────────────
// Valida que el usuario que llama sea miembro del tenant, lee el certificado
// del tenant desde Storage privado de Supabase, e instancia el SDK de ARCA.
//
// A diferencia de la Edge Function (Deno), esto corre en Node.js, donde el
// SDK puede usar useHttpsAgent: true y firmar correctamente contra AFIP.

import { createClient } from '@supabase/supabase-js'
import { Arca } from '@arcasdk/core'
import ws from 'ws'

// Node < 22 no trae WebSocket nativo. El cliente de Supabase lo necesita al
// inicializarse (aunque no usemos tiempo real). Se lo damos vía el global.
if (!globalThis.WebSocket) {
  globalThis.WebSocket = ws
}

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

export async function prepararArca(authHeader, tenantId) {
  if (!tenantId) throw new Error('Falta tenant_id')

  // 1) Validar que el usuario sea miembro del tenant (RLS filtra por usuario)
  const supabaseUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader || '' } },
    realtime: { transport: ws },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: membership, error: memErr } = await supabaseUser
    .from('tenant_users')
    .select('tenant_id, rol')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (memErr) throw new Error('Error validando permisos: ' + memErr.message)
  if (!membership) throw new Error('No tenés permiso sobre este negocio')

  // 2) Cliente admin (service_role) para leer config y certificado
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    realtime: { transport: ws },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: config, error: cfgErr } = await admin
    .from('arca_config')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (cfgErr) throw new Error('Error leyendo config fiscal: ' + cfgErr.message)
  if (!config) throw new Error('El negocio no tiene configuración fiscal cargada')
  if (!config.cuit) throw new Error('Falta el CUIT en la configuración fiscal')
  if (!config.cert_cargado) throw new Error('Todavía no se cargó el certificado de ARCA')

  // 3) Leer certificado y clave del bucket privado
  const [certFile, keyFile] = await Promise.all([
    admin.storage.from('arca-certs').download(`${tenantId}/cert.pem`),
    admin.storage.from('arca-certs').download(`${tenantId}/key.pem`),
  ])
  if (certFile.error || !certFile.data) throw new Error('No se encontró el certificado del negocio')
  if (keyFile.error || !keyFile.data) throw new Error('No se encontró la clave privada del negocio')

  const cert = await certFile.data.text()
  const key = await keyFile.data.text()

  // 4) Instanciar el SDK. useHttpsAgent: true es CLAVE — habilita el agente
  //    HTTPS legacy que los servidores viejos de AFIP requieren. Solo funciona
  //    en Node.js (por eso este servicio existe en vez de una Edge Function).
  const arca = new Arca({
    cuit: Number(String(config.cuit).replace(/\D/g, '')),
    cert,
    key,
    production: config.entorno === 'produccion',
    useHttpsAgent: true,
  })

  return { arca, config, admin }
}

// ── FlexVentas — Módulo de Mercado Pago (Suscripciones) ──────────────────────
// Maneja el cobro recurrente de los planes del SaaS vía la API de Suscripciones
// (preapproval) de Mercado Pago. Usa fetch nativo (Node 20+), sin dependencias.
//
// Variables de entorno necesarias (se configuran en Railway):
//   MP_ACCESS_TOKEN   → Access Token de tu app de Mercado Pago
//   APP_URL           → URL de la app (back_url tras el checkout). Ej: https://app.softcode.com.ar
//   ADMIN_SECRET      → clave simple para proteger el endpoint de crear planes
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY → ya existentes
//
// Modelo: por cada plan (starter/profesional/empresa) se crean DOS planes en MP:
//   - mensual: cobro cada mes, 14 días gratis
//   - anual:   cobro cada 12 meses (precio x10 = 2 meses bonificados), 1 mes gratis
// La clave en la tabla planes_mp es `${plan}_${ciclo}` (ej: profesional_anual).

import { createClient } from '@supabase/supabase-js'
import ws from 'ws'
if (!globalThis.WebSocket) globalThis.WebSocket = ws

const MP_TOKEN  = process.env.MP_ACCESS_TOKEN
const APP_URL   = process.env.APP_URL || 'https://app.softcode.com.ar'
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// Precio MENSUAL base de cada plan (en ARS). Ajustá acá si cambian.
const PLANES = {
  starter:     { reason: 'FlexVentas · Plan Starter',     precio: 15000 },
  profesional: { reason: 'FlexVentas · Plan Profesional', precio: 29000 },
  empresa:     { reason: 'FlexVentas · Plan Empresa',     precio: 55000 },
}

// Ciclos de cobro. El anual cobra 10 meses (2 gratis) y da 1 mes de prueba.
const CICLOS = {
  mensual: {
    frequency: 1,  frequency_type: 'months', mult: 1,
    free_trial: { frequency: 14, frequency_type: 'days' },   // 14 días gratis
  },
  anual: {
    frequency: 12, frequency_type: 'months', mult: 10,
    free_trial: { frequency: 1,  frequency_type: 'months' }, // 1 mes gratis
  },
}

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    realtime: { transport: ws },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// Helper para llamar a la API de Mercado Pago con el token.
async function mpFetch(path, opts = {}) {
  if (!MP_TOKEN) throw new Error('Falta configurar MP_ACCESS_TOKEN')
  const res = await fetch('https://api.mercadopago.com' + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + MP_TOKEN,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(`MP ${res.status}: ${data?.message || JSON.stringify(data)}`)
  }
  return data
}

// Mapea el estado de una suscripción de MP al plan_status que usa la app.
// (la app lee 'active' | 'suspended' | 'cancelled' en getEstadoLicencia)
function estadoApp(mpStatus) {
  if (mpStatus === 'authorized') return 'active'
  if (mpStatus === 'paused')     return 'suspended'
  if (mpStatus === 'cancelled')  return 'cancelled'
  return 'pending'
}

// ── Crear (o recrear) los planes de suscripción en Mercado Pago ──────────────
// Se corre UNA vez (o cuando cambian precios/trials). Crea 6 planes
// (3 planes x 2 ciclos) y los guarda en planes_mp.
export async function crearPlanes() {
  const db = admin()
  const resultados = []

  for (const [key, cfg] of Object.entries(PLANES)) {
    for (const [ciclo, c] of Object.entries(CICLOS)) {
      const precio = cfg.precio * c.mult
      const plan = await mpFetch('/preapproval_plan', {
        method: 'POST',
        body: JSON.stringify({
          reason: `${cfg.reason} (${ciclo})`,
          auto_recurring: {
            frequency: c.frequency,
            frequency_type: c.frequency_type,
            transaction_amount: precio,
            currency_id: 'ARS',
            free_trial: c.free_trial,
          },
          payment_methods_allowed: { payment_types: [{}], payment_methods: [{}] },
          back_url: `${APP_URL}/suscripcion-ok`,
        }),
      })

      const claveDb = `${key}_${ciclo}`   // ej: profesional_anual
      await db.from('planes_mp').upsert({
        plan: claveDb,
        preapproval_plan_id: plan.id,
        init_point: plan.init_point,
        precio,
        actualizado: new Date().toISOString(),
      }, { onConflict: 'plan' })

      resultados.push({ plan: claveDb, id: plan.id, precio, init_point: plan.init_point })
    }
  }
  return resultados
}

// ── Generar el link de checkout para que un tenant active su suscripción ─────
// planKey = starter | profesional | empresa ; ciclo = mensual | anual
export async function linkSuscripcion(tenantId, planKey, ciclo = 'mensual') {
  const db = admin()
  const claveDb = `${planKey}_${ciclo}`
  const { data: plan, error } = await db
    .from('planes_mp').select('init_point, preapproval_plan_id').eq('plan', claveDb).single()
  if (error || !plan) throw new Error('Plan no configurado en Mercado Pago: ' + claveDb)
  const back = encodeURIComponent(tenantId)
  const sep = plan.init_point.includes('?') ? '&' : '?'
  return { init_point: `${plan.init_point}${sep}ext=${back}` }
}

// ── Confirmar suscripción al volver del checkout ─────────────────────────────
// La app llama esto con el preapproval_id que MP devolvió. Verifica el estado
// real contra MP y activa el tenant si está autorizada.
export async function confirmarSuscripcion(tenantId, preapprovalId) {
  if (!tenantId || !preapprovalId) throw new Error('Faltan datos')
  const pre = await mpFetch('/preapproval/' + preapprovalId)
  const db = admin()

  const estado = estadoApp(pre.status)
  await db.from('tenants').update({
    mp_preapproval_id: preapprovalId,
    plan_status: estado,
  }).eq('id', tenantId)

  return { ok: estado === 'active', status: pre.status }
}

// ── Procesar notificación del webhook de Mercado Pago ────────────────────────
// MP avisa cada vez que cambia una suscripción o se procesa un cobro.
// Buscamos el tenant por su preapproval_id guardado y actualizamos su estado.
export async function procesarWebhook(body, query) {
  const tipo = body?.type || query?.type || query?.topic
  const id = body?.data?.id || query?.id || query['data.id']
  if (!id) return { ok: true, ignored: 'sin id' }

  if (tipo && !String(tipo).includes('preapproval') && !String(tipo).includes('subscription')) {
    return { ok: true, ignored: tipo }
  }

  let pre
  try { pre = await mpFetch('/preapproval/' + id) }
  catch (e) { return { ok: true, ignored: 'no es preapproval: ' + e.message } }

  const db = admin()
  const estado = estadoApp(pre.status)

  const { data: t } = await db.from('tenants')
    .update({ plan_status: estado })
    .eq('mp_preapproval_id', id)
    .select('id').maybeSingle()

  return { ok: true, preapproval: id, estado, tenant: t?.id || null }
}

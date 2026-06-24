// ── FlexVentas — Módulo de Mercado Pago (Suscripciones) ──────────────────────
// Maneja el cobro recurrente de los planes del SaaS vía la API de Suscripciones
// (preapproval) de Mercado Pago. Usa fetch nativo (Node 20+), sin dependencias.
//
// Variables de entorno necesarias (se configuran en Railway):
//   MP_ACCESS_TOKEN   → Access Token de PRODUCCIÓN de tu app de Mercado Pago
//   APP_URL           → URL de la app (back_url tras el checkout). Ej: https://app.softcode.com.ar
//   ADMIN_SECRET      → clave simple para proteger el endpoint de crear planes
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY → ya existentes
//
// Modelo: un "preapproval_plan" por cada plan (starter/profesional/empresa),
// cada uno con 30 días gratis y cobro mensual automático en ARS.

import { createClient } from '@supabase/supabase-js'
import ws from 'ws'
if (!globalThis.WebSocket) globalThis.WebSocket = ws

const MP_TOKEN  = process.env.MP_ACCESS_TOKEN
const APP_URL   = process.env.APP_URL || 'https://app.softcode.com.ar'
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// Definición de los planes del SaaS (precio mensual en ARS).
// Ajustá los montos acá si cambian. El precio es lo que MP cobra cada mes.
const PLANES = {
  starter:     { reason: 'FlexVentas · Plan Starter',     precio: 15000 },
  profesional: { reason: 'FlexVentas · Plan Profesional', precio: 29000 },
  empresa:     { reason: 'FlexVentas · Plan Empresa',     precio: 55000 },
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

// ── Crear (o recrear) los planes de suscripción en Mercado Pago ──────────────
// Se corre UNA vez (o cuando cambian los precios). Guarda los IDs e init_points
// en la tabla planes_mp de Supabase para que la app los use.
export async function crearPlanes() {
  const db = admin()
  const resultados = []

  for (const [key, cfg] of Object.entries(PLANES)) {
    // Crear el plan en MP con 30 días de prueba gratis y cobro mensual
    const plan = await mpFetch('/preapproval_plan', {
      method: 'POST',
      body: JSON.stringify({
        reason: cfg.reason,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: cfg.precio,
          currency_id: 'ARS',
          free_trial: { frequency: 30, frequency_type: 'days' },
        },
        payment_methods_allowed: { payment_types: [{}], payment_methods: [{}] },
        back_url: `${APP_URL}/suscripcion-ok`,
      }),
    })

    // Guardar en Supabase (upsert por plan)
    await db.from('planes_mp').upsert({
      plan: key,
      preapproval_plan_id: plan.id,
      init_point: plan.init_point,
      precio: cfg.precio,
      actualizado: new Date().toISOString(),
    }, { onConflict: 'plan' })

    resultados.push({ plan: key, id: plan.id, init_point: plan.init_point })
  }
  return resultados
}

// ── Generar el link de checkout para que un tenant active su suscripción ─────
// Devuelve el init_point del plan. El external_reference (tenant_id) se vincula
// al volver del checkout (confirmarSuscripcion) y vía webhook.
export async function linkSuscripcion(tenantId, planKey) {
  const db = admin()
  const { data: plan, error } = await db
    .from('planes_mp').select('init_point, preapproval_plan_id').eq('plan', planKey).single()
  if (error || !plan) throw new Error('Plan no configurado en Mercado Pago: ' + planKey)
  // Pasamos el tenant en el back_url para reconocerlo al volver
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

  const activa = pre.status === 'authorized'
  await db.from('tenants').update({
    mp_preapproval_id: preapprovalId,
    plan_status: activa ? 'active' : 'pending',
  }).eq('id', tenantId)

  return { ok: activa, status: pre.status }
}

// ── Procesar notificación del webhook de Mercado Pago ────────────────────────
// MP avisa cada vez que cambia una suscripción o se procesa un cobro.
// Buscamos el tenant por su preapproval_id guardado y actualizamos su estado.
export async function procesarWebhook(body, query) {
  // El id de la suscripción puede venir de distintas formas según el evento
  const tipo = body?.type || query?.type || query?.topic
  const id = body?.data?.id || query?.id || query['data.id']
  if (!id) return { ok: true, ignored: 'sin id' }

  // Solo nos interesan eventos de suscripción
  if (tipo && !String(tipo).includes('preapproval') && !String(tipo).includes('subscription')) {
    return { ok: true, ignored: tipo }
  }

  let pre
  try { pre = await mpFetch('/preapproval/' + id) }
  catch (e) { return { ok: true, ignored: 'no es preapproval: ' + e.message } }

  const db = admin()
  const nuevoEstado =
    pre.status === 'authorized' ? 'active' :
    pre.status === 'paused'     ? 'suspendida' :
    pre.status === 'cancelled'  ? 'cancelada' : 'pending'

  // Actualizar el tenant que tenga esta suscripción
  const { data: t } = await db.from('tenants')
    .update({ plan_status: nuevoEstado })
    .eq('mp_preapproval_id', id)
    .select('id').maybeSingle()

  return { ok: true, preapproval: id, estado: nuevoEstado, tenant: t?.id || null }
}

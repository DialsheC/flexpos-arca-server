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
// IMPORTANTE: mantener sincronizado con sistemas-pos/js/config.js (FV_CONFIG)
const PLANES = {
  starter:     { reason: 'FlexVentas · Plan Starter',     precio: 15000 },
  profesional: { reason: 'FlexVentas · Plan Profesional', precio: 29000 },
  empresa:     { reason: 'FlexVentas · Plan Empresa',     precio: 55000 },
}

// Descuento de lanzamiento — debe coincidir con FV_CONFIG.descuento de la web.
// El precio que se cobra en MP es SIEMPRE el precio final con este descuento.
const DESCUENTO_LANZAMIENTO = 0.30

function precioFinal(planKey, mult = 1) {
  const base = PLANES[planKey]?.precio || 0
  return Math.round(base * mult * (1 - DESCUENTO_LANZAMIENTO))
}

// Regla comercial: SOLO el plan Profesional tiene 14 días de prueba.
const PLAN_CON_TRIAL = 'profesional'

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
      const precio = precioFinal(key, c.mult)   // ← precio CON descuento de lanzamiento
      // Trial solo para el plan Profesional (regla comercial)
      const trial = (key === PLAN_CON_TRIAL) ? c.free_trial : undefined
      const plan = await mpFetch('/preapproval_plan', {
        method: 'POST',
        body: JSON.stringify({
          reason: `${cfg.reason} (${ciclo})`,
          auto_recurring: {
            frequency: c.frequency,
            frequency_type: c.frequency_type,
            transaction_amount: precio,
            currency_id: 'ARS',
            ...(trial ? { free_trial: trial } : {}),
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
// codigo  = código promocional opcional (aplica descuento extra sobre el precio final)
export async function linkSuscripcion(tenantId, planKey, ciclo = 'mensual', codigo = null) {
  const db = admin()

  // ── CON CÓDIGO PROMO: preapproval individual con precio custom ──
  if (codigo) {
    const promo = await validarCodigo(db, codigo, planKey)
    if (!promo.ok) throw new Error(promo.error)

    const c = CICLOS[ciclo] || CICLOS.mensual
    const base = precioFinal(planKey, c.mult)                       // precio con dto. lanzamiento
    const conPromo = Math.round(base * (1 - promo.descuento))       // + dto. del código

    // Email del dueño del tenant (requerido por MP para preapproval sin plan)
    const { data: tenant } = await db.from('tenants').select('owner_id, nombre_negocio').eq('id', tenantId).single()
    if (!tenant) throw new Error('Negocio no encontrado')
    const { data: usr } = await db.auth.admin.getUserById(tenant.owner_id)
    const email = usr?.user?.email
    if (!email) throw new Error('No se pudo obtener el email del dueño')

    const trial = (planKey === PLAN_CON_TRIAL) ? (CICLOS[ciclo]?.free_trial) : undefined
    const pre = await mpFetch('/preapproval', {
      method: 'POST',
      body: JSON.stringify({
        reason: `${PLANES[planKey]?.reason || 'FlexVentas'} (${ciclo}) · código ${promo.codigo}`,
        external_reference: tenantId,
        payer_email: email,
        auto_recurring: {
          frequency: (CICLOS[ciclo] || CICLOS.mensual).frequency,
          frequency_type: (CICLOS[ciclo] || CICLOS.mensual).frequency_type,
          transaction_amount: conPromo,
          currency_id: 'ARS',
          ...(trial ? { free_trial: trial } : {}),
        },
        back_url: `${APP_URL}/suscripcion-ok`,
        status: 'pending',
      }),
    })

    // Registrar el uso y dejar trazabilidad en el tenant
    await db.from('codigos_promo').update({ usos: promo.usos + 1 }).eq('codigo', promo.codigo)
    await db.from('tenants').update({ codigo_promo: promo.codigo }).eq('id', tenantId)

    return { init_point: pre.init_point, precio: conPromo, codigo_aplicado: promo.codigo }
  }

  // ── SIN CÓDIGO: flujo normal con los planes precreados ──
  const claveDb = `${planKey}_${ciclo}`
  const { data: plan, error } = await db
    .from('planes_mp').select('init_point, preapproval_plan_id').eq('plan', claveDb).single()
  if (error || !plan) throw new Error('Plan no configurado en Mercado Pago: ' + claveDb)
  const back = encodeURIComponent(tenantId)
  const sep = plan.init_point.includes('?') ? '&' : '?'
  return { init_point: plan.init_point + sep + 'external_reference=' + back }
}

// ── Validar un código promocional contra la tabla codigos_promo ─────────────
async function validarCodigo(db, codigo, planKey) {
  const cod = String(codigo || '').trim().toUpperCase()
  if (!cod) return { ok: false, error: 'Código vacío' }

  const { data: promo, error } = await db
    .from('codigos_promo').select('*').eq('codigo', cod).single()

  if (error || !promo)        return { ok: false, error: 'Código inválido' }
  if (!promo.activo)          return { ok: false, error: 'Código desactivado' }
  if (promo.valido_desde && new Date(promo.valido_desde) > new Date())
                              return { ok: false, error: 'Código aún no vigente' }
  if (promo.valido_hasta && new Date(promo.valido_hasta) < new Date())
                              return { ok: false, error: 'Código vencido' }
  if (promo.usos_max != null && promo.usos >= promo.usos_max)
                              return { ok: false, error: 'Código agotado' }
  if (promo.solo_plan && promo.solo_plan !== planKey)
                              return { ok: false, error: 'Código no válido para este plan' }

  return { ok: true, codigo: cod, descuento: Number(promo.descuento), usos: promo.usos }
}

// ── Confirmar suscripción al volver del checkout ─────────────────────────────
// La app llama esto con el preapproval_id que MP devolvió. Verifica el estado
// real contra MP y activa el tenant si está autorizada.
// Intenta obtener la marca y los últimos 4 dígitos de la tarjeta asociada.
// Durante la prueba gratis puede no haber cobro aún, así que devuelve lo que encuentre.
async function datosTarjeta(preapprovalId, pre) {
  const out = {}
  if (pre?.payment_method_id) out.card_brand = pre.payment_method_id
  try {
    const r = await mpFetch('/authorized_payments/search?preapproval_id=' + preapprovalId + '&sort=date_created&criteria=desc&limit=1')
    const item = r?.results?.[0] || {}
    const pay = item.payment || item
    if (pay?.card?.last_four_digits) out.card_last_four = pay.card.last_four_digits
    if (pay?.payment_method_id) out.card_brand = pay.payment_method_id
  } catch {}
  return out
}

export async function confirmarSuscripcion(tenantId, preapprovalId) {
  if (!tenantId || !preapprovalId) throw new Error('Faltan datos')
  const pre = await mpFetch('/preapproval/' + preapprovalId)
  const db = admin()

  const estado = estadoApp(pre.status)
  const cambios = { mp_preapproval_id: preapprovalId, plan_status: estado }

  // Datos de la tarjeta (marca + últimos 4) para mostrarlos en la web
  Object.assign(cambios, await datosTarjeta(preapprovalId, pre))

  // Si quedó activa, promover del trial al plan que el cliente eligió
  if (estado === 'active') {
    const { data: t } = await db.from('tenants').select('plan_elegido').eq('id', tenantId).maybeSingle()
    if (t?.plan_elegido) cambios.plan = t.plan_elegido
  }

  await db.from('tenants').update(cambios).eq('id', tenantId)
  return { ok: estado === 'active', status: pre.status }
}

// ── Cancelar una suscripción ────────────────────────────────────────
// Valida que el usuario (por su token) sea miembro del tenant antes de cancelar.
export async function cancelarSuscripcion(tenantId, preapprovalId, userToken) {
  if (!tenantId || !preapprovalId) throw new Error('Faltan datos')
  const db = admin()

  // Validar identidad: el token debe pertenecer a un miembro del negocio
  if (userToken) {
    const { data: ures } = await db.auth.getUser(userToken)
    const uid = ures?.user?.id
    if (!uid) throw new Error('No autorizado')
    const { data: miembro } = await db.from('tenant_users')
      .select('user_id').eq('tenant_id', tenantId).eq('user_id', uid).maybeSingle()
    if (!miembro) throw new Error('No autorizado para este negocio')
  }

  // Verificar que la suscripción corresponde al tenant
  const { data: t } = await db.from('tenants')
    .select('mp_preapproval_id').eq('id', tenantId).maybeSingle()
  if (!t || t.mp_preapproval_id !== preapprovalId) throw new Error('La suscripción no coincide con el negocio')

  // Cancelar en Mercado Pago
  await mpFetch('/preapproval/' + preapprovalId, {
    method: 'PUT',
    body: JSON.stringify({ status: 'cancelled' }),
  })

  // Marcar el negocio como cancelado
  await db.from('tenants').update({ plan_status: 'cancelled' }).eq('id', tenantId)
  return { ok: true }
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

  // Buscar el tenant: primero por su referencia (external_reference = tenantId que
  // mandamos al crear el checkout) y si no, por el preapproval_id ya guardado.
  let t = null
  if (pre.external_reference) {
    const r = await db.from('tenants').select('id, plan_elegido').eq('id', pre.external_reference).maybeSingle()
    t = r.data
  }
  if (!t) {
    const r = await db.from('tenants').select('id, plan_elegido').eq('mp_preapproval_id', id).maybeSingle()
    t = r.data
  }

  if (t) {
    const cambios = { mp_preapproval_id: id, plan_status: estado }
    // Datos de la tarjeta (marca + últimos 4) para mostrarlos en la web
    Object.assign(cambios, await datosTarjeta(id, pre))
    // Si quedó activa, promover del trial al plan elegido
    if (estado === 'active' && t.plan_elegido) cambios.plan = t.plan_elegido
    await db.from('tenants').update(cambios).eq('id', t.id)
  }

  return { ok: true, preapproval: id, estado, tenant: t?.id || null }
}

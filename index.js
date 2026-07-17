// ── FlexPOS — Microservicio de facturación ARCA/AFIP ─────────────────────────
// Servidor Node.js + Express. Expone los endpoints que el SDK necesita correr
// en Node (no en Edge): /test (probar conexión) y /emitir (emitir comprobante).
//
// La carga del certificado (/subir-cert) sigue en la Edge Function de Supabase,
// porque esa NO usa el SDK (solo guarda en Storage) y funciona bien en Deno.

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import crypto from 'node:crypto'
import { prepararArca } from './src/arca.js'
import { crearPlanes, linkSuscripcion, confirmarSuscripcion, cancelarSuscripcion, procesarWebhook, listarSuscripcionesAdmin, gestionarSuscripcionAdmin } from './src/mercadopago.js'

const app = express()

// Railway está detrás de un proxy — necesario para que el rate limit vea la IP real
app.set('trust proxy', 1)

// ── SEGURIDAD: headers ──
app.use(helmet())

// ── SEGURIDAD: CORS con allowlist ──
// Solo los orígenes propios pueden llamar a la API desde un browser.
// El webhook de MP no usa CORS (server-to-server), no se ve afectado.
const ORIGENES_PERMITIDOS = [
  'https://softcode.com.ar',
  'https://www.softcode.com.ar',
  'https://app.softcode.com.ar',
  'http://localhost:5173',        // dev vite
  'http://localhost:8080',        // dev
]
app.use(cors({
  origin(origin, cb) {
    // Permitir requests sin Origin (curl, MP webhooks, apps nativas/Electron)
    if (!origin) return cb(null, true)
    if (ORIGENES_PERMITIDOS.includes(origin)) return cb(null, true)
    cb(new Error('Origen no permitido por CORS'))
  },
}))

app.use(express.json({ limit: '1mb' }))

// ── SEGURIDAD: rate limiting ──
// Global: 300 requests por IP cada 15 min (generoso para uso normal)
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas solicitudes, intentá en unos minutos' },
}))

// Estricto para pagos: 10 requests por IP cada 10 min
// (un usuario real toca /mp/suscribir 1-2 veces; 10 ya es mucho)
const mpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos de pago, esperá unos minutos' },
})

// Estricto para facturación: 30 por IP cada 10 min
const arcaLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiadas solicitudes de facturación' },
})

// Helpers fiscales
function fechaAfipHoy() {
  const now = new Date()
  const ar = new Date(now.getTime() - 3 * 60 * 60 * 1000) // UTC-3 Argentina
  return ar.toISOString().slice(0, 10).replace(/-/g, '')
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100 }

// Condición frente al IVA del receptor (RG 5616 de AFIP, obligatorio).
// Mapea nuestras condiciones internas al código que espera AFIP.
// Referencia: método FEParamGetCondicionIvaReceptor del WSFE.
const COND_IVA_RECEPTOR = {
  responsable_inscripto: 1,   // IVA Responsable Inscripto
  exento:                4,   // IVA Sujeto Exento
  consumidor_final:      5,   // Consumidor Final
  monotributista:        6,   // Responsable Monotributo
  no_categorizado:       7,   // Sujeto No Categorizado
}
function condIvaReceptorId(cond, docTipo) {
  // Si no hay condición o es consumidor final sin identificar, va Consumidor Final (5)
  return COND_IVA_RECEPTOR[cond] || 5
}

// ── Health check (Railway lo usa para saber que el servicio está vivo) ──
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'flexpos-arca-server', ts: new Date().toISOString() })
})

// ── POST /test — probar conexión y certificado contra AFIP ──
app.post('/test', arcaLimiter, async (req, res) => {
  try {
    const { tenant_id } = req.body
    const { arca, config } = await prepararArca(req.headers.authorization, tenant_id)

    const status = await arca.electronicBillingService.getServerStatus()

    let ultimoComprobante = null
    try {
      ultimoComprobante = await arca.electronicBillingService.getLastVoucher(
        Number(config.punto_venta) || 1, 6,
      )
    } catch (authErr) {
      return res.json({
        ok: false,
        msg: 'Los servidores de AFIP responden, pero el certificado no autenticó: ' +
             (authErr?.message || String(authErr)),
        servidores: status,
      })
    }

    res.json({
      ok: true,
      msg: `Conexión OK (${config.entorno}). Certificado válido. ` +
           `Último comprobante B en PtoVta ${config.punto_venta}: ${ultimoComprobante}.`,
      servidores: status,
      ultimo_comprobante: ultimoComprobante,
    })
  } catch (e) {
    res.status(500).json({ ok: false, msg: e?.message || String(e) })
  }
})

// ── POST /emitir — emitir un comprobante y obtener el CAE ──
app.post('/emitir', arcaLimiter, async (req, res) => {
  try {
    const payload = req.body
    const { tenant_id, tipo_cbte, doc_tipo, doc_nro, imp_total, concepto, cond_iva_receptor } = payload

    if (!imp_total || Number(imp_total) <= 0) {
      return res.status(400).json({ ok: false, error: 'El importe total debe ser mayor a cero' })
    }

    const { arca, config } = await prepararArca(req.headers.authorization, tenant_id)

    const total = round2(imp_total)
    const cbteTipo = Number(tipo_cbte)

    // Desglose fiscal: A y B discriminan IVA; C no.
    let impNeto = total
    let impIVA = 0
    let ivaArray = []
    const esConIVA = cbteTipo === 1 || cbteTipo === 6
    if (esConIVA) {
      const ALICUOTA = 21
      impNeto = round2(total / (1 + ALICUOTA / 100))
      impIVA = round2(total - impNeto)
      ivaArray = [{ Id: 5, BaseImp: impNeto, Importe: impIVA }]
    }

    let docTipo = Number(doc_tipo) || 99
    let docNro = Number(String(doc_nro || '0').replace(/\D/g, '')) || 0
    if (docTipo === 99) docNro = 0

    // Armar el comprobante. Para Factura C (sin IVA) NO se incluye el objeto Iva
    // ni siquiera vacío (AFIP lo rechaza con error 10071).
    const comprobante = {
      CantReg: 1,
      PtoVta: Number(config.punto_venta) || 1,
      CbteTipo: cbteTipo,
      Concepto: Number(concepto) || 1,
      DocTipo: docTipo,
      DocNro: docNro,
      CbteFch: fechaAfipHoy(),
      ImpTotal: total,
      ImpTotConc: 0,
      ImpNeto: impNeto,
      ImpOpEx: 0,
      ImpIVA: impIVA,
      ImpTrib: 0,
      MonId: 'PES',
      MonCotiz: 1,
      // RG 5616: condición frente al IVA del receptor (obligatorio)
      CondicionIVAReceptorId: condIvaReceptorId(cond_iva_receptor, docTipo),
    }
    // Solo agregar el desglose de IVA en comprobantes A y B
    if (esConIVA) {
      comprobante.Iva = ivaArray
    }

    const voucher = await arca.electronicBillingService.createNextVoucher(comprobante)

    const cae = voucher.CAE || voucher.cae
    const caeVto = voucher.CAEFchVto || voucher.caeFchVto
    const resultado = voucher.Resultado || voucher.resultado
    const numero = voucher.CbteHasta || voucher.numero || voucher.voucherNumber

    // Log completo para diagnóstico (se ve en la terminal del servidor / logs de Railway)
    console.log('Respuesta AFIP createNextVoucher:', JSON.stringify(voucher, null, 2))

    if (!cae || resultado === 'R') {
      // Extraer el motivo real del rechazo. AFIP lo manda en Observaciones/Errores,
      // que pueden venir anidados de distintas formas según el SDK.
      const motivos = []
      const obs = voucher.Observaciones || voucher.observaciones || voucher.Obs
      const errs = voucher.Errores || voucher.errores || voucher.Errors
      const extraer = (x) => {
        if (!x) return
        const arr = Array.isArray(x) ? x : (x.Obs || x.Err || x.Observacion || x.Error || [x])
        const lista = Array.isArray(arr) ? arr : [arr]
        for (const o of lista) {
          const code = o?.Code ?? o?.code ?? o?.Codigo ?? o?.codigo ?? ''
          const msg = o?.Msg ?? o?.msg ?? o?.Mensaje ?? o?.mensaje ?? (typeof o === 'string' ? o : '')
          if (msg) motivos.push(`[${code}] ${msg}`)
        }
      }
      extraer(obs); extraer(errs)
      const detalle = motivos.length ? motivos.join(' · ') : 'AFIP rechazó el comprobante sin detalle'
      return res.status(422).json({ ok: false, error: detalle, respuesta_afip: voucher })
    }

    const caeVtoISO = caeVto && String(caeVto).length === 8
      ? `${String(caeVto).slice(0, 4)}-${String(caeVto).slice(4, 6)}-${String(caeVto).slice(6, 8)}`
      : null

    res.json({
      ok: true,
      cae,
      cae_vencimiento: caeVtoISO,
      numero,
      resultado,
      imp_neto: impNeto,
      imp_iva: impIVA,
      imp_total: total,
      respuesta_afip: voucher,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// MERCADO PAGO — Suscripciones
// ════════════════════════════════════════════════════════════════════════════

// POST /mp/crear-planes — crea los planes en MP (correr una vez). Protegido.
app.post('/mp/crear-planes', async (req, res) => {
  try {
    if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ ok: false, error: 'No autorizado' })
    }
    const planes = await crearPlanes()
    res.json({ ok: true, planes })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

// POST /mp/suscribir — devuelve el link de checkout para un tenant + plan
// Acepta opcionalmente: ciclo ('mensual'|'anual') y codigo (código promocional)
app.post('/mp/suscribir', mpLimiter, async (req, res) => {
  try {
    const { tenant_id, plan, ciclo, codigo } = req.body
    if (!tenant_id || !plan) return res.status(400).json({ ok: false, error: 'Faltan tenant_id y plan' })
    const r = await linkSuscripcion(tenant_id, plan, ciclo || 'mensual', codigo || null)
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

// POST /mp/confirmar — al volver del checkout, verifica y activa la suscripción
app.post('/mp/confirmar', mpLimiter, async (req, res) => {
  try {
    const { tenant_id, preapproval_id } = req.body
    const r = await confirmarSuscripcion(tenant_id, preapproval_id)
    res.json(r)
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

// POST /mp/cancelar — cancela la suscripción de un tenant (valida identidad del usuario)
app.post('/mp/cancelar', mpLimiter, async (req, res) => {
  try {
    const { tenant_id, preapproval_id } = req.body
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    const r = await cancelarSuscripcion(tenant_id, preapproval_id, token)
    res.json(r)
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

// ── ADMIN: suscripciones (protegido: requiere token de un usuario rol='admin') ──
function tokenDe(req) {
  const auth = req.headers.authorization || ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : null
}

// POST /mp/admin/suscripciones — lista todas las suscripciones de clientes
app.post('/mp/admin/suscripciones', mpLimiter, async (req, res) => {
  try {
    const r = await listarSuscripcionesAdmin(tokenDe(req))
    res.json(r)
  } catch (e) {
    const noAuth = /admin|autorizado/i.test(e?.message || '')
    res.status(noAuth ? 403 : 500).json({ ok: false, error: e?.message || String(e) })
  }
})

// POST /mp/admin/suscripcion — acción: cancelar | pausar | reactivar
app.post('/mp/admin/suscripcion', mpLimiter, async (req, res) => {
  try {
    const { preapproval_id, accion } = req.body
    const r = await gestionarSuscripcionAdmin(tokenDe(req), preapproval_id, accion)
    res.json(r)
  } catch (e) {
    const noAuth = /admin|autorizado/i.test(e?.message || '')
    res.status(noAuth ? 403 : 500).json({ ok: false, error: e?.message || String(e) })
  }
})

// POST/GET /mp/webhook — notificaciones de Mercado Pago (cobros, cambios de estado)
//
// SEGURIDAD: validamos la firma x-signature de MP (HMAC-SHA256).
// Configurar MP_WEBHOOK_SECRET en Railway con la "clave secreta" que aparece en:
// Mercado Pago → Tus integraciones → [tu app] → Webhooks → Clave secreta.
// Si la env no está seteada, el webhook sigue funcionando (modo compatible)
// pero loguea una advertencia — configurala cuanto antes.
function verificarFirmaMP(req) {
  const secret = process.env.MP_WEBHOOK_SECRET
  if (!secret) {
    console.warn('⚠️  MP_WEBHOOK_SECRET no configurada — webhook sin validación de firma')
    return true
  }
  try {
    const signature = req.headers['x-signature'] || ''
    const requestId = req.headers['x-request-id'] || ''
    // x-signature: "ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a5e839"
    const parts = Object.fromEntries(signature.split(',').map(p => p.trim().split('=')))
    if (!parts.ts || !parts.v1) return false
    const dataId = (req.query['data.id'] || req.body?.data?.id || '').toString().toLowerCase()
    const manifest = `id:${dataId};request-id:${requestId};ts:${parts.ts};`
    const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex')
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(parts.v1))
  } catch {
    return false
  }
}

async function webhookHandler(req, res) {
  try {
    if (!verificarFirmaMP(req)) {
      console.warn('Webhook MP con firma inválida — descartado. IP:', req.ip)
      return res.status(200).json({ ok: false })  // 200 para no revelar el filtro
    }
    const r = await procesarWebhook(req.body || {}, req.query || {})
    res.status(200).json(r)   // MP espera 200 siempre
  } catch (e) {
    // Aun ante error respondemos 200 para que MP no reintente infinito; logueamos
    console.error('webhook MP:', e?.message || e)
    res.status(200).json({ ok: false })
  }
}
app.post('/mp/webhook', webhookHandler)
app.get('/mp/webhook', webhookHandler)

const PORT = process.env.PORT || 8080
app.listen(PORT, () => console.log(`FlexPOS ARCA server escuchando en :${PORT}`))

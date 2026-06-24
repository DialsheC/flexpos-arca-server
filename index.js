// ── FlexPOS — Microservicio de facturación ARCA/AFIP ─────────────────────────
// Servidor Node.js + Express. Expone los endpoints que el SDK necesita correr
// en Node (no en Edge): /test (probar conexión) y /emitir (emitir comprobante).
//
// La carga del certificado (/subir-cert) sigue en la Edge Function de Supabase,
// porque esa NO usa el SDK (solo guarda en Storage) y funciona bien en Deno.

import express from 'express'
import cors from 'cors'
import { prepararArca } from './src/arca.js'
import { crearPlanes, linkSuscripcion, confirmarSuscripcion, procesarWebhook } from './src/mercadopago.js'

const app = express()
app.use(cors())                       // permite llamadas desde la app web
app.use(express.json({ limit: '2mb' }))

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
app.post('/test', async (req, res) => {
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
app.post('/emitir', async (req, res) => {
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
app.post('/mp/suscribir', async (req, res) => {
  try {
    const { tenant_id, plan } = req.body
    if (!tenant_id || !plan) return res.status(400).json({ ok: false, error: 'Faltan tenant_id y plan' })
    const r = await linkSuscripcion(tenant_id, plan)
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

// POST /mp/confirmar — al volver del checkout, verifica y activa la suscripción
app.post('/mp/confirmar', async (req, res) => {
  try {
    const { tenant_id, preapproval_id } = req.body
    const r = await confirmarSuscripcion(tenant_id, preapproval_id)
    res.json(r)
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) })
  }
})

// POST/GET /mp/webhook — notificaciones de Mercado Pago (cobros, cambios de estado)
async function webhookHandler(req, res) {
  try {
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

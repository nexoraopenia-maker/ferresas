import { z } from 'zod'
import {
  errorDeDocumento, esLicenciaValida, esPlacaValida, esUbigeoValido,
  TIPOS_DOC_CONDUCTOR, TIPOS_DOC_DESTINATARIO,
} from './reglas'
import { validarRuc } from '@/lib/documentos'

const id = z.string().min(1).max(64)

/**
 * El esquema base solo describe las FORMAS (tipos). Todas las comprobaciones de
 * contenido van juntas en `superRefine`: Zod no ejecuta los refinamientos si falló
 * una validación básica, y la persona descubriría los errores de uno en uno
 * (primero el peso, luego la placa, luego la licencia…). Así salen todos a la vez.
 */
const punto = z.object({ address: z.string().trim().max(200), ubigeo: z.string().trim().max(10) })

export const emitirGuiaSchema = z.object({
  saleId: id.optional(),
  transferId: id.optional(),
  motive: z.enum(['VENTA', 'COMPRA', 'TRASLADO_ESTABLECIMIENTOS', 'OTROS']),
  motiveDetail: z.string().trim().max(120).optional(),
  transportMode: z.enum(['PUBLICO', 'PRIVADO']),
  transferStartDate: z.string().trim().max(10),
  // Opcional en la forma; el refinamiento exige que exista y sea positivo.
  grossWeightKg: z.number().optional(),
  packages: z.number().optional(),
  recipient: z.object({
    docType: z.enum(TIPOS_DOC_DESTINATARIO as [string, ...string[]]),
    docNumber: z.string().trim().max(20),
    name: z.string().trim().max(150),
  }),
  origin: punto,
  destination: punto,
  carrier: z.object({ ruc: z.string().trim().max(20), name: z.string().trim().max(150) }).optional(),
  vehicle: z.object({ plate: z.string().trim().max(12) }).optional(),
  driver: z.object({
    docType: z.enum(TIPOS_DOC_CONDUCTOR as [string, ...string[]]),
    docNumber: z.string().trim().max(20),
    name: z.string().trim().max(150),
    license: z.string().trim().max(20),
  }).optional(),
  notes: z.string().trim().max(300).optional(),
  items: z.array(z.object({ productId: id, quantity: z.number() })).max(200),
}).superRefine((d, ctx) => {
  const err = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message })

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.transferStartDate)) err(['transferStartDate'], 'Indica la fecha de inicio del traslado.')
  if (!(typeof d.grossWeightKg === 'number' && d.grossWeightKg > 0)) err(['grossWeightKg'], 'Indica el peso bruto total (mayor que cero).')
  else if (d.grossWeightKg > 99_999_999) err(['grossWeightKg'], 'Peso demasiado grande.')
  if (d.packages !== undefined && !(Number.isInteger(d.packages) && d.packages > 0 && d.packages <= 1_000_000)) err(['packages'], 'El número de bultos debe ser un entero positivo.')

  if (d.motive === 'VENTA' && !d.saleId) err(['saleId'], 'El motivo «Venta» exige elegir la venta.')
  if (d.motive === 'TRASLADO_ESTABLECIMIENTOS' && !d.transferId) err(['transferId'], 'El traslado entre almacenes exige elegir la transferencia.')
  if (d.saleId && d.transferId) err(['saleId'], 'Una guía se vincula a una venta o a una transferencia, no a las dos.')
  if (d.motive === 'OTROS' && !(d.motiveDetail && d.motiveDetail.length >= 3)) err(['motiveDetail'], 'Explica el motivo del traslado.')

  if (d.recipient.name.length < 2) err(['recipient', 'name'], 'Escribe el nombre o la razón social del destinatario.')
  const e = d.recipient.docNumber ? errorDeDocumento(d.recipient.docType as never, d.recipient.docNumber) : 'Escribe el documento del destinatario.'
  if (e) err(['recipient', 'docNumber'], e)

  for (const [clave, p, que] of [['origin', d.origin, 'partida'], ['destination', d.destination, 'llegada']] as const) {
    if (p.address.length < 8) err([clave, 'address'], `Escribe la dirección de ${que} completa.`)
    if (!esUbigeoValido(p.ubigeo)) err([clave, 'ubigeo'], 'El ubigeo son 6 dígitos.')
  }

  if (d.transportMode === 'PUBLICO') {
    const ruc = d.carrier?.ruc ?? ''
    const r = ruc ? validarRuc(ruc) : null
    if (!r) err(['carrier', 'ruc'], 'Indica el RUC de la empresa de transporte.')
    else if (!r.valido) err(['carrier', 'ruc'], `RUC del transportista: ${r.mensaje}`)
    if ((d.carrier?.name.length ?? 0) < 2) err(['carrier', 'name'], 'Escribe la razón social del transportista.')
  } else {
    if (!d.vehicle || !esPlacaValida(d.vehicle.plate)) err(['vehicle', 'plate'], 'Placa inválida (6 o 7 letras o números).')
    const dr = d.driver
    const ed = dr?.docNumber ? errorDeDocumento(dr.docType as never, dr.docNumber) : 'Indica el documento del conductor.'
    if (ed) err(['driver', 'docNumber'], ed)
    if ((dr?.name.length ?? 0) < 2) err(['driver', 'name'], 'Escribe el nombre del conductor.')
    if (!dr || !esLicenciaValida(dr.license)) err(['driver', 'license'], 'Licencia de conducir inválida (8 a 12 letras o números).')
  }

  if (d.items.length === 0) err(['items'], 'Añade al menos un producto.')
  d.items.forEach((i, n) => { if (!(i.quantity > 0 && i.quantity <= 1_000_000)) err(['items', n, 'quantity'], 'La cantidad debe ser mayor que cero.') })
  const ids = d.items.map((i) => i.productId)
  if (new Set(ids).size !== ids.length) err(['items'], 'Un producto aparece dos veces: junta las cantidades en una línea.')
})

export type EmitirGuiaInput = z.infer<typeof emitirGuiaSchema>

export const anularGuiaSchema = z.object({
  guideId: id,
  reason: z.string().trim().min(5, 'Explica el motivo (5 caracteres o más).').max(300),
})

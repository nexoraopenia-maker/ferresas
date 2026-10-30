import { getTenantPrisma } from '@/lib/tenant-prisma'
import { requireTenantContext } from '@/lib/session'
import { TaxDocumentList } from '@/features/invoicing/components/TaxDocumentList'
import { SeriesPanel } from '@/features/invoicing/components/SeriesPanel'
import { listarSeriesConfigurables } from '@/features/invoicing/counter-service'
import { puede } from '@/lib/puede'
import { SunatConfig } from '@/features/invoicing/components/SunatConfig'
import { DatosFiscalesForm } from '@/features/invoicing/components/DatosFiscalesForm'
import { leerDatosFiscales } from '@/features/sunat/datos-fiscales'
import { estadoCredencialesSunat } from '@/features/sunat/credenciales'
import { modoFiscal } from '@/features/invoicing/modo-fiscal'
import { bajasDeComprobantes, motivoDeNoBaja } from '@/features/sunat/baja'
import { diaLocal } from '@/lib/periodos'
import { CODIGOS_NOTA_CREDITO_PARCIAL, CODIGOS_NOTA_CREDITO_TOTAL } from '@/features/invoicing/notas'

export const dynamic = 'force-dynamic'

/**
 * Registro de comprobantes emitidos.
 *
 * Es la pantalla que el contador necesita: qué se emitió, con qué serie y
 * correlativo, y en qué estado está frente a la administración tributaria.
 */
export default async function ComprobantesPage() {
  const ctx = await requireTenantContext()
  const db = getTenantPrisma(ctx)

  const [docs, resumen] = await Promise.all([
    db.taxDocument.findMany({
      orderBy: [{ issuedAt: 'desc' }],
      take: 100,
      select: {
        id: true, fullNumber: true, documentType: true, series: true,
        correlativo: true, status: true, statusMessage: true,
        receiverDocType: true, receiverDocNumber: true, receiverName: true,
        currency: true, subtotal: true, taxTotal: true, total: true,
        issuedAt: true,
        saleId: true, isTrial: true, externalId: true, reasonCode: true,
        relatedDocument: { select: { fullNumber: true } },
        archivos: { select: { kind: true } },
        // Una nota de crédito VIVA de este comprobante (una rechazada no cuenta): la total (única, por índice) o, desde F6.2, una parcial por devolución.
        // Con cualquiera de las dos no se ofrece emitir otra nota total (contaría dos veces lo devuelto).
        notes: {
          where: { documentType: 'NOTA_CREDITO', reasonCode: { in: [...CODIGOS_NOTA_CREDITO_TOTAL, ...CODIGOS_NOTA_CREDITO_PARCIAL] }, status: { not: 'RECHAZADO' } },
          take: 1, select: { fullNumber: true },
        },
        dispatch: { select: { status: true, attempts: true, nextAttemptAt: true, lastError: true } },
        sale: { select: { number: true } },
      },
      // Una sentencia en vez de dos: ver la nota en src/lib/session.ts.
      relationLoadStrategy: 'join',
    }),
    // Los documentos de PRUEBA nunca cuentan como pendientes: no hay nada que enviar.
    db.taxDocument.groupBy({ by: ['status'], where: { isTrial: false }, _count: { _all: true } }),
  ])

  const tenant = await db.tenant.findFirst({ select: { timezone: true, isDemo: true, realBillingEnabledAt: true, realBillingPausedAt: true } })
  const modo = tenant ? modoFiscal(tenant) : 'ENSAYO'
  // Baja (S4): la más reciente de cada comprobante, sus archivos y cuántas notas vivas tiene (una nota y una baja a la vez se contradicen).
  const ids = docs.map((d) => d.id)
  const [bajas, archivosBaja, notasVivas] = await Promise.all([
    bajasDeComprobantes(db, ids),
    db.taxVoidFile.findMany({ where: { taxVoid: { taxDocumentId: { in: ids } } }, select: { kind: true, taxVoid: { select: { taxDocumentId: true } } } }),
    db.taxDocument.groupBy({ by: ['relatedDocumentId'], where: { isTrial: false, relatedDocumentId: { in: ids }, status: { not: 'RECHAZADO' } }, _count: { _all: true } }),
  ])
  const notasPorDoc = new Map(notasVivas.map((n) => [n.relatedDocumentId, n._count._all]))
  const ahoraPagina = new Date()
  const facturacionActiva = modo === 'REAL' || modo === 'PAUSADO'

  /*
   * Series configurables de la sucursal activa. Solo para quien puede
   * gestionarlas: a un cajero no le sirve de nada y el panel invita a tocar
   * algo irreversible.
   */
  const puedeSeries = puede(ctx, 'config.fiscal')
  const [series, sucursal] = ctx.branchId && puedeSeries
    ? await Promise.all([
        listarSeriesConfigurables(db, ctx, ctx.branchId),
        db.branch.findFirst({ where: { id: ctx.branchId }, select: { name: true } }),
      ])
    : [null, null]

  const sunat = puedeSeries ? await estadoCredencialesSunat(db) : null
  const datosFiscales = puedeSeries ? await leerDatosFiscales(db) : null
  const porEstado = Object.fromEntries(resumen.map((r) => [r.status, r._count._all]))

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-2xl font-bold text-ink">Comprobantes</h1>
        <p className="text-sm text-ink-muted">
          Boletas y facturas emitidas, con su serie y estado tributario.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Contador label="Pendientes" value={porEstado.PENDIENTE ?? 0} tono="warn" />
        <Contador label="Enviados" value={porEstado.ENVIADO ?? 0} tono="info" />
        <Contador label="Aceptados" value={(porEstado.ACEPTADO ?? 0) + (porEstado.OBSERVADO ?? 0)} tono="ok" />
        <Contador label="Rechazados" value={porEstado.RECHAZADO ?? 0} tono="stop" />
      </section>

      {datosFiscales && (
        <DatosFiscalesForm
          ruc={datosFiscales.ruc} razonSocial={datosFiscales.razonSocial} rucBloqueadoPor={datosFiscales.rucBloqueadoPor}
          puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
        />
      )}

      {sunat && (
        <SunatConfig
          estado={{
            configurado: sunat.configurado, ambiente: sunat.ambiente, usuarioSol: sunat.usuarioSol,
            certificado: sunat.certificado && {
              sujeto: sunat.certificado.sujeto, ruc: sunat.certificado.ruc, estado: sunat.certificado.estado,
              diasRestantes: sunat.certificado.diasRestantes, vence: sunat.certificado.vence.toISOString().slice(0, 10),
            },
            ultimaPrueba: sunat.ultimaPrueba && { en: sunat.ultimaPrueba.en.toISOString(), ok: sunat.ultimaPrueba.ok, mensaje: sunat.ultimaPrueba.mensaje },
          }}
          claveMaestra={sunat.claveMaestra}
          puedeOperar={ctx.access === 'FULL' || ctx.access === 'WARN'}
        />
      )}

      {series && ctx.branchId && (
        <SeriesPanel
          series={series.map((s) => ({
            scope: s.scope as 'TAX_BOLETA' | 'TAX_FACTURA',
            series: s.series,
            next: s.next,
            startNumber: s.startNumber,
            emitidos: s.emitidos,
            editable: s.editable,
            ultimoEmitido: s.ultimoEmitido,
          }))}
          branchId={ctx.branchId}
          sucursal={sucursal?.name ?? 'esta sucursal'}
          puedeGestionar={ctx.access === 'FULL' || ctx.access === 'WARN'}
        />
      )}

      <TaxDocumentList
        canManage={puede(ctx, 'comprobantes.anular')}
        puedeEmitirNota={puede(ctx, 'comprobantes.anular') && (ctx.access === 'FULL' || ctx.access === 'WARN')}
        facturacionActiva={facturacionActiva}
        puedeDarBaja={puede(ctx, 'comprobantes.dar_baja') && (ctx.access === 'FULL' || ctx.access === 'WARN') && facturacionActiva}
        puedeEmitirGuia={puede(ctx, 'guias.emitir')}
        puedeEnviar={puede(ctx, 'comprobantes.emitir') && (ctx.access === 'FULL' || ctx.access === 'WARN')}
        zonaHoraria={tenant?.timezone ?? 'America/Lima'}
        docs={docs.map((d) => ({
          id: d.id,
          fullNumber: d.fullNumber,
          documentType: d.documentType,
          status: d.status,
          statusMessage: d.statusMessage,
          receiverDocNumber: d.receiverDocNumber,
          receiverName: d.receiverName,
          currency: d.currency,
          subtotal: d.subtotal.toFixed(2),
          taxTotal: d.taxTotal.toFixed(2),
          total: d.total.toFixed(2),
          issuedAt: d.issuedAt.toISOString(),
          saleNumber: d.sale.number,
          saleId: d.saleId,
          isTrial: d.isTrial,
          series: d.series,
          documentoRelacionado: d.relatedDocument?.fullNumber ?? null,
          motivo: d.reasonCode,
          notaTotal: d.notes[0]?.fullNumber ?? null,
          tieneIdProveedor: !!d.externalId,
          archivos: d.archivos.map((a) => a.kind),
          baja: bajas[d.id] ? { identificador: bajas[d.id]!.identificador, status: bajas[d.id]!.status, motivo: bajas[d.id]!.motivo, mensaje: bajas[d.id]!.mensaje, ticket: bajas[d.id]!.ticket } : null,
          archivosBaja: archivosBaja.filter((a) => a.taxVoid.taxDocumentId === d.id).map((a) => a.kind),
          bajaBloqueo: motivoDeNoBaja({
            documentType: d.documentType, series: d.series, isTrial: d.isTrial, status: d.status,
            diaEmision: diaLocal(tenant?.timezone ?? 'America/Lima', d.issuedAt), diaHoy: diaLocal(tenant?.timezone ?? 'America/Lima', ahoraPagina),
            bajaPrevia: bajas[d.id] ? { status: bajas[d.id]!.status, ticket: bajas[d.id]!.ticket } : null, notasVivas: notasPorDoc.get(d.id) ?? 0,
          }),
          cola: d.dispatch ? { estado: d.dispatch.status, intentos: d.dispatch.attempts, proximo: d.dispatch.nextAttemptAt.toISOString(), error: d.dispatch.lastError } : null,
        }))}
      />
    </main>
  )
}

function Contador({
  label, value, tono,
}: { label: string; value: number; tono: 'ok' | 'info' | 'warn' | 'stop' }) {
  const acento =
    tono === 'ok' ? 'text-stock-ok'
    : tono === 'warn' ? 'text-stock-low'
    : tono === 'stop' ? 'text-stock-out'
    : 'text-industrial-600'
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${acento}`}>{value}</p>
    </div>
  )
}

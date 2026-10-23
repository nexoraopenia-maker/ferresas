import Link from 'next/link'
import { guardDashboard } from '@/lib/dashboard-guard'
import { permisosDe, puede, puedeAlguno } from '@/lib/puede'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import { logoutAction } from '../(auth)/actions'
import { AccountBannerBar } from '@/features/billing/components/AccountBannerBar'
import { estadoEnvioFiscal } from '@/features/invoicing/alarma-envio'
import { FiscalAlertBar } from '@/features/invoicing/components/FiscalAlertBar'
import { ImpersonationBanner } from '@/features/superadmin/components/ImpersonationBanner'
import { NavLinks } from '@/features/shell/components/NavLinks'
import { BranchSwitcher } from '@/features/branches/components/BranchSwitcher'
import { OperadorSwitcher } from '@/features/seguridad/components/OperadorSwitcher'

/**
 * Armazón del área de cliente.
 *
 * ─── POR QUÉ HÍBRIDO Y NO UN SOLO PATRÓN ─────────────────────────────────
 *
 * Son dos usuarios distintos con el mismo software:
 *
 *   · El almacenero recorre pasillos con el móvil en una mano y la otra
 *     ocupada con mercadería. Necesita los destinos al alcance del pulgar,
 *     o sea abajo. Un sidebar en esa pantalla sería una gaveta que hay que
 *     abrir con la mano que no tiene libre.
 *
 *   · El cajero está sentado frente a un monitor y lo que le escasea es
 *     ancho útil: cada píxel que gaste la navegación se lo quita al carrito.
 *     Un sidebar fijo de 16 rem le cuesta menos que una barra inferior que
 *     le roba altura a la lista de productos.
 *
 * El corte en 1024 px (`lg:`) no es arbitrario: por debajo caben una o dos
 * columnas y la navegación compite con el contenido; por encima sobra sitio.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  /*
   * La guarda contra la BASE vive aquí desde que el proxy dejó de consultar.
   * Bloquea lo que solo la base sabe: usuario desactivado, sesión revocada
   * por cambio de contraseña y tenant suspendido. Ver src/proxy.ts y
   * src/lib/dashboard-guard.ts.
   *
   * Corre UNA vez por render y la comparte con todas las páginas, porque
   * `requireTenantContext` está memoizado con `cache()`.
   */
  const { ctx } = await guardDashboard()
  const db = getTenantPrisma(ctx)
  const [tenant, asignadas, operador] = await Promise.all([
    db.tenant.findFirst({ select: { name: true, isDemo: true, realBillingEnabledAt: true } }),
    /*
     * Sucursales que el usuario puede operar. Se consultan aquí, en el
     * armazón, para que el selector esté en todas las pantallas: equivocarse
     * de local al emitir es un error que solo se detecta cuando el
     * comprobante ya salió impreso con la serie de otro establecimiento.
     */
    db.branch.findMany({
      where: { id: { in: [...(ctx.branchIds ?? [])] }, isActive: true, deletedAt: null },
      select: { id: true, code: true, name: true, seriesNumber: true },
      orderBy: { code: 'asc' },
    }),
    // Solo en modo operador: el nombre de quien está cobrando.
    ctx.operadorDe
      ? db.user.findFirst({ where: { id: ctx.userId }, select: { name: true } })
      : Promise.resolve(null),
  ])
  const nombreOperador = operador?.name ?? null
  // Alarma de comprobantes sin enviar: solo a quien gestiona lo fiscal, y solo si el negocio ya emite en serie real
  // (en ensayo y en demo no hay nada que enviar, así que no se paga la consulta).
  const estadoFiscal = tenant?.realBillingEnabledAt && puedeAlguno(ctx, 'config.fiscal', 'comprobantes.anular')
    ? await estadoEnvioFiscal(db)
    : null
  // El selector de operador lo ve quien cobra o vende; y siempre quien YA está en modo operador, para poder salir.
  const puedeOperarCaja =
    !!ctx.operadorDe || puede(ctx, 'ventas.cobrar') || puede(ctx, 'ventas.crear') || puede(ctx, 'caja.abrir_cerrar')
  const sucursales = asignadas

  return (
    <div className="min-h-dvh lg:flex">
      {/* ───────── Sidebar: solo escritorio ───────── */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-hairline bg-surface-raised lg:sticky lg:top-0 lg:flex lg:h-dvh">
        <div className="bg-brand-gradient px-4 py-4 text-white">
          <p className="truncate text-sm font-bold">
            {tenant?.name ?? 'Mi ferretería'}
          </p>
          <p className="truncate text-xs font-medium text-white/85">{ctx.role.toLowerCase()}</p>
        </div>

        <div className="border-b border-hairline px-4 py-3">
          <BranchSwitcher sucursales={sucursales} activa={ctx.branchId} />
          {puedeOperarCaja && <div className="mt-2"><OperadorSwitcher operadorActual={nombreOperador} /></div>}
        </div>

        <nav aria-label="Navegación principal" className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          <NavLinks variant="sidebar" permisos={[...permisosDe(ctx)]} />
        </nav>

        <div className="border-t border-hairline p-2">
          <form action={logoutAction}>
            <button
              type="submit"
              className="h-touch-lg w-full rounded-xl px-3 text-left text-sm font-semibold text-ink-muted hover:bg-surface-sunken"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      </aside>

      {/* ───────── Contenido ───────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Los avisos van por encima de todo y a ancho completo: el de
            soporte PRIMERO, porque si el superadmin ve «solo lectura» sin
            saber que está impersonando, diagnosticará un problema de
            suscripción que el cliente no tiene. */}
        {tenant?.isDemo && (
          <div role="status" className="bg-accent-100 px-4 py-2 text-center text-sm font-semibold text-accent-900">
            Cuenta de demostración · los datos son ficticios y no se envía nada a SUNAT
          </div>
        )}
        <ImpersonationBanner />
        <AccountBannerBar />
        {estadoFiscal && <FiscalAlertBar estado={estadoFiscal} />}

        {/* Cabecera solo en móvil: en escritorio esa información ya está en
            el sidebar y repetirla gasta altura. */}
        <header className="bg-brand-gradient px-4 py-3 text-white lg:hidden">
          <div className="flex items-center justify-between gap-3">
            <p className="truncate text-sm font-bold">
              {tenant?.name ?? 'Mi ferretería'}
            </p>
            <Link href="/facturacion" className="shrink-0 text-xs font-semibold text-white/85">
              {ctx.role.toLowerCase()}
            </Link>
          </div>
          {/* El selector también en móvil: el almacenero que recorre dos
              locales necesita saber —y cambiar— en cuál está operando, y en
              móvil el sidebar que lo contiene no existe. */}
          <div className="mt-2">
            <BranchSwitcher sucursales={sucursales} activa={ctx.branchId} />
          </div>
          {puedeOperarCaja && <div className="mt-2"><OperadorSwitcher operadorActual={nombreOperador} /></div>}
        </header>

        <main className="min-w-0 flex-1 bg-surface-raised">{children}</main>

        {/* ───────── Barra inferior: solo móvil ───────── */}
        <nav
          aria-label="Navegación principal"
          className="safe-bottom sticky bottom-0 z-30 flex items-stretch gap-1 border-t border-hairline bg-surface px-2 pt-1.5 lg:hidden"
        >
          <NavLinks variant="bottom" permisos={[...permisosDe(ctx)]} />
          <form action={logoutAction} className="flex min-w-0 flex-1">
            <button
              type="submit"
              className="flex w-full flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 text-ink-muted"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="size-5">
                <path d="M15 17l5-5-5-5M20 12H9m0 9H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
              </svg>
              <span className="text-[0.6875rem] font-bold leading-none">Salir</span>
            </button>
          </form>
        </nav>
      </div>
    </div>
  )
}

import type { ReactNode } from 'react'
import { ETIQUETA_PRESET, PRESETS_PERIODO, type PresetPeriodo } from '../periodo'
import type { ParametrosVentas } from '../schemas'

const campo = 'h-touch rounded-xl border border-hairline bg-surface px-3 text-base text-ink'

/**
 * Selector de periodo de los reportes: un formulario de dirección (GET), sin JavaScript. Cambiar el periodo recarga el reporte con la
 * dirección nueva, que se puede compartir. Las fechas del rango solo cuentan con «Rango de fechas».
 */
export function SelectorPeriodo({ tab, params, accion = '/reportes/ventas', pestanaInicial = 'periodo', extra }: {
  /** La pestaña abierta; se conserva al cambiar de periodo. */
  tab: string
  params: { p: PresetPeriodo; desde?: string; hasta?: string; agrupar?: ParametrosVentas['agrupar']; atrib?: ParametrosVentas['atrib'] }
  /** A qué página vuelve el formulario. */
  accion?: string
  /** La pestaña que NO necesita ir en la dirección (la de por defecto). */
  pestanaInicial?: string
  /** Campos propios de un reporte (p. ej. el ABC), junto a los del periodo. */
  extra?: ReactNode
}) {
  return (
    <form action={accion} method="get" data-form="periodo" className="flex flex-wrap items-end gap-3 rounded-2xl border border-hairline bg-surface p-4">
      {tab !== pestanaInicial && <input type="hidden" name="t" value={tab} />}
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Periodo
        <select name="p" defaultValue={params.p} className={campo}>
          {PRESETS_PERIODO.map((p) => <option key={p} value={p}>{ETIQUETA_PRESET[p]}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Desde
        <input type="date" name="desde" defaultValue={params.desde ?? ''} className={campo} />
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Hasta
        <input type="date" name="hasta" defaultValue={params.hasta ?? ''} className={campo} />
      </label>
      {tab === 'periodo' && (
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Agrupar por
          <select name="agrupar" defaultValue={params.agrupar ?? 'auto'} className={campo}>
            <option value="auto">Automático</option><option value="dia">Día</option><option value="semana">Semana</option><option value="mes">Mes</option>
          </select>
        </label>
      )}
      {tab === 'vendedor' && (
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Atribuir a
          <select name="atrib" defaultValue={params.atrib ?? 'VENDEDOR'} className={campo}>
            <option value="VENDEDOR">Quien armó el pedido (vendedor)</option><option value="COBRO">Quien cobró en caja</option>
          </select>
        </label>
      )}
      {extra}
      <button type="submit" className="h-touch rounded-xl bg-industrial-600 px-5 font-bold text-white">Ver</button>
      <p className="basis-full text-xs text-ink-muted">Las fechas del rango solo se usan con «Rango de fechas». Los días son los de tu negocio.</p>
    </form>
  )
}

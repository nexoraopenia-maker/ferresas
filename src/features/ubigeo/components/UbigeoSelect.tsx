'use client'

import { useEffect, useState } from 'react'
import { describirUbigeoAction, estadoUbigeoAction, listarUbigeoAction } from '../actions'
import type { OpcionUbigeo } from '../service'

const campo =
  'h-touch-lg w-full rounded-xl border border-hairline bg-surface px-4 text-base text-ink placeholder:text-ink-muted focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40'

/**
 * Selector de ubigeo en cascada: departamento → provincia → distrito.
 *
 * Mientras el catálogo oficial del INEI no esté cargado cae a un campo de 6
 * dígitos (con aviso), para no impedir nada. Emite el código de 6 dígitos del
 * distrito, o '' mientras la selección esté incompleta.
 */
export function UbigeoSelect({
  value, onChange, error, id,
}: { value: string; onChange: (codigo: string) => void; error?: string; id?: string }) {
  const [cargado, setCargado] = useState<boolean | null>(null)
  const [deps, setDeps] = useState<OpcionUbigeo[]>([])
  const [provs, setProvs] = useState<OpcionUbigeo[]>([])
  const [dists, setDists] = useState<OpcionUbigeo[]>([])
  const [dep, setDep] = useState('')
  const [prov, setProv] = useState('')

  // Estado del catálogo y departamentos; y, si ya hay un valor, su cadena completa.
  useEffect(() => {
    let vivo = true
    void (async () => {
      const e = await estadoUbigeoAction()
      if (!vivo) return
      setCargado(e.cargado)
      if (!e.cargado) return
      const d = await listarUbigeoAction()
      if (!vivo) return
      setDeps(d)
      if (/^\d{6}$/.test(value) && (await describirUbigeoAction(value))) {
        const dCod = `${value.slice(0, 2)}0000`
        const pCod = `${value.slice(0, 4)}00`
        const [ps, ds] = await Promise.all([listarUbigeoAction(dCod), listarUbigeoAction(pCod)])
        if (!vivo) return
        setDep(dCod); setProvs(ps); setProv(pCod); setDists(ds)
      }
    })()
    return () => { vivo = false }
    // Solo al montar: después manda lo que elija la persona.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const elegirDep = async (cod: string) => {
    setDep(cod); setProv(''); setDists([]); onChange('')
    setProvs(cod ? await listarUbigeoAction(cod) : [])
  }
  const elegirProv = async (cod: string) => {
    setProv(cod); onChange('')
    setDists(cod ? await listarUbigeoAction(cod) : [])
  }

  const marca = error ? ' border-stock-out' : ''

  if (cargado === null) return <div className={`${campo} animate-pulse`} aria-busy />
  if (!cargado) {
    return (
      <div className="flex flex-col gap-1">
        <input
          id={id} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric" maxLength={6} placeholder="150101" className={campo + marca}
        />
        <span className="text-xs text-ink-muted">El catálogo oficial aún no está cargado: escribe los 6 dígitos.</span>
        {error && <span className="text-xs font-semibold text-stock-out">{error}</span>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <select id={id} aria-label="Departamento" value={dep} onChange={(e) => void elegirDep(e.target.value)} className={campo + marca}>
        <option value="">Departamento…</option>
        {deps.map((o) => <option key={o.codigo} value={o.codigo}>{o.nombre}</option>)}
      </select>
      <select aria-label="Provincia" value={prov} disabled={!dep} onChange={(e) => void elegirProv(e.target.value)} className={campo + marca}>
        <option value="">Provincia…</option>
        {provs.map((o) => <option key={o.codigo} value={o.codigo}>{o.nombre}</option>)}
      </select>
      <select aria-label="Distrito" value={/^\d{6}$/.test(value) && dists.some((d) => d.codigo === value) ? value : ''} disabled={!prov} onChange={(e) => onChange(e.target.value)} className={campo + marca}>
        <option value="">Distrito…</option>
        {dists.map((o) => <option key={o.codigo} value={o.codigo}>{o.nombre}</option>)}
      </select>
      {error && <span className="text-xs font-semibold text-stock-out">{error}</span>}
    </div>
  )
}

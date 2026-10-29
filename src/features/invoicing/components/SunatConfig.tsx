'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { guardarCredencialesSunatAction, probarCredencialesSunatAction, quitarCredencialesSunatAction } from '../actions'

/**
 * «Conexión con SUNAT»: certificado digital y usuario SOL secundario para enviar comprobantes DIRECTO a SUNAT, sin intermediario. Solo el dueño
 * (`config.fiscal`). Tres pasos: 1) certificado, 2) usuario SOL secundario, 3) probar la conexión.
 *
 * El .pfx y las claves se escriben una vez y NO vuelven a mostrarse: el servidor las guarda cifradas y esta pantalla solo conoce los metadatos del
 * certificado. Todo lo que se teclea se borra del estado del navegador apenas se guarda. El archivo se lee en memoria; no se sube a ningún otro sitio.
 */

export interface EstadoSunatVista {
  configurado: boolean
  ambiente: 'BETA' | 'PRODUCCION' | null
  usuarioSol: string | null
  certificado: { sujeto: string; ruc: string | null; vence: string; estado: 'vigente' | 'por_vencer' | 'vencido' | 'aun_no_vigente'; diasRestantes: number } | null
  ultimaPrueba: { en: string; ok: boolean; mensaje: string } | null
}

const ESTADO_CERT = {
  vigente: { texto: 'Vigente', cls: 'bg-stock-ok-soft text-stock-ok' },
  por_vencer: { texto: 'Por vencer', cls: 'bg-stock-low-soft text-stock-low' },
  vencido: { texto: 'Vencido', cls: 'bg-stock-out-soft text-stock-out' },
  aun_no_vigente: { texto: 'Aún no vigente', cls: 'bg-stock-low-soft text-stock-low' },
} as const

/** base64 de un archivo, por trozos (un spread gigante desborda la pila). */
async function aBase64(archivo: File): Promise<string> {
  const bytes = new Uint8Array(await archivo.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export function Paso({ n, titulo, hecho, children }: { n: number; titulo: string; hecho: boolean; children?: React.ReactNode }) {
  return (
    <li data-sunat-paso={n} className="flex items-start gap-3">
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${hecho ? 'bg-stock-ok text-white' : 'bg-surface-sunken text-ink-muted'}`} aria-hidden>{hecho ? '✓' : n}</span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{titulo}{hecho ? <span className="sr-only"> (hecho)</span> : null}</p>
        {children}
      </div>
    </li>
  )
}

export function SunatConfig({
  estado, claveMaestra, puedeOperar,
}: { estado: EstadoSunatVista; claveMaestra: boolean; puedeOperar: boolean }) {
  const router = useRouter()
  const [editando, setEditando] = useState(!estado.configurado)
  const [archivo, setArchivo] = useState<{ nombre: string; base64: string } | null>(null)
  const [claveCert, setClaveCert] = useState('')
  const [usuarioSol, setUsuarioSol] = useState('')
  const [claveSol, setClaveSol] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null)
  const [pendiente, startTransition] = useTransition()

  const elegir = async (f: File | undefined) => {
    setMsg(null)
    if (!f) { setArchivo(null); return }
    if (f.size > 100 * 1024) { setArchivo(null); setMsg({ ok: false, texto: 'El archivo es demasiado grande para ser un certificado (máximo 100 KB).' }); return }
    setArchivo({ nombre: f.name, base64: await aBase64(f) })
  }
  const limpiar = () => { setArchivo(null); setClaveCert(''); setUsuarioSol(''); setClaveSol('') }

  const guardar = () => {
    if (!archivo) return
    setMsg(null)
    startTransition(async () => {
      const r = await guardarCredencialesSunatAction({ pfxBase64: archivo.base64, claveCertificado: claveCert, usuarioSol, claveSol })
      if (!r.ok) { setMsg({ ok: false, texto: r.message }); return }
      limpiar(); setEditando(false)
      setMsg({ ok: true, texto: 'Guardado. El certificado y las claves quedaron cifrados y no se vuelven a mostrar. Falta probar la conexión.' })
      router.refresh()
    })
  }
  const probar = () => {
    setMsg(null)
    startTransition(async () => {
      const r = await probarCredencialesSunatAction()
      setMsg(r.ok ? { ok: r.data.ok, texto: r.data.mensaje } : { ok: false, texto: r.message })
      router.refresh()
    })
  }
  const quitar = () => {
    if (!window.confirm('¿Quitar el certificado y las credenciales de SUNAT? Los comprobantes nuevos quedarán pendientes de envío.')) return
    startTransition(async () => {
      const r = await quitarCredencialesSunatAction()
      if (!r.ok) { setMsg({ ok: false, texto: r.message }); return }
      setEditando(true); setMsg(null); router.refresh()
    })
  }

  const campo = 'h-touch w-full rounded-xl border border-hairline bg-surface px-3 text-base text-ink'
  const cert = estado.certificado
  const listo = !!archivo && claveCert.length > 0 && usuarioSol.trim().length >= 3 && claveSol.length >= 4
  const probado = estado.ultimaPrueba?.ok === true
  return (
    <section data-sunat="conexion" className="rounded-2xl border border-hairline bg-surface p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-ink">Conexión con SUNAT</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            {estado.configurado && cert
              ? <>Certificado de <b className="text-ink">{cert.sujeto}</b>, usuario SOL <b className="text-ink">{estado.usuarioSol}</b>.</>
              : 'Sin configurar: los comprobantes se emiten y quedan pendientes de envío.'}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${cert ? ESTADO_CERT[cert.estado].cls : 'bg-stock-low-soft text-stock-low'}`}>
          {cert ? ESTADO_CERT[cert.estado].texto : 'Pendiente'}
        </span>
      </div>

      <ol className="mt-3 flex flex-col gap-2" aria-label="Pasos de la conexión con SUNAT">
        <Paso n={1} titulo="Certificado digital" hecho={!!cert}>
          <p className="text-xs text-ink-muted">Cada negocio usa el suyo (lo tramita con una entidad de certificación acreditada). Archivo .pfx o .p12 y su clave.</p>
        </Paso>
        <Paso n={2} titulo="Usuario SOL secundario" hecho={estado.configurado}>
          <p className="text-xs text-ink-muted">Créalo en el portal de SUNAT con solo el perfil de comprobantes electrónicos. Nunca uses el usuario principal.</p>
        </Paso>
        <Paso n={3} titulo="Probar la conexión" hecho={probado}>
          <p className="text-xs text-ink-muted">
            {estado.ultimaPrueba
              ? <>Última prueba: <b className={estado.ultimaPrueba.ok ? 'text-stock-ok' : 'text-stock-out'}>{estado.ultimaPrueba.ok ? 'bien' : 'falló'}</b> — {estado.ultimaPrueba.mensaje}</>
              : 'Aún no se probó. No envía ni emite nada: solo comprueba el acceso.'}
          </p>
        </Paso>
      </ol>

      {cert && (
        <p className={`mt-3 text-sm font-semibold ${cert.estado === 'vigente' ? 'text-ink-muted' : cert.estado === 'por_vencer' ? 'text-stock-low' : 'text-stock-out'}`}>
          {cert.estado === 'vencido' ? `El certificado venció el ${cert.vence}. Renuévalo: sin él no se puede emitir.`
            : cert.estado === 'aun_no_vigente' ? `El certificado empieza a valer el ${cert.vence}.`
            : `Vence el ${cert.vence} (${cert.diasRestantes} día${cert.diasRestantes === 1 ? '' : 's'}).`}
        </p>
      )}
      {estado.ambiente === 'BETA' && (
        <p role="note" className="mt-2 rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
          Ambiente de PRUEBAS de SUNAT: lo que se envíe aquí no tiene validez tributaria. La emisión real la habilita soporte más adelante.
        </p>
      )}
      {!claveMaestra && <p role="alert" className="mt-3 text-sm font-semibold text-stock-out">Guardar credenciales está deshabilitado: falta la clave de cifrado del servidor. Avisa a soporte.</p>}

      {puedeOperar && claveMaestra && (editando ? (
        <div className="mt-3 flex flex-col gap-2" data-sunat="formulario">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Certificado digital (.pfx o .p12)</span>
            <input type="file" accept=".pfx,.p12,application/x-pkcs12" onChange={(e) => void elegir(e.target.files?.[0])} className={campo + ' py-2'} />
            {archivo && <span className="text-xs text-ink-muted">Elegido: {archivo.nombre}</span>}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Clave del certificado</span>
            <input type="password" value={claveCert} onChange={(e) => setClaveCert(e.target.value)} autoComplete="new-password" className={campo} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Usuario SOL secundario</span>
            <input value={usuarioSol} onChange={(e) => setUsuarioSol(e.target.value)} autoComplete="off" autoCapitalize="characters" className={campo} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">Clave SOL</span>
            <input type="password" value={claveSol} onChange={(e) => setClaveSol(e.target.value)} autoComplete="new-password" className={campo} />
          </label>
          <div className="flex gap-2">
            {estado.configurado && <button type="button" onClick={() => { limpiar(); setEditando(false) }} className="h-touch flex-1 rounded-xl border border-hairline font-semibold text-ink">Cancelar</button>}
            <button type="button" data-boton="guardar-sunat" disabled={pendiente || !listo} onClick={guardar} className="h-touch flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40">
              {pendiente ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" data-boton="probar-sunat" disabled={pendiente} onClick={probar} className="h-touch rounded-xl bg-industrial-600 px-4 font-bold text-white disabled:opacity-50">{pendiente ? 'Probando…' : 'Probar conexión'}</button>
          <button type="button" onClick={() => setEditando(true)} className="h-touch rounded-xl border border-hairline px-4 font-semibold text-ink">Cambiar</button>
          <button type="button" disabled={pendiente} onClick={quitar} className="h-touch rounded-xl px-4 font-semibold text-stock-out">Quitar</button>
        </div>
      ))}

      {msg && <p role="status" className={`mt-3 rounded-xl px-3 py-2 text-sm font-semibold ${msg.ok ? 'bg-stock-ok-soft text-stock-ok' : 'bg-stock-out-soft text-stock-out'}`}>{msg.texto}</p>}
    </section>
  )
}

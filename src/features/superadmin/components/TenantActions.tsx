'use client'

import type { ModoFiscal } from '@/features/invoicing/modo-fiscal'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import {
  reactivateTenant,
  resetTenantOwnerPassword,
  setFacturacionRealAction,
  setUmbralesAlertaAction,
  startImpersonation,
  suspendTenant,
  updateTenantProfileAction,
} from '../actions'

export interface TenantPerfil {
  name: string
  legalName: string | null
  taxId: string | null
  phone: string | null
  email: string | null
}

type Accion = 'suspender' | 'reactivar' | 'soporte' | 'password' | 'perfil' | 'facturacion' | 'real_habilitar' | 'real_pausar' | 'real_reanudar' | 'real_ensayo' | 'umbrales'

const COPY: Record<Exclude<Accion, 'perfil' | 'facturacion'>, {
  titulo: string
  descripcion: string
  boton: string
  placeholder: string
}> = {
  suspender: {
    titulo: 'Suspender cuenta',
    descripcion: 'Bloquea el acceso con independencia de su estado de pago.',
    boton: 'Suspender',
    placeholder: 'Ej. Fraude confirmado en el ticket #4821',
  },
  reactivar: {
    titulo: 'Reactivar cuenta',
    descripcion: 'Devuelve el acceso. El estado de pago se recalcula solo.',
    boton: 'Reactivar',
    placeholder: 'Ej. Cliente aportó documentación; falso positivo',
  },
  soporte: {
    titulo: 'Entrar como soporte',
    descripcion: 'Verás la cuenta en modo solo lectura durante 60 minutos.',
    boton: 'Entrar',
    placeholder: 'Ej. Ticket #1290: no le aparece el stock del almacén 2',
  },
  real_habilitar: {
    titulo: 'Habilitar facturación real',
    descripcion: 'Desde ahora este negocio emite en serie REAL y envía a su proveedor. Solo si ya validaste el XML y los catálogos en el sandbox.',
    boton: 'Habilitar',
    placeholder: 'Ej. Sandbox del PSE validado el 12/11; RUC y sucursales completos',
  },
  real_pausar: {
    titulo: 'Pausar el envío a SUNAT',
    descripcion: 'Los comprobantes siguen emitiéndose con numeración real, pero NO se envían: esperan hasta reanudar. El dueño verá una alarma con cuántos hay y cuánto llevan.',
    boton: 'Pausar',
    placeholder: 'Ej. El proveedor rechaza el XML; se revisa antes de volver a enviar',
  },
  real_reanudar: {
    titulo: 'Reanudar el envío a SUNAT',
    descripcion: 'Se vuelven a enviar los comprobantes: primero los que quedaron pendientes.',
    boton: 'Reanudar',
    placeholder: 'Ej. El proveedor corrigió el fallo; probado con una boleta',
  },
  real_ensayo: {
    titulo: 'Volver a modo ensayo',
    descripcion: 'Solo si NO se emitió ningún documento en serie real. Los documentos nuevos volverán a ser de prueba, sin valor tributario.',
    boton: 'Volver a ensayo',
    placeholder: 'Ej. Se habilitó por error antes de terminar la validación',
  },
  umbrales: {
    titulo: 'Umbrales de la alarma de envío',
    descripcion: 'Horas sin enviar a partir de las cuales el dueño y tú ven el aviso y luego el estado crítico. Vacío = valor por defecto de la plataforma.',
    boton: 'Guardar',
    placeholder: 'Ej. Plazo confirmado por el contador del negocio',
  },
  password: {
    titulo: 'Restablecer contraseña',
    descripcion:
      'Asigna la contraseña que escribas (o una al azar) y cierra las sesiones abiertas del dueño.',
    boton: 'Restablecer',
    placeholder: 'Ej. El dueño perdió el acceso; verificado por teléfono',
  },
}

/**
 * Menú único de gestión por ferretería.
 *
 * Sustituye los tres botones horizontales que había. El motivo no es solo
 * estético: con seis acciones por fila, los botones ocupaban más que los
 * datos y obligaban a desplazar la tabla. Y agrupar lo destructivo dentro de
 * un menú, separado y en rojo, hace falta un paso más para suspender una
 * cuenta por error.
 *
 * Todas las acciones exigen motivo escrito antes de ejecutarse (§6.6): el
 * diálogo obliga a pensar qué se va a escribir en el AuditLog ANTES de tocar
 * la cuenta de un cliente.
 */
export function TenantActions({
  tenantId,
  tenantName,
  isActive,
  modoFiscal,
  umbrales,
  perfil,
  onFacturacion,
}: {
  tenantId: string
  tenantName: string
  isActive: boolean
  modoFiscal: ModoFiscal
  umbrales: { avisoHoras: number; criticoHoras: number; avisoPropio: number | null; criticoPropio: number | null }
  perfil: TenantPerfil
  onFacturacion: () => void
}) {
  const router = useRouter()
  const [accion, setAccion] = useState<Accion | null>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [campos, setCampos] = useState<Record<string, string[]>>({})
  const [credencial, setCredencial] = useState<{ email: string; password: string } | null>(null)
  const [copiado, setCopiado] = useState(false)
  const [nuevaClave, setNuevaClave] = useState('')
  const [avisoH, setAvisoH] = useState('')
  const [criticoH, setCriticoH] = useState('')
  const [verClave, setVerClave] = useState(false)
  const [pending, startTransition] = useTransition()

  // Perfil editable
  const [form, setForm] = useState<TenantPerfil>(perfil)

  const cerrar = () => {
    setAccion(null)
    setReason('')
    setNuevaClave('')
    setAvisoH('')
    setCriticoH('')
    setVerClave(false)
    setError(null)
    setCampos({})
    setForm(perfil)
  }

  const abrir = (a: Accion) => {
    if (a === 'facturacion') return onFacturacion()
    setError(null)
    setCampos({})
    setForm(perfil)
    setAccion(a)
  }

  const ejecutar = () => {
    if (!accion || accion === 'facturacion') return
    setError(null)
    setCampos({})

    startTransition(async () => {
      const res =
        accion === 'suspender' ? await suspendTenant({ tenantId, reason })
        : accion === 'reactivar' ? await reactivateTenant({ tenantId, reason })
        : accion === 'soporte' ? await startImpersonation({ tenantId, reason })
        : accion === 'password' ? await resetTenantOwnerPassword({ tenantId, reason, password: nuevaClave })
        : accion === 'umbrales' ? await setUmbralesAlertaAction({ tenantId, reason, warnHours: horas(avisoH), criticalHours: horas(criticoH) })
        : accion.startsWith('real_') ? await setFacturacionRealAction({ tenantId, reason, accion: accion.replace('real_', '').replace('ensayo', 'volver_a_ensayo') })
        : await updateTenantProfileAction({
            tenantId,
            reason,
            name: form.name,
            legalName: form.legalName ?? '',
            taxId: form.taxId ?? '',
            phone: form.phone ?? '',
            email: form.email ?? '',
          })

      if (!res.ok) {
        if (res.code === 'VALIDATION') setCampos((res.details ?? {}) as Record<string, string[]>)
        setError(res.message)
        return
      }

      if (accion === 'soporte') {
        // Recarga completa: la cookie de soporte cambió quién es el usuario
        // efectivo y el router de Next serviría caché del superadmin.
        window.location.assign('/panel')
        return
      }

      if (accion === 'password' && res.data && 'temporaryPassword' in res.data) {
        // La contraseña se muestra FUERA del diálogo y persiste: no se puede
        // recuperar después, así que cerrar no debe hacerla desaparecer.
        setCredencial({ email: res.data.userEmail, password: res.data.temporaryPassword })
        setAccion(null)
        setReason('')
        setNuevaClave('')
        setVerClave(false)
        return
      }

      cerrar()
      router.refresh()
    })
  }

  const err = (c: string) => campos[c]?.[0]
  const esPerfil = accion === 'perfil'
  const copy = accion && accion !== 'perfil' && accion !== 'facturacion' ? COPY[accion] : null
  const puedeEnviar = esPerfil
    ? reason.trim().length >= 10 && form.name.trim().length >= 3
    : accion === 'password'
      ? reason.trim().length >= 10 && nuevaClave.trim().length >= 8
      : reason.trim().length >= 10

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Gestionar ${tenantName}`}
            className="h-touch rounded-lg border border-hairline px-3 text-sm font-semibold text-ink data-[state=open]:bg-surface-sunken"
          >
            Gestionar ⋮
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent>
          <DropdownMenuLabel>{tenantName}</DropdownMenuLabel>

          <DropdownMenuItem onSelect={() => abrir('facturacion')}>
            Facturación y plan
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => abrir('perfil')}>
            Editar perfil (RUC, teléfono)
          </DropdownMenuItem>
          {modoFiscal !== 'DEMO' && (
            <>
              {modoFiscal === 'ENSAYO' && <DropdownMenuItem onSelect={() => abrir('real_habilitar')}>Habilitar facturación real</DropdownMenuItem>}
              {modoFiscal === 'REAL' && <DropdownMenuItem onSelect={() => abrir('real_pausar')}>Pausar el envío a SUNAT</DropdownMenuItem>}
              {modoFiscal === 'PAUSADO' && <DropdownMenuItem onSelect={() => abrir('real_reanudar')}>Reanudar el envío a SUNAT</DropdownMenuItem>}
              {(modoFiscal === 'REAL' || modoFiscal === 'PAUSADO') && <DropdownMenuItem onSelect={() => abrir('real_ensayo')}>Volver a modo ensayo</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => abrir('umbrales')}>Umbrales de la alarma de envío</DropdownMenuItem>
            </>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuLabel>Soporte</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => abrir('soporte')}>
            Entrar como soporte
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => abrir('password')}>
            Restablecer contraseña
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {isActive ? (
            <DropdownMenuItem tone="danger" onSelect={() => abrir('suspender')}>
              Suspender cuenta
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem tone="ok" onSelect={() => abrir('reactivar')}>
              Reactivar cuenta
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* --- Credencial temporal: fuera del diálogo y persistente --------- */}
      {credencial && (
        <div className="mt-2 rounded-xl border-2 border-stock-ok bg-stock-ok-soft p-3">
          <p className="text-sm font-bold text-stock-ok">Contraseña restablecida</p>
          <dl className="mt-1 text-xs text-ink">
            <div className="flex gap-2">
              <dt className="text-ink-muted">Correo:</dt>
              <dd className="font-mono font-semibold">{credencial.email}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-ink-muted">Clave:</dt>
              <dd className="font-mono font-semibold">{credencial.password}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs font-semibold text-stock-out">
            No se puede volver a ver. Entrégala ahora.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(
                  `Correo: ${credencial.email}\nContraseña: ${credencial.password}`,
                )
                setCopiado(true)
                setTimeout(() => setCopiado(false), 2000)
              }}
              className="h-touch rounded-lg bg-graphite-900 px-3 text-xs font-bold text-white dark:bg-graphite-50 dark:text-graphite-900"
            >
              {copiado ? 'Copiado ✓' : 'Copiar'}
            </button>
            <button
              type="button"
              onClick={() => { setCredencial(null); router.refresh() }}
              className="h-touch rounded-lg border border-hairline px-3 text-xs font-semibold text-ink"
            >
              Ya la guardé
            </button>
          </div>
        </div>
      )}

      {/* --- Diálogo de confirmación / edición --------------------------- */}
      <Dialog open={accion !== null && accion !== 'facturacion'} onOpenChange={(o) => !o && cerrar()}>
        {accion && accion !== 'facturacion' && (
          <DialogContent
            title={esPerfil ? 'Editar perfil' : copy!.titulo}
            description={esPerfil ? tenantName : copy!.descripcion}
            size={esPerfil ? 'lg' : 'md'}
          >
            {accion === 'soporte' && (
              <p className="mb-3 rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
                Verás la cuenta en modo solo lectura. Todo queda registrado.
              </p>
            )}
            {accion === 'password' && (
              <p className="mb-3 rounded-xl bg-stock-low-soft px-3 py-2 text-sm font-semibold text-stock-low">
                Se cerrarán las sesiones abiertas del dueño. La contraseña nueva
                se muestra una sola vez.
              </p>
            )}

            {accion === 'password' && (
              <div className="mb-3">
                <Campo label="Nueva contraseña (mínimo 8 caracteres)" error={err('password')}>
                  <div className="flex gap-2">
                    <input
                      type={verClave ? 'text' : 'password'}
                      value={nuevaClave}
                      onChange={(e) => setNuevaClave(e.target.value)}
                      autoComplete="new-password"
                      autoFocus
                      placeholder="Escribe la contraseña"
                      className={inputCls(err('password'))}
                    />
                    <button
                      type="button"
                      onClick={() => setVerClave((v) => !v)}
                      aria-pressed={verClave}
                      className="h-touch-lg shrink-0 rounded-xl border border-hairline px-3 text-sm font-semibold text-ink"
                    >
                      {verClave ? 'Ocultar' : 'Ver'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setNuevaClave(claveAlAzar()); setVerClave(true) }}
                      className="h-touch-lg shrink-0 rounded-xl border border-hairline px-3 text-sm font-semibold text-ink"
                    >
                      Generar al azar
                    </button>
                  </div>
                </Campo>
              </div>
            )}

            {accion === 'umbrales' && (
              <div className="mb-3 grid grid-cols-2 gap-3">
                <Campo label={`Aviso (h) · por defecto ${umbrales.avisoHoras}`}>
                  <input inputMode="numeric" value={avisoH} onChange={(e) => setAvisoH(e.target.value)} placeholder={String(umbrales.avisoPropio ?? '')} className={inputCls(undefined)} />
                </Campo>
                <Campo label={`Crítico (h) · por defecto ${umbrales.criticoHoras}`}>
                  <input inputMode="numeric" value={criticoH} onChange={(e) => setCriticoH(e.target.value)} placeholder={String(umbrales.criticoPropio ?? '')} className={inputCls(undefined)} />
                </Campo>
                <p className="col-span-2 text-xs text-ink-muted">⚠️ Estos valores no son plazos de SUNAT: los fija quien responde por lo fiscal del negocio.</p>
              </div>
            )}

            {esPerfil && (
              <div className="mb-3 flex flex-col gap-3">
                <Campo label="Nombre comercial" error={err('name')}>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={inputCls(err('name'))} />
                </Campo>
                <Campo label="Razón social" error={err('legalName')}>
                  <input value={form.legalName ?? ''} onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                    placeholder="FERRETERÍA EL SOL S.A.C." className={inputCls(err('legalName'))} />
                </Campo>
                <div className="flex gap-3">
                  <Campo label="RUC (11 dígitos)" error={err('taxId')} className="flex-1">
                    <input value={form.taxId ?? ''} onChange={(e) => setForm({ ...form, taxId: e.target.value })}
                      inputMode="numeric" maxLength={11} className={inputCls(err('taxId'))} />
                  </Campo>
                  <Campo label="Teléfono" error={err('phone')} className="flex-1">
                    <input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      inputMode="tel" className={inputCls(err('phone'))} />
                  </Campo>
                </div>
                <Campo label="Correo de facturación" error={err('email')}>
                  <input type="email" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className={inputCls(err('email'))} />
                </Campo>
                <p className="text-xs text-ink-muted">
                  Dejar un campo vacío lo borra. El RUC debe ser correcto: una
                  factura emitida con un RUC equivocado la rechaza SUNAT.
                </p>
              </div>
            )}

            <Campo label="Motivo (obligatorio, queda auditado)" error={err('reason')}>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                autoFocus={!esPerfil}
                placeholder={esPerfil ? 'Ej. El cliente corrigió su RUC por teléfono' : copy!.placeholder}
                className="rounded-xl border border-hairline bg-surface px-3 py-2 text-base text-ink focus:border-industrial-600 focus:outline-none focus:ring-2 focus:ring-industrial-600/40"
              />
            </Campo>

            {error && (
              <p role="alert" className="mt-2 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <DialogFooter>
              <button type="button" onClick={cerrar}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Cancelar
              </button>
              <button
                type="button"
                onClick={ejecutar}
                disabled={pending || !puedeEnviar}
                className={`h-touch-lg flex-1 rounded-xl font-bold text-white disabled:opacity-40 ${
                  accion === 'suspender' ? 'bg-stock-out' : 'bg-industrial-600'
                }`}
              >
                {pending ? 'Aplicando…' : esPerfil ? 'Guardar' : copy!.boton}
              </button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}

/**
 * Misma forma que `generateTempPassword` del servidor (16 caracteres sin
 * ambiguos, en grupos de 4), con `crypto.getRandomValues` y sin sesgo de módulo.
 */
function claveAlAzar(): string {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789'
  const limite = 256 - (256 % alfabeto.length)
  let salida = ''
  while (salida.length < 16) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limite && salida.length < 16) salida += alfabeto[b % alfabeto.length]
    }
  }
  return salida.match(/.{1,4}/g)!.join('-')
}

/** Horas de un campo de texto: vacío = null (valor por defecto); no numérico = NaN, que el servidor rechaza. */
function horas(t: string): number | null {
  return t.trim() === '' ? null : Number(t)
}

function inputCls(error?: string) {
  return [
    'h-touch-lg w-full rounded-xl border bg-surface px-4 text-base text-ink',
    'focus:outline-none focus:ring-2',
    error
      ? 'border-stock-out focus:border-stock-out focus:ring-stock-out/40'
      : 'border-hairline focus:border-industrial-600 focus:ring-industrial-600/40',
  ].join(' ')
}

function Campo({
  label, error, className = '', children,
}: {
  label: string
  error?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      {children}
      {error && <span className="text-xs font-semibold text-stock-out">{error}</span>}
    </label>
  )
}

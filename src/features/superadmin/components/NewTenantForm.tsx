'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

export interface PlanChoice {
  code: string
  name: string
  trialDays: number
}

interface Creado {
  tenantId: string
  slug: string
  planName: string
  trialEndsAt: string
  ownerEmail: string
  generatedPassword?: string
}

/**
 * Alta de clientes desde la torre de control.
 *
 * Llama a POST /api/tenants con `credentials: 'same-origin'`. Al ir por fetch
 * y no por un <form> nativo, el navegador manda `Sec-Fetch-Site: same-origin`
 * y `Content-Type: application/json`, que es lo que el endpoint exige para
 * descartar una petición CSRF.
 */
export function NewTenantForm({ plans }: { plans: PlanChoice[] }) {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [creado, setCreado] = useState<Creado | null>(null)
  const [copiado, setCopiado] = useState(false)

  const [businessName, setBusinessName] = useState('')
  const [ownerName, setOwnerName] = useState('')
  const [email, setEmail] = useState('')
  const [planCode, setPlanCode] = useState(plans[0]?.code ?? '')
  const [phone, setPhone] = useState('')
  const [taxId, setTaxId] = useState('')
  const [password, setPassword] = useState('')
  const [manual, setManual] = useState(false)

  const [error, setError] = useState<string | null>(null)
  const [campos, setCampos] = useState<Record<string, string[]>>({})
  const [pending, startTransition] = useTransition()

  const limpiar = () => {
    setBusinessName(''); setOwnerName(''); setEmail(''); setPhone('')
    setTaxId(''); setPassword(''); setManual(false)
    setPlanCode(plans[0]?.code ?? '')
    setError(null); setCampos({})
  }

  const cerrar = () => { setAbierto(false); limpiar() }

  const enviar = () => {
    setError(null)
    setCampos({})

    startTransition(async () => {
      const res = await fetch('/api/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          businessName, ownerName, email, planCode,
          phone: phone || undefined,
          taxId: taxId || undefined,
          password: manual && password ? password : undefined,
        }),
      })

      if (res.status === 404) {
        // El endpoint devuelve 404 a quien no es SUPERADMIN, así que aquí
        // casi siempre significa sesión caducada, no ruta inexistente.
        setError('Tu sesión expiró. Recarga la página y vuelve a entrar.')
        return
      }
      if (res.status === 429) {
        setError('Demasiadas altas seguidas. Espera unos minutos.')
        return
      }

      const datos = await res.json().catch(() => null)

      if (!res.ok) {
        if (datos?.fields) setCampos(datos.fields)
        setError(datos?.message ?? 'No se pudo crear la cuenta.')
        return
      }

      setCreado(datos as Creado)
      setAbierto(false)
      limpiar()
      // Refresca la tabla y las métricas del panel con el cliente nuevo.
      router.refresh()
    })
  }

  const err = (c: string) => campos[c]?.[0]
  const plan = plans.find((p) => p.code === planCode)

  return (
    <>
      <button
        type="button"
        onClick={() => { setCreado(null); setAbierto(true) }}
        className="h-touch-lg rounded-xl bg-industrial-600 px-5 text-base font-bold text-white transition active:scale-95"
      >
        + Nueva ferretería
      </button>

      {/* --- Credenciales recién creadas ------------------------------------
          Se muestran FUERA del formulario y persisten hasta que el Super
          Admin las cierra: la contraseña generada no se puede recuperar
          después, así que cerrar el modal no debe hacerla desaparecer. */}
      {creado && (
        <div className="mt-4 rounded-2xl border-2 border-stock-ok bg-stock-ok-soft p-4">
          <h3 className="font-bold text-stock-ok">Cuenta creada</h3>
          <dl className="mt-2 grid gap-1 text-sm text-ink">
            <Dato label="Ferretería" value={creado.slug} />
            <Dato label="Plan" value={creado.planName} />
            <Dato label="Prueba hasta" value={new Date(creado.trialEndsAt).toLocaleDateString('es-PE')} />
            <Dato label="Correo de acceso" value={creado.ownerEmail} mono />
            {creado.generatedPassword && (
              <Dato label="Contraseña temporal" value={creado.generatedPassword} mono />
            )}
          </dl>

          {creado.generatedPassword && (
            <>
              <p className="mt-3 text-sm font-semibold text-stock-out">
                Esta contraseña no se puede volver a ver. Cópiala y entrégala al
                cliente ahora.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(
                      `Correo: ${creado.ownerEmail}\nContraseña: ${creado.generatedPassword}`,
                    )
                    setCopiado(true)
                    setTimeout(() => setCopiado(false), 2000)
                  }}
                  className="h-touch rounded-lg bg-graphite-900 px-4 text-sm font-bold text-white dark:bg-graphite-50 dark:text-graphite-900"
                >
                  {copiado ? 'Copiado ✓' : 'Copiar credenciales'}
                </button>
                <button
                  type="button"
                  onClick={() => setCreado(null)}
                  className="h-touch rounded-lg border border-hairline px-4 text-sm font-semibold text-ink"
                >
                  Ya las guardé
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* --- Formulario ---------------------------------------------------- */}
      {abierto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
          <div className="absolute inset-0 bg-graphite-950/70" onClick={cerrar} aria-hidden />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="nuevo-tenant"
            className="relative my-8 w-full max-w-md rounded-2xl bg-surface p-5 shadow-2xl"
          >
            <h2 id="nuevo-tenant" className="text-lg font-bold text-ink">
              Nueva ferretería
            </h2>
            <p className="mt-1 text-sm text-ink-muted">
              Se crea la cuenta, su usuario dueño, su almacén principal y la
              suscripción en prueba.
            </p>

            <div className="mt-4 flex flex-col gap-3">
              <Campo label="Nombre de la ferretería" error={err('businessName')}>
                <input value={businessName} onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="Ferretería El Sol" className={inputCls(err('businessName'))} />
              </Campo>

              <Campo label="Nombre del dueño" error={err('ownerName')}>
                <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)}
                  className={inputCls(err('ownerName'))} />
              </Campo>

              <Campo label="Correo del dueño" error={err('email')}>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  autoComplete="off" className={inputCls(err('email'))} />
              </Campo>

              <Campo label="Plan" error={err('planCode')}>
                <select value={planCode} onChange={(e) => setPlanCode(e.target.value)}
                  className={inputCls(undefined)}>
                  {plans.map((p) => (
                    <option key={p.code} value={p.code}>{p.name}</option>
                  ))}
                </select>
                {plan && (
                  <span className="text-xs text-ink-muted">
                    {plan.trialDays} días de prueba
                  </span>
                )}
              </Campo>

              <div className="flex gap-3">
                <Campo label="Teléfono (opcional)" error={err('phone')} className="flex-1">
                  <input value={phone} onChange={(e) => setPhone(e.target.value)}
                    inputMode="tel" className={inputCls(err('phone'))} />
                </Campo>
                <Campo label="RUC (opcional)" error={err('taxId')} className="flex-1">
                  <input value={taxId} onChange={(e) => setTaxId(e.target.value)}
                    inputMode="numeric" className={inputCls(err('taxId'))} />
                </Campo>
              </div>

              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={manual}
                  onChange={(e) => setManual(e.target.checked)}
                  className="size-5 accent-industrial-600" />
                Escribir yo la contraseña
              </label>

              {manual ? (
                <Campo label="Contraseña (mínimo 8)" error={err('password')}>
                  <input type="text" value={password} onChange={(e) => setPassword(e.target.value)}
                    autoComplete="off" className={inputCls(err('password'))} />
                </Campo>
              ) : (
                <p className="rounded-xl bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
                  Se generará una contraseña temporal y se mostrará una sola vez.
                </p>
              )}
            </div>

            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-stock-out-soft px-3 py-2 text-sm font-semibold text-stock-out">
                {error}
              </p>
            )}

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={cerrar}
                className="h-touch-lg flex-1 rounded-xl border border-hairline font-semibold text-ink">
                Cancelar
              </button>
              <button
                type="button"
                onClick={enviar}
                disabled={
                  pending ||
                  businessName.trim().length < 3 ||
                  ownerName.trim().length < 2 ||
                  !email.trim() ||
                  !planCode ||
                  (manual && password.length < 8)
                }
                className="h-touch-lg flex-1 rounded-xl bg-industrial-600 font-bold text-white disabled:opacity-40"
              >
                {pending ? 'Creando…' : 'Crear cuenta'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Dato({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={`font-semibold ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
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

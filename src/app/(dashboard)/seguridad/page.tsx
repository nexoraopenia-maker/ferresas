import { auth } from '@/auth'
import { requireTenantContext } from '@/lib/session'
import { listarDispositivos } from '@/features/seguridad/dispositivos'
import { estadoMfa } from '@/features/seguridad/mfa-service'
import { MfaPanel } from '@/features/seguridad/components/MfaPanel'
import { DispositivosManager } from '@/features/seguridad/components/DispositivosManager'

export const dynamic = 'force-dynamic'

/** Mis dispositivos: dónde está abierta mi sesión, y cerrarlas. */
export default async function SeguridadPage() {
  const ctx = await requireTenantContext()
  const sesion = await auth()
  // Las sesiones son del usuario que INICIÓ sesión en el dispositivo, no del operador por PIN.
  const usuario = ctx.operadorDe ?? ctx.userId
  const dispositivos = await listarDispositivos(usuario, sesion?.sid)
  const mfa = await estadoMfa(usuario)

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-5 p-4">
      <header>
        <h1 className="text-2xl font-extrabold text-ink">Seguridad</h1>
        <p className="text-sm text-ink-muted">
          Dónde tienes la sesión abierta. Si no reconoces un dispositivo, ciérralo y cambia tu contraseña.
        </p>
      </header>
      <MfaPanel activo={mfa.activo} obligatorio={mfa.obligatorio} codigosRestantes={mfa.codigosRestantes} />
      <DispositivosManager
        dispositivos={dispositivos.map((d) => ({
          id: d.id, descripcion: d.descripcion, ip: d.ip, actual: d.actual,
          creadaEn: d.creadaEn.toISOString(), vistaEn: d.vistaEn.toISOString(),
        }))}
      />
    </main>
  )
}

import { after } from 'next/server'
import { prisma } from '@/lib/prisma'
import { asegurarDatosDemo, correoDemo } from './seed'

/**
 * Al iniciar sesión con la cuenta demo, asegura que tenga sus datos.
 *
 * NO espera al sembrado: tarda decenas de segundos y el usuario no debe
 * quedarse mirando el login. Se programa con `after`, que mantiene viva la
 * función hasta terminar. Si aun así el proceso se corta, el reclamo caduca y
 * el siguiente inicio de sesión lo retoma (ver `asegurarDatosDemo`).
 *
 * Para cualquier otro correo no hace NADA, ni siquiera una consulta.
 */
export async function alIniciarSesion(userId: string, email: string): Promise<void> {
  if (email.trim().toLowerCase() !== correoDemo()) return

  const u = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } })
  if (!u?.tenantId) return

  const tarea = () =>
    asegurarDatosDemo(u.tenantId!).then(
      (r) => { if (r === 'sembrada') console.info('[demo] datos de demostración precargados') },
      (e) => console.error('[demo] no se pudieron precargar los datos', e instanceof Error ? e.message : e),
    )
  try {
    after(tarea)
  } catch {
    void tarea()
  }
}

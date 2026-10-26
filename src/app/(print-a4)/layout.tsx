import './a4.css'
import { requireTenantContext } from '@/lib/session'

/**
 * Contenedor de los informes impresos en A4. FUERA del grupo (dashboard), como (print): un informe con el menú del panel alrededor
 * saldría impreso con el menú encima. Su `@page` (A4) solo afecta a estas rutas.
 *
 * A diferencia de (print), VERIFICA la sesión contra la base: lo que imprime es el estado de cuenta de un cliente (deuda, teléfono),
 * y todo layout de un área privada es la puerta de lo que envuelve. `requireTenantContext` está memoizado por render, así que la
 * página que lo vuelve a pedir no hace otra consulta.
 */
export default async function ImpresionA4Layout({ children }: { children: React.ReactNode }) {
  await requireTenantContext()
  return <div className="a4-pantalla">{children}</div>
}

import { redirect } from 'next/navigation'
import { ROUTES } from '@/lib/route-access'

export default function Home() {
  // El proxy decide el destino real según sesión, rol y estado de cuenta.
  redirect(ROUTES.dashboard)
}

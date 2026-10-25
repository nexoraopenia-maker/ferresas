import type { Metadata, Viewport } from 'next'
import './globals.css'
import { BannerSinRed } from '@/components/pwa/BannerSinRed'
import { RegistrarServiceWorker } from '@/components/pwa/RegistrarServiceWorker'

export const metadata: Metadata = {
  title: 'FerreSaaS',
  description: 'Control de inventario y punto de venta para ferreterías.',
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'FerreSaaS', statusBarStyle: 'black-translucent' },
}

export const viewport: Viewport = {
  // Sin zoom: en el flujo de escaneo un pellizco accidental rompe el encuadre.
  // Nota: esto degrada accesibilidad, así que los tamaños base ya son grandes.
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover', // habilita env(safe-area-inset-*)
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="es">
      <body className="antialiased">
        <BannerSinRed />
        <RegistrarServiceWorker />
        {children}
      </body>
    </html>
  )
}

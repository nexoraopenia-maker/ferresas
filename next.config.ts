import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // El escáner necesita la cámara y `navigator.mediaDevices` solo existe en
  // contextos seguros. En producción Vercel ya sirve por HTTPS; en LAN
  // (probar con el celular real) hace falta un túnel https o next dev --experimental-https.
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        // Solo el propio origen puede pedir cámara; nada de micrófono ni GPS.
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
      ],
    },
    {
      // El worker se revalida SIEMPRE: si el navegador lo cacheara, una versión vieja con una política vieja seguiría activa.
      source: '/sw.js',
      headers: [
        { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
        { key: 'Service-Worker-Allowed', value: '/' },
      ],
    },
  ],
}

export default nextConfig

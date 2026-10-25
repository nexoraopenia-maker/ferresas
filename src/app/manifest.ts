import type { MetadataRoute } from 'next'

/**
 * Manifest de la PWA (se sirve en /manifest.webmanifest).
 *
 * `start_url` apunta al punto de venta: es lo que se abre desde el icono del celular. Si la persona no tiene sesión, el
 * proxy la manda al login y vuelve después; el manifest NO guarda nada de ella.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'FerreSaaS',
    short_name: 'FerreSaaS',
    description: 'Control de inventario y punto de venta para ferreterías.',
    lang: 'es',
    start_url: '/pos',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    // El logo es blanco sobre negro: el fondo de arranque y la barra siguen ese tono.
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

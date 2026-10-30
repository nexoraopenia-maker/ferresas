'use client'

import dynamic from 'next/dynamic'

/**
 * El escáner por cámara SOLO existe en el navegador (getUserMedia, BarcodeDetector, ZXing con `BarcodeFormat`…). Se carga con `next/dynamic` y `ssr: false` para que el servidor
 * NO lo toque ni al renderizar ni al compilar los Client Components que lo usan (POS, inventario, conteo): su código y el de ZXing salen del bundle del servidor y se bajan
 * solo cuando el modal se abre. Quien lo use debe importar `InventoryScannerModal` DESDE AQUÍ (los tipos, de `InventoryScannerModal` con `import type`).
 */
export const InventoryScannerModal = dynamic(
  () => import('./InventoryScannerModal').then((m) => m.InventoryScannerModal),
  { ssr: false },
)

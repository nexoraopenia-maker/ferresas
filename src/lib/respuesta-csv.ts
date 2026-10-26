import { NextResponse } from 'next/server'

/**
 * La respuesta HTTP de una descarga CSV. Una sola, para que ninguna ruta olvide un encabezado:
 *  · `attachment`: el navegador descarga, no pinta datos de clientes en una pestaña.
 *  · `no-store`: lleva datos personales y de deuda; ni el navegador ni un intermediario los guardan.
 *  · `nosniff`: que nadie lo reinterprete como HTML.
 * El nombre del archivo se limpia aquí aunque quien lo arma ya lo haya hecho: es lo que acaba en una cabecera HTTP.
 */
export function respuestaCsv(archivo: { nombre: string; contenido: string }): NextResponse {
  const nombre = archivo.nombre.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'datos.csv'
  return new NextResponse(archivo.contenido, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${nombre}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

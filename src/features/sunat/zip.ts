import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

/**
 * ZIP mínimo (un archivo, deflate) con `node:zlib`, sin dependencias: lo que pide el servicio de SUNAT para enviar un
 * comprobante, y lo necesario para leer el ZIP del CDR que devuelve. Defensivo al leer: tamaño máximo descomprimido
 * (bomba ZIP), nombres sin rutas y sin cifrado.
 */

const MAX_DESCOMPRIMIDO = 5 * 1024 * 1024
const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_FIN = 0x06054b50

export class ZipInvalido extends Error {
  constructor(mensaje: string) { super(mensaje); this.name = 'ZipInvalido' }
}

export function crearZip(nombre: string, contenido: Buffer): Buffer {
  const n = Buffer.from(nombre, 'utf8')
  const datos = deflateRawSync(contenido)
  const crc = crc32(contenido)
  // Fecha/hora fijas: el ZIP es determinista (mismo XML → mismo ZIP).
  const hora = 0, fecha = (46 << 9) | (1 << 5) | 1 // 2026-01-01

  const local = Buffer.alloc(30)
  local.writeUInt32LE(SIG_LOCAL, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6) // UTF-8
  local.writeUInt16LE(8, 8); local.writeUInt16LE(hora, 10); local.writeUInt16LE(fecha, 12)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(datos.length, 18); local.writeUInt32LE(contenido.length, 22)
  local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(SIG_CENTRAL, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10); central.writeUInt16LE(hora, 12); central.writeUInt16LE(fecha, 14)
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(datos.length, 20); central.writeUInt32LE(contenido.length, 24)
  central.writeUInt16LE(n.length, 28); central.writeUInt32LE(0, 42) // offset del local = 0

  const cuerpo = Buffer.concat([local, n, datos])
  const dirCentral = Buffer.concat([central, n])
  const fin = Buffer.alloc(22)
  fin.writeUInt32LE(SIG_FIN, 0); fin.writeUInt16LE(1, 8); fin.writeUInt16LE(1, 10)
  fin.writeUInt32LE(dirCentral.length, 12); fin.writeUInt32LE(cuerpo.length, 16)
  return Buffer.concat([cuerpo, dirCentral, fin])
}

export interface EntradaZip { nombre: string; contenido: Buffer }

export function leerZip(zip: Buffer): EntradaZip[] {
  // Fin del directorio central: se busca desde el final (puede llevar un comentario).
  let fin = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === SIG_FIN) { fin = i; break }
  }
  if (fin < 0) throw new ZipInvalido('No es un ZIP válido.')
  const total = zip.readUInt16LE(fin + 10)
  let p = zip.readUInt32LE(fin + 16)
  const salida: EntradaZip[] = []
  for (let k = 0; k < total; k++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipInvalido('Directorio central dañado.')
    const flags = zip.readUInt16LE(p + 8), metodo = zip.readUInt16LE(p + 10)
    const crcDeclarado = zip.readUInt32LE(p + 16), csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24)
    const ln = zip.readUInt16LE(p + 28), le = zip.readUInt16LE(p + 30), lc = zip.readUInt16LE(p + 32)
    const offLocal = zip.readUInt32LE(p + 42)
    const nombre = zip.subarray(p + 46, p + 46 + ln).toString('utf8')
    p += 46 + ln + le + lc

    if (flags & 1) throw new ZipInvalido('ZIP cifrado: no se admite.')
    // Nunca se escribe a disco, pero igual se rechazan los nombres que intentan salirse (`..`, `\\`, ruta absoluta, NUL). Una ruta NORMAL (`dummy/R-F001-1.xml`) sí vale:
    // los ZIP de CDR de SUNAT traen el archivo dentro de una carpeta `dummy/` (hallazgo en BETA, docs/SUNAT-SUPUESTOS.md #33).
    if (nombre.includes('\\') || nombre.includes('\0') || nombre.startsWith('/') || nombre.split('/').includes('..')) throw new ZipInvalido('Nombre de archivo no permitido en el ZIP.')
    // Una carpeta no es un archivo: se salta (sin tocar su cabecera, que a veces ni lleva datos).
    if (nombre.endsWith('/')) continue
    if (usize > MAX_DESCOMPRIMIDO) throw new ZipInvalido('El contenido del ZIP es demasiado grande.')
    if (offLocal + 30 > zip.length || zip.readUInt32LE(offLocal) !== SIG_LOCAL) throw new ZipInvalido('Cabecera local dañada.')
    const inicio = offLocal + 30 + zip.readUInt16LE(offLocal + 26) + zip.readUInt16LE(offLocal + 28)
    const datos = zip.subarray(inicio, inicio + csize)
    let contenido: Buffer
    try {
      contenido = metodo === 0 ? Buffer.from(datos) : metodo === 8 ? inflateRawSync(datos, { maxOutputLength: MAX_DESCOMPRIMIDO }) : (() => { throw new ZipInvalido('Método de compresión no admitido.') })()
    } catch (e) {
      throw e instanceof ZipInvalido ? e : new ZipInvalido('No se pudo descomprimir el ZIP.')
    }
    if (contenido.length !== usize) throw new ZipInvalido('El tamaño descomprimido no coincide.')
    // La suma de control del archivo: un CDR dañado en el camino no se acepta como si estuviera bien.
    if (crc32(contenido) !== crcDeclarado) throw new ZipInvalido('El contenido del ZIP no coincide con su suma de control.')
    salida.push({ nombre: nombre.slice(nombre.lastIndexOf('/') + 1), contenido })
  }
  return salida
}

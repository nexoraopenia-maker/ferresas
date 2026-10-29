import { crc32, deflateRawSync } from 'node:zlib'

/**
 * ZIP «al estilo de SUNAT» para las pruebas: lo que SUNAT BETA devolvió de verdad en la primera prueba real (hallazgo #33): el CDR viene dentro de una carpeta `dummy/`
 * (una entrada de carpeta y luego el archivo con ruta), y el archivo se escribe con BANDERA 3 (tamaños y suma de control DESPUÉS de los datos, en un descriptor), así que
 * la cabecera local lleva ceros. Nuestro lector solo debe fiarse del directorio central.
 */
export function crearZipEstiloSunat(rutaArchivo: string, contenido: Buffer, opciones: { conCarpeta?: boolean } = {}): Buffer {
  const partes: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const agregar = (nombre: string, datos: Buffer | null) => {
    const n = Buffer.from(nombre, 'utf8')
    const esCarpeta = datos === null
    const comprimido = esCarpeta ? Buffer.alloc(0) : deflateRawSync(datos)
    const crc = esCarpeta ? 0 : crc32(datos)
    const usize = esCarpeta ? 0 : datos.length
    const flags = esCarpeta ? 0 : 0x0008
    const metodo = esCarpeta ? 0 : 8
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(metodo, 8)
    local.writeUInt16LE(n.length, 26)   // crc y tamaños locales = 0 (van en el descriptor)
    const descriptor = Buffer.alloc(esCarpeta ? 0 : 16)
    if (!esCarpeta) { descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(comprimido.length, 8); descriptor.writeUInt32LE(usize, 12) }
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(metodo, 10)
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comprimido.length, 20); c.writeUInt32LE(usize, 24); c.writeUInt16LE(n.length, 28)
    if (esCarpeta) c.writeUInt32LE(0x10, 38)   // atributo externo: directorio
    c.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([c, n]))
    const trozo = Buffer.concat([local, n, comprimido, descriptor])
    partes.push(trozo)
    offset += trozo.length
  }
  const carpeta = rutaArchivo.includes('/') ? rutaArchivo.slice(0, rutaArchivo.lastIndexOf('/') + 1) : null
  if (opciones.conCarpeta !== false && carpeta) agregar(carpeta, null)
  agregar(rutaArchivo, contenido)
  const dir = Buffer.concat(central)
  const fin = Buffer.alloc(22)
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(central.length, 8); fin.writeUInt16LE(central.length, 10)
  fin.writeUInt32LE(dir.length, 12); fin.writeUInt32LE(offset, 16)
  return Buffer.concat([...partes, dir, fin])
}

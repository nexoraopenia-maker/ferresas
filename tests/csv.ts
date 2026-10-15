import './guard'
import {
  detectDelimiter, mapColumns, normalizeUnit, parseAmount, parseCsv,
} from '../src/features/inventory/csv'

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

console.log('\n1) Detección de separador — la trampa de Excel en español')
check('>>> punto y coma (Excel es-PE)', detectDelimiter('nombre;precio;stock') === ';')
check('coma (Excel en-US)', detectDelimiter('nombre,precio,stock') === ',')
check('tabulador (pegado desde Excel)', detectDelimiter('nombre\tprecio\tstock') === '\t')
check('>>> NO se deja engañar por una coma DENTRO de comillas',
  detectDelimiter('"Cemento, 42.5kg";"32.50";"10"') === ';')

console.log('\n2) BOM de Excel «CSV UTF-8»')
{
  const t = parseCsv('﻿nombre;precio\nCemento;32.50')
  check('>>> se quita el BOM de la primera cabecera', t.headers[0] === 'nombre', JSON.stringify(t.headers[0]))
  check('la fila se lee bien', t.rows[0]?.[0] === 'Cemento')
}

console.log('\n3) Campos entre comillas')
{
  const t = parseCsv('nombre;precio\n"Cemento Sol, 42.5 kg";32.50')
  check('>>> el separador dentro de comillas NO parte el campo',
    t.rows[0]?.[0] === 'Cemento Sol, 42.5 kg', JSON.stringify(t.rows[0]))
  check('el precio queda en su columna', t.rows[0]?.[1] === '32.50')
}
{
  const t = parseCsv('nombre;nota\n"Tubo 1/2""";"mide 1/2"" exacto"')
  check('comillas escapadas ("" -> ")', t.rows[0]?.[0] === 'Tubo 1/2"', JSON.stringify(t.rows[0]?.[0]))
  check('y en medio de un campo', t.rows[0]?.[1] === 'mide 1/2" exacto')
}
{
  const t = parseCsv('nombre;desc\nCable;"linea 1\nlinea 2"')
  check('>>> salto de línea DENTRO de un campo no parte la fila',
    t.rows.length === 1 && t.rows[0]?.[1] === 'linea 1\nlinea 2', `${t.rows.length} filas`)
}

console.log('\n4) Finales de línea y filas vacías')
check('CRLF de Windows', parseCsv('a;b\r\n1;2\r\n').rows.length === 1)
check('CR suelto (Mac clásico)', parseCsv('a;b\r1;2').rows.length === 1)
check('sin salto final', parseCsv('a;b\n1;2').rows.length === 1)
check('>>> ignora la fila vacía que añade Excel al final',
  parseCsv('a;b\n1;2\n;\n').rows.length === 1)
check('e ignora huecos en medio', parseCsv('a;b\n1;2\n\n3;4').rows.length === 2)

console.log('\n5) Cabeceras: alias en castellano')
{
  const m = mapColumns(['nombre', 'código de barras', 'p. venta', 'stock', 'unidad'])
  check('nombre', m.indices.name === 0)
  check('código de barras -> barcode', m.indices.barcode === 1)
  check('«p. venta» -> salePrice', m.indices.salePrice === 2)
  check('stock', m.indices.stock === 3)
  check('unidad -> unitType', m.indices.unitType === 4)
}
{
  const m = mapColumns(['Producto', 'PRECIO', 'Existencias'])
  check('insensible a mayúsculas',
    m.indices.name === 0 && m.indices.salePrice === 1 && m.indices.stock === 2)
}
{
  const m = mapColumns(['nombre', 'precio', 'proveedor', 'ubicacion'])
  check('reporta las columnas no reconocidas',
    m.ignoradas.join(',') === 'proveedor,ubicacion', m.ignoradas.join(','))
}

console.log('\n6) Unidades')
check('kg -> KILOGRAMO', normalizeUnit('kg') === 'KILOGRAMO')
check('Kilos -> KILOGRAMO', normalizeUnit(' Kilos ') === 'KILOGRAMO')
check('und. -> UNIDAD (con punto)', normalizeUnit('und.') === 'UNIDAD')
check('bls -> BOLSA', normalizeUnit('bls') === 'BOLSA')
check('vacío -> null (se usará el valor por defecto)', normalizeUnit('') === null)
check('desconocida -> null (se avisa en la fila)', normalizeUnit('cajitas') === null)

console.log('\n7) Importes: coma, punto y separador de miles')
check('"32.50" -> 32.5', parseAmount('32.50') === 32.5)
check('>>> "32,50" -> 32.5 (coma decimal)', parseAmount('32,50') === 32.5)
check('>>> "1.234,56" -> 1234.56 (miles con punto)', parseAmount('1.234,56') === 1234.56)
check('"32.50" en precio sigue siendo 32.5', parseAmount('32.50', 'money') === 32.5)
check('>>> "1,234.56" -> 1234.56 (miles con coma)', parseAmount('1,234.56') === 1234.56)
check('>>> en PRECIO, "1.200" -> 1200 (miles), no 1.2',
  parseAmount('1.200', 'money') === 1200, String(parseAmount('1.200', 'money')))
check('>>> en CANTIDAD, "0.250" -> 0.25 (250 g), no 250',
  parseAmount('0.250', 'quantity') === 0.25, String(parseAmount('0.250', 'quantity')))
check('en CANTIDAD, "45.500" -> 45.5 kg, no 45500',
  parseAmount('45.500', 'quantity') === 45.5, String(parseAmount('45.500', 'quantity')))
check('en PRECIO, "1.234.567" -> 1234567', parseAmount('1.234.567', 'money') === 1234567)
check('"1,200" -> 1200', parseAmount('1,200') === 1200, String(parseAmount('1,200')))
check('quita el símbolo de soles', parseAmount('S/ 32.50') === 32.5)
check('quita espacios', parseAmount(' 32.50 ') === 32.5)
check('vacío -> null', parseAmount('') === null)
check('texto -> null', parseAmount('gratis') === null)
check('cero es un valor válido, no null', parseAmount('0') === 0)

console.log('\n8) Un archivo realista de ferretería')
{
  const archivo = [
    'Nombre;Código de barras;Unidad;P. Venta;Costo;Stock;Mínimo',
    '"Cemento Sol 42.5 kg";7751234567890;bls;32,50;28,00;120;20',
    '"Clavo 3"" a granel";;kg;8,50;6,20;45,5;5',
    '"Cable THW 14 AWG";;m;4,20;3,10;200;25',
    '"Tubo PVC 1/2"" x 3m";7751234567891;und;11,80;9,00;60;10',
    ';;;;;;',
  ].join('\r\n')

  const t = parseCsv(archivo)
  const m = mapColumns(t.headers)
  check('separador detectado', t.delimiter === ';')
  check('4 productos (la fila vacía se descarta)', t.rows.length === 4, `${t.rows.length}`)
  check('todas las columnas reconocidas', m.ignoradas.length === 0)
  check('el nombre con comillas escapadas sale bien',
    t.rows[1]?.[m.indices.name!] === 'Clavo 3" a granel', t.rows[1]?.[0])
  check('precio con coma decimal', parseAmount(t.rows[0]?.[m.indices.salePrice!]) === 32.5)
  check('stock fraccionado del granel',
    parseAmount(t.rows[1]?.[m.indices.stock!], 'quantity') === 45.5)
  check('unidad a granel normalizada', normalizeUnit(t.rows[2]?.[m.indices.unitType!]) === 'METRO')
  check('código de barras vacío queda vacío', t.rows[1]?.[m.indices.barcode!] === '')
}

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)

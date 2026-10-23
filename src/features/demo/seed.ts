import { randomUUID } from 'node:crypto'
import { BusinessError } from '@/lib/errors'
import { ean13 } from '@/lib/codigos-barras'
import { completarRuc } from '@/lib/documentos'
import { periodos } from '@/lib/periodos'
import { prisma } from '@/lib/prisma'
import { getTenantPrisma } from '@/lib/tenant-prisma'
import type { TenantContext } from '@/lib/tenant-context'
import { registerTenant } from '@/features/onboarding/service'
import { createProductExpress } from '@/features/inventory/product-service'
import { registerSale } from '@/features/pos/sale-service'
import { convertQuoteToSale, registerQuote } from '@/features/pos/quote-service'
import { issueTaxDocument } from '@/features/invoicing/service'
import { enviarComprobante } from '@/features/invoicing/envio'
import { closeCashSession, currentCashSession, openCashSession } from '@/features/branches/cash-service'

/**
 * Cuenta de demostración.
 *
 * Una ferretería ficticia, completa y usable, para que quien la visita vea el
 * sistema funcionando sin partir de cero: productos con stock (y algunos en
 * alerta), clientes, cotizaciones, ventas de los últimos días, comprobantes y
 * cajas cerradas y abierta.
 *
 * ─── REGLAS ──────────────────────────────────────────────────────────────
 *
 *  · NO escribe nada "por detrás" en una cuenta real. Todo cuelga de un
 *    tenant con `isDemo = true`, y `prepararCuentaDemo` se niega a tocar un
 *    correo que ya pertenezca a un negocio de verdad.
 *  · Los datos pasan por los MISMOS servicios que usa el POS (venta, cotización,
 *    caja, comprobante), no por inserts sueltos: el libro de movimientos
 *    cuadra con el stock y los correlativos son los de verdad. Después solo se
 *    reescriben las FECHAS, para repartir las ventas por los últimos días.
 *  · Todo lo que identifica a una persona o a una empresa es ficticio. Los
 *    documentos son números obviamente falsos (00000001…).
 *  · Los comprobantes no salen a SUNAT: no hay proveedor real conectado y, aun
 *    si lo hubiera, `obtenerProveedor` fuerza el simulado para un tenant demo.
 */

export const CORREO_DEMO_POR_DEFECTO = 'pool@fer.pe'
export const correoDemo = () => (process.env.DEMO_EMAIL ?? CORREO_DEMO_POR_DEFECTO).trim().toLowerCase()

const MS_DIA = 86_400_000

interface ProductoDemo {
  name: string
  sku: string
  barcode?: string
  unitType: 'UNIDAD' | 'KILOGRAMO' | 'METRO' | 'BOLSA' | 'LITRO' | 'CAJA' | 'PLANCHA'
  /** Código QR propio, para probar la lectura de QR además de la de barras. */
  qrCode?: string
  salePrice: number
  stock: number
  minStock: number
}

/** Precios en soles, razonables para una ferretería de barrio. Los stocks bajos son a propósito. */
const PRODUCTOS_BASE: readonly ProductoDemo[] = [
  { name: 'Cemento Sol 42.5 kg', sku: 'CEM-SOL', barcode: '7750000100011', unitType: 'BOLSA', salePrice: 31.5, stock: 120, minStock: 30 },
  { name: 'Cemento Andino 42.5 kg', sku: 'CEM-AND', barcode: '7750000100028', unitType: 'BOLSA', salePrice: 30.9, stock: 80, minStock: 30 },
  { name: 'Fierro corrugado 3/8" x 9 m', sku: 'FIE-38', barcode: '7750000100035', unitType: 'UNIDAD', salePrice: 29.0, stock: 200, minStock: 40 },
  { name: 'Fierro corrugado 1/2" x 9 m', sku: 'FIE-12', barcode: '7750000100042', unitType: 'UNIDAD', salePrice: 52.5, stock: 90, minStock: 30 },
  { name: 'Ladrillo King Kong 18 huecos', sku: 'LAD-KK', unitType: 'UNIDAD', salePrice: 1.25, stock: 3000, minStock: 500 },
  { name: 'Arena gruesa (m³)', sku: 'ARE-GR', unitType: 'UNIDAD', salePrice: 65.0, stock: 12, minStock: 4 },
  { name: 'Clavos 3" (kg)', sku: 'CLA-3', unitType: 'KILOGRAMO', salePrice: 6.5, stock: 60, minStock: 15 },
  { name: 'Clavos 2" (kg)', sku: 'CLA-2', unitType: 'KILOGRAMO', salePrice: 6.8, stock: 40, minStock: 15 },
  { name: 'Alambre N°16 (kg)', sku: 'ALA-16', unitType: 'KILOGRAMO', salePrice: 7.9, stock: 8, minStock: 10 },
  { name: 'Tubo PVC 1/2" x 3 m', sku: 'PVC-12', barcode: '7750000100059', unitType: 'UNIDAD', salePrice: 11.8, stock: 70, minStock: 20 },
  { name: 'Tubo PVC 4" desagüe x 3 m', sku: 'PVC-4D', barcode: '7750000100066', unitType: 'UNIDAD', salePrice: 38.0, stock: 25, minStock: 8 },
  { name: 'Codo PVC 1/2"', sku: 'COD-12', unitType: 'UNIDAD', salePrice: 0.9, stock: 300, minStock: 60 },
  { name: 'Pegamento PVC 1/4 gal', sku: 'PEG-PVC', barcode: '7750000100073', unitType: 'UNIDAD', salePrice: 24.5, stock: 18, minStock: 6 },
  { name: 'Cinta teflón 1/2"', sku: 'TEF-12', barcode: '7750000100080', unitType: 'UNIDAD', salePrice: 1.5, stock: 0, minStock: 40 },
  { name: 'Cable THW 14 AWG (m)', sku: 'THW-14', unitType: 'METRO', salePrice: 2.4, stock: 600, minStock: 100 },
  { name: 'Cable THW 12 AWG (m)', sku: 'THW-12', unitType: 'METRO', salePrice: 3.6, stock: 450, minStock: 100 },
  { name: 'Interruptor simple', sku: 'INT-S', barcode: '7750000100097', unitType: 'UNIDAD', salePrice: 6.0, stock: 55, minStock: 15 },
  { name: 'Tomacorriente doble', sku: 'TOM-D', barcode: '7750000100103', unitType: 'UNIDAD', salePrice: 8.5, stock: 3, minStock: 12 },
  { name: 'Foco LED 9 W', sku: 'LED-9', barcode: '7750000100110', unitType: 'UNIDAD', salePrice: 5.5, stock: 140, minStock: 40 },
  { name: 'Cinta aislante 18 m', sku: 'CIN-AIS', barcode: '7750000100127', unitType: 'UNIDAD', salePrice: 3.5, stock: 90, minStock: 20 },
  { name: 'Pintura látex blanco 1 gal', sku: 'PIN-LB', barcode: '7750000100134', unitType: 'UNIDAD', salePrice: 48.0, stock: 36, minStock: 10 },
  { name: 'Pintura esmalte negro 1/4 gal', sku: 'PIN-EN', barcode: '7750000100141', unitType: 'UNIDAD', salePrice: 29.0, stock: 14, minStock: 8 },
  { name: 'Thinner acrílico 1 L', sku: 'THI-1', barcode: '7750000100158', unitType: 'LITRO', salePrice: 9.0, stock: 40, minStock: 12 },
  { name: 'Brocha 3"', sku: 'BRO-3', barcode: '7750000100165', unitType: 'UNIDAD', salePrice: 7.5, stock: 33, minStock: 10 },
  { name: 'Rodillo 9" con mango', sku: 'ROD-9', barcode: '7750000100172', unitType: 'UNIDAD', salePrice: 12.0, stock: 22, minStock: 8 },
  { name: 'Martillo carpintero 16 oz', sku: 'MAR-16', barcode: '7750000100189', unitType: 'UNIDAD', salePrice: 28.0, stock: 15, minStock: 5 },
  { name: 'Alicate universal 8"', sku: 'ALI-8', barcode: '7750000100196', unitType: 'UNIDAD', salePrice: 24.0, stock: 12, minStock: 5 },
  { name: 'Destornillador Phillips N°2', sku: 'DES-P2', barcode: '7750000100202', unitType: 'UNIDAD', salePrice: 9.5, stock: 4, minStock: 8 },
  { name: 'Disco de corte metal 4½"', sku: 'DIS-45', barcode: '7750000100219', unitType: 'UNIDAD', salePrice: 4.5, stock: 6, minStock: 30 },
  { name: 'Candado 40 mm', sku: 'CAN-40', barcode: '7750000100226', unitType: 'UNIDAD', salePrice: 18.0, stock: 26, minStock: 6 },
  { name: 'Bisagra 3" (par)', sku: 'BIS-3', unitType: 'UNIDAD', salePrice: 5.0, stock: 48, minStock: 12 },
  { name: 'Tornillo drywall 1" (caja 100)', sku: 'TOR-DW', barcode: '7750000100233', unitType: 'CAJA', salePrice: 8.0, stock: 0, minStock: 15 },
]


/**
 * Catálogo ampliado. Los EAN-13 se GENERAN con dígito de control válido (prefijo
 * 775 = GS1 Perú, secuencia de prueba): un EAN con el dígito mal lo descarta el
 * escáner, y la demo existe justo para probar el escáner.
 */
const ean = (n: number) => ean13(`775000010${String(n).padStart(3, '0')}`)

const PRODUCTOS_EXTRA: readonly ProductoDemo[] = [
  // Herramientas manuales
  { name: 'Cinta métrica 5 m', sku: 'CIN-M5', barcode: ean(300), qrCode: 'QR-CIN-M5', unitType: 'UNIDAD', salePrice: 14.5, stock: 40, minStock: 10 },
  { name: 'Cinta métrica 8 m', sku: 'CIN-M8', barcode: ean(301), unitType: 'UNIDAD', salePrice: 19.9, stock: 25, minStock: 8 },
  { name: 'Wincha 50 m', sku: 'WIN-50', barcode: ean(302), unitType: 'UNIDAD', salePrice: 36.0, stock: 6, minStock: 2 },
  { name: 'Nivel de aluminio 24"', sku: 'NIV-24', barcode: ean(303), unitType: 'UNIDAD', salePrice: 32.0, stock: 10, minStock: 4 },
  { name: 'Escuadra metálica 12"', sku: 'ESC-12', unitType: 'UNIDAD', salePrice: 15.0, stock: 12, minStock: 4 },
  { name: 'Serrucho 20"', sku: 'SER-20', barcode: ean(304), unitType: 'UNIDAD', salePrice: 26.0, stock: 9, minStock: 3 },
  { name: 'Tenaza 8"', sku: 'TEN-8', barcode: ean(305), unitType: 'UNIDAD', salePrice: 21.0, stock: 11, minStock: 4 },
  { name: 'Llave francesa 10"', sku: 'LLA-F10', barcode: ean(306), unitType: 'UNIDAD', salePrice: 34.0, stock: 8, minStock: 3 },
  { name: 'Juego de destornilladores 6 pzs', sku: 'JUE-DES6', barcode: ean(307), unitType: 'UNIDAD', salePrice: 29.0, stock: 14, minStock: 5 },
  { name: 'Alicate de punta 8"', sku: 'ALI-PU8', barcode: ean(308), unitType: 'UNIDAD', salePrice: 24.9, stock: 12, minStock: 4 },
  { name: 'Alicate de presión 10"', sku: 'ALI-PR10', barcode: ean(309), unitType: 'UNIDAD', salePrice: 38.5, stock: 7, minStock: 3 },
  { name: 'Martillo de goma', sku: 'MAR-GO', unitType: 'UNIDAD', salePrice: 22.0, stock: 6, minStock: 3 },
  { name: 'Cincel plano 1"', sku: 'CIN-PL', unitType: 'UNIDAD', salePrice: 12.0, stock: 10, minStock: 3 },
  // Herramientas eléctricas y abrasivos
  { name: 'Taladro percutor 650 W', sku: 'TAL-650', barcode: ean(310), qrCode: 'QR-TAL-650', unitType: 'UNIDAD', salePrice: 189.0, stock: 6, minStock: 2 },
  { name: 'Amoladora 4½" 850 W', sku: 'AMO-45', barcode: ean(311), unitType: 'UNIDAD', salePrice: 159.0, stock: 5, minStock: 2 },
  { name: 'Broca para concreto 3/8"', sku: 'BRO-C38', barcode: ean(312), unitType: 'UNIDAD', salePrice: 6.5, stock: 60, minStock: 15 },
  { name: 'Broca para metal 1/4"', sku: 'BRO-M14', barcode: ean(313), unitType: 'UNIDAD', salePrice: 4.5, stock: 50, minStock: 15 },
  { name: 'Disco de corte concreto 4½"', sku: 'DIS-CC', barcode: ean(314), unitType: 'UNIDAD', salePrice: 9.5, stock: 40, minStock: 12 },
  // Gasfitería
  { name: 'Tubo PVC 3/4" x 3 m', sku: 'PVC-34', barcode: ean(315), unitType: 'UNIDAD', salePrice: 15.5, stock: 55, minStock: 18 },
  { name: 'Tubo PVC 1" x 3 m', sku: 'PVC-1', barcode: ean(316), unitType: 'UNIDAD', salePrice: 21.0, stock: 40, minStock: 12 },
  { name: 'Tubo PVC 2" desagüe x 3 m', sku: 'PVC-2D', barcode: ean(317), unitType: 'UNIDAD', salePrice: 24.0, stock: 30, minStock: 10 },
  { name: 'Codo PVC 3/4"', sku: 'COD-34', unitType: 'UNIDAD', salePrice: 1.2, stock: 250, minStock: 60 },
  { name: 'Tee PVC 1/2"', sku: 'TEE-12', unitType: 'UNIDAD', salePrice: 1.1, stock: 220, minStock: 60 },
  { name: 'Válvula esfera 1/2"', sku: 'VAL-E12', barcode: ean(318), unitType: 'UNIDAD', salePrice: 14.5, stock: 30, minStock: 10 },
  { name: 'Grifo de lavatorio cromado', sku: 'GRI-LAV', barcode: ean(319), unitType: 'UNIDAD', salePrice: 38.0, stock: 12, minStock: 4 },
  { name: 'Manguera 1/2" (m)', sku: 'MAN-12', unitType: 'METRO', salePrice: 3.8, stock: 200, minStock: 50 },
  // Electricidad
  { name: 'Interruptor doble', sku: 'INT-D', barcode: ean(320), unitType: 'UNIDAD', salePrice: 8.5, stock: 40, minStock: 12 },
  { name: 'Interruptor de 3 vías', sku: 'INT-3V', barcode: ean(321), unitType: 'UNIDAD', salePrice: 9.5, stock: 25, minStock: 8 },
  { name: 'Tomacorriente simple con tierra', sku: 'TOM-ST', barcode: ean(322), unitType: 'UNIDAD', salePrice: 7.5, stock: 50, minStock: 15 },
  { name: 'Cable vulcanizado 2x14 (m)', sku: 'CAB-V214', unitType: 'METRO', salePrice: 4.5, stock: 300, minStock: 80 },
  { name: 'Foco LED 12 W', sku: 'LED-12', barcode: ean(323), unitType: 'UNIDAD', salePrice: 7.5, stock: 90, minStock: 30 },
  { name: 'Tubo conduit PVC 3/4"', sku: 'CON-34', unitType: 'UNIDAD', salePrice: 4.2, stock: 100, minStock: 30 },
  { name: 'Caja rectangular PVC', sku: 'CAJ-R', unitType: 'UNIDAD', salePrice: 1.5, stock: 150, minStock: 40 },
  { name: 'Interruptor termomagnético 20 A', sku: 'TM-20', barcode: ean(324), unitType: 'UNIDAD', salePrice: 28.0, stock: 18, minStock: 6 },
  // Clavos, tornillería y cerrajería
  { name: 'Clavos 1" (kg)', sku: 'CLA-1', unitType: 'KILOGRAMO', salePrice: 7.2, stock: 25, minStock: 8 },
  { name: 'Clavos 4" (kg)', sku: 'CLA-4', unitType: 'KILOGRAMO', salePrice: 6.2, stock: 45, minStock: 15 },
  { name: 'Clavos de acero 2" (kg)', sku: 'CLA-AC', unitType: 'KILOGRAMO', salePrice: 9.8, stock: 20, minStock: 8 },
  { name: 'Tornillo autorroscante 1½" (caja 100)', sku: 'TOR-AR', barcode: ean(325), unitType: 'CAJA', salePrice: 12.0, stock: 30, minStock: 10 },
  { name: 'Perno hexagonal 3/8" x 2"', sku: 'PER-38', unitType: 'UNIDAD', salePrice: 1.6, stock: 200, minStock: 50 },
  { name: 'Tarugo plástico 1/4" (bolsa 100)', sku: 'TAR-14', barcode: ean(326), unitType: 'BOLSA', salePrice: 5.5, stock: 60, minStock: 20 },
  { name: 'Candado 50 mm', sku: 'CAN-50', barcode: ean(327), unitType: 'UNIDAD', salePrice: 24.0, stock: 18, minStock: 6 },
  { name: 'Cerradura de embutir', sku: 'CER-EM', barcode: ean(328), unitType: 'UNIDAD', salePrice: 65.0, stock: 8, minStock: 3 },
  { name: 'Bisagra 4"', sku: 'BIS-4', unitType: 'UNIDAD', salePrice: 6.5, stock: 40, minStock: 12 },
  { name: 'Cadena galvanizada (m)', sku: 'CAD-G', unitType: 'METRO', salePrice: 8.5, stock: 80, minStock: 20 },
  // Construcción
  { name: 'Cal hidratada 20 kg', sku: 'CAL-20', barcode: ean(329), unitType: 'BOLSA', salePrice: 14.5, stock: 40, minStock: 12 },
  { name: 'Yeso 25 kg', sku: 'YES-25', barcode: ean(330), unitType: 'BOLSA', salePrice: 11.0, stock: 30, minStock: 10 },
  { name: 'Cemento cola 25 kg', sku: 'CEM-CO', barcode: ean(331), unitType: 'BOLSA', salePrice: 24.0, stock: 35, minStock: 10 },
  { name: 'Plancha drywall 1/2"', sku: 'DRY-12', barcode: ean(332), unitType: 'PLANCHA', salePrice: 32.0, stock: 40, minStock: 12 },
  // Pintura
  { name: 'Lija de agua N°220', sku: 'LIJ-220', unitType: 'UNIDAD', salePrice: 1.2, stock: 150, minStock: 40 },
  { name: 'Espátula 3"', sku: 'ESP-3', barcode: ean(333), unitType: 'UNIDAD', salePrice: 6.5, stock: 20, minStock: 6 },
  { name: 'Masilla 1 kg', sku: 'MAS-1', barcode: ean(334), unitType: 'UNIDAD', salePrice: 12.0, stock: 20, minStock: 6 },
  { name: 'Pintura látex amarillo 1 gal', sku: 'PIN-LA', barcode: ean(335), unitType: 'UNIDAD', salePrice: 52.0, stock: 14, minStock: 5 },
  { name: 'Esmalte sintético blanco 1 gal', sku: 'PIN-ESB', barcode: ean(336), unitType: 'UNIDAD', salePrice: 79.0, stock: 10, minStock: 4 },
  { name: 'Cinta de enmascarar 3/4"', sku: 'CIN-EN', barcode: ean(337), unitType: 'UNIDAD', salePrice: 3.2, stock: 70, minStock: 20 },
  // Seguridad
  { name: 'Casco de seguridad', sku: 'CAS-SEG', barcode: ean(338), qrCode: 'QR-CAS-SEG', unitType: 'UNIDAD', salePrice: 18.0, stock: 25, minStock: 8 },
  { name: 'Lentes de seguridad', sku: 'LEN-SEG', barcode: ean(339), unitType: 'UNIDAD', salePrice: 6.5, stock: 40, minStock: 12 },
  { name: 'Guantes de cuero (par)', sku: 'GUA-CU', barcode: ean(340), unitType: 'UNIDAD', salePrice: 9.0, stock: 35, minStock: 10 },
  { name: 'Chaleco reflectivo', sku: 'CHA-REF', unitType: 'UNIDAD', salePrice: 15.0, stock: 20, minStock: 6 },
  { name: 'Mascarilla descartable (caja 50)', sku: 'MAS-DES', barcode: ean(341), unitType: 'CAJA', salePrice: 22.0, stock: 12, minStock: 4 },
]

export const PRODUCTOS_DEMO: readonly ProductoDemo[] = [...PRODUCTOS_BASE, ...PRODUCTOS_EXTRA]

/** Categorías de la demo y qué SKU pertenece a cada una. */
export const CATEGORIAS_DEMO: ReadonlyArray<{ slug: string; name: string; skus: readonly string[] }> = [
  { slug: 'construccion', name: 'Materiales de construcción', skus: ['CEM-SOL', 'CEM-AND', 'LAD-KK', 'ARE-GR', 'CAL-20', 'YES-25', 'CEM-CO', 'DRY-12'] },
  { slug: 'fierro-alambres', name: 'Fierro y alambres', skus: ['FIE-38', 'FIE-12', 'ALA-16', 'CAD-G'] },
  { slug: 'gasfiteria', name: 'Gasfitería', skus: ['PVC-12', 'PVC-4D', 'COD-12', 'PEG-PVC', 'TEF-12', 'PVC-34', 'PVC-1', 'PVC-2D', 'COD-34', 'TEE-12', 'VAL-E12', 'GRI-LAV', 'MAN-12'] },
  { slug: 'electricidad', name: 'Electricidad', skus: ['THW-14', 'THW-12', 'INT-S', 'TOM-D', 'LED-9', 'CIN-AIS', 'INT-D', 'INT-3V', 'TOM-ST', 'CAB-V214', 'LED-12', 'CON-34', 'CAJ-R', 'TM-20'] },
  { slug: 'pintura', name: 'Pintura y acabados', skus: ['PIN-LB', 'PIN-EN', 'THI-1', 'BRO-3', 'ROD-9', 'LIJ-220', 'ESP-3', 'MAS-1', 'PIN-LA', 'PIN-ESB', 'CIN-EN'] },
  { slug: 'herramientas-manuales', name: 'Herramientas manuales', skus: ['MAR-16', 'ALI-8', 'DES-P2', 'CIN-M5', 'CIN-M8', 'WIN-50', 'NIV-24', 'ESC-12', 'SER-20', 'TEN-8', 'LLA-F10', 'JUE-DES6', 'ALI-PU8', 'ALI-PR10', 'MAR-GO', 'CIN-PL'] },
  { slug: 'herramientas-electricas', name: 'Herramientas eléctricas y abrasivos', skus: ['DIS-45', 'TAL-650', 'AMO-45', 'BRO-C38', 'BRO-M14', 'DIS-CC'] },
  { slug: 'ferreteria-general', name: 'Clavos, tornillería y cerrajería', skus: ['CLA-3', 'CLA-2', 'CAN-40', 'BIS-3', 'TOR-DW', 'CLA-1', 'CLA-4', 'CLA-AC', 'TOR-AR', 'PER-38', 'TAR-14', 'CAN-50', 'CER-EM', 'BIS-4'] },
  { slug: 'seguridad', name: 'Seguridad industrial', skus: ['CAS-SEG', 'LEN-SEG', 'GUA-CU', 'CHA-REF', 'MAS-DES'] },
]

/**
 * RUC ficticios pero con dígito verificador VÁLIDO: el sistema valida los RUC
 * de las facturas y uno inventado a mano (20000000000) se rechazaría. Son
 * números de prueba construidos aquí, no empresas; pueden coincidir por azar
 * con uno real, y por eso todo lo demo lleva «(demo)» y el aviso permanente.
 */
const RUC_EMISOR_DEMO = completarRuc('2099999990')
const RUC_CLIENTE_1 = completarRuc('2000000001')
const RUC_CLIENTE_2 = completarRuc('2000000002')

const RUC_CLIENTE_3 = completarRuc('2000000003')
const RUC_CLIENTE_4 = completarRuc('2000000004')
const RUC_CLIENTE_5 = completarRuc('2000000005')

export const CLIENTES_DEMO = [
  { docType: 'DNI' as const, docNumber: '00000001', name: 'Juan Pérez (cliente demo)' },
  { docType: 'DNI' as const, docNumber: '00000002', name: 'María Quispe (cliente demo)' },
  { docType: 'DNI' as const, docNumber: '00000003', name: 'Carlos Huamán (cliente demo)' },
  { docType: 'RUC' as const, docNumber: RUC_CLIENTE_1, name: 'Constructora Los Andes S.A.C. (demo)' },
  { docType: 'RUC' as const, docNumber: RUC_CLIENTE_2, name: 'Inversiones El Roble E.I.R.L. (demo)' },
  { docType: 'DNI' as const, docNumber: '00000004', name: 'Rosa Mamani (cliente demo)' },
  // Maestros de obra y empresas que compran a crédito (línea de crédito de ejemplo).
  { docType: 'DNI' as const, docNumber: '00000005', name: 'Pedro Condori, maestro de obra (demo)', phone: '999000005', creditLimit: 2000 },
  { docType: 'DNI' as const, docNumber: '00000006', name: 'Luis Ccama, maestro de obra (demo)', phone: '999000006', creditLimit: 1500 },
  { docType: 'DNI' as const, docNumber: '00000007', name: 'Ana Flores (cliente demo)', phone: '999000007' },
  { docType: 'DNI' as const, docNumber: '00000008', name: 'Marco Salas, gasfitero (demo)', phone: '999000008', creditLimit: 800 },
  { docType: 'DNI' as const, docNumber: '00000009', name: 'Elena Torres, electricista (demo)', phone: '999000009', creditLimit: 800 },
  { docType: 'DNI' as const, docNumber: '00000010', name: 'Jorge Mendoza (cliente demo)' },
  { docType: 'RUC' as const, docNumber: RUC_CLIENTE_3, name: 'Corporación Cusco Obras S.A.C. (demo)', creditLimit: 10000 },
  { docType: 'RUC' as const, docNumber: RUC_CLIENTE_4, name: 'Ingeniería y Construcción Sur S.R.L. (demo)', creditLimit: 8000 },
  { docType: 'RUC' as const, docNumber: RUC_CLIENTE_5, name: 'Acabados Premium E.I.R.L. (demo)' },
]

export interface ResultadoCuentaDemo {
  tenantId: string
  userId: string
  creada: boolean
}

/**
 * Crea la cuenta demo si no existe, o la reconoce si ya existe.
 *
 * Si el correo YA pertenece a un negocio que no es de demostración, se niega:
 * convertir una cuenta real en demo la llenaría de productos y ventas
 * inventados.
 */
export async function prepararCuentaDemo(opts: {
  email: string
  password?: string
}): Promise<ResultadoCuentaDemo> {
  const email = opts.email.trim().toLowerCase()
  const existente = await prisma.user.findUnique({
    where: { email },
    select: { id: true, tenantId: true, tenant: { select: { isDemo: true } } },
  })

  if (existente) {
    if (!existente.tenantId || !existente.tenant?.isDemo) {
      throw new BusinessError(
        'FORBIDDEN_ROLE',
        `El correo ${email} ya pertenece a un negocio que NO es de demostración. ` +
          'No se toca. Usa otro correo para la demo (variable DEMO_EMAIL).',
      )
    }
    return { tenantId: existente.tenantId, userId: existente.id, creada: false }
  }

  if (!opts.password || opts.password.length < 8) {
    throw new BusinessError(
      'INVALID_DOCUMENT',
      'Para crear la cuenta demo hace falta DEMO_PASSWORD (mínimo 8 caracteres) en el entorno.',
    )
  }

  const r = await registerTenant({
    businessName: 'Ferretería Demo',
    ownerName: 'Cuenta Demo',
    email,
    password: opts.password,
    planCode: 'premium',
  })

  await prisma.$transaction([
    prisma.tenant.update({
      where: { id: r.tenantId },
      data: {
        isDemo: true,
        // La demo enseña la política de caja: el efectivo entra siempre en un turno.
        cashRequired: true,
        legalName: 'FERRETERIA DEMO S.A.C.',
        // Ficticio. Un RUC real aquí haría pasar la demo por una empresa de verdad.
        taxId: RUC_EMISOR_DEMO,
        address: 'Av. Ficticia 123, Lima',
        ubigeo: '150101',
      },
    }),
    // La demo no caduca ni se bloquea por mora: es una vitrina.
    prisma.subscription.update({
      where: { tenantId: r.tenantId },
      data: { status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: null, pastDueSince: null },
    }),
  ])

  return { tenantId: r.tenantId, userId: r.userId, creada: true }
}

/** Precarga los datos de la demo (ver la cabecera del módulo). */
export async function sembrarDatosDemo(tenantId: string, ahora: Date = new Date()): Promise<{
  productos: number; clientes: number; cotizaciones: number; ventas: number; comprobantes: number
}> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId }, select: { isDemo: true },
  })
  if (!tenant.isDemo) {
    throw new BusinessError('FORBIDDEN_ROLE', 'Solo se precargan datos en una cuenta de demostración.')
  }

  const owner = await prisma.user.findFirstOrThrow({
    where: { tenantId, role: 'OWNER' }, select: { id: true },
  })
  const branch = await prisma.branch.findFirstOrThrow({
    where: { tenantId, isDefault: true }, select: { id: true },
  })
  const wh = await prisma.warehouse.findFirstOrThrow({
    where: { tenantId, branchId: branch.id, isDefault: true }, select: { id: true },
  })

  const ctx: TenantContext = {
    tenantId, userId: owner.id, role: 'OWNER', access: 'FULL',
    branchId: branch.id, branchIds: [branch.id],
  }
  const db = getTenantPrisma(ctx)

  // ── Clientes ───────────────────────────────────────────────────────────
  await prisma.customer.createMany({
    data: CLIENTES_DEMO.map((c) => ({ tenantId, ...c })),
    skipDuplicates: true,
  })
  const clientes = await prisma.customer.findMany({ where: { tenantId }, select: { id: true, docNumber: true } })
  const cliente = (n: string) => clientes.find((c) => c.docNumber === n)?.id ?? null

  // ── Productos con stock, por el servicio del alta exprés ───────────────
  const ids = new Map<string, string>()
  const yaHechos = await prisma.product.findMany({
    where: { tenantId, sku: { in: PRODUCTOS_DEMO.map((p) => p.sku) } }, select: { id: true, sku: true },
  })
  for (const p of yaHechos) ids.set(p.sku, p.id)
  const pendientes = PRODUCTOS_DEMO.filter((p) => !ids.has(p.sku))
  // En tandas de 8: son independientes y la red es lo que más tarda.
  for (let i = 0; i < pendientes.length; i += 8) {
    await Promise.all(pendientes.slice(i, i + 8).map(async (p) => {
      const r = await createProductExpress(db, ctx, {
        name: p.name, sku: p.sku, barcode: p.barcode, qrCode: p.qrCode, unitType: p.unitType,
        salePrice: p.salePrice, initialStock: p.stock, minStock: p.minStock,
        warehouseId: wh.id, idempotencyKey: randomUUID(),
      } as never)
      ids.set(p.sku, r.productId)
    }))
  }
  const prod = (sku: string) => ids.get(sku)!

  // ── Categorías: se crean y se asignan SOLO a los productos que aún no tienen
  // ninguna (así la demo que ya existía las recibe sin pisar nada). ──────────
  for (const c of CATEGORIAS_DEMO) {
    const cat = await prisma.category.upsert({
      where: { tenantId_slug: { tenantId, slug: c.slug } },
      create: { tenantId, slug: c.slug, name: c.name },
      update: {},
      select: { id: true },
    })
    await prisma.product.updateMany({
      where: { tenantId, categoryId: null, sku: { in: [...c.skus] } },
      data: { categoryId: cat.id },
    })
  }

  const linea = (sku: string, quantity: number) => ({ productId: prod(sku), quantity, discount: 0 })
  const fechar = async (saleId: string, cuando: Date) => {
    await prisma.sale.update({ where: { id: saleId }, data: { createdAt: cuando, completedAt: cuando } })
    await prisma.payment.updateMany({ where: { saleId }, data: { createdAt: cuando } })
    await prisma.stockMovement.updateMany({ where: { tenantId, referenceId: saleId }, data: { createdAt: cuando } })
    await prisma.taxDocument.updateMany({ where: { saleId }, data: { issuedAt: cuando } })
  }
  // Las fechas se reparten por el día civil de LIMA (no por el UTC del servidor):
  // sembrar a las 00:30 de Lima con aritmética UTC dejaba las ventas «de hoy» en ayer.
  const hoyLima = periodos(ahora, 'America/Lima').hoy.desde.getTime()
  const hace = (dias: number, hora: number) => {
    const d = new Date(hoyLima - dias * MS_DIA + hora * 3_600_000)
    // Lo de «hoy» no puede quedar en el futuro ni antes de la medianoche de hoy.
    return d > ahora ? new Date(Math.max(ahora.getTime() - 60_000, hoyLima + 60_000)) : d
  }

  // Si una ejecución anterior se cortó a medias, los productos y clientes ya
  // están; lo transaccional (ventas, caja, cotizaciones) solo se hace sobre una
  // demo SIN ventas, para no duplicar nada ni dejar números repetidos.
  if ((await prisma.sale.count({ where: { tenantId } })) > 0) {
    return { productos: PRODUCTOS_DEMO.length, clientes: CLIENTES_DEMO.length, cotizaciones: 0, ventas: 0, comprobantes: 0 }
  }

  // ── Turno de ayer, cerrado con un pequeño faltante ─────────────────────
  await openCashSession(db, ctx, { openingAmount: 100, notes: 'Apertura (demo)' } as never)
  const ventasDef: { dias: number; hora: number; cliente?: string; doc: 'NOTA_VENTA' | 'BOLETA' | 'FACTURA'; metodo: 'EFECTIVO' | 'YAPE' | 'TARJETA_DEBITO' | 'TRANSFERENCIA'; items: [string, number][] }[] = [
    { dias: 6, hora: 9, doc: 'BOLETA', metodo: 'EFECTIVO', items: [['CEM-SOL', 10], ['CLA-3', 2]] },
    { dias: 6, hora: 15, cliente: RUC_CLIENTE_1, doc: 'FACTURA', metodo: 'TRANSFERENCIA', items: [['FIE-38', 40], ['FIE-12', 20], ['CEM-AND', 30]] },
    { dias: 5, hora: 10, doc: 'NOTA_VENTA', metodo: 'EFECTIVO', items: [['PVC-12', 4], ['COD-12', 8], ['PEG-PVC', 1]] },
    { dias: 4, hora: 11, cliente: '00000001', doc: 'BOLETA', metodo: 'YAPE', items: [['PIN-LB', 2], ['BRO-3', 2], ['ROD-9', 1]] },
    { dias: 4, hora: 17, doc: 'BOLETA', metodo: 'EFECTIVO', items: [['THW-14', 50], ['INT-S', 3], ['CIN-AIS', 2]] },
    { dias: 3, hora: 9, cliente: '00000002', doc: 'BOLETA', metodo: 'TARJETA_DEBITO', items: [['MAR-16', 1], ['ALI-8', 1], ['DES-P2', 2]] },
    { dias: 3, hora: 14, doc: 'NOTA_VENTA', metodo: 'EFECTIVO', items: [['LAD-KK', 400], ['ARE-GR', 2]] },
    { dias: 2, hora: 10, cliente: RUC_CLIENTE_2, doc: 'FACTURA', metodo: 'TRANSFERENCIA', items: [['CEM-SOL', 25], ['FIE-38', 30]] },
    { dias: 2, hora: 16, doc: 'BOLETA', metodo: 'YAPE', items: [['LED-9', 6], ['TOM-D', 2]] },
    { dias: 1, hora: 9, doc: 'NOTA_VENTA', metodo: 'EFECTIVO', items: [['CLA-2', 3], ['ALA-16', 2], ['BIS-3', 2]] },
    { dias: 1, hora: 13, cliente: '00000003', doc: 'BOLETA', metodo: 'EFECTIVO', items: [['DIS-45', 4], ['CAN-40', 2]] },
    { dias: 1, hora: 18, doc: 'BOLETA', metodo: 'TARJETA_DEBITO', items: [['PIN-EN', 2], ['THI-1', 2]] },
    { dias: 0, hora: 8, doc: 'BOLETA', metodo: 'EFECTIVO', items: [['CEM-AND', 8], ['PVC-4D', 3]] },
    { dias: 0, hora: 10, cliente: '00000004', doc: 'NOTA_VENTA', metodo: 'YAPE', items: [['THW-12', 30], ['CIN-AIS', 1]] },
  ]

  let ventas = 0
  let comprobantes = 0
  let turnoHoyAbierto = false
  for (const v of ventasDef) {
    // Al pasar de "ayer" a "hoy": se cierra el turno viejo y se abre el de hoy.
    if (v.dias === 0 && !turnoHoyAbierto) {
      const actual = await currentCashSession(db, ctx)
      if (!actual) throw new Error('La demo esperaba un turno abierto.')
      // Cierra con un faltante de S/ 2.50: así el panel enseña un descuadre real.
      await closeCashSession(db, ctx, {
        sessionId: actual.id,
        countedAmount: Math.max(0, Math.round((actual.expectedAmount - 2.5) * 100) / 100),
        notes: 'Cierre (demo)',
      } as never)
      await openCashSession(db, ctx, { openingAmount: 150, notes: 'Apertura de hoy (demo)' } as never)
      turnoHoyAbierto = true
    }
    const items = v.items.map(([sku, q]) => linea(sku, q))
    const total = v.items.reduce((s, [sku, q]) => s + PRODUCTOS_DEMO.find((p) => p.sku === sku)!.salePrice * q, 0)
    const r = await registerSale(db, ctx, {
      warehouseId: wh.id,
      customerId: v.cliente ? cliente(v.cliente) : null,
      items,
      payments: [{ method: v.metodo, amount: Math.round(total * 100) / 100 }],
      documentType: v.doc === 'NOTA_VENTA' ? 'NOTA_VENTA' : v.doc,
      allowNegativeStock: false,
      idempotencyKey: randomUUID(),
    } as never)
    ventas++
    if (v.doc !== 'NOTA_VENTA') {
      const doc = await issueTaxDocument(db, ctx, { saleId: r.saleId, documentType: v.doc } as never)
      // Al proveedor simulado: así la demo enseña comprobantes ACEPTADOS, no pendientes.
      await enviarComprobante(db, ctx, doc.id)
      comprobantes++
    }
    await fechar(r.saleId, hace(v.dias, v.hora))
  }

  // El turno cerrado queda con fechas de ayer; el abierto, con las de hoy.
  const ayer = hace(1, 8)
  await prisma.cashSession.updateMany({
    where: { tenantId, status: 'CERRADA' },
    data: { openedAt: ayer, closedAt: hace(1, 20) },
  })
  await prisma.cashSession.updateMany({
    where: { tenantId, status: 'ABIERTA' },
    data: { openedAt: hace(0, 7) },
  })

  // ── Cotizaciones ───────────────────────────────────────────────────────
  const cotis: [string | undefined, [string, number][]][] = [
    [RUC_CLIENTE_1, [['CEM-SOL', 40], ['FIE-12', 60], ['LAD-KK', 2000]]],
    ['00000002', [['PIN-LB', 4], ['THI-1', 4], ['BRO-3', 4]]],
    [undefined, [['PVC-4D', 10], ['PEG-PVC', 3]]],
    [RUC_CLIENTE_2, [['THW-14', 300], ['THW-12', 200], ['INT-S', 20], ['TOM-D', 20]]],
  ]
  let cotizaciones = 0
  for (const [doc, its] of cotis) {
    await registerQuote(db, ctx, {
      warehouseId: wh.id,
      customerId: doc ? cliente(doc) : null,
      items: its.map(([sku, q]) => linea(sku, q)),
      validDays: 15,
      idempotencyKey: randomUUID(),
    } as never)
    cotizaciones++
  }
  // Una cotización convertida en venta, para ver el flujo completo.
  const q = await db.quote.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true, total: true } })
  const conv = await convertQuoteToSale(db, ctx, {
    quoteId: q.id, payments: [{ method: 'TRANSFERENCIA', amount: Number(q.total) }],
    documentType: 'FACTURA', allowNegativeStock: false, idempotencyKey: randomUUID(),
  } as never)
  ventas++
  await fechar(conv.saleId, hace(0, 9))

  return { productos: PRODUCTOS_DEMO.length, clientes: CLIENTES_DEMO.length, cotizaciones, ventas, comprobantes }
}

/** Un reclamo de sembrado caduca a los 10 minutos: si el proceso murió, otro lo retoma. */
export const CADUCIDAD_RECLAMO_MS = 10 * 60_000
const VENTAS_ESPERADAS = 15

/**
 * Garantiza que la demo tenga sus datos. Seguro de llamar muchas veces y a la
 * vez: `demoSeededAt` es el RECLAMO (la hora del último intento) y se toma con
 * un UPDATE condicional, así que de varios llamadores simultáneos solo uno
 * siembra. Si ese proceso muere (una función serverless cortada por tiempo),
 * el reclamo caduca y el siguiente lo retoma; como el sembrado es reanudable,
 * retomarlo no duplica nada. Si la demo ya está completa, no hace nada.
 */
export async function asegurarDatosDemo(
  tenantId: string,
  ahora: Date = new Date(),
): Promise<'sembrada' | 'ya-estaba' | 'no-es-demo'> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isDemo: true } })
  if (!t?.isDemo) return 'no-es-demo'

  const reclamo = await prisma.tenant.updateMany({
    where: {
      id: tenantId, isDemo: true,
      OR: [{ demoSeededAt: null }, { demoSeededAt: { lt: new Date(ahora.getTime() - CADUCIDAD_RECLAMO_MS) } }],
    },
    data: { demoSeededAt: ahora },
  })
  if (reclamo.count !== 1) return 'ya-estaba'

  const [productos, ventas] = await Promise.all([
    prisma.product.count({ where: { tenantId, deletedAt: null } }),
    prisma.sale.count({ where: { tenantId, status: 'COMPLETADA' } }),
  ])
  if (productos >= PRODUCTOS_DEMO.length && ventas >= VENTAS_ESPERADAS) return 'ya-estaba'

  await sembrarDatosDemo(tenantId, ahora)
  return 'sembrada'
}

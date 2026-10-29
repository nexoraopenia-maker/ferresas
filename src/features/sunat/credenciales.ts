import { BusinessError } from '@/lib/errors'
import { ClaveMaestraAusente, CifradoInvalido, cifrar, descifrar, hayClaveMaestra } from '@/lib/cifrado'
import { exigir } from '@/lib/puede'
import type { TenantContext } from '@/lib/tenant-context'
import type { TenantPrismaClient } from '@/lib/tenant-prisma'
import { validarRuc } from '@/lib/documentos'
import { CertificadoInvalido, estadoCertificado, leerPfx, type EstadoCertificado } from './certificado'
import { consultarCdr, EndpointNoPermitido, type DepsCliente } from './cliente'
import { esFalloDeAcceso } from './cdr'
import { SUNAT_BETA_BILL, SUNAT_PRODUCCION_BILL } from './endpoints'

/**
 * Credenciales de SUNAT directo de cada negocio (S2): certificado digital (.pfx) y usuario SOL SECUNDARIO.
 *
 * ─── QUIÉN ───────────────────────────────────────────────────────────────
 * Solo `config.fiscal` (el dueño: el administrador no lo tiene, no es opcional ni delegable, y está fuera del PIN de operador). Además,
 * **guardar o quitar se niega durante una suplantación** del SuperAdmin: el soporte puede mirar los metadatos, nunca escribir secretos.
 *
 * ─── QUÉ SE GUARDA ───────────────────────────────────────────────────────
 * El .pfx, su clave y la clave SOL, CIFRADOS (AES-256-GCM atado al negocio; el texto cifrado lleva la versión de la clave maestra, así que
 * se puede rotar: `src/lib/cifrado.ts`). El archivo `.pfx` no se conserva como archivo: se abre, se valida, se cifra y se descarta. Nada de
 * esto vuelve al navegador: la pantalla solo conoce los metadatos del certificado. Ningún mensaje de error, auditoría ni log lleva un secreto.
 *
 * ─── AMBIENTE ────────────────────────────────────────────────────────────
 * Siempre nace en BETA. Pasar a producción es del SuperAdmin (S5), no se puede desde aquí.
 */

export const TOPE_PFX_BYTES = 100 * 1024
/** Entre dos pruebas de conexión del mismo negocio: SUNAT bloquea usuarios que prueban claves a ráfagas. */
export const ESPERA_ENTRE_PRUEBAS_MS = 15_000

export interface EstadoSunat {
  configurado: boolean
  ambiente: 'BETA' | 'PRODUCCION' | null
  usuarioSol: string | null
  certificado: {
    sujeto: string
    emisor: string
    ruc: string | null
    serie: string
    desde: Date
    vence: Date
    estado: EstadoCertificado
    diasRestantes: number
  } | null
  /** Última prueba de conexión con SUNAT, si hubo. */
  ultimaPrueba: { en: Date; ok: boolean; mensaje: string } | null
  /** Sin clave maestra en el servidor no se puede guardar nada. */
  claveMaestra: boolean
}

const DIA = 86_400_000

/** Lo que la pantalla puede ver. Nunca secretos. */
export async function estadoCredencialesSunat(db: TenantPrismaClient, ahora: Date = new Date()): Promise<EstadoSunat> {
  const c = await db.sunatCredential.findFirst({
    select: {
      ambiente: true, solUser: true, certSubject: true, certIssuer: true, certRuc: true, certSerial: true, certValidFrom: true, certValidTo: true,
      lastTestAt: true, lastTestOk: true, lastTestMessage: true,
    },
  })
  if (!c) return { configurado: false, ambiente: null, usuarioSol: null, certificado: null, ultimaPrueba: null, claveMaestra: hayClaveMaestra() }
  return {
    configurado: true, ambiente: c.ambiente, usuarioSol: c.solUser, claveMaestra: hayClaveMaestra(),
    certificado: {
      sujeto: c.certSubject, emisor: c.certIssuer, ruc: c.certRuc, serie: c.certSerial, desde: c.certValidFrom, vence: c.certValidTo,
      estado: estadoCertificado({ desde: c.certValidFrom, vence: c.certValidTo }, ahora),
      diasRestantes: Math.floor((c.certValidTo.getTime() - ahora.getTime()) / DIA),
    },
    ultimaPrueba: c.lastTestAt ? { en: c.lastTestAt, ok: c.lastTestOk === true, mensaje: c.lastTestMessage ?? '' } : null,
  }
}

/** Solo para la barra de aviso: el estado del certificado, o `null` si no hay credenciales. Barato: una fila. */
export async function alertaDeCertificado(db: TenantPrismaClient, ahora: Date = new Date()): Promise<{ estado: EstadoCertificado; diasRestantes: number } | null> {
  const c = await db.sunatCredential.findFirst({ select: { certValidFrom: true, certValidTo: true } })
  if (!c) return null
  return { estado: estadoCertificado({ desde: c.certValidFrom, vence: c.certValidTo }, ahora), diasRestantes: Math.floor((c.certValidTo.getTime() - ahora.getTime()) / DIA) }
}

export interface EntradaCredencialesSunat {
  /** El .pfx en base64. */
  pfxBase64: string
  claveCertificado: string
  usuarioSol: string
  claveSol: string
}

const invalido = (m: string) => new BusinessError('INVALID_DOCUMENT', m)

/** Quien suplanta no escribe secretos de otro negocio. */
function negarSiSuplanta(ctx: TenantContext) {
  if (ctx.impersonationId) throw new BusinessError('FORBIDDEN_ROLE', 'Durante una suplantación de soporte no se pueden cargar ni quitar las credenciales de SUNAT: las carga el dueño.')
}

export async function guardarCredencialesSunat(
  db: TenantPrismaClient, ctx: TenantContext, input: EntradaCredencialesSunat, ahora: Date = new Date(),
): Promise<EstadoSunat> {
  exigir(ctx, 'config.fiscal')
  negarSiSuplanta(ctx)
  if (!hayClaveMaestra()) throw invalido('El servidor no tiene configurada la clave para guardar credenciales de forma segura. Avisa a soporte.')

  const usuarioSol = input.usuarioSol.trim()
  if (!/^[A-Za-z0-9]{3,30}$/.test(usuarioSol)) throw invalido('El usuario SOL secundario solo lleva letras y números (3 a 30).')
  if (input.claveSol.length < 4 || input.claveSol.length > 100) throw invalido('La clave SOL no parece válida.')
  if (input.claveCertificado.length < 1 || input.claveCertificado.length > 200) throw invalido('Escribe la clave del certificado.')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.pfxBase64)) throw invalido('El archivo del certificado no llegó bien. Vuelve a elegirlo.')
  const pfx = Buffer.from(input.pfxBase64, 'base64')
  if (pfx.length < 200 || pfx.length > TOPE_PFX_BYTES) throw invalido('El certificado no parece un .pfx válido (tamaño fuera de lo normal).')

  // Abrirlo es la validación: clave correcta, clave privada incluida, certificado propio.
  let cert
  try { cert = leerPfx(pfx, input.claveCertificado) } catch (e) {
    if (e instanceof CertificadoInvalido) throw invalido(e.message)
    throw e
  }
  const estado = estadoCertificado(cert, ahora)
  if (estado === 'vencido') throw invalido('El certificado digital está vencido: renuévalo antes de cargarlo.')
  if (estado === 'aun_no_vigente') throw invalido('El certificado digital todavía no está vigente.')

  const tenant = await db.tenant.findFirstOrThrow({ select: { id: true, taxId: true } })
  if (!tenant.taxId || !validarRuc(tenant.taxId).valido) throw invalido('Completa el RUC (válido) del negocio antes de cargar el certificado.')
  // ⚠️ El RUC del titular se deduce del sujeto (heurística). Si se detecta y no coincide, es un certificado ajeno.
  if (cert.ruc && cert.ruc !== tenant.taxId) throw invalido('El certificado digital no corresponde al RUC de este negocio.')

  const datos = {
    pfxEnc: cifrar(input.pfxBase64, ctx.tenantId),
    pfxPasswordEnc: cifrar(input.claveCertificado, ctx.tenantId),
    solUser: usuarioSol,
    solPasswordEnc: cifrar(input.claveSol, ctx.tenantId),
    // Siempre BETA al cargar o cambiar credenciales: producción la activa un SuperAdmin (S5) y exige volver a probar.
    ambiente: 'BETA' as const,
    certSubject: cert.sujeto.slice(0, 500), certIssuer: cert.emisor.slice(0, 500), certSerial: cert.serie.slice(0, 200),
    certRuc: cert.ruc, certValidFrom: cert.desde, certValidTo: cert.vence,
    // Credenciales nuevas: la prueba anterior ya no vale.
    lastTestAt: null, lastTestOk: null, lastTestMessage: null,
    updatedById: ctx.userId,
  }
  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    const previa = await t.sunatCredential.findFirst({ select: { id: true, certSerial: true, certValidTo: true, solUser: true, ambiente: true } })
    if (previa) await t.sunatCredential.update({ where: { id: previa.id }, data: datos })
    else await t.sunatCredential.create({ data: { tenantId: ctx.tenantId, ...datos } })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'sunat.credenciales_guardadas', entityType: 'SunatCredential', entityId: tenant.id,
        // NUNCA el .pfx ni las claves: solo qué certificado, de quién y quién lo cargó.
        before: previa ? { serie: previa.certSerial, vence: previa.certValidTo.toISOString().slice(0, 10), usuarioSol: previa.solUser } : undefined,
        after: { serie: cert.serie, ruc: cert.ruc, vence: cert.vence.toISOString().slice(0, 10), usuarioSol, ambiente: 'BETA' },
        impersonationId: ctx.impersonationId ?? null,
      },
    })
  })
  return estadoCredencialesSunat(db, ahora)
}

export async function quitarCredencialesSunat(db: TenantPrismaClient, ctx: TenantContext): Promise<void> {
  exigir(ctx, 'config.fiscal')
  negarSiSuplanta(ctx)
  const t = await db.tenant.findFirstOrThrow({ select: { id: true } })
  await db.$transaction(async (tx) => {
    const x = tx as unknown as TenantPrismaClient
    const previa = await x.sunatCredential.findFirst({ select: { certSerial: true, solUser: true } })
    if (!previa) return
    await x.sunatCredential.deleteMany({})
    await x.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role,
        action: 'sunat.credenciales_quitadas', entityType: 'SunatCredential', entityId: t.id,
        before: { serie: previa.certSerial, usuarioSol: previa.solUser }, impersonationId: ctx.impersonationId ?? null,
      },
    })
  })
}

/** Las credenciales descifradas, SOLO para usarlas en el servidor (S3). `null` si no hay. Nunca se devuelve esto a una pantalla. */
export interface CredencialesSunatDescifradas {
  pfx: Buffer
  claveCertificado: string
  usuarioSol: string
  claveSol: string
  ambiente: 'BETA' | 'PRODUCCION'
  /** URL del servicio de envío que corresponde al ambiente. */
  urlBill: string
}

export async function credencialesSunatDelNegocio(db: TenantPrismaClient, tenantId: string): Promise<CredencialesSunatDescifradas | null> {
  const c = await db.sunatCredential.findFirst({ select: { pfxEnc: true, pfxPasswordEnc: true, solUser: true, solPasswordEnc: true, ambiente: true } })
  if (!c) return null
  try {
    return {
      pfx: Buffer.from(descifrar(c.pfxEnc, tenantId), 'base64'),
      claveCertificado: descifrar(c.pfxPasswordEnc, tenantId),
      usuarioSol: c.solUser,
      claveSol: descifrar(c.solPasswordEnc, tenantId),
      ambiente: c.ambiente,
      urlBill: c.ambiente === 'PRODUCCION' ? SUNAT_PRODUCCION_BILL : SUNAT_BETA_BILL,
    }
  } catch (e) {
    if (e instanceof ClaveMaestraAusente || e instanceof CifradoInvalido) throw invalido('No se pudieron leer las credenciales de SUNAT del negocio. Vuelve a cargarlas.')
    throw e
  }
}

export interface ResultadoPrueba {
  ok: boolean
  mensaje: string
}

/**
 * «Probar conexión» (paso 3 de la pantalla): comprueba que las credenciales guardadas se pueden leer, que el certificado abre y está vigente, y
 * que SUNAT acepta el usuario y la clave SOL. Para lo último hace una CONSULTA de un comprobante que no existe (no emite, no firma, no envía nada
 * tributario): si SUNAT responde algo que no sea un rechazo de acceso, las credenciales pasaron.
 * ⚠️ Que un fallo de acceso (`esFalloDeAcceso`: 0101–0106) sea «usuario o clave incorrectos» y cualquier otra respuesta signifique «acceso concedido» es un SUPUESTO
 * (docs/SUNAT-SUPUESTOS.md #13): se confirma con el ambiente beta. Una prueba por negocio cada `ESPERA_ENTRE_PRUEBAS_MS`.
 */
export async function probarConexionSunat(
  db: TenantPrismaClient, ctx: TenantContext, deps: DepsCliente & { urlBill?: string; ahora?: Date } = {},
): Promise<ResultadoPrueba> {
  exigir(ctx, 'config.fiscal')
  const ahora = deps.ahora ?? new Date()
  const previa = await db.sunatCredential.findFirst({ select: { id: true, lastTestAt: true, certValidFrom: true, certValidTo: true } })
  if (!previa) return { ok: false, mensaje: 'Primero carga el certificado y el usuario SOL.' }
  if (previa.lastTestAt && ahora.getTime() - previa.lastTestAt.getTime() < ESPERA_ENTRE_PRUEBAS_MS) {
    throw new BusinessError('RATE_LIMITED', 'Espera unos segundos antes de volver a probar: SUNAT bloquea a quien prueba claves muy seguido.')
  }

  let resultado: ResultadoPrueba
  try {
    const cred = await credencialesSunatDelNegocio(db, ctx.tenantId)
    if (!cred) throw invalido('No hay credenciales.')
    const cert = leerPfx(cred.pfx, cred.claveCertificado)
    const estado = estadoCertificado(cert, ahora)
    const tenant = await db.tenant.findFirstOrThrow({ select: { taxId: true } })
    if (estado === 'vencido') resultado = { ok: false, mensaje: 'El certificado digital está vencido: renuévalo y vuelve a cargarlo.' }
    else if (estado === 'aun_no_vigente') resultado = { ok: false, mensaje: 'El certificado digital todavía no está vigente.' }
    else if (!tenant.taxId) resultado = { ok: false, mensaje: 'Completa el RUC del negocio.' }
    else {
      const r = await consultarCdr(deps.urlBill ?? cred.urlBill, { ruc: tenant.taxId, usuarioSol: cred.usuarioSol, claveSol: cred.claveSol }, { tipo: '01', serie: 'F001', numero: 1 }, deps)
      if (r.tipo === 'transitorio') resultado = { ok: false, mensaje: 'No se pudo comunicar con SUNAT en este momento. Intenta de nuevo en unos minutos.' }
      else if (r.tipo === 'fallo' && esFalloDeAcceso(r.fallo.codigo)) resultado = { ok: false, mensaje: 'SUNAT no aceptó el usuario SOL o su clave. Revísalos (y que el usuario secundario tenga el perfil de comprobantes electrónicos).' }
      else resultado = { ok: true, mensaje: cert.vence.getTime() - ahora.getTime() < 30 * DIA ? 'SUNAT aceptó las credenciales, pero el certificado vence pronto: renuévalo.' : 'SUNAT aceptó las credenciales y el certificado está vigente.' }
    }
  } catch (e) {
    if (e instanceof EndpointNoPermitido) resultado = { ok: false, mensaje: 'La dirección del servicio de SUNAT no está permitida.' }
    else if (e instanceof BusinessError || e instanceof CertificadoInvalido) resultado = { ok: false, mensaje: 'No se pudieron leer las credenciales guardadas. Vuelve a cargarlas.' }
    else throw e
  }

  await db.$transaction(async (tx) => {
    const t = tx as unknown as TenantPrismaClient
    await t.sunatCredential.update({ where: { id: previa.id }, data: { lastTestAt: ahora, lastTestOk: resultado.ok, lastTestMessage: resultado.mensaje.slice(0, 300) } })
    await t.auditLog.create({
      data: {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorRole: ctx.role, action: 'sunat.prueba_conexion', entityType: 'SunatCredential', entityId: previa.id,
        after: { ok: resultado.ok }, impersonationId: ctx.impersonationId ?? null,
      },
    })
  })
  return resultado
}

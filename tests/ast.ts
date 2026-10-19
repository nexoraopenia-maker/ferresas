import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Project, SyntaxKind, type SourceFile } from 'ts-morph'

/**
 * Análisis del código por AST, para las pruebas estructurales.
 *
 * ─── POR QUÉ NO SE BUSCA TEXTO ───────────────────────────────────────────
 *
 * Las primeras pruebas estructurales hacían `archivo.includes('...')`, y eso
 * dio TRES falsos positivos seguidos, todos por la misma causa: la cadena
 * buscada aparecía en un COMENTARIO que explicaba justamente por qué el
 * código NO hacía eso.
 *
 *   · «no importa getTenantPrisma» → la cabecera del proxy explica en prosa
 *     que el enforcement vive en getTenantPrisma.
 *   · «no pone un rol por defecto» → el comentario dice por qué NO hay
 *     `?? 'VENDEDOR'`.
 *   · «la API no pasa por aquí» → esperaba que la política respondiera algo
 *     que no le corresponde.
 *
 * Filtrar líneas que empiezan por `*` o `//` tapaba el síntoma y fallaba con
 * un comentario al final de una línea de código, o con una cadena que
 * contuviera la palabra. El AST no tiene ese problema: los comentarios no son
 * nodos del árbol, y una cadena literal se distingue de un identificador por
 * construcción.
 *
 * ─── POR QUÉ ts-morph Y NO LA API DE TYPESCRIPT ──────────────────────────
 *
 * TypeScript 7 es el compilador reescrito en Go: su entry principal exporta
 * SOLO `version`, y la API clásica (`ts.createSourceFile`, `ts.forEachChild`)
 * ya no existe. Lo que hay está en `typescript/unstable/ast` y
 * `typescript/unstable/sync`, sin `forEachChild` ni función de parseo
 * expuesta, y marcado **unstable** por el propio proveedor.
 *
 * Una suite que tiene que quedarse verde no se apoya en una API que su autor
 * llama inestable. `ts-morph` trae su propio TypeScript estable, entra solo
 * como devDependency —nunca viaja a producción— y es lo que estaba pedido.
 * Comprobado: no añade ninguna vulnerabilidad al árbol.
 */

export const RAIZ = join(import.meta.dirname ?? process.cwd(), '..')

/**
 * Proyecto SIN cargar el tsconfig completo.
 *
 * Solo hace falta el árbol sintáctico, no el chequeo de tipos, así que se
 * añaden los archivos uno a uno. Cargar el programa entero multiplicaría por
 * diez el tiempo de la prueba sin aportar nada.
 */
export function proyecto(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: false },
  })
}

export function abrir(proj: Project, rutaRelativa: string): SourceFile {
  return proj.addSourceFileAtPath(join(RAIZ, rutaRelativa))
}

/** Rutas relativas a la raíz, con separadores normalizados. */
export function rel(absoluta: string): string {
  return relative(RAIZ, absoluta).replace(/\\/g, '/')
}

export function ficheros(dir: string, filtro: (p: string) => boolean): string[] {
  const out: string[] = []
  const recorrer = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'generated') continue
        recorrer(p)
      } else if (filtro(p)) out.push(p)
    }
  }
  recorrer(dir)
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONSULTAS SOBRE EL ÁRBOL
// ═══════════════════════════════════════════════════════════════════════════

export interface ImportInfo {
  modulo: string
  nombres: string[]
  /**
   * `true` si TODO lo que trae es solo tipos (`import type`, o cada nombre
   * marcado con `type`). Esos imports se borran al compilar: no existen en
   * tiempo de ejecución y por tanto no pueden tocar la base.
   */
  soloTipos: boolean
}

/** Imports REALES del archivo. Un comentario que nombre un módulo no cuenta. */
export function imports(sf: SourceFile): ImportInfo[] {
  return sf.getImportDeclarations().map((d) => {
    const nombrados = d.getNamedImports()
    const nombres = [
      ...nombrados.map((n) => n.getName()),
      ...(d.getDefaultImport() ? [d.getDefaultImport()!.getText()] : []),
      ...(d.getNamespaceImport() ? [d.getNamespaceImport()!.getText()] : []),
    ]
    const soloTipos =
      d.isTypeOnly() ||
      (nombrados.length > 0 &&
        nombrados.every((n) => n.isTypeOnly()) &&
        !d.getDefaultImport() &&
        !d.getNamespaceImport())
    return { modulo: d.getModuleSpecifierValue(), nombres, soloTipos }
  })
}

/**
 * ¿Depende este archivo de la base de datos EN TIEMPO DE EJECUCIÓN?
 *
 * La distinción importa y es la que faltaba: `route-access.ts` importa
 * `type { Role } from '@/generated/prisma/enums'`, y eso es un import de
 * TIPO. Se borra al compilar, así que el módulo sigue siendo puro — tenerlo
 * por una dependencia de base de datos sería un falso positivo, igual que
 * los que daba buscar texto.
 *
 * Lo que sí cuenta: importar el cliente (`lib/prisma`, `tenant-prisma`) o
 * cualquier valor del cliente generado.
 */
export function dependeDeLaBase(sf: SourceFile): boolean {
  return imports(sf).some(
    (i) =>
      !i.soloTipos &&
      (/lib\/prisma$/.test(i.modulo) ||
        /tenant-prisma$/.test(i.modulo) ||
        /generated\/prisma(\/client)?$/.test(i.modulo)),
  )
}

/** ¿Importa este archivo el símbolo indicado, de cualquier módulo? */
export function importa(sf: SourceFile, nombre: string): boolean {
  return imports(sf).some((i) => i.nombres.includes(nombre))
}

/** ¿Importa de un módulo cuyo especificador contenga este fragmento? */
export function importaDeModulo(sf: SourceFile, fragmento: string): boolean {
  return imports(sf).some((i) => i.modulo.includes(fragmento))
}

/**
 * Nombres de función LLAMADOS en el archivo.
 *
 * Incluye tanto `foo()` como `obj.foo()`, quedándose con el último segmento:
 * a estas pruebas les importa QUÉ se invoca, no a través de qué objeto.
 */
export function llamadas(sf: SourceFile): Set<string> {
  const out = new Set<string>()
  for (const c of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = c.getExpression()
    if (expr.getKind() === SyntaxKind.Identifier) {
      out.add(expr.getText())
    } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const partes = expr.getText().split('.')
      out.add(partes[partes.length - 1]!)
      out.add(expr.getText())
    }
  }
  return out
}

/** Identificadores que aparecen en CÓDIGO (nunca en comentarios). */
export function identificadores(sf: SourceFile): Set<string> {
  return new Set(sf.getDescendantsOfKind(SyntaxKind.Identifier).map((i) => i.getText()))
}

/** Valores de las cadenas literales del CÓDIGO. */
export function cadenas(sf: SourceFile): string[] {
  return [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral).map((s) => s.getLiteralValue()),
    ...sf
      .getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)
      .map((s) => s.getLiteralValue()),
  ]
}

/**
 * ¿Hay un `X ?? 'valor'` en el código?
 *
 * Detecta la coalescencia nula con una cadena concreta a la derecha, que es
 * exactamente el patrón «valor por defecto si falta el dato». Un comentario
 * que escriba `?? 'VENDEDOR'` no produce ningún nodo, así que no cuenta.
 */
export function tieneDefaultDeCadena(sf: SourceFile, valor: string): boolean {
  return sf
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .some((b) => {
      if (b.getOperatorToken().getKind() !== SyntaxKind.QuestionQuestionToken) return false
      const der = b.getRight()
      return (
        (der.getKind() === SyntaxKind.StringLiteral ||
          der.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) &&
        der.getText().replace(/['"`]/g, '') === valor
      )
    })
}

/**
 * ¿La cadena que contiene `fragmento` se CONSTRUYE (plantilla con
 * sustituciones) o está escrita a mano (literal)?
 *
 * Existe para una prueba concreta: la cabecera `Server-Timing` llevaba
 * `sesion_bd;dur=0` como literal, con un comentario diciendo que si cambiaba
 * sería que alguien reintrodujo una consulta. Un literal nunca cambia, así
 * que ese «detector» no detectaba nada. Esto distingue medir de declarar.
 */
export function esValorCalculado(sf: SourceFile, fragmento: string): boolean {
  const enPlantilla = sf
    .getDescendantsOfKind(SyntaxKind.TemplateExpression)
    .some((t) => t.getText().includes(fragmento) && t.getTemplateSpans().length > 0)
  const enLiteral = cadenas(sf).some((c) => c.includes(fragmento))
  return enPlantilla && !enLiteral
}

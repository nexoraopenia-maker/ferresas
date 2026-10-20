import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Contraste WCAG de la paleta, SIN base de datos.
 *
 * Se lee `globals.css` (la fuente real de los tokens) y se comprueban los
 * pares que de verdad se pintan juntos. Sirve para poder hacer la interfaz más
 * viva sin que nadie, retocando un tono a ojo, deje un texto ilegible a pleno
 * sol del mostrador. Umbral: 4,5:1 (AA, texto normal).
 */
let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${extra ? ` — ${extra}` : ''}`)
}

const css = readFileSync(join(import.meta.dirname ?? process.cwd(), '../src/app/globals.css'), 'utf8')

function tokens(bloque: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const x of bloque.matchAll(/--([\w-]+):\s*([^;]+);/g)) m.set(x[1]!, x[2]!.trim().replace(/\s*\/\*.*$/, ''))
  return m
}
const tema = tokens(/@theme\s*\{([\s\S]*?)\n\}/.exec(css)![1]!)
const claro = tokens(/:root\s*\{([\s\S]*?)\n\}/.exec(css)![1]!)
const oscuro = tokens(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}\s*\}/.exec(css)![1]!)

function resolver(nombre: string, ...capas: Map<string, string>[]): string {
  let v: string | undefined
  for (const c of capas) if (c.has(nombre)) { v = c.get(nombre); break }
  if (v === undefined) throw new Error(`token --${nombre} no definido`)
  const ref = /^var\(--([\w-]+)\)$/.exec(v)
  return ref ? resolver(ref[1]!, ...capas) : v
}

function luminancia(hex: string): number {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const ratio = (a: string, b: string) => {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

type Par = [texto: string, fondo: string]
const BLANCO = '#ffffff'
function verificar(titulo: string, capas: Map<string, string>[], pares: Par[], minimo = 4.5) {
  console.log(`\n${titulo}`)
  for (const [t, f] of pares) {
    const ct = t.startsWith('#') ? t : resolver(t, ...capas)
    const cf = f.startsWith('#') ? f : resolver(f, ...capas)
    const r = ratio(ct, cf)
    check(`${t} sobre ${f}`, r >= minimo, `${r.toFixed(2)}:1`)
  }
}

verificar('1) Modo claro', [claro, tema], [
  ['color-ink', 'color-surface'],
  ['color-ink', 'color-surface-raised'],
  ['color-ink', 'color-surface-sunken'],
  ['color-ink-muted', 'color-surface'],
  ['color-ink-muted', 'color-surface-raised'],
  ['color-ink-muted', 'color-surface-sunken'],
  [BLANCO, 'color-industrial-600'],
  [BLANCO, 'color-industrial-700'],
  [BLANCO, 'color-industrial-500'],
  [BLANCO, 'color-accent-600'],
  [BLANCO, 'color-accent-700'],
  ['color-industrial-700', 'color-surface'],
  ['color-industrial-800', 'color-industrial-50'],
  ['color-stock-ok', 'color-stock-ok-soft'],
  ['color-stock-low', 'color-stock-low-soft'],
  ['color-stock-out', 'color-stock-out-soft'],
])

verificar('2) Modo oscuro', [oscuro, claro, tema], [
  ['color-ink', 'color-surface'],
  ['color-ink', 'color-surface-raised'],
  ['color-ink-muted', 'color-surface'],
  ['color-ink-muted', 'color-surface-raised'],
  ['color-ink-muted', 'color-surface-sunken'],
  ['color-industrial-400', 'color-surface'],
  ['color-industrial-300', 'color-surface-raised'],
])

console.log(`\n${fail === 0 ? '✔' : '✖'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)

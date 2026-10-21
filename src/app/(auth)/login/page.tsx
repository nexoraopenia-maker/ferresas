import { existsSync } from 'node:fs'
import { join } from 'node:path'
import Image from 'next/image'
import { LoginForm } from './LoginForm'

export const dynamic = 'force-dynamic'

/**
 * Pantalla de inicio de sesión: una sola pieza a pantalla completa.
 *
 * Fondo: si existe `public/fondo-login.jpg` se usa esa fotografía; si no, una
 * escena de ferretería premium hecha solo con CSS (luz cálida, estantes de
 * madera y metal mate, viñeta), para que la pantalla se vea bien desde el
 * primer día. El formulario flota centrado sobre un cristal esmerilado.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; motivo?: string }>
}) {
  const { callbackUrl, motivo } = await searchParams
  const hayFoto = existsSync(join(process.cwd(), 'public', 'fondo-login.jpg'))

  return (
    <main className="relative isolate flex min-h-dvh w-full items-center justify-center overflow-hidden bg-neutral-950 px-4 py-10">
      {/* ───────── Fondo a pantalla completa ───────── */}
      <div aria-hidden className="absolute inset-0 -z-20">
        {hayFoto ? (
          <Image src="/fondo-login.jpg" alt="" fill priority sizes="100vw" className="object-cover" />
        ) : (
          <EscenaFerreteria />
        )}
      </div>
      {/* Velo para que el texto se lea sobre cualquier foto. */}
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-black/55 via-black/35 to-black/70" />

      {/* ───────── Tarjeta de cristal, centrada ───────── */}
      <section
        aria-labelledby="titulo-login"
        className="w-full max-w-md rounded-3xl border border-white/20 bg-white/10 p-6 shadow-2xl shadow-black/50 ring-1 ring-black/20 backdrop-blur-xl sm:p-9"
      >
        <header className="flex flex-col items-center text-center">
          {/* El logo es un JPG sobre negro: `mix-blend-screen` borra el negro y deja solo el trazo. */}
          <Image
            src="/aima-logo.jpg"
            alt="AIMA Automatizaciones"
            width={1536}
            height={1024}
            priority
            className="-my-6 h-auto w-64 mix-blend-screen sm:w-72"
          />
          <h1 id="titulo-login" className="mt-2 text-lg font-semibold tracking-wide text-white sm:text-xl">
            Todo tu negocio en un solo sistema
          </h1>
          <span aria-hidden className="mt-3 h-px w-16 bg-gradient-to-r from-transparent via-sky-400 to-transparent" />
        </header>

        {motivo === 'sesion' && (
          <p role="status" className="mt-6 rounded-xl border border-amber-300/40 bg-amber-300/15 px-3 py-2 text-center text-sm font-medium text-amber-100">
            Tu sesión se cerró. Vuelve a entrar para continuar.
          </p>
        )}

        <div className="mt-7">
          {/* Solo se acepta una ruta relativa: un callbackUrl absoluto sería un open redirect. */}
          <LoginForm callbackUrl={callbackUrl?.startsWith('/') ? callbackUrl : undefined} />
        </div>
      </section>
    </main>
  )
}

/** Interior de ferretería premium, solo con degradados: sin imágenes ni red. */
function EscenaFerreteria() {
  return (
    <div className="absolute inset-0 bg-[#0b0a09]">
      {/* Suelo de concreto pulido: reflejo cálido en la mitad inferior. */}
      <div className="absolute inset-x-0 bottom-0 h-2/5 bg-[linear-gradient(to_top,#2a2724_0%,#1a1816_55%,transparent_100%)]" />
      <div className="absolute inset-x-0 bottom-0 h-1/3 bg-[radial-gradient(ellipse_at_50%_100%,rgba(255,176,92,0.20),transparent_65%)]" />

      {/* Estantería de madera cálida con bandas de metal mate (izquierda y derecha). */}
      {(['left-0', 'right-0'] as const).map((lado) => (
        <div
          key={lado}
          className={`absolute ${lado} top-0 h-3/4 w-[34%] opacity-90 blur-[3px] [mask-image:linear-gradient(to_bottom,black_70%,transparent)]`}
          style={{
            backgroundImage:
              'repeating-linear-gradient(to bottom, #3a2a1c 0 9px, #5b4128 9px 14px, #14110e 14px 74px, #23201d 74px 78px, #14110e 78px 148px)',
          }}
        >
          {/* Objetos sobre los estantes: bloques de color apagado que sugieren herramientas y cajas. */}
          <div
            className="absolute inset-0 opacity-70"
            style={{
              backgroundImage:
                'repeating-linear-gradient(to right, transparent 0 22px, rgba(205,140,70,0.35) 22px 30px, transparent 30px 52px, rgba(120,130,140,0.35) 52px 58px, transparent 58px 88px)',
              maskImage: 'repeating-linear-gradient(to bottom, black 0 56px, transparent 56px 148px)',
            }}
          />
        </div>
      ))}

      {/* Luz ambiente cálida desde arriba, y un foco sutil al centro. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_50%_0%,rgba(255,190,110,0.28),transparent_70%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_55%,rgba(255,170,90,0.10),transparent_55%)]" />
      {/* Viñeta: profundidad de campo. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(0,0,0,0.75)_100%)]" />
    </div>
  )
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Servidor HTTP local para probar clientes de terceros (PSE, padrón) sin red. */
export interface Peticion { metodo: string; ruta: string; cabeceras: IncomingMessage['headers']; cuerpo: string }
export type Manejador = (req: Peticion, res: ServerResponse) => void | Promise<void>

export async function servidorFalso(manejador: Manejador) {
  const peticiones: Peticion[] = []
  const srv = createServer((req, res) => {
    const trozos: Buffer[] = []
    req.on('data', (t: Buffer) => trozos.push(t))
    req.on('end', () => {
      const p: Peticion = { metodo: req.method ?? '', ruta: req.url ?? '', cabeceras: req.headers, cuerpo: Buffer.concat(trozos).toString('utf8') }
      peticiones.push(p)
      void Promise.resolve(manejador(p, res)).catch(() => { res.statusCode = 500; res.end() })
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  return {
    url, peticiones,
    cerrar: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()) }),
  }
}

export const json = (res: ServerResponse, status: number, cuerpo: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo))
}

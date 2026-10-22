// Serve the built marketing site locally; no Gateway state or API is exposed.
import { watch } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSite } from './build.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const port = Number(process.argv[2] ?? 4173)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Pass a port number from 1 to 65535')
}
const { output } = buildSite()
let rebuild
watch(resolve(root, 'site'), { recursive: true }, () => {
  clearTimeout(rebuild)
  rebuild = setTimeout(() => {
    buildSite()
    console.log('Site rebuilt; refresh the browser.')
  }, 100)
})
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', { status: 405 })
    }
    let pathname
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    if (pathname.startsWith('/Rovloom/')) {
      pathname = pathname.slice('/Rovloom'.length)
    }
    const path = resolve(output, '.' + (pathname === '/' ? '/index.html' : pathname))
    if (!path.startsWith(output + sep)) {
      return new Response('Not found', { status: 404 })
    }
    const file = Bun.file(path)
    if (!(await file.exists())) {
      return new Response(Bun.file(resolve(output, '404.html')), { status: 404 })
    }
    return new Response(request.method === 'HEAD' ? null : file, {
      headers: { 'content-type': file.type, 'cache-control': 'no-store' }
    })
  }
})
console.log(`Rovloom site: http://127.0.0.1:${server.port}/Rovloom/`)

/** 仅本机隔离 UI 验证服务；/ 使用生产不可用壳，/fixtures/ 显式注入测试投影。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toolchain } from '../bun/toolchain.mjs'

toolchain()
const root = fileURLToPath(new URL('../../', import.meta.url))
const bundle = await Bun.build({
  entrypoints: [root + 'test/webui/browser-fixture.ts'],
  target: 'browser',
  format: 'esm'
})
if (!bundle.success || bundle.outputs.length !== 1) {
  throw new Error('fixture browser build failed')
}
const fixture = await bundle.outputs[0].text()
const shell = readFileSync(root + 'dist/webui/index.html', 'utf8')
const headers = {
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.argv[2] ?? 0),
  /** 仅提供固定静态资源与显式测试页，不提供管理 API、凭据或文件路径解析。 */
  fetch(request) {
    const url = new URL(request.url)
    if (request.headers.get('host') !== `127.0.0.1:${server.port}`) {
      return new Response('forbidden', { status: 403, headers })
    }
    if (request.method !== 'GET') {
      return new Response('method_not_allowed', { status: 405, headers })
    }
    let body
    let type
    if (url.pathname === '/' || url.pathname === '/fixtures/') {
      body = url.pathname === '/' ? shell : shell.replace('./browser.js', './fixture.js')
      type = 'text/html; charset=utf-8'
    } else if (url.pathname === '/fixtures/fixture.js') {
      body = fixture
      type = 'text/javascript; charset=utf-8'
    } else if (url.pathname === '/manage.css' || url.pathname === '/fixtures/manage.css') {
      body = readFileSync(root + 'dist/webui/manage.css')
      type = 'text/css; charset=utf-8'
    } else if (url.pathname === '/rovloom-logo.png' || url.pathname === '/fixtures/rovloom-logo.png') {
      body = readFileSync(root + 'dist/webui/rovloom-logo.png')
      type = 'image/png'
    } else if (/^\/(?:browser|chunk-[a-zA-Z0-9]+)\.js$/.test(url.pathname)) {
      body = readFileSync(root + 'dist/webui' + url.pathname)
      type = 'text/javascript; charset=utf-8'
    } else {
      return new Response('not_found', { status: 404, headers })
    }
    return new Response(body, { headers: { ...headers, 'content-type': type } })
  }
})
console.log(`UI verification only: http://127.0.0.1:${server.port}/ ; fixture page: /fixtures/ ; no management backend`)

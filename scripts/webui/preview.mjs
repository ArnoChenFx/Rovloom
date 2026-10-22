/** 仅本机隔离 UI 验证服务；/fixtures/ 显式注入测试投影，三动作模式仅使用临时 Store。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toolchain } from '../bun/toolchain.mjs'

toolchain()
const root = fileURLToPath(new URL('../../', import.meta.url))
const actionMode = process.argv[3] === '--actions'
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
let actions
let resetActions
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.argv[2] ?? 0),
  /** 仅提供固定资源、显式测试页和可选临时 handler，不接生产身份或用户设备。 */
  async fetch(request) {
    const url = new URL(request.url)
    if (request.headers.get('host') !== `127.0.0.1:${server.port}`) {
      return new Response('forbidden', { status: 403, headers })
    }
    if (actionMode && url.pathname === '/') {
      return new Response('Explicit UI fixture only: /fixtures/', { status: 503, headers })
    }
    if (actions && url.pathname.startsWith('/admin/v1/')) {
      return actions.fetch(request)
    }
    if (actions && url.pathname === '/__fixture') {
      if (request.method === 'POST' && request.headers.get('origin') === `http://127.0.0.1:${server.port}`) {
        const control = await request.clone().json()
        if (control.mode === 'reset') {
          resetActions()
        }
      }
      return actions.control(request)
    }
    if (request.method !== 'GET') {
      return new Response('method_not_allowed', { status: 405, headers })
    }
    if (url.pathname === '/admin/v1/status' && !url.search) {
      return new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 503,
        headers: { ...headers, 'content-type': 'application/json' }
      })
    }
    let body
    let type
    if (url.pathname === '/' || url.pathname === '/fixtures/') {
      body = url.pathname === '/' || actions ? shell : shell.replace('./browser.js', './fixture.js')
      if (actions) {
        body = body
          .replace(
            '</head>',
            `<meta name="rovloom-management-bootstrap" content="${actions.bootstrap.csrf}" data-expires-at="${actions.bootstrap.expires_at}"></head>`
          )
          .replace(
            '<body>',
            '<body><p>隔离页面测试 / Synthetic fixture: 临时 Store 与 handler；不代表生产登录或真实设备链路。</p>'
          )
      }
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
    } else if (
      url.pathname === '/rovloom-mark-transparent.png' ||
      url.pathname === '/fixtures/rovloom-mark-transparent.png'
    ) {
      body = readFileSync(root + 'dist/webui/rovloom-mark-transparent.png')
      type = 'image/png'
    } else if (url.pathname === '/theme.js' || url.pathname === '/fixtures/theme.js') {
      body = readFileSync(root + 'dist/webui/theme.js')
      type = 'text/javascript; charset=utf-8'
    } else if (/^\/(?:fixtures\/)?(?:browser|chunk-[a-zA-Z0-9]+)\.js$/.test(url.pathname)) {
      body = readFileSync(root + 'dist/webui/' + url.pathname.split('/').at(-1))
      type = 'text/javascript; charset=utf-8'
    } else {
      return new Response('not_found', { status: 404, headers })
    }
    return new Response(body, {
      headers: {
        ...headers,
        'content-type': type,
        ...(actions && url.pathname === '/fixtures/' ? { 'set-cookie': actions.cookie } : {})
      }
    })
  }
})
if (actionMode) {
  const { createActionsHostFixture } = await import('../../test/webui/actions-host-fixture.ts')
  resetActions = /** 每个显式页面用例拥有全新临时Store与短期会话。 */ () => {
    actions?.close()
    actions = createActionsHostFixture(`http://127.0.0.1:${server.port}`)
  }
  resetActions()
}
console.log(
  `UI verification only: http://127.0.0.1:${server.port}/ ; fixture page: /fixtures/ ; ${actionMode ? 'temporary Store/handler only' : 'no management backend'}`
)

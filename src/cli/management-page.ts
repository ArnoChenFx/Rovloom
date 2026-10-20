// 只将既有受保护管理员租期交付同源根页面，复用原authority，不建立身份库或公开bootstrap端点。
import { ReadError } from '../webui/reader.js'
import type { ManagementHttpOptions } from '../admin/read-http.js'
import type { ManagementSessionAuthority, ManagementSessionLease } from '../runtime/management-session.js'

export const MANAGEMENT_COOKIE_NAME = 'rovloom_management'
export const MANAGEMENT_BOOTSTRAP_META = 'rovloom-management-bootstrap'
export type ManagementPageLeaseSource = (
  request: Request,
  signal: AbortSignal
) => Promise<ManagementSessionLease | null>

/** lease来源必须核验该页面请求的既有受保护会话；不得按本机UID、普通header或浏览器参数默认选管理员。 */
export function createManagementPageInitializer(
  authority: ManagementSessionAuthority,
  resolveLease: ManagementPageLeaseSource,
  options: Readonly<{ challenge?: 'basic' }> = {}
): NonNullable<ManagementHttpOptions['initializePage']> {
  if (typeof resolveLease !== 'function') {
    throw new Error('management_page_source_required')
  }
  return /* 原handler先检查固定Origin并建立取消范围；无有效既有lease时仅交付原只读页面。 */ async (
    request,
    page,
    signal
  ) => {
    try {
      const html = await page.text()
      if (signal.aborted) {
        throw new ReadError('unavailable')
      }
      if (!html.includes('</head>') || html.includes(MANAGEMENT_BOOTSTRAP_META)) {
        throw new ReadError('unavailable')
      }
      const lease = await resolveLease(request, signal)
      if (signal.aborted) {
        throw new ReadError('unavailable')
      }
      if (lease === null) {
        if (options.challenge === 'basic') {
          const headers = new Headers(page.headers)
          headers.delete('content-length')
          headers.set('cache-control', 'no-store')
          headers.set('content-type', 'application/json; charset=utf-8')
          headers.set('www-authenticate', 'Basic realm="Rovloom management", charset="UTF-8"')
          return new Response('{"error":"unauthenticated"}', { status: 401, headers })
        }
        return new Response(html, { status: page.status, headers: page.headers })
      }
      const bootstrap = authority.bootstrap(lease, { signal, rotate: false })
      if (signal.aborted) {
        throw new ReadError('unavailable')
      }
      // authority只生成base64url原值；HTML不包含cookie、principal或管理session引用。
      const metadata = `<meta name="${MANAGEMENT_BOOTSTRAP_META}" content="${bootstrap.csrf}" data-expires-at="${bootstrap.expires_at}">`
      const headers = new Headers(page.headers)
      headers.delete('content-length')
      headers.set('cache-control', 'no-store')
      headers.set(
        'set-cookie',
        `${MANAGEMENT_COOKIE_NAME}=${bootstrap.cookie}; Path=/admin/v1; HttpOnly; SameSite=Strict; Expires=${new Date(bootstrap.expires_at).toUTCString()}`
      )
      return new Response(html.replace('</head>', metadata + '</head>'), { status: page.status, headers })
    } catch (error) {
      if (error instanceof ReadError) {
        throw error
      }
      throw new ReadError('unauthenticated')
    }
  }
}

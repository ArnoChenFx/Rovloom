// 通配监听测试共用：用原始 TCP 发送任意 Host 头（fetch 不保证允许覆盖 Host）。
import { connect } from 'node:net'

/** 向 127.0.0.1:port 发一个 GET，返回状态码；Host 头由调用者指定。 */
export function statusWithHost(port: number, host: string, path = '/'): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let text = ''
    socket.setTimeout(3000, () => {
      socket.destroy()
      reject(new Error('timeout'))
    })
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`))
    socket.on('data', (chunk) => (text += chunk.toString('utf8')))
    socket.on('error', reject)
    socket.on('close', () => {
      const status = Number(/^HTTP\/1\.[01] (\d{3})/u.exec(text)?.[1])
      if (Number.isInteger(status)) {
        resolve(status)
      } else {
        reject(new Error('no_status'))
      }
    })
  })
}

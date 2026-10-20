// 用操作系统默认访问控制的本地命名管道交付固定关停请求；不设置ACL、不保存PID或新增用户配置。
import { createHash } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { ServiceError, type ServiceRole } from './types.js'

// 名称绑定完整登记ID及当前二进制/角色/配置；不读取账户profile或目录状态。
export function windowsStopPipe(role: ServiceRole, executable: string, config: string, serviceId: string): string {
  const identity = createHash('sha256')
    .update(JSON.stringify([role, executable.toLowerCase(), config.toLowerCase(), serviceId]))
    .digest('hex')
  return String.raw`\\.\pipe\rovloom-stop-${identity}`
}

// 普通管道传输也可在隔离临时socket上验证；生产只传Windows命名管道，不监听TCP端口。
export async function openStopPipe(path: string, stop: () => void): Promise<() => Promise<void>> {
  let failed = false
  const server = createServer(
    { allowHalfOpen: true },
    /* 每个连接最多接受一个固定小请求。 */ (socket) => {
      let input = ''
      let handled = false
      socket.setTimeout(1000, /* 无完整请求即关闭自有连接，不保留空闲客户端。 */ () => socket.destroy())
      socket.on('error', /* 客户端断开不触发角色关停或重试。 */ () => socket.destroy())
      socket.on(
        'data',
        /* 输入有界且不作为脚本、路径或任意RPC使用。 */ (bytes: Buffer) => {
          if (handled) {
            return
          }
          input += bytes.toString('utf8')
          if (Buffer.byteLength(input) > 16) {
            socket.destroy()
          } else if (input.includes('\n')) {
            handled = true
            if (input === 'stop\n') {
              socket.end('stopping\n', /* 命名管道不依赖双向半关闭，写完即释放本次连接。 */ () => socket.destroy())
              stop()
            } else {
              socket.end('refused\n', /* 未知帧只关闭本次连接。 */ () => socket.destroy())
            }
          }
        }
      )
      socket.on(
        'end',
        /* EOF不能替代固定帧，也不被当作服务退出。 */ () => {
          if (!handled) {
            socket.end('refused\n', /* 回收不完整请求。 */ () => socket.destroy())
          }
        }
      )
    }
  )
  await new Promise<void>(
    /* 真实listen成功前不交付控制句柄；绑定失败保持普通启动失败。 */ (resolve, reject) => {
      server.once('error', reject)
      server.listen(
        path,
        /* 只移除启动错误监听，后续错误仍触发已有关停。 */ () => {
          server.off('error', reject)
          server.on(
            'error',
            /* 监听器失败触发资源回收，并在最终关闭时保留失败码。 */ () => {
              failed = true
              stop()
            }
          )
          resolve()
        }
      )
    }
  )
  let closing: Promise<void> | undefined
  return /* 只关闭本进程的管道并等待已结束的确认连接，不删除任何状态文件。 */ () => {
    closing ??= new Promise<void>(
      /* 服务资源回收可重复调用，连接有独立的一秒空闲上限。 */ (resolve, reject) => {
        server.close(
          /* 回收错误不能伪造为角色正常退出。 */ (error) =>
            error || failed ? reject(new ServiceError('system_command_failed')) : resolve()
        )
      }
    )
    return closing
  }
}

// 只发送一次本地停止请求；确认不是退出证明，后续仍由ServiceManager核对系统实例终态。
export async function requestStopPipe(path: string, timeout = 5000): Promise<void> {
  await new Promise<void>(
    /* 无连接、拒绝或丢失确认均失败，不退回强杀或重发操作。 */ (resolve, reject) => {
      const socket = createConnection(path)
      let reply = ''
      let settled = false
      const timer = setTimeout(
        /* 本地交付有界，服务本身的原监管期限不变。 */ () => finish(new ServiceError('service_timeout')),
        timeout
      )
      // 统一关闭本次连接并只结算一次，不将迟到的消息洗成成功。
      function finish(error?: ServiceError): void {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      socket.once('connect', /* 发送唯一完整帧，Windows管道不依赖半关闭表示消息结束。 */ () => socket.write('stop\n'))
      socket.on(
        'data',
        /* 不接受额外字段、系统输出或超长回复。 */ (bytes: Buffer) => {
          reply += bytes.toString('utf8')
          if (reply === 'stopping\n') {
            finish()
          } else if (Buffer.byteLength(reply) > 16 || !'stopping\n'.startsWith(reply)) {
            finish(new ServiceError('service_conflict'))
          }
        }
      )
      socket.once(
        'end',
        /* 只有精确确认表示请求已交付，业务退出仍由原监管器验证。 */ () =>
          finish(
            reply === 'stopping\n' ? undefined : new ServiceError(reply ? 'service_conflict' : 'system_command_failed')
          )
      )
      socket.once(
        'error',
        /* 访问权限沿用系统；未知控制端口不可被当作已停止。 */ (error: NodeJS.ErrnoException) =>
          finish(
            new ServiceError(
              error.code === 'EACCES' || error.code === 'EPERM' ? 'permission_denied' : 'system_command_failed'
            )
          )
      )
      socket.once(
        'close',
        /* 提前关闭且没有完整确认必须失败。 */ () => {
          if (!settled) {
            finish(new ServiceError('system_command_failed'))
          }
        }
      )
    }
  )
}

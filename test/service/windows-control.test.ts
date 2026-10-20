// 用自有临时socket/Windows命名管道验证固定停止协议和登记隔离；不安装服务、不改权限或操作PID。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection, createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStopPipe, requestStopPipe, windowsStopPipe } from '../../src/service/windows-control.js'
import { launchArguments, serviceControlId } from '../../src/service/spec.js'
import { parseCommand } from '../../src/cli/run.js'
import { serviceDiagnostic } from '../../src/cli/service-output.js'
import { ServiceManager } from '../../src/service/manager.js'
import { model, sampleSpec } from './helpers.js'

// 跨平台只使用本例临时资源；Windows不访问任何已有服务管道。
function endpoint(directory: string, label: string): string {
  return process.platform === 'win32'
    ? windowsStopPipe('gateway', process.execPath, join(directory, label), 'a'.repeat(64))
    : join(directory, label + '.sock')
}

// 普通本地客户端仅用于拒绝/分片回归，不发送到系统服务。
async function exchange(path: string, text: string): Promise<string> {
  const socket = createConnection(path)
  let reply = ''
  socket.setTimeout(1000, /* fixture同样不能无限等待。 */ () => socket.destroy(new Error('fixture_timeout')))
  const response = new Promise<string>(
    /* 用一帧回复结束，不依赖Windows管道半关闭。 */ (resolve, reject) => {
      socket.on(
        'data',
        /* 收齐固定短回复帧。 */ (bytes: Buffer) => {
          reply += bytes.toString('utf8')
          if (reply.includes('\n')) {
            resolve(reply)
          }
        }
      )
      socket.once('error', reject)
      socket.once('end', /* 提前EOF交由断言识别不完整回复。 */ () => resolve(reply))
    }
  )
  try {
    socket.write(text)
    return await response
  } finally {
    socket.destroy()
  }
}

test(
  'Windows后台参数携带精确登记ID，普通前台非交互模式不携带服务身份',
  /* 只验证固定argv和路径绑定，不加载产品宿主。 */ () => {
    const spec = sampleSpec('win32')
    const id = serviceControlId(spec)
    const path = windowsStopPipe(spec.role, spec.executable, spec.config, id)
    assert.deepEqual(
      Array.from(path.slice(0, 9), /* 检查真实Win32前缀，不能多转义成另一路径。 */ (char) => char.charCodeAt(0)),
      [92, 92, 46, 92, 112, 105, 112, 101, 92]
    )
    const command = parseCommand(launchArguments(spec), { home: undefined, platform: 'win32' })
    assert.deepEqual(command, { action: spec.role, path: spec.config, nonInteractive: true, serviceId: id })
    const foreground = parseCommand([spec.role, '--config', spec.config, '--non-interactive'], {
      home: undefined,
      platform: 'win32'
    })
    assert(!('serviceId' in foreground))
    for (const changed of [
      { ...spec, account: 'other-user' },
      { ...spec, directory: 'C:\\other' },
      { ...spec, config: 'C:\\other.json' },
      { ...spec, role: 'gateway' as const }
    ]) {
      assert.notEqual(
        windowsStopPipe(changed.role, changed.executable, changed.config, serviceControlId(changed)),
        path
      )
    }
    assert.throws(
      /* 服务身份不能由未知格式或交互模式输入隐式启用。 */ () =>
        parseCommand([spec.role, '--config', spec.config, '--service-id', id], { home: undefined, platform: 'win32' })
    )
  }
)

test(
  '真实本地停止请求只交付选中端点，未知命令不触发关停',
  /* 运行本例两份端点，另一份始终保持未停止。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-stop-'))
    const closers: (() => Promise<void>)[] = []
    let first = 0
    let second = 0
    let collisionClose: (() => Promise<void>) | undefined
    try {
      const a = endpoint(directory, 'a')
      const b = endpoint(directory, 'b')
      closers.push(
        await openStopPipe(
          a,
          /* 仅记录本端点收到的停止。 */ () => {
            first++
          }
        )
      )
      closers.push(
        await openStopPipe(
          b,
          /* 另一端点不能被请求误停。 */ () => {
            second++
          }
        )
      )
      await assert.rejects(
        /* 同名绑定不能接管已运行端点；拒绝后原端点仍须工作。 */ async () => {
          collisionClose = await openStopPipe(
            a,
            /* 冲突端点不能接收停止。 */ () => {
              second++
            }
          )
        }
      )
      assert.equal(await exchange(a, 'status\n'), 'refused\n')
      assert.equal(await exchange(a, 'stop extra\n'), 'refused\n')
      assert.equal(first, 0)
      await requestStopPipe(a)
      assert.equal(first, 1)
      assert.equal(second, 0)
    } finally {
      await collisionClose?.()
      for (const close of closers) {
        await close()
      }
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  '缺失管道、错误确认和无回复均失败，不重发停止或当作已退出',
  /* 使用独立错误端点验证交付边界。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-stop-'))
    const sockets = new Set<Socket>()
    let mode: 'bad' | 'silent' | 'closed' = 'bad'
    let connections = 0
    const server = createServer(
      { allowHalfOpen: true },
      /* 明确不返回协议确认。 */ (socket) => {
        sockets.add(socket)
        connections++
        socket.on('error', /* 预期超时回收不泄露底层异常。 */ () => {})
        socket.on(
          'data',
          /* 返回错误确认、保持沉默或提前断开，均不能成为停止成功。 */ () => {
            if (mode === 'bad') {
              socket.end('other\n')
            }
            if (mode === 'closed') {
              socket.destroy()
            }
          }
        )
      }
    )
    try {
      await assert.rejects(/* 不存在的实例不能回退强杀。 */ () => requestStopPipe(endpoint(directory, 'missing')), {
        code: 'system_command_failed'
      })
      server.listen(endpoint(directory, 'silent'))
      await once(server, 'listening')
      await assert.rejects(/* 非协议回复必须拒绝。 */ () => requestStopPipe(endpoint(directory, 'silent')), {
        code: 'service_conflict'
      })
      mode = 'silent'
      await assert.rejects(
        /* 有连接也不能把缺少确认当作成功。 */ () => requestStopPipe(endpoint(directory, 'silent'), 100),
        { code: 'service_timeout' }
      )
      mode = 'closed'
      await assert.rejects(/* 提前关闭不表示请求已交付。 */ () => requestStopPipe(endpoint(directory, 'silent')), {
        code: 'system_command_failed'
      })
      assert.equal(connections, 3)
    } finally {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>(
        /* 结束本例监听器。 */ (resolve) => server.close(/* 所有连接已主动关闭。 */ () => resolve())
      )
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  '正常停止确认之后仍等监管终态，CLI如实报告graceful_request',
  /* 监管模型只验证结果模式，不冒充Windows实例验收。 */ async () => {
    const current = model('win32')
    const spec = sampleSpec('win32')
    current.set({ spec, state: 'running', enabled: true })
    current.backend.stop = /* 固定请求后模型才报告已停止；真实生命周期由原生CI验证。 */ async () => {
      current.get()!.state = 'stopped'
      return 'graceful_request' as const
    }
    const result = await new ServiceManager(current.backend, current.clock).execute({ action: 'stop', role: spec.role })
    assert.equal(result.state, 'stopped')
    assert.equal(result.stopMode, 'graceful_request')
    assert.equal(JSON.parse(serviceDiagnostic(JSON.stringify(result) + '\n')).stopMode, 'graceful_request')
    current.get()!.state = 'running'
    current.backend.stop = /* 确认本身不能代替角色退出。 */ async () => 'graceful_request' as const
    await assert.rejects(
      /* 监管器仍观察为running时保留原实例并报告超时。 */ () =>
        new ServiceManager(current.backend, current.clock).execute({ action: 'stop', role: spec.role }),
      { code: 'service_timeout' }
    )
    assert.equal(current.get()!.state, 'running')
  }
)

/** 检验 Herdr 本机路径、显式启动品牌及单请求 IO；测试不启动真实 Herdr。 */
import assert from 'node:assert/strict'
import { ChildProcess, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  HerdrLocalError,
  HerdrProcessBinding,
  herdrEnvironment,
  inspectHerdrPath,
  pinHerdrConfig,
  prepareHerdrEndpointDirectory,
  verifyHerdrInstallation,
  measureHerdrInstallation
} from '../../../src/connector/herdr/local.js'
import type { HerdrLocalConfig, HerdrEndpoint } from '../../../src/connector/herdr/local.js'
import { exchangeHerdr, herdrDeadline, runHerdrCommand, withHerdrSocket } from '../../../src/connector/herdr/io.js'
import { HERDR_READONLY_REVIEW } from '../../../src/connector/herdr/review.js'
import { privateHerdrTestRoot } from './private-root.js'
import { ConnectorCapacityError } from '../../../src/connector/capacity.js'

const request = Buffer.from('{"id":"synthetic","method":"ping","params":{}}\n')
const reply = Buffer.from('{"id":"synthetic","result":{"type":"pong"}}\n')

/** 使用与其它 native 测试相同的 harness 根，不依赖当前工作目录或特定云环境路径。 */
function privateRoot(): string {
  return privateHerdrTestRoot('.herdr-local-test-')
}

test(
  'private test roots use the harness or source checkout independently of an untrusted cwd',
  /** 在隔离 Bun 子进程重现 CI 的 tmp cwd，核对两种可信根与不安全显式根的拒绝清理。 */ () => {
    const root = privateHerdrTestRoot('.herdr-root-harness-')
    const untrustedCwd = mkdtempSync(join(tmpdir(), 'herdr-untrusted-cwd-'))
    try {
      chmodSync(untrustedCwd, 0o777)
      assert.throws(/** tmp 的公开可写祖先仍须被真实生产检查拒绝。 */ () => inspectHerdrPath(untrustedCwd, 'directory'))
      const copied = join(root, 'checkout', 'test', 'connector', 'herdr')
      mkdirSync(copied, { recursive: true, mode: 0o700 })
      const helperUrl = new URL('./private-root.ts', import.meta.url)
      const copiedHelper = join(copied, 'private-root.ts')
      writeFileSync(
        copiedHelper,
        readFileSync(helperUrl, 'utf8').replace(
          '../../../src/connector/herdr/local.js',
          new URL('../../../src/connector/herdr/local.ts', import.meta.url).href
        ),
        { mode: 0o600 }
      )
      for (const explicit of [true, false]) {
        const source = explicit ? fileURLToPath(helperUrl) : copiedHelper
        const script = `
import { dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { privateHerdrTestRoot } from ${JSON.stringify(pathToFileURL(source).href)};
const root = privateHerdrTestRoot('owned-');
try { console.log(dirname(root)); } finally { rmSync(root,{recursive:true,force:true}); }
`
        const child = spawnSync(process.execPath, ['--no-env-file', '-e', script], {
          cwd: untrustedCwd,
          env: explicit ? { LUVUS_TEST_ROOT: root } : {},
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 4096
        })
        assert.equal(child.status, 0, child.stderr)
        assert.equal(child.stdout.trim(), root)
      }
      const rejected = spawnSync(
        process.execPath,
        [
          '--no-env-file',
          '-e',
          `
import { privateHerdrTestRoot } from ${JSON.stringify(helperUrl.href)};
try { privateHerdrTestRoot('rejected-'); process.exitCode=1; }
catch (error) { console.log(error.code); }
`
        ],
        {
          cwd: untrustedCwd,
          env: { LUVUS_TEST_ROOT: untrustedCwd },
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 4096
        }
      )
      assert.equal(rejected.status, 0, rejected.stderr)
      assert.equal(rejected.stdout.trim(), 'herdr_local_path_untrusted')
      assert.deepEqual(readdirSync(untrustedCwd), [])
    } finally {
      rmSync(untrustedCwd, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  }
)

/** 在自有目录建立纯合成配置；二进制刻意不匹配官方 hash，因此不会执行。 */
function configFixture(root: string): HerdrLocalConfig {
  for (const name of ['home', 'config', 'state', 'cache', 'tmp', 'work']) {
    mkdirSync(join(root, name), { mode: 0o700 })
  }
  const binary = join(root, 'synthetic-binary')
  writeFileSync(binary, 'synthetic bytes, never executed\n', { mode: 0o700 })
  return pinHerdrConfig({
    target: { machine_id: 'test-machine', provider_id: 'test-herdr', profile: 'session', session: 'owned' },
    binding_revision: 1,
    config_ref: 'synthetic-owned-herdr',
    binary,
    home: join(root, 'home'),
    config_home: join(root, 'config'),
    state_home: join(root, 'state'),
    cache_home: join(root, 'cache'),
    temporary_home: join(root, 'tmp'),
    cwd: join(root, 'work')
  })
}

/** 核对固定错误码且不接受意外 TypeError 充当失败关闭证据。 */
function code(expected: string, errorType: typeof HerdrLocalError = HerdrLocalError): (error: unknown) => boolean {
  return /** 所有错误均须来自产品本地错误类型。 */ (error) => {
    assert(error instanceof errorType)
    assert.equal(error.code, expected)
    return true
  }
}

/** 纯合成流供确定性重入及同步 write 反例；不冒称 Unix socket 或 peer 实证。 */
class SyntheticSocket extends EventEmitter {
  destroyed = false
  connecting = false
  writable = true
  readableEnded = false
  writes: Buffer[] = []
  writeFailure = false
  /** 仅记录待写字节，允许模拟操作系统同步写入失败。 */
  write(bytes: Uint8Array): boolean {
    this.writes.push(Buffer.from(bytes))
    if (this.writeFailure) {
      throw new Error('synthetic write failure')
    }
    return true
  }
}

/** 为合成流保留独立 owner 错误监听，检查 exchange 只删除自己的监听器。 */
function syntheticSocket() {
  const socket = new SyntheticSocket()
  const owner = /** 外层连接所有者消费不属于本次 exchange 的错误。 */ () => {}
  socket.on('error', owner)
  return { socket, raw: socket as unknown as Socket, owner }
}

/** 本地真实 Unix listener 只交换固定合成字节；不涉及 Herdr 进程或未知方法。 */
async function unixFixture(use: (socket: Socket) => void) {
  const root = privateRoot()
  const address = join(root, 'owned.sock')
  const peers = new Set<Socket>()
  const server = createServer(
    /** 跟踪本测试接受的每条连接以便完整清理。 */ (socket) => {
      peers.add(socket)
      socket.on('error', /** 清理中消费自己 peer 的断连错误。 */ () => {})
      use(socket)
    }
  )
  await new Promise<void>(
    /** 只等待本测试私有 socket 完成监听。 */ (resolve, reject) => {
      server.once('error', reject)
      server.listen(address, resolve)
    }
  )
  chmodSync(address, 0o600)
  const endpoint: HerdrEndpoint = { address, stamp: inspectHerdrPath(address, 'socket'), uid: process.geteuid!() }
  return {
    root,
    address,
    endpoint,
    /** 销毁本 listener 的全部连接，再删除自有目录。 */
    async close() {
      for (const socket of peers) {
        socket.destroy()
      }
      await new Promise<void>(
        /** 等待本次 listener 完整关闭。 */ (resolve) =>
          server.close(/** server 关闭后目录中不再有活动 socket。 */ () => resolve())
      )
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'exchange success and failure remove the error listener without a shadowed argument',
  /** 精确复现 finish(undefined/error) 两条路径，不允许 TypeError 或残留监听。 */ async () => {
    for (const failed of [false, true]) {
      const state = syntheticSocket()
      const response = exchangeHerdr(
        state.raw,
        new AbortController().signal,
        /** 只准备固定合成请求。 */ () => ({
          bytes: request,
          beforeWrite: /** 模拟同步最终派发标记。 */ () => {}
        })
      )
      if (failed) {
        state.socket.emit('error', new Error('synthetic transport failure'))
        await assert.rejects(response, code('herdr_socket_io'))
      } else {
        state.socket.emit('data', reply.subarray(0, 7))
        state.socket.emit('data', reply.subarray(7))
        state.socket.emit('end')
        assert.deepEqual(await response, reply)
      }
      assert.equal(state.socket.listenerCount('data'), 0)
      assert.equal(state.socket.listenerCount('end'), 0)
      assert.equal(state.socket.listenerCount('close'), 0)
      assert.deepEqual(state.socket.listeners('error'), [state.owner])
    }
  }
)

test(
  'synchronous abort during preparation or beforeWrite never sends bytes',
  /** 两个重入位置都必须在写入前拒绝，准备阶段取消不能触发最终派发标记。 */ async () => {
    for (const phase of ['prepare', 'beforeWrite']) {
      const state = syntheticSocket()
      const controller = new AbortController()
      let marked = 0
      const pending = exchangeHerdr(
        state.raw,
        controller.signal,
        /** 注入当前准备阶段的同步中止。 */ () => {
          if (phase === 'prepare') {
            controller.abort()
          }
          return {
            bytes: request,
            beforeWrite: /** 只在已经完成前置核验后模拟最终阶段中止。 */ () => {
              marked++
              controller.abort()
            }
          }
        }
      )
      await assert.rejects(pending, code('herdr_cancelled'))
      assert.equal(state.socket.writes.length, 0)
      assert.equal(marked, phase === 'prepare' ? 0 : 1)
    }
  }
)

test(
  'invalid request bytes and asynchronous beforeWrite never reach write',
  /** 在派发标记前拒绝超限、多行及不完整请求；异步授权不能被当作同步完成。 */ async () => {
    for (const bytes of [
      Buffer.alloc(0),
      request.subarray(0, -1),
      Buffer.concat([request, request]),
      Buffer.alloc(HERDR_READONLY_REVIEW.frame_bytes + 1)
    ]) {
      const state = syntheticSocket()
      let marked = 0
      await assert.rejects(
        exchangeHerdr(
          state.raw,
          new AbortController().signal,
          /** 为畸形原始请求绑定可观察的最终标记。 */ () => ({
            bytes,
            beforeWrite: /** 记录是否越过字节边界。 */ () => {
              marked++
            }
          })
        ),
        code('herdr_request_framing')
      )
      assert.equal(marked, 0)
      assert.equal(state.socket.writes.length, 0)
    }
    const state = syntheticSocket()
    await assert.rejects(
      exchangeHerdr(
        state.raw,
        new AbortController().signal,
        /** 返回异步最终核验，必须拒绝而不是先发送再等待。 */ () => ({
          bytes: request,
          beforeWrite: /** 异步拒绝应被消费并保持零写入。 */ () =>
            Promise.reject(new Error('synthetic async authority'))
        })
      ),
      code('herdr_prepare_rejected')
    )
    assert.equal(state.socket.writes.length, 0)
  }
)

test(
  'preparation failures are distinguished from writes that may already have begun',
  /** 前置错误不标记派发；同步 write 抛错前已执行最终标记，宿主须报告 unknown。 */ async () => {
    const state = syntheticSocket()
    let dispatched = false
    await assert.rejects(
      exchangeHerdr(
        state.raw,
        new AbortController().signal,
        /** 模拟 codec 前置拒绝，不获得可写请求。 */ () => {
          throw new Error('synthetic preparation failure')
        }
      ),
      code('herdr_prepare_rejected')
    )
    assert.equal(state.socket.writes.length, 0)
    assert.equal(dispatched, false)
    state.socket.writeFailure = true
    await assert.rejects(
      exchangeHerdr(
        state.raw,
        new AbortController().signal,
        /** 标记必须位于实际 write 前，不能只在 write 返回后补记。 */ () => ({
          bytes: request,
          beforeWrite: /** 表示宿主已越过唯一派发边界。 */ () => {
            dispatched = true
          }
        })
      ),
      code('herdr_socket_io')
    )
    assert.equal(dispatched, true)
    assert.equal(state.socket.writes.length, 1)
  }
)

test(
  'response framing requires actual EOF and respects the raw byte ceiling',
  /** 关闭、错误编码、部分行、多行与原始超限都不产生伪造响应。 */ async () => {
    for (const [data, terminal, expected] of [
      [Buffer.alloc(0), 'end', 'herdr_native_framing'],
      [reply.subarray(0, -1), 'end', 'herdr_native_framing'],
      [Buffer.concat([reply, reply]), 'end', 'herdr_native_framing'],
      [Buffer.alloc(HERDR_READONLY_REVIEW.frame_bytes + 1), 'data-only', 'herdr_response_limit'],
      ['synthetic decoded text\n', 'data-only', 'herdr_socket_io'],
      [Buffer.alloc(0), 'close', 'herdr_socket_eof']
    ] as const) {
      const state = syntheticSocket()
      const pending = exchangeHerdr(
        state.raw,
        new AbortController().signal,
        /** 只准备固定合成单行。 */ () => ({
          bytes: request,
          beforeWrite: /** 无额外副作用的最终核验。 */ () => {}
        })
      )
      state.socket.emit('data', data)
      if (terminal !== 'data-only') {
        state.socket.emit(terminal)
      }
      await assert.rejects(pending, code(expected))
    }
    const state = syntheticSocket()
    const raw = Buffer.alloc(HERDR_READONLY_REVIEW.frame_bytes, 32)
    raw[raw.length - 1] = 10
    const pending = exchangeHerdr(
      state.raw,
      new AbortController().signal,
      /** 大小边界仍使用固定小请求。 */ () => ({
        bytes: request,
        beforeWrite: /** 仅表示允许本次写入。 */ () => {}
      })
    )
    state.socket.emit('data', raw)
    state.socket.emit('end')
    assert.deepEqual(await pending, raw)
  }
)

test(
  'real owned Unix socket succeeds only after peer EOF and is destroyed after use',
  /** 原生 IO 正例只针对自建 listener；JSON 内容不是 Herdr 来源证明。 */ async () => {
    const fixture = await unixFixture(
      /** 收到唯一请求后分两段回复并关闭写端。 */ (socket) => {
        socket.once(
          'data',
          /** 核对实际收到原始请求，不接受重试或额外字节。 */ (bytes) => {
            assert.deepEqual(bytes, request)
            socket.write(reply.subarray(0, 9))
            socket.end(reply.subarray(9))
          }
        )
      }
    )
    let connected: Socket | undefined
    try {
      const raw = await withHerdrSocket(
        fixture.endpoint,
        new AbortController().signal,
        /** 保持同一连接直到读取真实 EOF。 */ (socket) => {
          connected = socket
          return exchangeHerdr(
            socket,
            new AbortController().signal,
            /** 只准备合成 ping 字节。 */ () => ({
              bytes: request,
              beforeWrite: /** 自建 listener 不提供生产权限。 */ () => {}
            })
          )
        }
      )
      assert.deepEqual(raw, reply)
      assert.equal(connected?.destroyed, true)
    } finally {
      await fixture.close()
    }
  }
)

test(
  'a complete line without EOF remains pending until bridge cancellation',
  /** 不把 LF 当作完整 socket 调用结束，也不把本地 timeout 伪造成原生回复。 */ async () => {
    let notify: (() => void) | undefined
    const wrote = new Promise<void>(
      /** 记录自建 listener 已写出完整行但保留连接。 */ (resolve) => {
        notify = resolve
      }
    )
    const fixture = await unixFixture(
      /** 只输出完整行，故意不结束 peer 写端。 */ (socket) => {
        socket.once(
          'data',
          /** 触发真实无 EOF 等待场景。 */ () => {
            socket.write(reply)
            notify!()
          }
        )
      }
    )
    const controller = new AbortController()
    let resolved = false
    let connected: Socket | undefined
    try {
      const pending = withHerdrSocket(
        fixture.endpoint,
        controller.signal,
        /** 记录实际桥接 socket。 */ (socket) => {
          connected = socket
          return exchangeHerdr(
            socket,
            controller.signal,
            /** 无额外请求或重试。 */ () => ({
              bytes: request,
              beforeWrite: /** 只记录这一条准备好的写入。 */ () => {}
            })
          )
        }
      )
      void pending.then(
        /** 只有成功结算才改变标记。 */ () => {
          resolved = true
        },
        /** 预期取消已有独立断言。 */ () => {}
      )
      await wrote
      await new Promise<void>(/** 给本地数据回调一次事件循环机会，仍不制造 EOF。 */ (resolve) => setImmediate(resolve))
      assert.equal(resolved, false)
      controller.abort('deadline')
      await assert.rejects(pending, code('herdr_timeout'))
      assert.equal(connected?.destroyed, true)
    } finally {
      await fixture.close()
    }
  }
)

test(
  'endpoint permissions and inode replacement fail before or after connection',
  /** 核对连接前私有权限以及读取完成后的路径身份；不只核对地址字符串。 */ async () => {
    const fixture = await unixFixture(
      /** 对已连接的原 listener 回复固定数据。 */ (socket) => {
        socket.once('data', /** 发送完整单行及 EOF。 */ () => socket.end(reply))
      }
    )
    try {
      chmodSync(fixture.address, 0o666)
      assert.throws(
        /** 不安全权限时不能创建连接。 */ () =>
          withHerdrSocket(
            fixture.endpoint,
            new AbortController().signal,
            /** 此回调不应被权限失败路径调用。 */ async () => {
              throw new Error('unexpected callback')
            }
          ),
        code('herdr_local_path_untrusted')
      )
      chmodSync(fixture.address, 0o600)
      const endpoint = { ...fixture.endpoint, stamp: inspectHerdrPath(fixture.address, 'socket') }
      await assert.rejects(
        withHerdrSocket(
          endpoint,
          new AbortController().signal,
          /** 已连接后替换目录项，原连接成功也不能通过来源后验。 */ async () => {
            renameSync(fixture.address, fixture.address + '.old')
            writeFileSync(fixture.address, 'synthetic replacement', { mode: 0o600 })
            return Buffer.alloc(0)
          }
        ),
        code('herdr_local_path_untrusted')
      )
    } finally {
      await fixture.close()
    }
  }
)

test(
  'cancellation destroys an owned socket and consumes the delayed callback failure',
  /** 取消后晚到的宿主回调不能继续写入，也不能泄露未处理拒绝。 */ async () => {
    const fixture = await unixFixture(/** 本 listener 不主动发送任何内容。 */ () => {})
    const controller = new AbortController()
    let entered: (() => void) | undefined
    const ready = new Promise<void>(
      /** 只在回调已经持有实际连接后执行取消。 */ (resolve) => {
        entered = resolve
      }
    )
    let release: (() => void) | undefined
    const delayed = new Promise<void>(
      /** 模拟暂停中的准备流程，不启动任何原生工作。 */ (resolve) => {
        release = resolve
      }
    )
    let socket: Socket | undefined
    let writes = 0
    try {
      const pending = withHerdrSocket(
        fixture.endpoint,
        controller.signal,
        /** 延迟后尝试准备请求，检查取消是否在进入准备回调前生效。 */ async (connected) => {
          socket = connected
          entered!()
          await delayed
          return exchangeHerdr(
            connected,
            controller.signal,
            /** 取消后不应到达此唯一写入准备。 */ () => {
              writes++
              return { bytes: request, beforeWrite: /** 没有生产权限的合成最终阶段。 */ () => {} }
            }
          )
        }
      )
      await ready
      controller.abort()
      await assert.rejects(pending, code('herdr_cancelled'))
      assert.equal(socket?.destroyed, true)
      release!()
      await new Promise<void>(/** 让晚到拒绝经过已有消费链，不能成为未处理异常。 */ (resolve) => setImmediate(resolve))
      assert.equal(writes, 0)
      const rejected = withHerdrSocket(
        fixture.endpoint,
        new AbortController().signal,
        /** 空拒绝值仍然必须保持失败结论。 */ () => Promise.reject(undefined)
      )
      await assert.rejects(rejected, /** 原样拒绝 undefined，不能误当作成功值返回。 */ (error) => error === undefined)
    } finally {
      release?.()
      await fixture.close()
    }
  }
)

test(
  'private path ancestry, symlinks, command whitelist and environment are explicit',
  /** 路径与环境来自受保护配置；任何未知命令都在安装核验和进程启动之前拒绝。 */ () => {
    const root = privateRoot()
    try {
      const config = configFixture(root)
      const environment = herdrEnvironment(config)
      assert.equal(environment.HOME, config.home)
      assert.equal(environment.XDG_CONFIG_HOME, config.config_home)
      assert(!Object.hasOwn(environment, 'HERDR_SOCKET_PATH'))
      assert(!Object.hasOwn(environment, 'SSH_AUTH_SOCK'))
      assert(!Object.hasOwn(environment, 'OPENAI_API_KEY'))
      symlinkSync(config.binary, join(root, 'linked'))
      assert.throws(
        /** 链接文件不能代替安装路径。 */ () => inspectHerdrPath(join(root, 'linked'), 'binary'),
        code('herdr_local_path_untrusted')
      )
      chmodSync(root, 0o777)
      assert.throws(
        /** 公开可写父目录使其内普通文件同样不可信。 */ () => inspectHerdrPath(config.binary, 'binary'),
        code('herdr_local_path_untrusted')
      )
      chmodSync(root, 0o700)
      assert.throws(
        /** unknown 不能退化成 schema 命令。 */ () =>
          runHerdrCommand(config, 'unknown' as 'schema', new AbortController().signal),
        code('herdr_cli_command_invalid')
      )
      assert.throws(
        /** 缺失路径仅返回固定原因，不传播底层系统路径。 */ () => inspectHerdrPath(join(root, 'missing'), 'binary'),
        code('herdr_local_path_untrusted')
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'actual installation measurement and external ChildProcess do not mint a process binding',
  /** 实际合成字节可测量，配置摘要不符和来源伪造均拒绝；本例不执行文件。 */ async () => {
    const root = privateRoot()
    try {
      const config = configFixture(root)
      const measured = measureHerdrInstallation(config)
      assert.match(measured.sha256, /^[a-f0-9]{64}$/u)
      assert.equal(verifyHerdrInstallation(config, measured.sha256), measured.stamp)
      assert.throws(
        /** 实际配置摘要不符时在执行前拒绝。 */ () => verifyHerdrInstallation(config, '0'.repeat(64)),
        code('herdr_binary_identity_changed')
      )
      assert.throws(
        /** 即使拥有 ChildProcess 对象也没有模块私有凭据。 */ () =>
          Reflect.construct(HerdrProcessBinding, [config, new ChildProcess(), {}]),
        code('herdr_supervised_process_required')
      )
      assert.throws(
        /** 只有原型而没有模块品牌同样不构成来源。 */ () =>
          HerdrProcessBinding.prototype.assert.call(Object.create(HerdrProcessBinding.prototype), config),
        code('herdr_native_instance_untrusted')
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'local deadlines reject invalid bounds, propagate abort and close permanently',
  /** 不允许溢出 setTimeout 缩短期限；关闭只中止本次桥接等待。 */ () => {
    for (const duration of [0, -1, NaN, Infinity, 600_001, 2 ** 31]) {
      assert.throws(
        /** 非正整数或超出本地上限都不能创建等待。 */ () => herdrDeadline(undefined, duration),
        code('herdr_deadline_invalid')
      )
    }
    const parent = new AbortController()
    const deadline = herdrDeadline(parent.signal, 1000)
    parent.abort('deadline')
    assert.equal(deadline.signal.reason, 'deadline')
    deadline.close()
    const closed = herdrDeadline(undefined, 1000)
    closed.close()
    assert.equal(closed.signal.aborted, true)
    assert.equal(closed.signal.reason, 'closed')
  }
)

test(
  'Bun supervised-child branding and peer lifecycle use an explicitly synthetic launch module',
  /** 只替换临时派生模块的安装与 spawn 入口；自有 Bun 等待进程不是 Herdr 原生来源证据。 */ async () => {
    const root = privateRoot()
    const source = readFileSync(new URL('../../../src/connector/herdr/local.ts', import.meta.url), 'utf8')
    const script = join(root, 'local.ts')
    let derived = source.replace('ChildProcess, spawn', 'ChildProcess, spawn as actualSpawn')
    assert.notEqual(derived, source)
    derived = derived.replace('export function verifyHerdrInstallation(', 'function originalVerifyHerdrInstallation(')
    for (const [relative, url] of [
      ['../../wire/index.js', new URL('../../../src/wire/index.ts', import.meta.url).href],
      ['../terminal-execution.js', new URL('../../../src/connector/terminal-execution.ts', import.meta.url).href],
      ['../local/agent-path.js', new URL('../../../src/connector/local/agent-path.ts', import.meta.url).href],
      ['../local/linux-peer.js', new URL('../../../src/connector/local/linux-peer.ts', import.meta.url).href],
      ['../../platform/windows.js', new URL('../../../src/platform/windows.ts', import.meta.url).href],
      ['../../platform/macos.js', new URL('../../../src/platform/macos.ts', import.meta.url).href],
      ['./review.js', new URL('../../../src/connector/herdr/review.ts', import.meta.url).href]
    ]) {
      derived = derived.replaceAll(relative!, url!)
    }
    derived += `
export let checks = 0;
export let changeAfterSpawn = false;
export let captured;
export let child;
/** 通过显式测试入口改变合成安装核验，不修改模块命名空间。 */
export function changeInstallation() { changeAfterSpawn = true; }
/** 明确的合成 hash 检查，仅覆盖宿主启动状态机而非真实来源。 */
export function verifyHerdrInstallation() { checks++; return checks % 2 === 0 && changeAfterSpawn ? 'changed' : 'synthetic-installation'; }
/** 底层实际 ChildProcess 用于验证 Bun 品牌与退出通知，伪 argv 不计作原生实证。 */
function spawn(binary, argv, options) {
 captured = {binary, argv, options};
 child = actualSpawn(${JSON.stringify(process.execPath)}, ['--no-env-file', '-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore', env:options.env, cwd:options.cwd});
 child.spawnfile = binary;
 child.spawnargs = [binary,...argv];
 return child;
}
`
    writeFileSync(script, derived, { mode: 0o600 })
    const local = await import(pathToFileURL(script).href)
    let child: ChildProcess | undefined
    try {
      const config = {
        ...configFixture(root),
        agent_bin_dirs: [join(root, 'Agent Tools')],
        allow_terminal_execution: false
      }
      const launched = await local.launchHerdrProcess(config)
      child = launched.child
      assert(child instanceof ChildProcess)
      assert.equal(local.checks, 2)
      assert.deepEqual(local.captured.argv, ['--session', 'owned', 'server'])
      assert.equal(local.captured.options.shell, false)
      assert.deepEqual(local.captured.options.env, herdrEnvironment(config))
      assert.equal(local.captured.options.env.PATH, config.agent_bin_dirs!.join(':') + ':/usr/bin:/bin')
      assert.equal(config.allow_terminal_execution, false)
      const peer = { pid: child.pid!, uid: process.geteuid!(), gid: process.getegid!() }
      launched.binding.assert(config, peer)
      assert.throws(
        /** PATH 的本地配置变化不能重新解释已启动 child 的归属。 */ () =>
          launched.binding.assert({ ...config, agent_bin_dirs: [join(root, 'different')] }, peer),
        code('herdr_native_instance_untrusted', local.HerdrLocalError)
      )
      for (const field of ['pid', 'uid', 'gid'] as const) {
        assert.throws(
          /** 内核 peer 的进程与双端属主必须同时匹配。 */ () =>
            launched.binding.assert(config, { ...peer, [field]: peer[field] + 1 }),
          code('herdr_native_instance_untrusted', local.HerdrLocalError)
        )
      }
      assert.throws(
        /** 同一子进程不能重新解释为另一 session 或本机配置。 */ () =>
          launched.binding.assert({ ...config, target: { ...config.target, session: 'other' } }, peer),
        code('herdr_native_instance_untrusted', local.HerdrLocalError)
      )
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      assert.throws(
        /** 原子进程退出后来源永久失效。 */ () => launched.binding.assert(config, peer),
        code('herdr_native_instance_untrusted', local.HerdrLocalError)
      )
      child = undefined
      local.changeInstallation()
      await assert.rejects(
        local.launchHerdrProcess(config),
        code('herdr_binary_identity_changed', local.HerdrLocalError)
      )
      child = local.child
      if (child && child.exitCode === null && child.signalCode === null) {
        await once(child, 'exit')
      }
      assert.equal(local.checks, 4)
      assert.equal(readFileSync(new URL('../../../src/connector/herdr/local.ts', import.meta.url), 'utf8'), source)
    } finally {
      child?.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'Herdr 端点目录由产品以 0700 创建，不依赖宿主 umask；已存在的目录不被修改',
  /** Herdr 自己新建目录会继承 umask（常见 0755）并被 0700 门禁拒绝，所以启动前必须由产品建好。 */ () => {
    const root = privateRoot()
    const previous = process.umask(0o022)
    try {
      for (const session of ['default', 'owned']) {
        const base = configFixture(mkdtempSync(join(root, 'case-')))
        const config = pinHerdrConfig({ ...base, target: { ...base.target, session } })
        prepareHerdrEndpointDirectory(config)
        const directory =
          session === 'default'
            ? join(config.config_home, 'herdr')
            : join(config.config_home, 'herdr', 'sessions', session)
        assert.equal(lstatSync(directory).mode & 0o777, 0o700)
        // 再次调用是空操作；已存在目录即使权限过宽也不被静默放行或修改。
        prepareHerdrEndpointDirectory(config)
        chmodSync(directory, 0o755)
        prepareHerdrEndpointDirectory(config)
        assert.equal(lstatSync(directory).mode & 0o777, 0o755)
        assert.throws(() => inspectHerdrPath(directory, 'directory'), code('herdr_local_path_untrusted'))
      }
    } finally {
      process.umask(previous)
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'exchange preserves local claim capacity only before the socket write boundary',
  /** 准备期错误保留诊断；实际 write 抛出的同类型错误不能伪装成尚未发送。 */ async () => {
    const capacity = new ConnectorCapacityError('claim_entries', 1000)
    const before = syntheticSocket()
    await assert.rejects(
      exchangeHerdr(
        before.raw,
        new AbortController().signal,
        /** 合成满额，不准备原生字节。 */ () => {
          throw capacity
        }
      ),
      /** 只有同一个内部类型化错误可保留容量详情，不能从消息自报重建。 */ (error: unknown) => error === capacity
    )
    assert.equal(before.socket.writes.length, 0)
    const after = syntheticSocket()
    after.socket.write = /** write 可能已把字节交给系统，再抛同码错误仍按 IO 失败。 */ (bytes) => {
      after.socket.writes.push(Buffer.from(bytes))
      throw capacity
    }
    await assert.rejects(
      exchangeHerdr(
        after.raw,
        new AbortController().signal,
        /** 提供合法固定帧进入真实 write 边界。 */ () => ({
          bytes: request,
          beforeWrite: /** 本例只观察 IO 层，不建立原生执行许可。 */ () => {}
        })
      ),
      code('herdr_socket_io')
    )
    assert.equal(after.socket.writes.length, 1)
  }
)

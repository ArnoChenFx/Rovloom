// 验证唯一配置到实际出站端点的绑定与错误清理；TLS、凭据和会话均为本例合成fixture。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:https'
import { PassThrough } from 'node:stream'
import { createRuntimeCliRuntime, type RuntimeCliConnectorResources } from '../../src/cli/runtime.js'
import { configTemplate, type ConnectorConfig } from '../../src/cli/config.js'
import { runCli, type RunningConnector } from '../../src/cli/run.js'
import type { ConnectorRuntimeOptions } from '../../src/runtime/types.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { runtime as transportRuntime } from '../../src/transport/common.js'
import { saveCredential } from '../../src/transport/index.js'
import { decodeWireFrame } from '../../src/wire/index.js'

test(
  '生产Connector的快照声明穿过两层CLI并进入真实TLS认证帧，未声明时不补广告',
  /** 对端只观察真实Wire协商后拒绝认证；来源和凭据为明确合成fixture，不建立native会话。 */ async () => {
    if (process.platform !== 'linux') {
      return
    }
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-cli-snapshot-'))
    const refs = join(directory, 'refs')
    mkdirSync(refs, { mode: 0o700 })
    const tls = certificate(directory)
    let observe!: (capabilities: string[]) => void
    const listener = transportRuntime().serve<null>({
      hostname: '127.0.0.1',
      port: 0,
      tls,
      fetch: /** 仅本例固定端点接受WebSocket，观察协议不创建Gateway身份。 */ (request, server) =>
        new URL(request.url).pathname === '/connector' && server.upgrade(request, { data: null })
          ? undefined
          : new Response(null, { status: 404 }),
      websocket: {
        maxPayloadLength: 65_536,
        backpressureLimit: 65_536,
        closeOnBackpressureLimit: true,
        perMessageDeflate: false,
        open: /** 链路打开不代表认证或provider就绪。 */ () => {},
        message: /** 复用实际Wire decoder，只交付能力数组，凭据及原帧不进入输出。 */ (socket, message) => {
          const frame = decodeWireFrame(message, { phase: 'preauth', direction: 'connector_to_gateway' })
          assert.equal(frame.type, 'authenticate')
          if (frame.type === 'authenticate') {
            observe([...frame.payload.offer.capabilities])
          }
          socket.close()
        },
        close: /** 测试peer没有持久身份或业务会话可清理。 */ () => {}
      }
    })
    try {
      const config = {
        ...configTemplate('connector'),
        state_dir: directory,
        gateway_url: `wss://127.0.0.1:${listener.port}`,
        provider_config_refs: ['snapshot_fixture']
      } as ConnectorConfig
      writeFileSync(
        join(directory, 'runtime.json'),
        JSON.stringify({
          schema_version: 1,
          role: 'connector',
          credential_ref: 'fixture_device',
          ca_ref: 'fixture_tls',
          provider_config_refs: config.provider_config_refs
        }),
        { mode: 0o600 }
      )
      writeFileSync(join(refs, 'fixture_tls.ca.pem'), tls.cert, { mode: 0o600 })
      writeFileSync(join(refs, 'snapshot_fixture.json'), JSON.stringify({ kind: 'luvus' }), { mode: 0o600 })
      saveCredential(join(refs, 'fixture_device.json'), {
        machine_id: 'snapshot_fixture',
        recovery_generation: 'snapshot_generation',
        credential: 'SYNTHETIC_SNAPSHOT_CREDENTIAL_NOT_REAL'
      })
      for (const declared of [true, false]) {
        const received = new Promise<string[]>(
          /** 每轮只观察自己实际收到的认证帧。 */ (resolve) => {
            observe = resolve
          }
        )
        let released = 0
        let sessions = 0
        const runtime = createProductionCliRuntime({
          connector: /** 合成资源只声明已有能力，实际两个CLI组合点和出站transport保持原实现。 */ async () => ({
            ...(declared ? { provider_snapshot: true as const } : {}),
            session: /** peer没有接受认证，任何native会话创建都是本例失败。 */ () => {
              sessions++
              throw new Error('unexpected_fixture_session')
            },
            release: /** 本轮真实runtime只释放一次合成所有者。 */ async () => {
              released++
            }
          })
        })
        const running = await runtime.connector!(config)
        try {
          assert.equal((await received).includes('provider_snapshot'), declared)
        } finally {
          await running.close()
          await running.closed
        }
        assert.equal(released, 1)
        assert.equal(sessions, 0)
      }
    } finally {
      listener.stop(true)
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

// 本地一日证书只供拒绝握手，不安装系统信任、不创建真实设备身份。
function certificate(directory: string) {
  const cert = join(directory, 'fixture.crt')
  const key = join(directory, 'fixture.key')
  const result = spawnSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=fixture-only',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-out',
      cert,
      '-keyout',
      key
    ],
    { stdio: 'ignore' }
  )
  assert.equal(result.status, 0)
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') }
}

test(
  'runtime Connector从唯一配置固定真实TLS端点，宿主不重复提供URL',
  /* 真实TLS只到本例401服务，不接受认证或建立native session。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-runtime-resource-'))
    const tls = certificate(directory)
    let observed!: (url: string) => void
    const requested = new Promise<string>(/* 收到真实HTTP请求后才验证路径和关闭。 */ (resolve) => (observed = resolve))
    const server = createServer(
      tls,
      /* 拒绝WebSocket升级，不接收凭据帧或建立设备会话。 */ (request, response) => {
        response.writeHead(401, { connection: 'close' })
        response.end()
        observed(request.url!)
      }
    )
    server.on(
      'upgrade',
      /* 明确拒绝真实WebSocket升级，只观察请求路径，不接收认证帧。 */ (request, socket) => {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        observed(request.url!)
      }
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    let released = 0
    let credentials = 0
    let sessions = 0
    let running: RunningConnector | undefined
    try {
      const address = server.address()
      assert(address && typeof address === 'object')
      const config = {
        ...configTemplate('connector'),
        state_dir: directory,
        gateway_url: `wss://127.0.0.1:${address.port}`
      } as ConnectorConfig
      class FixtureResources implements RuntimeCliConnectorResources {
        readonly marker = 'fixture_instance'
        readonly transport = {
          ca: tls.cert,
          credential: /* Gateway握手拒绝，此fixture不能成为生产身份。 */ () => {
            credentials++
            return {
              machine_id: 'fixture_denied',
              recovery_generation: 'fixture_generation',
              credential: 'SYNTHETIC_CREDENTIAL_NOT_FOR_PRODUCTION'
            }
          }
        }
        // 原型方法仍绑定同一资源实例；401不能创建真实Wire/native会话。
        session(): never {
          assert.equal(this.marker, 'fixture_instance')
          sessions++
          throw new Error('unexpected_fixture_session')
        }
        // 释放需要原型方法和实际this，不能把类实例展开为缺方法的普通对象。
        async release() {
          assert.equal(this.marker, 'fixture_instance')
          released++
        }
      }
      const source = new FixtureResources()
      const runtime = createRuntimeCliRuntime({
        connector: /* 只交付实际TLS CA和明确合成设备输入，URL由CLI配置拥有。 */ async () => source
      })
      running = await runtime.connector!(config)
      assert.equal(await requested, '/connector')
      await running.close()
      await running.closed
      await running.close()
      assert.equal(released, 1)
      assert.equal(credentials, 1)
      assert.equal(sessions, 0)
    } finally {
      await running?.close()
      const closed = once(server, 'close')
      server.closeAllConnections()
      server.close()
      await closed
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

test(
  'runtime资源夹带冲突URL在凭据读取前拒绝，释放失败也不回显秘密',
  /* 旧完整options只用于模拟结构类型额外字段；不创建任何网络或native资源。 */ async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-runtime-target-'))
    try {
      const path = join(directory, 'connector.json')
      writeFileSync(path, JSON.stringify({ ...configTemplate('connector'), state_dir: directory }), { mode: 0o600 })
      for (const failRelease of [false, true]) {
        let released = 0
        let credentials = 0
        let sessions = 0
        const legacy: ConnectorRuntimeOptions = {
          transport: {
            url: 'wss://SYNTHETIC_SECRET_DO_NOT_PRINT.invalid/connector',
            credential: /* 冲突校验必须早于实际凭据读取。 */ () => {
              credentials++
              throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT')
            }
          },
          session: /* 不得把冲突来源交给实际native会话。 */ () => {
            sessions++
            throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT')
          },
          release: /* 每种失败都回收一次；底层错误原文不得进入CLI诊断。 */ async () => {
            released++
            if (failRelease) {
              throw new Error('SYNTHETIC_SECRET_DO_NOT_PRINT')
            }
          }
        }
        const runtime = createRuntimeCliRuntime({
          connector: /* 结构类型允许旧完整options，其运行时冲突仍须拒绝。 */ async () => legacy
        })
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        let out = ''
        let err = ''
        stdout.on('data', /* 失败不输出配置或来源。 */ (chunk) => (out += chunk))
        stderr.on('data', /* 只允许固定诊断，不泄漏URL/底层释放错误。 */ (chunk) => (err += chunk))
        const code = await runCli(
          ['connector', '--config', path],
          {
            stdin: new PassThrough(),
            stdout,
            stderr,
            signal: new AbortController().signal
          },
          runtime
        )
        assert.equal(code, 1)
        assert.equal(out, '')
        assert.equal(err, 'runtime_failed\n')
        assert.equal(released, 1)
        assert.equal(credentials, 0)
        assert.equal(sessions, 0)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

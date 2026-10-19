// 验证CLI确实组合现有transport及关闭资源；身份、原生回调和历史全部是隔离fixture，不证明native闭环。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PassThrough } from 'node:stream'
import {
  configTemplate,
  createTransportCliRuntime,
  runCli,
  type GatewayConfig,
  type GatewayTransportPorts,
  type GatewayTransportResources,
  type ConnectorConfig
} from '../../src/cli/index.js'
import { FacadeServiceError, StoreGatewayService, type ServiceContext } from '../../src/mcp/index.js'
import { storeFixture, policy } from '../mcp/store-fixture.js'

// 测试信号使用显式Promise握手，不以sleep推测角色已经启动或关闭。
function notification() {
  let resolve!: () => void
  const promise = new Promise<void>(
    /* 保存测试私有通知函数，不创建业务请求或授权。 */ (done) => {
      resolve = done
    }
  )
  return { promise, resolve }
}

// 生成仅用于本例loopback握手的一日自签证书，不修改系统信任或生产证书。
function certificate(directory: string) {
  const cert = join(directory, 'mock.crt')
  const key = join(directory, 'mock.key')
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
      '/CN=mock-only',
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

// 默认拒绝所有设备，只开放真实listener测试；没有认证或native会话可被这套fixture接受。
function resources(f: ReturnType<typeof storeFixture>): GatewayTransportResources {
  return {
    store: f.store,
    identities: f.identities,
    localPolicies: f.localPolicies,
    caller: { resolve: /* 此合成caller仅用于测试已有Store授权查询。 */ () => ({ principal_id: 'alice' }) },
    transport: {
      hostname: '127.0.0.1',
      port: 0,
      developmentLoopback: true,
      identity: {
        generation: /* 读取实际测试Store的恢复代次，不从设备帧建立代次。 */ () => f.store.generation(),
        authenticate: /* 不签发或接受任何凭据，认证必定拒绝。 */ () => {
          throw new Error('mock_denied')
        },
        assert: /* 未认证连接不能通过后续复验。 */ () => {
          throw new Error('mock_denied')
        },
        disconnect: /* 拒绝fixture从未建立连接，因此没有可断开的持久epoch。 */ () => {}
      },
      session: /* 拒绝身份后不应创建native会话；到达此处即测试失败。 */ () => {
        throw new Error('unexpected_mock_session')
      }
    },
    close: /* 资源所有权交给runtime，关闭真实Store而不删除测试断言所需目录。 */ async () => f.store.close()
  }
}

test(
  '两角色宿主同步重入close仍共用原Promise且只释放一次资源',
  /* 复现Promise赋值前执行清理的重入条件，直接验证真实transport宿主的资源所有权。 */ async () => {
    const f = storeFixture()
    let nestedGateway: Promise<void> | undefined
    let nestedConnector: Promise<void> | undefined
    let gatewayCloses = 0
    let connectorCloses = 0
    const runtime = createTransportCliRuntime({
      gateway: /* 真实listener只使用测试Store，清理时同步重入当前Gateway关闭接口。 */ async () => ({
        ...resources(f),
        close: /* 不等待自身关闭，验证同步重入取得同一Promise且不再释放一次Store。 */ async () => {
          gatewayCloses++
          nestedGateway = gateway.close()
          f.store.close()
        }
      }),
      connector: /* 只创建实际Connector生命周期；凭据读取拒绝，不建立socket或设备身份。 */ async () => ({
        transport: {
          credential: /* 拒绝本例的凭据读取，使客户端保持未连接路径，不提供任何设备身份。 */ () => {
            throw new Error('unexpected_credential')
          },
          session: /* 本例不应建立认证会话。 */ () => {
            throw new Error('unexpected_session')
          },
          nativeInput: /* 本例不应进入原生输入。 */ () => {
            throw new Error('unexpected_native')
          },
          execute: /* 本例不应执行原生调用。 */ async () => {
            throw new Error('unexpected_native')
          }
        },
        close: /* 同步重入当前Connector关闭，清理只允许进入一次。 */ async () => {
          connectorCloses++
          nestedConnector = connector.close()
        }
      })
    })
    const gateway = await runtime.gateway!({ ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig)
    const connector = await runtime.connector!({
      ...configTemplate('connector'),
      gateway_url: 'wss://127.0.0.1:1'
    } as ConnectorConfig)
    try {
      const firstGateway = gateway.close()
      const firstConnector = connector.close()
      await Promise.all([firstGateway, firstConnector, connector.closed])
      assert.equal(nestedGateway, firstGateway)
      assert.equal(nestedConnector, firstConnector)
      assert.equal(gatewayCloses, 1)
      assert.equal(connectorCloses, 1)
    } finally {
      await gateway.close()
      await connector.close()
      f.close()
    }
  }
)

test(
  'CLI transport宿主打开实际listener，EOF先停网络再释放一次Store资源',
  /* 运行实际runCli/stdio/Store/transport；不以角色stub替代网络生命周期。 */ async () => {
    const f = storeFixture()
    let ports: GatewayTransportPorts | undefined
    let closes = 0
    const runtime = createTransportCliRuntime({
      gateway: /* 只交付本测试已持有的隔离Store和拒绝所有设备的身份来源。 */ async () => ({
        ...resources(f),
        service: /* 复用同一Router构造真实Store服务并观察所属transport。 */ (value) => {
          ports = value
          return new StoreGatewayService({ ...resources(f), router: value.router })
        },
        close: /* 必须先停止真实listener再释放Store，重复关闭不得多次进入。 */ async () => {
          closes++
          assert.equal(ports!.transport.status().stopped, true)
          f.store.close()
        }
      })
    })
    const config = { ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig
    const path = join(f.directory, 'gateway.json')
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const started = notification()
    const opening = runtime.gateway!
    runtime.gateway = /* 明确等待实际listener创建后再发EOF，避免伪造启动成功。 */ async (value) => {
      const running = await opening(value)
      started.resolve()
      return running
    }
    const running = runCli(
      ['gateway', '--config', path],
      {
        stdin,
        stdout,
        stderr,
        signal: new AbortController().signal
      },
      runtime
    )
    try {
      await started.promise
      assert.equal(ports!.resolveOriginalRead, ports!.transport.resolveOriginalRead)
      assert.equal(ports!.resolveOriginalRead('call_fixture'), undefined)
      assert.equal((await fetch(ports!.transport.url.replace('ws:', 'http:'))).status, 400)
      assert.equal(ports!.transport.status().stopped, false)
    } finally {
      stdin.end()
      assert.equal(await running, 0)
      f.close()
    }
    assert.equal(closes, 1)
    assert.equal(stdout.read(), null)
    assert.equal(stderr.read(), null)
  }
)

test(
  '并发异步服务的dispatch保持所属caller且每次重读身份，无请求作用域时拒绝',
  /* 使用明确的探针服务stub，仅检查真实Router与transport拒绝，不伪装native业务成功。 */ async () => {
    const f = storeFixture()
    const gates = { alice: notification(), bob: notification() }
    let pending: ReturnType<typeof notification> | undefined
    let aliceActive = true
    const readers: string[] = []
    let ports!: GatewayTransportPorts
    const runtime = createTransportCliRuntime({
      gateway: /* 交付同一真实Store及两个合成身份，二者不共享调用归属。 */ async () => ({
        ...resources(f),
        identities: {
          principal: /* 只按受信caller返回对应合成身份；未知身份仍拒绝。 */ (caller) =>
            ['alice', 'bob'].includes(caller.principal_id) && (caller.principal_id !== 'alice' || aliceActive)
              ? { id: caller.principal_id, policy: policy() }
              : null,
          administrator: /* 此测试不提供管理员会话。 */ () => null
        },
        service: /* 仅保存实际transport并创建故意交错的探针服务。 */ (value) => {
          ports = value
          return {
            execute: /* 等待caller独立门后尝试实际dispatch，所有分支都应拒绝而不发送。 */ async (
              _name,
              _args,
              context
            ) => {
              await (pending ?? gates[context.caller.principal_id as keyof typeof gates]).promise
              readers.push(ports.principal().id)
              assert.equal(ports.localPolicies, f.localPolicies)
              ports.originalAttempt('call_fixture', 'attempt_fixture')
              ports.transport.dispatch('call_fixture')
              throw new Error('unexpected_dispatch')
            }
          }
        }
      })
    })
    const running = await runtime.gateway!({ ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig)
    const context = /* 只为测试显式构造宿主上下文，不来自MCP业务参数。 */ (id: string): ServiceContext => ({
      caller: { principal_id: id },
      wait_signal: new AbortController().signal
    })
    try {
      assert.throws(
        /* 无所属请求作用域不能为结果模块借用最近身份或读取原请求。 */ () =>
          ports.originalAttempt('call_fixture', 'attempt_fixture'),
        new FacadeServiceError('unauthenticated')
      )
      assert.throws(
        /* 在服务上下文外派发，即使调用归属已存在也不能借用最近caller。 */ () =>
          ports.transport.dispatch('call_fixture'),
        /Gateway service rejected/
      )
      const alice = running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('alice'))
      const bob = running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('bob'))
      const aliceRejected = assert.rejects(alice, { code: 'connection_unavailable' })
      const bobRejected = assert.rejects(bob, { code: 'call_not_found' })
      gates.bob.resolve()
      gates.alice.resolve()
      await Promise.all([aliceRejected, bobRejected])
      assert.deepEqual([...readers].sort(), ['alice', 'bob'])
      aliceActive = false
      await assert.rejects(running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('alice')), {
        code: 'unauthenticated'
      })
      aliceActive = true
      pending = notification()
      const late = running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('alice'))
      await running.close()
      pending.resolve()
      await assert.rejects(late, { code: 'unavailable' })
      await assert.rejects(running.service.execute('runtime_call_get', { call_id: 'call_fixture' }, context('alice')), {
        code: 'unavailable'
      })
      await running.close()
    } finally {
      await running.close()
      f.close()
    }
  }
)

test(
  'CLI Wire模式Connector复用严格WSS且终止后关闭，启动失败也释放宿主资源',
  /* 真实TLS socket只进入拒绝认证路径，无配对、凭据签发、native执行或用户会话。 */ async () => {
    const f = storeFixture()
    const authentication = notification()
    const stop = new AbortController()
    let gatewayPorts!: GatewayTransportPorts
    let connectorCloses = 0
    let invalidCloses = 0
    const tls = certificate(f.directory)
    const base = resources(f)
    const runtime = createTransportCliRuntime({
      gateway: /* 真实listener仅信任临时测试证书；设备认证保持拒绝。 */ async () => ({
        ...base,
        transport: {
          ...base.transport,
          tls,
          identity: {
            ...base.transport.identity,
            authenticate: /* 到达此回调证明Connector走过实际TLS与认证握手，随后必定拒绝。 */ () => {
              authentication.resolve()
              throw new Error('mock_denied')
            }
          }
        },
        service: /* 保存真实listener端点并复用实际Store服务，不开放native工具。 */ (ports) => {
          gatewayPorts = ports
          return f.service
        }
      }),
      connector: /* 专用回调只返回不可用于生产的固定mock输入，不从argv或URL读取秘密。 */ async () => ({
        transport: {
          ca: tls.cert,
          credential: /* mock握手会被Gateway拒绝，不执行任何凭据安装或签发动作。 */ () => ({
            machine_id: 'mock_denied',
            recovery_generation: f.store.generation(),
            credential: 'MOCK_ONLY_NOT_A_REAL_DEVICE_CREDENTIAL'
          }),
          session: /* Wire模式在认证通过后才创建executeWire；本例认证拒绝，不能建立会话或回退执行。 */ () => {
            throw new Error('unexpected_mock_session')
          }
        },
        close: /* 只统计已停止的Connector本地资源，不能宣称原生取消。 */ async () => {
          connectorCloses++
        }
      })
    })
    const gateway = await runtime.gateway!({ ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig)
    const config = {
      ...configTemplate('connector'),
      state_dir: f.directory,
      gateway_url: new URL(gatewayPorts.transport.url).origin
    } as ConnectorConfig
    const path = join(f.directory, 'connector.json')
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const running = runCli(['connector', '--config', path], { stdin, stdout, stderr, signal: stop.signal }, runtime)
    try {
      await authentication.promise
      stop.abort()
      assert.equal(await running, 0)
      assert.equal(connectorCloses, 1)
      assert.equal(stdout.read(), null)
      assert.equal(stderr.read(), null)
      const invalid = createTransportCliRuntime({
        gateway: /* 缺TLS且非开发loopback的真实transport启动必须拒绝并清理。 */ async () => ({
          ...resources(f),
          transport: { ...base.transport, developmentLoopback: false },
          close: /* 此失败宿主只计数，不提前关闭仍由上方Gateway持有的同一测试Store。 */ async () => {
            invalidCloses++
          }
        })
      })
      await assert.rejects(invalid.gateway!({ ...configTemplate('gateway'), state_dir: f.directory } as GatewayConfig))
      assert.equal(invalidCloses, 1)
    } finally {
      stop.abort()
      await running
      await gateway.close()
      f.close()
    }
  }
)

/** 对照固定官方契约验证窗口/Agent 普通操作，合成参数测试不冒充真实 Agent 对话或本机 Owner。 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { LuvusAdapterError } from '../../src/connector/luvus/types.js'
import { createLuvusOperationsProvider } from '../../src/runtime/luvus-operations-provider.js'
import type { LocalOwnerLuvusInstance } from '../../src/runtime/native-source.js'
import {
  LUVUS_OPERATION_METHODS,
  luvusOperationDescriptor,
  luvusOperationValidation,
  validateLuvusOperationParams
} from '../../src/runtime/luvus-operations.js'

const capabilities = JSON.parse(
  readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
).result
const schema = JSON.parse(
  readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8')
).request
const examples: Record<string, object> = {
  'session.snapshot': {},
  'workspace.list': {},
  'workspace.get': { workspace: 0 },
  'workspace.new': { cwd: '/isolated/project' },
  'workspace.open': { path: '/isolated/project' },
  'workspace.focus': { workspace: 0 },
  'workspace.rename': { workspace: 0, name: 'project' },
  'workspace.close': { workspace: 0 },
  'tab.list': {},
  'tab.get': { tab: 1 },
  'tab.new': {},
  'tab.focus': { tab: 1 },
  'tab.rename': { tab: 1, name: 'workspace' },
  'tab.close': { tab: 1 },
  'pane.list': { all_tabs: true },
  'pane.get': { pane: '1' },
  'pane.current': {},
  'pane.split': { pane: '1', direction: 'down' },
  'pane.focus': { pane: '1' },
  'pane.rename': { pane: '1', name: 'agent-window' },
  'pane.status': { pane: '1' },
  'pane.read': { pane: '1', lines: 100 },
  'pane.close': { pane: '1' },
  'agent.list': {},
  'agent.get': { target: 'selected-agent' },
  'agent.explain': { target: 'selected-agent' },
  'agent.start': { name: 'selected-agent', kind: 'opencode', pane: '1' },
  'agent.prompt': {
    target: 'selected-agent',
    terminal_id: '1'.repeat(32),
    text: 'first turn',
    strict: true,
    wait: true,
    until: ['idle'],
    timeout_s: 30
  },
  'agent.send': { target: 'selected-agent', terminal_id: '1'.repeat(32), text: 'second turn', strict: true },
  'agent.keys': {
    target: 'selected-agent',
    keys: ['ctrl+c', 'Enter'],
    terminal_id: '1'.repeat(32),
    if_content_revision: 1
  },
  'agent.read': { target: 'selected-agent', lines: 100, source: 'recent' },
  'agent.sessions': {},
  'agent.resume': { session_id: 'native-session-id' },
  'agent.wait': { pane: '1', status: 'idle', timeout_s: 30 }
}

test(
  'Luvus ordinary operation descriptors exactly match the official fixed live method contracts',
  /** 分类的 access/scope/idempotent 逐项取官方固定证据，不能从方法名称猜权限。 */ () => {
    assert(LUVUS_OPERATION_METHODS.length > 20)
    assert.deepEqual([...LUVUS_OPERATION_METHODS].sort(), Object.keys(examples).sort())
    for (const method of LUVUS_OPERATION_METHODS) {
      const expected = capabilities.method_contracts.find(
        /** 查找官方原生精确方法，不匹配前缀或通配符。 */ (entry: { method: string }) => entry.method === method
      )
      const descriptor = luvusOperationDescriptor(method)!
      assert.deepEqual(descriptor.native, expected)
      assert.equal(descriptor.effect, expected.access === 'read' ? 'read' : 'execute')
      const detailed = schema.allOf.some(
        /** 原 schema 是否实际有参数条件分支，generic 事实不能被分类掩盖。 */ (branch: any) => {
          const matcher = branch.if?.properties?.method
          return matcher?.const === method || matcher?.enum?.includes(method)
        }
      )
      assert.equal(descriptor.native_parameter_schema, detailed ? 'conditional_branch' : 'generic_params_only')
      assert.equal(luvusOperationValidation(method), detailed ? 'strict' : 'raw-contract')
      assert.doesNotThrow(
        /** 每个启用方法必须有一条明确可调用的参数样例。 */ () => validateLuvusOperationParams(method, examples[method])
      )
    }
  }
)

test(
  'Luvus Agent prompt, output and keys preserve explicit target and terminal identity across turns',
  /** 此测试只验证参数边界，真实模型两轮回复须由隔离 lab 另行实际执行。 */ () => {
    const target = 'selected-agent'
    const terminal = '1'.repeat(32)
    for (const text of ['remember this context', 'continue the previous turn']) {
      const params = {
        target,
        terminal_id: terminal,
        text,
        strict: true,
        wait: true,
        until: ['idle', 'done'],
        timeout_s: 60
      }
      validateLuvusOperationParams('agent.prompt', params)
      assert.equal(params.target, target)
      assert.equal(params.terminal_id, terminal)
      validateLuvusOperationParams('agent.read', { target, lines: 100, source: 'recent' })
    }
    validateLuvusOperationParams('agent.keys', { target, keys: ['esc'] })
    validateLuvusOperationParams('agent.wait', { pane: '1', statuses: ['idle', 'done'], timeout_s: 30 })
  }
)

for (const [method, params] of [
  ['workspace.focus', { workspace: -1 }],
  ['tab.focus', { tab: 0 }],
  ['pane.focus', { pane: 'other' }],
  ['pane.list', { all_tabs: 'true' }],
  ['pane.read', { pane: '1', source: 'recent' }],
  ['pane.split', { pane: '1', direction: 'left' }],
  ['agent.start', { name: 'x', kind: 'opencode', pane: '1', anchor: '2' }],
  ['agent.start', { name: 'x', kind: 'unreviewed kind' }],
  ['agent.prompt', { target: 'x', text: 'hello', until: ['idle'] }],
  ['agent.prompt', { target: 'x', text: 'hello', wait: true, until: ['finished'] }],
  ['agent.prompt', { target: 'x', text: 'hello', terminal_id: 'changed' }],
  ['agent.send', { target: 'x', text: 'hello', wait: true }],
  ['agent.keys', { target: 'x', keys: ['ctrl+c'], terminal_id: '1'.repeat(32) }],
  ['agent.keys', { target: 'x', keys: ['\u001b'] }],
  ['agent.keys', { target: 'x', keys: ['run arbitrary command'] }],
  ['agent.wait', { pane: '1', status: 'idle', statuses: ['done'] }],
  ['agent.read', { target: 'x', lines: 1001 }],
  ['agent.get', { target: 'x', auth: 'caller-token' }]
] as const) {
  test(
    `Luvus ordinary operation ${method} rejects malformed ${Object.keys(params).join(',')} params`,
    /** 错形参数不得被 Owner 模式或 generic 原 schema 的宽松外壳吞掉。 */ () => {
      assert.throws(
        /** 错误只返回固定码，不泄露 prompt、路径或输出。 */ () => validateLuvusOperationParams(method, params),
        /** 检查安全错误类型和公开固定消息。 */ (error: unknown) =>
          error instanceof LuvusAdapterError &&
          error.code === 'luvus_operation_params_invalid' &&
          error.message === error.code
      )
    }
  )
}

test(
  'Luvus ordinary operation surface excludes token, admin, shell and integration state fabrication',
  /** 首版窗口/Agent 操作不借 Owner 模式加入 token、任意终端执行或伪造 Agent 上报。 */ () => {
    for (const method of [
      'uhp.token.create',
      'server.stop',
      'config.patch',
      'pane.run',
      'pane.send_input',
      'agent.report',
      'agent.release'
    ]) {
      assert.equal(luvusOperationDescriptor(method), undefined)
      assert.throws(
        /** 未审方法没有模式推导，不自动进入 raw。 */ () => luvusOperationValidation(method),
        /luvus_operation_unreviewed/
      )
      assert.throws(
        /** 空参数也不能把未知方法变成允许操作。 */ () => validateLuvusOperationParams(method, {}),
        /luvus_operation_unreviewed/
      )
    }
  }
)

test(
  'Luvus operation params do not invoke getters and a forged local Owner cannot establish a provider',
  /** 对参数与来源分别验证真实边界，ready 回调或同形 JSON 均不是 Owner 证据。 */ () => {
    let invoked = false
    const params = Object.defineProperty({}, 'target', {
      enumerable: true,
      /** 记录访问器是否执行，参数边界必须先拒绝。 */ get() {
        invoked = true
        return 'selected-agent'
      }
    })
    assert.throws(
      /** 不通过调用 getter 获取参数。 */ () => validateLuvusOperationParams('agent.get', params),
      /luvus_operation_params_invalid/
    )
    const owner = {
      ready: /** 假来源不能借回调自证。 */ () => {
        invoked = true
        return true
      }
    } as unknown as LocalOwnerLuvusInstance
    assert.throws(
      /** 工厂在读取任何伪造来源字段前核实际交付句柄。 */ () => createLuvusOperationsProvider(owner, 'local1'),
      /local_owner_unavailable/
    )
    assert.equal(invoked, false)
  }
)

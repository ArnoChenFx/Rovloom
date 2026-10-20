/** 验证 Herdr 完整原生 schema、异步生成来源品牌、有界任务及严格私有协议。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { compileHerdrSchemas, isCompiledHerdrSchemas } from '../../../src/connector/herdr/compiler-api.js'
import { HerdrSchemaCompiler } from '../../../src/connector/herdr/compiler-host.js'
import { createHerdrCompilerWorker } from '../../../src/connector/herdr/compiler-location.js'
import {
  HERDR_COMPILER_VERSION,
  HERDR_CODE_LIMIT,
  HERDR_INPUT_LIMIT,
  HERDR_IDENTITY
} from '../../../src/connector/herdr/compiler-protocol.js'
import type {
  HerdrCompilerArtifact,
  HerdrCompilerPort,
  HerdrCompileJob,
  HerdrCompileResult
} from '../../../src/connector/herdr/compiler-protocol.js'
import type { HerdrSchemas } from '../../../src/connector/herdr/readonly.js'
import type { JsonObject } from '../../../src/wire/types.js'

const raw = readFileSync(new URL('../../fixtures/herdr/0.9.5/schema.json', import.meta.url))
const exchanges = JSON.parse(readFileSync(new URL('../../fixtures/herdr/0.9.5/readonly.json', import.meta.url), 'utf8'))

/** 自有测试端口只注入私有协议故障，生产 API 不接受该工厂或 caller 产物。 */
class TestPort implements HerdrCompilerPort {
  onmessage: HerdrCompilerPort['onmessage'] = null
  onerror: HerdrCompilerPort['onerror'] = null
  job?: HerdrCompileJob
  terminated = 0
  /** 记录当前唯一任务，供故障用例精确关联回复。 */
  postMessage(job: HerdrCompileJob): void {
    this.job = job
  }
  /** 终止后仍可手工回消息，检验晚到产物不能恢复品牌。 */
  terminate(): void {
    this.terminated++
  }
  /** 自有端口没有物理事件循环引用。 */
  ref(): void {}
  /** 自有端口没有资源需要解除引用。 */
  unref(): void {}
  /** 测试端口不自动发送生命周期通知。 */
  addEventListener(): void {}
  /** 按当前任务回复，故障用例可覆盖版本或任务 ID。 */
  reply(result: unknown, extra: Record<string, unknown> = {}): void {
    this.onmessage?.({ data: { version: HERDR_COMPILER_VERSION, job_id: this.job?.job_id, result, ...extra } })
  }
}

/** 从真实固定 Worker 取得受控生成物，测试不在主线程调用 schema 编译器。 */
async function specimen(): Promise<HerdrCompilerArtifact> {
  const worker = createHerdrCompilerWorker()
  try {
    return await new Promise(
      /** 测试样本准备有独立期限，所有路径清理线程。 */ (resolve, reject) => {
        const timer = setTimeout(
          /** 固定测试期限避免失败 Worker 挂住测试。 */ () => reject(new Error('fixture timeout')),
          4000
        )
        worker.onerror = /** 只报告固定诊断，不输出安装 schema。 */ () => {
          clearTimeout(timer)
          reject(new Error('fixture worker failed'))
        }
        worker.onmessage = /** 只接纳真实编译成功的纯数据产物。 */ (event) => {
          clearTimeout(timer)
          const reply = event.data as { result: HerdrCompileResult }
          if (reply.result.ok) {
            resolve(reply.result.value)
          } else {
            reject(new Error(reply.result.reason))
          }
        }
        worker.postMessage({ version: HERDR_COMPILER_VERSION, job_id: randomUUID(), bytes: raw })
      }
    )
  } finally {
    worker.terminate()
  }
}
const artifact = await specimen()

/** 只允许对受控测试代码重新计算摘要，测试 API 不向生产入口传递代码。 */
function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** 断言准确错误文本，同时验证没有泄露注入的伪私有内容。 */
async function rejected(promise: Promise<HerdrSchemas>, reason: string): Promise<void> {
  await assert.rejects(
    promise,
    /** 失败仅暴露固定原因。 */ (error: unknown) => {
      assert(error instanceof Error)
      assert.equal(error.message, `herdr_schema_${reason}`)
      assert(!error.message.includes('synthetic-private'))
      return true
    }
  )
}

test(
  '完整原生根在 Worker 编译，宿主无 Ajv 重编译且品牌不能复制',
  /** 固定官方根覆盖全部方法和两类响应。 */ async () => {
    const keys = ['compile', 'addSchema', 'getSchema'] as const
    const originals = keys.map(/** 保存宿主原始方法，最终精确恢复。 */ (key) => Ajv2020.prototype[key])
    let calls = 0
    for (const key of keys) {
      Ajv2020.prototype[key] = /** 任意宿主 schema 编译立即使本测试失败。 */ (() => {
        calls++
        throw new Error('main compiler forbidden')
      }) as never
    }
    try {
      const schemas = await compileHerdrSchemas(raw)
      assert.equal(calls, 0)
      assert(isCompiledHerdrSchemas(schemas))
      assert(Object.isFrozen(schemas))
      assert(!isCompiledHerdrSchemas({ ...schemas }))
      assert(!isCompiledHerdrSchemas(JSON.parse(JSON.stringify(schemas))))
      assert.equal(schemas.protocol, HERDR_IDENTITY.protocol)
      assert.equal(schemas.schema_sha256, HERDR_IDENTITY.schema_sha256)
      for (const exchange of exchanges) {
        assert.equal(schemas.request(exchange.request), true)
        assert.equal(schemas.response(exchange.response), true)
        assert.equal(typeof schemas.request(exchange.request), 'boolean')
      }
      assert(schemas.response({ id: 'native-error', error: { code: 'synthetic', message: 'synthetic' } }))
      assert(!schemas.request({ method: 'ping', params: {} }))
      assert(!schemas.request({ id: 'test', method: 'future.method', params: {} }))
      assert(!schemas.response({ id: 'test', result: {} }))
      assert(!schemas.response({ id: 'test', error: { code: 'missing-message' } }))
      assert(!schemas.request({ id: 'test', method: 'agent.start', params: { name: 'synthetic' } }))
      const input = { id: 'test', method: 'agent.read', params: { target: 'synthetic', source: 'visible' } }
      const before = structuredClone(input)
      assert(schemas.request(input))
      assert.deepEqual(input, before)
    } finally {
      keys.forEach(
        /** 恢复宿主方法不影响 Worker 原型。 */ (key, i) => {
          Ajv2020.prototype[key] = originals[i] as never
        }
      )
    }
  }
)

test(
  '六种原生数值格式保持精确整数和边界语义',
  /** 整数和浮点格式在完整 request/response 根中实际执行。 */ async () => {
    const compiler = new HerdrSchemaCompiler(createHerdrCompilerWorker)
    try {
      const schemas = await compiler.compile(raw)
      const samples: Array<[string, JsonObject, string, number, number[]]> = [
        [
          'agent.wait',
          { target: 'synthetic' },
          'timeout_ms',
          Number.MAX_SAFE_INTEGER,
          [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]
        ],
        ['pane.read', { pane_id: 'synthetic', source: 'visible' }, 'lines', 4294967295, [-1, 4294967296, 1.5]],
        ['pane.link.activate', { pane_id: 'synthetic', viewport_row: 0 }, 'col', 65535, [-1, 65536, 1.5]],
        ['plugin.log.list', {}, 'limit', Number.MAX_SAFE_INTEGER, [-1, Number.MAX_SAFE_INTEGER + 1, 1.5]],
        ['layout.set_split_ratio', { path: [] }, 'ratio', 0.25, [Infinity, -Infinity, NaN]]
      ]
      for (const [method, params, key, valid, invalid] of samples) {
        assert(schemas.request({ id: 'format', method, params: { ...params, [key]: valid } }), method)
        for (const value of invalid) {
          assert(!schemas.request({ id: 'format', method, params: { ...params, [key]: value } }), `${method}: ${value}`)
        }
      }
      for (const exit_code of [-2147483648, 2147483647, -2147483649, 2147483648, 0.5]) {
        const response = {
          id: 'format',
          result: {
            type: 'plugin_log_list',
            logs: [
              {
                log_id: 'synthetic',
                plugin_id: 'synthetic',
                command: [],
                status: 'succeeded',
                started_unix_ms: 0,
                exit_code
              }
            ]
          }
        }
        assert.equal(
          schemas.response(response),
          Number.isInteger(exit_code) && exit_code >= -2147483648 && exit_code <= 2147483647
        )
      }
    } finally {
      compiler.close()
    }
  }
)

test(
  '非法 JSON、超预算和预先取消不启动 Worker',
  /** 损坏 JSON 与超限输入在创建 Worker 之前拒绝。 */ async () => {
    let starts = 0
    const compiler = new HerdrSchemaCompiler(
      /** 只统计自有端口创建次数。 */ () => {
        starts++
        return new TestPort()
      }
    )
    const changed = new Uint8Array(raw)
    changed[0] = 32
    await rejected(compiler.compile(changed), 'schema_compile_failed')
    await rejected(compiler.compile('synthetic-private'), 'schema_compile_failed')
    await rejected(compiler.compile(new Uint8Array(HERDR_INPUT_LIMIT + 1)), 'schema_input_limit')
    const controller = new AbortController()
    controller.abort()
    await rejected(compiler.compile(raw, controller.signal), 'compiler_cancelled')
    assert.equal(starts, 0)
    compiler.close()
  }
)

test(
  '单在途无队列、输入复制、取消退役且迟到产物无效',
  /** 已退役 Worker 永远不能补建或接纳旧回复。 */ async () => {
    const port = new TestPort()
    let starts = 0
    const compiler = new HerdrSchemaCompiler(
      /** 固定自有端口，检测意外补建。 */ () => {
        starts++
        return port
      }
    )
    const controller = new AbortController()
    const input = new Uint8Array(raw)
    const pending = compiler.compile(input, controller.signal)
    input.fill(0)
    assert.deepEqual(port.job?.bytes, new Uint8Array(raw))
    await rejected(compiler.compile(raw), 'compiler_busy')
    controller.abort()
    await rejected(pending, 'compiler_cancelled')
    port.reply({ ok: true, value: artifact })
    await rejected(compiler.compile(raw), 'compiler_unavailable')
    assert.equal(starts, 1)
    assert.equal(port.terminated, 1)
  }
)

const corruptions: Array<[string, (value: HerdrCompilerArtifact) => void]> = [
  [
    'compiler_artifact_invalid',
    /** 产物不能自选生成器。 */ (a) => {
      a.generator = 'future'
    }
  ],
  [
    'compiler_artifact_invalid',
    /** 版本必须精确匹配。 */ (a) => {
      a.version++
    }
  ],
  [
    'compiler_artifact_invalid',
    /** binary 摘要来自固定安装评审。 */ (a) => {
      Object.assign(a.identity, { binary_sha256: 'b'.repeat(64) })
    }
  ],
  [
    'compiler_artifact_invalid',
    /** schema 摘要不能换包。 */ (a) => {
      Object.assign(a.identity, { schema_sha256: 'b'.repeat(64) })
    }
  ],
  [
    'compiler_artifact_invalid',
    /** 原生版本不能推断兼容。 */ (a) => {
      Object.assign(a.identity, { version: 'future' })
    }
  ],
  [
    'compiler_artifact_invalid',
    /** protocol 必须精确匹配安装源。 */ (a) => {
      Object.assign(a.identity, { protocol: 23 })
    }
  ],
  [
    'compiler_artifact_invalid',
    /** dialect 不能由生成物改选。 */ (a) => {
      Object.assign(a.identity, { dialect: 'future' })
    }
  ],
  [
    'compiler_artifact_invalid',
    /** 根目录不能裁剪为单个方法。 */ (a) => {
      a.roots.pop()
    }
  ],
  [
    'compiler_artifact_invalid',
    /** 生成代码摘要必须精确匹配。 */ (a) => {
      a.code_sha256 = 'b'.repeat(64)
    }
  ],
  [
    'compiler_artifact_invalid',
    /** 编译设置及数值格式不能改写。 */ (a) => {
      a.options_sha256 = 'b'.repeat(64)
    }
  ],
  [
    'compiler_artifact_invalid',
    /** 未知元数据字段拒绝。 */ (a) => {
      Object.assign(a, { future: true })
    }
  ],
  [
    'generated_code_limit',
    /** 生成代码必须在解析前计量。 */ (a) => {
      a.code = ' '.repeat(HERDR_CODE_LIMIT + 1)
    }
  ],
  [
    'compiler_helper_forbidden',
    /** 宿主不给受控代码任意 require。 */ (a) => {
      a.code = 'require("node:fs")'
      a.code_sha256 = hash(a.code)
    }
  ],
  [
    'compiler_artifact_invalid',
    /** 所有三个根必须导出真实函数。 */ (a) => {
      a.code = 'exports.v0 = {}'
      a.code_sha256 = hash(a.code)
    }
  ]
]
for (const [index, [reason, corrupt]] of corruptions.entries()) {
  test(
    `严格产物校验 ${index}: ${reason}`,
    /** 故障产物只通过自有私有端口注入。 */ async () => {
      const port = new TestPort()
      const compiler = new HerdrSchemaCompiler(/** 每种故障独占内部端口。 */ () => port)
      const pending = compiler.compile(raw)
      const changed = structuredClone(artifact)
      corrupt(changed)
      port.reply({ ok: true, value: changed })
      await rejected(pending, reason)
      await rejected(compiler.compile(raw), 'compiler_unavailable')
      assert.equal(port.terminated, 1)
    }
  )
}

test(
  '错任务、错协议和额外字段撤销服务',
  /** 消息不能跨任务或跨版本兼容。 */ async () => {
    for (const extra of [{ version: 2 }, { job_id: randomUUID() }, { future: 'synthetic-private' }]) {
      const port = new TestPort()
      const compiler = new HerdrSchemaCompiler(/** 自有端口手工发送损坏消息。 */ () => port)
      const pending = compiler.compile(raw)
      port.reply({ ok: true, value: artifact }, extra)
      await assert.rejects(pending)
      await rejected(compiler.compile(raw), 'compiler_unavailable')
      assert.equal(port.terminated, 1)
    }
  }
)

test(
  '两秒整体接纳期限后不补建且拒绝迟到回复',
  /** 静默自有端口不提供物理退出证明，只验证期限和退役状态。 */ async () => {
    const port = new TestPort()
    let starts = 0
    const compiler = new HerdrSchemaCompiler(
      /** 确认期限失败后只创建过一次端口。 */ () => {
        starts++
        return port
      }
    )
    const started = performance.now()
    await rejected(compiler.compile(raw), 'compiler_timeout')
    assert(performance.now() - started >= 1900)
    port.reply({ ok: true, value: artifact })
    await rejected(compiler.compile(raw), 'compiler_unavailable')
    assert.equal(starts, 1)
    assert.equal(port.terminated, 1)
  }
)

test(
  '真实 Worker 拒绝未知协议及额外字段',
  /** 原生编译 Worker 不接受路径、代码或兼容选项。 */ async () => {
    const worker = createHerdrCompilerWorker()
    try {
      for (const extra of [{ version: 2 }, { future: true }]) {
        const job = { version: HERDR_COMPILER_VERSION, job_id: randomUUID(), bytes: raw, ...extra }
        const result = await new Promise<HerdrCompileResult>(
          /** 每次任务在独立测试期限内准确关联回复。 */ (resolve, reject) => {
            const timer = setTimeout(
              /** 缺少主动拒绝回复视为测试失败。 */ () => reject(new Error('protocol timeout')),
              2000
            )
            worker.onmessage = /** 核对原任务和固定协议后取回拒绝。 */ (event) => {
              clearTimeout(timer)
              const reply = event.data as { version: number; job_id: string; result: HerdrCompileResult }
              assert.equal(reply.version, HERDR_COMPILER_VERSION)
              assert.equal(reply.job_id, job.job_id)
              resolve(reply.result)
            }
            worker.postMessage(job)
          }
        )
        assert.deepEqual(result, { ok: false, reason: 'compiler_protocol_invalid' })
      }
    } finally {
      worker.terminate()
    }
  }
)

test(
  '宿主代码初始化计入两秒整体期限',
  /** 有限初始化延迟只验证超期接纳拒绝，不声称主线程可以被抢占。 */ async () => {
    const port = new TestPort()
    const compiler = new HerdrSchemaCompiler(/** 仅在此自有端口注入有界延迟。 */ () => port)
    const pending = compiler.compile(raw)
    const changed = structuredClone(artifact)
    changed.code = 'const until = Date.now() + 2100; while (Date.now() < until) {}\n' + changed.code
    changed.code_sha256 = hash(changed.code)
    port.reply({ ok: true, value: changed })
    await rejected(pending, 'compiler_timeout')
    await rejected(compiler.compile(raw), 'compiler_unavailable')
    assert.equal(port.terminated, 1)
  }
)

test(
  '固定 schema 编译故障与未知错误均退役服务',
  /** 只有已知固定原因可暴露，任何失败后都不补建 Worker。 */ async () => {
    for (const [reason, expected] of [
      ['schema_compile_failed', 'schema_compile_failed'],
      ['compiler_timeout', 'compiler_protocol_invalid'],
      ['synthetic-private', 'compiler_protocol_invalid']
    ]) {
      const port = new TestPort()
      const compiler = new HerdrSchemaCompiler(/** 每种错误独占内部测试服务。 */ () => port)
      const pending = compiler.compile(raw)
      port.reply({ ok: false, reason })
      await rejected(pending, expected!)
      await rejected(compiler.compile(raw), 'compiler_unavailable')
      assert.equal(port.terminated, 1)
    }
  }
)

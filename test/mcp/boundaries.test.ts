// 通过内存字节流和受控服务 stub 验证 SDK 协议、编码、请求 ID 与等待资源的拒绝边界。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import {
  parseToolArguments,
  FacadeServiceError,
  startStdioFacade,
  toolDefinition,
  type DiagnosticCode,
  type GatewayService,
  type ServiceContext,
  type ToolName
} from '../../src/mcp/index.js'

// 创建内存 stdio 探针，按公共请求 ID 收集真实 SDK 协议帧。
function rawStdio(service: GatewayService) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const diagnostics: DiagnosticCode[] = []
  const wire: Record<string, unknown>[] = []
  const pending = new Map<string | number, (value: Record<string, unknown>) => void>()
  let buffer = ''
  stdout.on(
    'data',
    /* 按换行拆出输出帧并唤醒对应请求，保留原始帧供边界断言。 */ (chunk) => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n')
        const message = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>
        buffer = buffer.slice(index + 1)
        wire.push(message)
        const id = message.id as string | number
        pending.get(id)?.(message)
        pending.delete(id)
      }
    }
  )
  const running = startStdioFacade({
    service,
    caller: {
      resolve: /* 为隔离探针提供固定 caller，不模拟生产认证后端。 */ () => ({ principal_id: 'isolated-caller' })
    },
    stdin,
    stdout,
    diagnostic: /* 记录受限诊断代码，供检验错误聚合和秘密隔离。 */ (code) => diagnostics.push(code)
  })
  const request = /* 登记一次响应等待后写入 JSON-RPC 请求，避免输出先于监听。 */ (
    id: string | number,
    method: string,
    params?: unknown
  ) => {
    const response = new Promise<Record<string, unknown>>(
      /* 按公共 ID 保存本次响应通知，兼容数字与字符串关联。 */ (resolve) => pending.set(id, resolve)
    )
    stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
    return response
  }
  const initialize = /* 完成真实 SDK 初始化流程，再通知服务可以处理工具请求。 */ async () => {
    await running
    await request(0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'isolated-raw-boundary', version: '1' }
    })
    stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  }
  return { stdin, stdout, running, wire, diagnostics, request, initialize }
}

test(
  'SDK framing 拒绝坏输入，stderr 诊断固定且有界，关闭时不反射超长请求 ID',
  /* 发送坏 JSON 和超长 ID，验证诊断有界且错误不回显载荷。 */ async () => {
    // 仅测试 facade，任何业务执行都视为错误；不接真实服务。
    const harness = rawStdio({
      execute: /* 禁止坏输入测试触发业务服务，暴露错误派发。 */ async () => {
        throw new Error('unused_stub')
      }
    })
    const running = await harness.running
    try {
      harness.stdin.write('{"SYNTHETIC_SECRET_DO_NOT_PRINT":\n')
      harness.stdin.write('{"SYNTHETIC_SECRET_DO_NOT_PRINT":\n')
      harness.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      const beforeInitialize = await harness.request(90, 'tools/list')
      assert.equal((beforeInitialize.error as Record<string, unknown>).code, -32600)
      await harness.initialize()
      await harness.request(1, 'ping')
      assert.deepEqual(harness.diagnostics, ['mcp_transport_error'])
      assert(!JSON.stringify(harness.wire).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      harness.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 'SYNTHETIC_SECRET_DO_NOT_PRINT'.repeat(10), method: 'ping' }) + '\n'
      )
      await running.closed
      assert.equal(harness.wire.length, 3)
      assert.deepEqual(harness.diagnostics, ['mcp_transport_error'])
    } finally {
      await running.close()
    }
  }
)

test(
  '超过 SDK 输入缓冲上限会关闭，不尝试解释或回显载荷',
  /* 发送超过缓冲上限的字节，检查 SDK 会关闭而不解释内容。 */ async () => {
    const harness = rawStdio({
      execute: /* 禁止超限输入到达服务，避免传输拒绝被当成业务成功。 */ async () => {
        throw new Error('unused_stub')
      }
    })
    const running = await harness.running
    harness.stdin.write('x'.repeat(1_048_577))
    await running.closed
    assert.deepEqual(harness.wire, [])
    assert.deepEqual(harness.diagnostics, ['mcp_transport_error'])
    await running.close()
  }
)

test(
  'stdout 关闭和 stdin 错误会结束桥接，重复关闭保持幂等',
  /* 分别关闭输出和破坏输入，检查桥接及重复关闭的清理行为。 */ async () => {
    for (const channel of ['stdout', 'stdin'] as const) {
      const harness = rawStdio({
        execute: /* 禁止管道故障测试执行业务动作，隔离关闭和授权行为。 */ async () => {
          throw new Error('unused_stub')
        }
      })
      const running = await harness.running
      await harness.initialize()
      if (channel === 'stdout') {
        harness.stdout.destroy()
      } else {
        harness.stdin.emit('error', new Error('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      }
      await running.closed
      await running.close()
      await running.close()
      assert(!JSON.stringify(harness.wire).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      assert(
        harness.diagnostics.every(
          /* 只允许固定传输诊断，禁止错误消息混入探针结果。 */ (code) => code === 'mcp_transport_error'
        )
      )
    }
  }
)

test(
  '最多 16 个在途请求；断开只结束等待且不额外发起业务取消',
  /* 阻塞十六个工具请求，再核对额外请求被拒绝且 EOF 终止等待。 */ async () => {
    let release!: () => void
    const gate = new Promise<void>(
      /* 保存 gate 释放通知，供测试在完成断言后清理阻塞请求。 */ (resolve) => {
        release = resolve
      }
    )
    let ready!: () => void
    const started = new Promise<void>(
      /* 保存全部名额占用通知，使容量断言不依赖任意延迟。 */ (resolve) => {
        ready = resolve
      }
    )
    const contexts: ServiceContext[] = []
    const operations: ToolName[] = []
    // 只用于资源/信号测试的阻塞 stub，不代表任何授权或持久化后端。
    const harness = rawStdio({
      execute: /* 记录服务调用与信号并占满名额，不提供真实业务结果。 */ async (name, _args, context) => {
        contexts.push(context)
        operations.push(name)
        if (contexts.length === 16) {
          ready()
        }
        await gate
        throw new Error('released_test_stub')
      }
    })
    const running = await harness.running
    try {
      await harness.initialize()
      for (let index = 1; index <= 16; index++) {
        // 关闭的请求不会有 response；此处直接写入，避免留下待完成的测试 promise。
        harness.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: index,
            method: 'tools/call',
            params: { name: 'machines_list', arguments: {} }
          }) + '\n'
        )
      }
      await started
      const busy = await harness.request(17, 'tools/call', { name: 'machines_list', arguments: {} })
      const result = busy.result as Record<string, unknown>
      assert.deepEqual(result.structuredContent, { gateway_error: { code: 'busy' } })
      assert.equal(result.isError, true)
      harness.stdin.end()
      await running.closed
      assert(contexts.every(/* 核对每个已交付等待信号都随会话关闭而终止。 */ (context) => context.wait_signal.aborted))
      assert(Object.isFrozen(contexts[0]?.caller))
      assert.deepEqual(operations, Array(16).fill('machines_list'))
    } finally {
      release()
      await running.close()
    }
  }
)

test(
  '参数快照拒绝 getter/循环，目录 schema 副本不能改变运行时校验',
  /* 用访问器、循环和可修改 schema 副本验证参数快照边界。 */ () => {
    let reads = 0
    const poisoned = Object.defineProperty({}, 'principal', {
      enumerable: true,
      // 若校验错误触发访问器便增加计数，以暴露意外读取副作用。
      get() {
        reads++
        return 'admin'
      }
    })
    assert.throws(
      /* 提交带 getter 的参数，确认快照会拒绝而不求值。 */ () => parseToolArguments('machines_list', poisoned)
    )
    assert.equal(reads, 0)
    const cyclic: Record<string, unknown> = {}
    cyclic.cursor = cyclic
    assert.throws(/* 提交循环对象，确认 JSON 边界会有界拒绝。 */ () => parseToolArguments('machines_list', cyclic))
    const definition = toolDefinition('machines_list')
    definition.inputSchema.additionalProperties = true
    assert.throws(
      /* 提交身份字段，确认目录 schema 副本修改不能放宽校验。 */ () =>
        parseToolArguments('machines_list', { principal: 'admin' })
    )
    assert.throws(
      /* 同时提交 ID 和名称，确认只读查询选择不能产生歧义。 */ () =>
        parseToolArguments('machines_get', { machine_id: 'machine', name: 'name' })
    )
  }
)

test(
  '合法 falsey ID 能取消等待；同 ID 的后续请求不收到旧等待的晚到回复',
  /* 对 falsey 和普通 ID 验证取消后复用不会收到旧等待的晚到回复。 */ async () => {
    for (const id of [0, '', 1]) {
      let started!: () => void
      const ready = new Promise<void>(
        /* 保存服务开始通知，确保取消发生在等待已经建立之后。 */ (resolve) => {
          started = resolve
        }
      )
      let release!: () => void
      const gate = new Promise<void>(
        /* 保存旧服务 gate，供复用请求完成后故意释放旧结果。 */ (resolve) => {
          release = resolve
        }
      )
      let finished!: () => void
      const done = new Promise<void>(
        /* 保存旧服务结束通知，确保晚到输出断言覆盖其返回时刻。 */ (resolve) => {
          finished = resolve
        }
      )
      const contexts: ServiceContext[] = []
      const harness = rawStdio({
        // 仅测试 SDK 等待关联；没有原生取消或业务写入。
        execute: /* 记录旧等待并故意等到测试放行，检验取消不等于业务取消。 */ async (_name, _args, context) => {
          contexts.push(context)
          started()
          await gate
          finished()
          throw new FacadeServiceError('unavailable')
        }
      })
      const running = await harness.running
      try {
        await harness.initialize()
        harness.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'machines_list' } }) + '\n'
        )
        await ready
        harness.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'SYNTHETIC_SECRET_DO_NOT_PRINT' }
          }) + '\n'
        )
        await new Promise<void>(/* 让取消通知的微任务完成后再检查等待信号。 */ (resolve) => setImmediate(resolve))
        assert.equal(contexts[0]?.wait_signal.aborted, true)
        assert(!String(contexts[0]?.wait_signal.reason).includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
        const ping = await harness.request(id, 'ping')
        assert.equal(ping.id, id)
        assert.deepEqual(ping.result, {})
        release()
        await done
        await new Promise<void>(/* 让旧服务返回链完成后再核对输出中没有晚到帧。 */ (resolve) => setImmediate(resolve))
        assert.equal(harness.wire.length, 2)
        assert.equal(contexts.length, 1)
      } finally {
        release()
        await running.close()
      }
    }
  }
)

test(
  '重复在途 ID 在进入 SDK 前关闭，会终止首个等待并禁止晚到输出',
  /* 重用在途 ID 触发关闭，确认没有第二次执行且首个等待被终止。 */ async () => {
    let started!: () => void
    const ready = new Promise<void>(
      /* 保存首个调用开始通知，避免重复请求早于待测关联建立。 */ (resolve) => {
        started = resolve
      }
    )
    let release!: () => void
    const gate = new Promise<void>(
      /* 保存首个调用 gate，供关闭后模拟晚到服务返回。 */ (resolve) => {
        release = resolve
      }
    )
    let finished!: () => void
    const done = new Promise<void>(
      /* 保存服务结束通知，让晚到输出检查覆盖完整返回链。 */ (resolve) => {
        finished = resolve
      }
    )
    const contexts: ServiceContext[] = []
    const harness = rawStdio({
      execute: /* 只记录首次请求并等待释放，以检验重复 ID 不再进入服务。 */ async (_name, _args, context) => {
        contexts.push(context)
        started()
        await gate
        finished()
        throw new FacadeServiceError('unavailable')
      }
    })
    const running = await harness.running
    try {
      await harness.initialize()
      const request =
        JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'machines_list' } }) + '\n'
      harness.stdin.write(request)
      await ready
      harness.stdin.write(request)
      await running.closed
      assert.equal(contexts.length, 1)
      assert.equal(contexts[0]?.wait_signal.aborted, true)
      release()
      await done
      await new Promise<void>(
        /* 排空服务返回微任务，检查关闭后不会再产生业务输出。 */ (resolve) => setImmediate(resolve)
      )
      assert.equal(harness.wire.length, 1)
      assert.deepEqual(harness.diagnostics, ['mcp_transport_error'])
    } finally {
      release()
      await running.close()
    }
  }
)

test(
  '非法或截断 UTF-8 在 SDK 替换前拒绝，合法跨 chunk 字符保留原值',
  /* 对非法和截断 UTF-8 做零派发断言，并逐字节验证合法 Unicode。 */ async () => {
    for (const incomplete of [false, true]) {
      let calls = 0
      const harness = rawStdio({
        execute: /* 记录任何错误派发次数，使非法编码改写后的执行无法被掩盖。 */ async () => {
          calls++
          throw new Error('unexpected_stub_call')
        }
      })
      const running = await harness.running
      await harness.initialize()
      if (incomplete) {
        harness.stdin.write(Buffer.from([0xe4]))
        harness.stdin.end()
      } else {
        harness.stdin.write(
          Buffer.concat([
            Buffer.from(
              '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"machines_register","arguments":{"name":"before'
            ),
            Buffer.from([0xff]),
            Buffer.from('after"}}}\n')
          ])
        )
      }
      await running.closed
      assert.equal(calls, 0)
      assert.equal(harness.wire.length, 1)
      assert.deepEqual(harness.diagnostics, ['mcp_transport_error'])
      await running.close()
    }
    let observed: unknown
    const harness = rawStdio({
      execute: /* 保留合法 Unicode 参数快照，供比较跨 chunk 解码后的原值。 */ async (_name, args) => {
        observed = args
        throw new FacadeServiceError('unavailable')
      }
    })
    const running = await harness.running
    try {
      await harness.initialize()
      const encoded = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'unicode',
          method: 'tools/call',
          params: { name: 'machines_get', arguments: { name: '前😀后' } }
        }) + '\n'
      )
      // 逐字节输入覆盖每个多字节字符的所有 chunk 边界。
      for (const byte of encoded) {
        harness.stdin.write(Buffer.from([byte]))
      }
      await harness.request(2, 'ping')
      await new Promise<void>(
        /* 等待 SDK 返回链完成，再检查逐字节输入没有额外诊断。 */ (resolve) => setImmediate(resolve)
      )
      assert.deepEqual(observed, { name: '前😀后' })
      assert.deepEqual(harness.diagnostics, [])
    } finally {
      await running.close()
    }
  }
)

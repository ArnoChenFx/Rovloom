// 只用固定离线契约和隔离子进程验证硬预算、精确语义及句柄撤销，不接触原生端点。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compileBundle,
  compileBundleIsolated,
  createNativeValidator,
  releaseCompiledContract,
  checkDispatch,
  checkResultBoundary
} from '../../src/native-contract/index.js'
import { SchemaProcess } from '../../src/native-contract/process-host.js'
import { auth, bytes, clone, identity, json, rejects, source, sourceFor, unwrap, view, request } from './helpers.js'

const assets = fileURLToPath(new URL('../../dist/native-contract/', import.meta.url))
const config = { assets_directory: assets }
const uri = 'https://luvus.dev/protocol/uhp/v1/schema/isolation-test.schema.json'

// 在 bundle 闭包加入测试 schema，并重新绑定真实字节摘要，不伪造原 fixture 身份。
function specimen(schema: unknown) {
  const bundle = json('schema-bundle.json')
  bundle.documents[uri] = { $id: uri, $schema: 'https://json-schema.org/draft/2020-12/schema', ...(schema as object) }
  const input = JSON.stringify(bundle)
  return {
    input,
    options: { identity: { ...identity, schema_sha256: createHash('sha256').update(input).digest('hex') } }
  }
}

// 为超时/内存故障保留父进程可核验的 wait4 计量，始终回收自建资源。
function failedCompilation(schema: unknown) {
  const specimenData = specimen(schema)
  const child = new SchemaProcess(assets)
  try {
    assert.throws(
      /* 恶意 schema 必须拒绝。 */ () =>
        child.request('compile', { bytes: specimenData.input, options: specimenData.options })
    )
  } finally {
    const metrics = child.stop()
    assert(metrics.spawn_peak_rss_bytes > 0)
    assert.equal(metrics.address_space_limit_bytes, 64 * 1024 * 1024)
  }
}

test(
  '隔离工厂编译完整原生闭包，结构结论/错误 data 与同步内核一致',
  /* 比较完整闭包与原内核的精确结构语义。 */ () => {
    const compiled = unwrap(compileBundleIsolated(bytes, { identity }, config))
    try {
      assert.equal(compiled.documents.length, 29)
      const remote = createNativeValidator(compiled)
      const local = createNativeValidator(unwrap(compileBundle(bytes, { identity })))
      for (const response of [
        { id: 'isolated', result: { keep: ['汉字😀', null, false, { __data: 1 }] } },
        { id: 'isolated', error: { code: 'synthetic', message: 'synthetic', data: { nested: [1, 2] } } },
        { id: 'isolated', result: {}, extra: true },
        { id: 'isolated', error: { code: 'invalid' } }
      ]) {
        assert.deepEqual(remote.checkResponseShape(response), local.checkResponseShape(response))
      }
      rejects(releaseCompiledContract(clone(compiled)), 'invalid_contract_handle')
    } finally {
      const metrics = unwrap(releaseCompiledContract(compiled))
      assert(metrics.spawn_peak_rss_bytes > 0)
      assert.equal(metrics.address_space_limit_bytes, 64 * 1024 * 1024)
    }
  }
)

test(
  '释放契约同时撤销旧候选/许可/仅响应上下文，清理本身仍然可用',
  /* 检查释放后全部派生权限失效且仍能清理。 */ () => {
    const compiled = unwrap(compileBundleIsolated(bytes, { identity }, config))
    const native = createNativeValidator(compiled)
    const capabilities = json('session-capabilities.json')
    capabilities.result.session = 'synthetic'
    capabilities.result.server_generation = source().binding.server_generation
    const discovered = unwrap(native.bindCapabilities(capabilities, source()))
    const input = { id: 'release-isolated', method: 'task.add', params: { title: 'synthetic' } }
    const candidate = unwrap(native.checkRequest(discovered, input))
    const authorization = auth(request(view(), input))
    const permit = unwrap(checkDispatch(candidate, authorization))
    const sealed = unwrap(native.sealResponseContext(permit))
    unwrap(releaseCompiledContract(compiled))
    rejects(checkDispatch(candidate, authorization), 'invalid_contract_handle')
    rejects(
      native.checkResponse(permit, { id: input.id, result: {} }, sourceFor(candidate.binding)),
      'invalid_contract_handle'
    )
    rejects(
      native.checkResponseOnly(sealed, { id: input.id, result: {} }, sourceFor(candidate.binding)),
      'invalid_contract_handle'
    )
    rejects(
      checkResultBoundary(permit, {
        principal_id: 'synthetic',
        caller_policy_allowed: true,
        local_policy_allowed: true,
        classification_source_verified: true,
        classification_revision: candidate.binding.classification_revision,
        channel: 'ordinary',
        content_status: 'available'
      }),
      'invalid_contract_handle'
    )
    unwrap(native.releaseRequestContext(permit))
    unwrap(native.releaseResponseContext(sealed))
  }
)

test(
  '隔离编译的缺引用/环/方言与未知关键字失败关闭，不联网补齐或降级',
  /* 逐项验证引用、方言和未知关键字失败关闭。 */ () => {
    for (const schema of [
      { $ref: '#' },
      { $ref: 'https://untrusted.invalid/never-fetch.json' },
      { $ref: 'file:///not-a-real-file.json' },
      { $schema: 'https://unknown.invalid/dialect' },
      { future_unknown_keyword: true }
    ]) {
      const sample = specimen(schema)
      const local = compileBundle(sample.input, sample.options)
      const isolated = compileBundleIsolated(sample.input, sample.options, config)
      rejects(isolated, 'schema_unavailable')
      assert.equal(local.ok, false)
      if (!local.ok && !isolated.ok) {
        assert.equal(isolated.error.reason, local.error.reason)
      }
    }
  }
)

test(
  '恶意编译增长在固定预算内拒绝，宿主继续可用且无可恢复句柄',
  /* 在恶意编译失败后确认健康编译仍可工作。 */ () => {
    failedCompilation({
      oneOf: Array.from(
        { length: 9000 },
        /* 构造真实编译增长而非协议字段错误。 */ (_, minimum) => ({ type: 'integer', minimum })
      )
    })
    const compiled = unwrap(compileBundleIsolated(bytes, { identity }, config))
    unwrap(releaseCompiledContract(compiled))
  }
)

test(
  '正则回溯在独立校验进程强终止；整个旧编译上下文失效而非重启恢复',
  /* 触发真实正则回溯并核对强终止与旧上下文撤销。 */ () => {
    const sample = specimen({ type: 'string', pattern: '(a+)+$' })
    const child = new SchemaProcess(assets)
    try {
      const metadata = child.request('compile', { bytes: sample.input, options: sample.options }) as {
        identity: unknown
        epoch: string
      }
      const start = performance.now()
      assert.throws(
        /* 错误或失效上下文不得给出校验结论。 */ () =>
          child.request('validate', {
            identity: metadata.identity,
            epoch: metadata.epoch,
            schema: uri,
            value: 'a'.repeat(20000) + '!'
          })
      )
      assert(performance.now() - start >= 1500)
      assert(performance.now() - start < 3000)
      assert.equal(child.active(), false)
      assert.throws(
        /* 错误或失效上下文不得给出校验结论。 */ () =>
          child.request('validate', { identity: metadata.identity, epoch: metadata.epoch, schema: uri, value: '' })
      )
    } finally {
      assert.equal(child.stop().address_space_limit_bytes, 64 * 1024 * 1024)
    }
  }
)

test(
  '私有 IPC 拒绝未知操作/代次/契约身份，旧内容不能恢复到新进程',
  /* 检查 IPC 跨进程身份和代次无法重放。 */ () => {
    const first = new SchemaProcess(assets)
    const firstMeta = first.request('compile', { bytes: bytes.toString('utf8'), options: { identity } }) as {
      identity: unknown
      epoch: string
    }
    first.stop()
    const second = new SchemaProcess(assets)
    try {
      const secondMeta = second.request('compile', { bytes: bytes.toString('utf8'), options: { identity } }) as {
        epoch: string
      }
      assert.notEqual(firstMeta.epoch, secondMeta.epoch)
      assert.throws(
        /* 新进程不得接纳旧代次。 */ () =>
          second.request('validate', { identity: firstMeta.identity, epoch: firstMeta.epoch, schema: uri, value: {} })
      )
      assert.equal(second.active(), false)
    } finally {
      second.stop()
    }
  }
)

test(
  '无构建产物或非法 UTF-8/BOM/超大输入不建立隔离契约',
  /* 检查产物缺失、编码错误和输入预算拒绝。 */ () => {
    rejects(
      compileBundleIsolated(bytes, { identity }, { assets_directory: '/tmp/rovloom-no-such-compiler-assets' }),
      'schema_unavailable'
    )
    for (const input of [new Uint8Array([255]), '\uFEFF{}', ' '.repeat(2 * 1024 * 1024 + 1)]) {
      rejects(compileBundleIsolated(input, { identity }, config), 'schema_unavailable')
    }
  }
)

// 检查真实内核状态，避免把 exec 前继承的 Bun RSS 当成受限 VM 的峰值。
test(
  '原生进程在初始化后实际受 64 MiB 地址空间/零 core 限制，只继承专用 IPC',
  /* 核对自建进程的内核限制与文件描述符隔离。 */ () => {
    const temporary = mkdtempSync(join(tmpdir(), 'rovloom-isolation-fd-'))
    const sentinel = openSync(join(temporary, 'synthetic-sentinel'), 'w')
    const child = new SchemaProcess(assets)
    try {
      child.request('compile', { bytes: bytes.toString('utf8'), options: { identity } })
      const root = '/proc/' + child.processId()
      const limits = readFileSync(root + '/limits', 'utf8')
      assert.match(limits, /Max address space\s+67108864\s+67108864\s+bytes/)
      assert.match(limits, /Max core file size\s+0\s+0\s+bytes/)
      const status = readFileSync(root + '/status', 'utf8')
      assert(Number(status.match(/VmPeak:\s+(\d+) kB/)?.[1]) * 1024 <= 64 * 1024 * 1024)
      assert.match(status, /Threads:\s+1\n/)
      assert.deepEqual(readdirSync(root + '/fd').sort(), ['0', '1', '2'])
      assert.equal(readFileSync(root + '/environ', 'utf8'), 'LANG=C.UTF-8\0')
    } finally {
      child.stop()
      closeSync(sentinel)
      rmSync(temporary, { recursive: true, force: true })
    }
  }
)

// 父进程的 JS 清理钩子无法运行时，内核仍须终止自建编译进程。
test(
  '宿主被 SIGKILL 后内核终止编译器，不留下可继续工作的孤儿 VM',
  /* 只杀死本测试创建的 Bun 与原生子进程。 */ async () => {
    const parent = Bun.spawn(
      [process.execPath, '--no-env-file', fileURLToPath(new URL('./isolated-parent.ts', import.meta.url)), assets],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { LANG: 'C.UTF-8' }
      }
    )
    try {
      const reader = parent.stdout.getReader()
      let line = ''
      while (!line.includes('\n') && line.length < 32) {
        const chunk = await reader.read()
        if (chunk.done) {
          assert.fail(
            (await new Response(parent.stderr).text()).slice(0, 8192) || 'isolated parent exited before readiness'
          )
        }
        line += new TextDecoder().decode(chunk.value)
      }
      reader.releaseLock()
      assert.match(line, /^\d+\n$/)
      const pid = Number(line.trim())
      parent.kill('SIGKILL')
      await parent.exited
      let stopped = false
      for (let count = 0; count < 100; count++) {
        try {
          const status = readFileSync('/proc/' + pid + '/status', 'utf8')
          stopped = /^State:\s+Z/m.test(status)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error
          }
          stopped = true
        }
        if (stopped) {
          break
        }
        await Bun.sleep(10)
      }
      assert(stopped, 'PDEATHSIG must stop the original compiler')
    } finally {
      parent.kill('SIGKILL')
      await parent.exited
    }
  }
)

// 未发布的私有协议不兼容推断，也不能靠未知字段补默认值。
test(
  'IPC 明确拒绝未知协议版本、错误序号和额外字段',
  /* 分别创建新进程检验三类协议故障均使上下文失效。 */ () => {
    for (const extra of [{ compiler_protocol: 2 }, { sequence: 9 }, { future_option: true }]) {
      const child = new SchemaProcess(assets)
      try {
        assert.throws(
          /* 已知离线样本不能掩盖私有协议错误。 */ () =>
            child.request('compile', {
              bytes: bytes.toString('utf8'),
              options: { identity },
              ...extra
            })
        )
        assert.equal(child.active(), false)
      } finally {
        child.stop()
      }
    }
  }
)

// 独立宿主会接管本次孤儿；若清理只依赖系统 init，此负例将失败。
test(
  '同一宿主反复正则超时后没有活跃或僵尸后代',
  { timeout: 15000 },
  /* 回收断言在自建子宿主内完成，避免改变主测试进程的回收策略。 */ async () => {
    const child = Bun.spawn(
      [process.execPath, '--no-env-file', fileURLToPath(new URL('./isolated-reap.ts', import.meta.url)), assets],
      {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { LANG: 'C.UTF-8' }
      }
    )
    try {
      const output = await new Response(child.stdout).text()
      const error = await new Response(child.stderr).text()
      assert.equal(await child.exited, 0, error)
      assert.equal(output.trim(), 'reaped')
    } finally {
      child.kill('SIGKILL')
      await child.exited
    }
  }
)

// 资源上限以宿主内存实例为准，既有测试上下文也必须计入，释放后才能重新分配。
test(
  '宿主编译进程数量固定有界，失败与释放不耗尽后续配额',
  /* 不编译或执行原生调用，只检查进程配额及同步回收。 */ () => {
    const children: SchemaProcess[] = []
    try {
      let reason = ''
      for (let count = 0; count < 5; count++) {
        try {
          children.push(new SchemaProcess(assets))
        } catch (error) {
          reason = (error as { failure?: { reason?: string } }).failure?.reason ?? ''
          break
        }
      }
      assert.equal(reason, 'compiler_capacity')
      assert(children.length > 0 && children.length <= 4)
    } finally {
      for (const child of children) {
        child.stop()
      }
    }
    const fresh = new SchemaProcess(assets)
    fresh.stop()
  }
)

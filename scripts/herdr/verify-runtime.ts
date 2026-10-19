/** 显式创建自有空白 Herdr，验收实际安装→Store/Router/Wire→原生 ping；报告和临时库均不入仓。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { ChildProcess } from 'node:child_process'
import { HerdrInstallation } from '../../src/connector/herdr/installation.js'
import { herdrEndpoint, launchHerdrProcess } from '../../src/connector/herdr/local.js'
import type { HerdrLocalConfig } from '../../src/connector/herdr/local.js'
import { fixedHerdrSource, HERDR_READONLY_REVIEW } from '../../src/connector/herdr/review.js'
import { contractRef } from '../../src/wire/index.js'
import { createHerdrRuntimeChain } from '../../test/connector/herdr/runtime-chain.js'
import { until } from '../../test/transport/helpers.js'

/** 停止且回收本次显式启动的唯一子进程，不按名称、PID 文件或 socket 枚举其它实例。 */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const ended = new Promise<void>(
    /** 只等待本 ChildProcess 的关闭，不接管其它设备。 */ (accept) => child.once('close', accept)
  )
  child.kill('SIGTERM')
  const timer = setTimeout(/** 宽限届满后只结束所属子进程。 */ () => child.kill('SIGKILL'), 1000)
  try {
    await ended
  } finally {
    clearTimeout(timer)
  }
}

/** 运行显式隔离验收；产品 runtime 不含该启动/配对 fixture 或安装行为。 */
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { binary: { type: 'string' }, report: { type: 'string' } } })
  if (
    !values.binary ||
    !values.report ||
    !isAbsolute(values.binary) ||
    !isAbsolute(values.report) ||
    existsSync(values.report)
  ) {
    throw new Error('provide_absolute_binary_and_new_report')
  }
  const checkout = resolve(import.meta.dir, '../..')
  if (resolve(values.report).startsWith(checkout + '/')) {
    throw new Error('report_must_be_outside_checkout')
  }
  const root = mkdtempSync('/workspace/herdr-h1-')
  chmodSync(root, 0o700)
  let resourceChain: ReturnType<typeof createHerdrRuntimeChain> | undefined
  const binary = join(root, 'herdr')
  let child: ChildProcess | undefined
  let installation: HerdrInstallation | undefined
  const checks: { name: string; passed: boolean; details?: unknown }[] = []
  let failure: string | undefined
  let diagnostics: unknown
  let observedPong: unknown
  let observedClaims = 0
  try {
    const chain = createHerdrRuntimeChain(root)
    resourceChain = chain
    copyFileSync(values.binary, binary)
    chmodSync(binary, 0o700)
    const digest = createHash('sha256').update(readFileSync(binary)).digest('hex')
    assert.equal(digest, HERDR_READONLY_REVIEW.binary_sha256)
    const config: HerdrLocalConfig = {
      target: chain.target,
      config_ref: chain.config_ref,
      binding_revision: chain.binding_revision,
      binary,
      home: join(root, 'h'),
      config_home: join(root, 'c'),
      state_home: join(root, 's'),
      cache_home: join(root, 'a'),
      temporary_home: join(root, 't'),
      cwd: join(root, 'w')
    }
    for (const directory of [
      config.home,
      config.config_home,
      config.state_home,
      config.cache_home,
      config.temporary_home,
      config.cwd,
      join(config.config_home, 'herdr'),
      join(config.config_home, 'herdr', 'sessions'),
      join(config.config_home, 'herdr', 'sessions', chain.target.session)
    ]) {
      mkdirSync(directory, { mode: 0o700 })
    }
    writeFileSync(
      join(config.config_home, 'herdr', 'config.toml'),
      'onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[session]\nresume_agents_on_restore = false\n',
      { mode: 0o600 }
    )
    const supervised = await launchHerdrProcess(config)
    child = supervised.child
    await until(
      /** 只等待自己显式实例的固定 socket；不执行 session list。 */ () => {
        if (child!.exitCode !== null || child!.signalCode !== null) {
          throw new Error('owned_server_exited')
        }
        try {
          herdrEndpoint(config)
          return true
        } catch {
          return false
        }
      },
      8000
    )
    installation = await HerdrInstallation.open(config, supervised.binding)
    assert.deepEqual(installation.record().wire.source, fixedHerdrSource())
    checks.push({
      name: 'installed_binary_schema_worker_and_kernel_peer',
      passed: true,
      details: {
        binary_sha256: digest,
        schema_sha256: installation.record().schemas.schema_sha256,
        version: installation.record().wire.source.binary_version,
        child_pid: child.pid,
        native_process_image_hash: 'not_measured',
        source_boundary: 'protected_launch_and_same_supervised_child_kernel_peer'
      }
    })
    await chain.connect(installation)
    // 官方 default_capabilities 按进程是否为 detached daemon 返回不同值；当前显式监管启动不脱离宿主。
    const referencePong = {
      type: 'pong',
      version: '0.9.5',
      protocol: 22,
      capabilities: {
        live_handoff: true,
        detached_server_daemon: false,
        endpoint_protocol_generation: 1,
        surface_interest: true,
        health_check: true,
        ssh_agent_registration: true
      }
    }
    for (let index = 0; index < 32; index++) {
      const result = await chain.ping()
      observedPong = result.response.result
      observedClaims = result.claims
      assert.deepEqual(result.response, {
        id: result.binding.native_request_id,
        result: referencePong
      })
      assert.equal(result.claims, index + 1)
    }
    checks.push({
      name: 'shared_router_gateway_connector_wire_store_native_ping',
      passed: true,
      details: {
        calls: 32,
        durable_claims: chain.claimCount(),
        response_evidence_commits: 32,
        authenticated_transport: 'existing_loopback',
        identity: 'synthetic_fixture_only'
      }
    })
    const before = chain.claimCount()
    for (const request of [
      { method: 'ping', params: { extra: true } },
      { method: 'session.snapshot', params: {} },
      { method: 'pane.read', params: {} }
    ]) {
      const grants = chain.f.principal.policy.grants
      const old = structuredClone(grants)
      grants[0]!.methods = [request.method]
      try {
        assert.throws(
          /** 当前方法/参数必须被生产 Store 门禁拒绝，不能创建原生发送 claim。 */ () =>
            chain.f.router.create(chain.f.principal, chain.target, request, {
              binding_revision: 1,
              contract_ref: contractRef(installation!.record().wire.source),
              validation: 'strict',
              timeoutMs: 10_000
            }),
          /provider_support_candidate/
        )
      } finally {
        grants.splice(0, grants.length, ...old)
      }
    }
    assert.equal(chain.claimCount(), before)
    checks.push({
      name: 'production_store_rejects_unreviewed_method_and_params',
      passed: true,
      details: { attempts: 3, new_claims: 0 }
    })
    const call = chain.f.router.create(
      chain.f.principal,
      chain.target,
      { method: 'ping', params: {} },
      {
        binding_revision: 1,
        contract_ref: contractRef(installation.record().wire.source),
        validation: 'strict',
        timeoutMs: 10_000
      }
    )
    chain.f.principal.policy.grants[0]!.actions = ['read']
    assert.throws(
      /** 当前撤权后 Gateway 不得领取派发或本地发送许可。 */ () => chain.f.gateway.dispatch(call.call_id),
      /forbidden/
    )
    assert.equal(chain.claimCount(), before)
    checks.push({ name: 'current_policy_revocation_blocks_dispatch', passed: true })
    const replaced = join(root, 'same-binary')
    copyFileSync(binary, replaced)
    chmodSync(replaced, 0o700)
    const { renameSync } = await import('node:fs')
    renameSync(replaced, binary)
    assert.throws(
      /** 即使相同字节替换 inode，也不能沿用原安装 receipt。 */ () => installation!.assert(),
      /herdr_installation_changed/
    )
    checks.push({ name: 'binary_inode_replacement_revokes_source', passed: true })
    assert.deepEqual(chain.failures, [])
  } catch (error) {
    failure =
      error instanceof Error && 'code' in error
        ? String(error.code)
        : error instanceof Error && /^[a-z_]{1,80}$/.test(error.message)
          ? error.message
          : error instanceof Error
            ? error.name
            : 'unknown'
  } finally {
    diagnostics = resourceChain?.diagnostics()
    try {
      resourceChain?.close()
    } finally {
      installation?.close()
      try {
        if (child) {
          await stop(child)
        }
      } finally {
        rmSync(root, { recursive: true })
      }
    }
  }
  const report = {
    format: 1,
    runtime: 'herdr',
    scope: 'H1 exact ping only',
    checks,
    failures: resourceChain?.failures ?? [],
    diagnostics,
    observed_pong: observedPong,
    observed_claims: observedClaims,
    failure: failure ?? null,
    passed: !failure && checks.length === 5,
    cleanup: {
      owned_child_exited: !child || child.exitCode !== null || child.signalCode !== null,
      private_root_removed: !existsSync(root)
    },
    native_method_scope: ['ping {}'],
    untested_native_methods: 101,
    non_claims: [
      'full_product_cli',
      'cross_platform_native',
      'unsupervised_process_identity',
      'kernel_exec_image_digest',
      'hard_heap_limit',
      'native_cancel',
      'event_replay',
      'private_device_access'
    ]
  }
  mkdirSync(dirname(values.report), { recursive: true, mode: 0o700 })
  writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(
    JSON.stringify({ passed: report.passed, checks: checks.length, cleanup: report.cleanup, failure: report.failure })
  )
  if (!report.passed) {
    process.exitCode = 1
  }
}

await main()

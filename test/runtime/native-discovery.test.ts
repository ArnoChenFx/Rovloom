/** 用合成安装、未知原字节和离线原生契约验证按协议/能力接纳；不启动用户会话或调用模型。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { attachExistingLuvus } from '../../src/runtime/native-attach.js'
import { discoverLuvusInstallation, readLuvusVersion } from '../../src/runtime/native-control.js'
import { initializeManagedLuvusRoot } from '../../src/runtime/native-root.js'
import { observedLuvusContract, MANAGED_LUVUS_REVISION } from '../../src/runtime/native-source.js'
import { compileBundle, createNativeValidator } from '../../src/native-contract/index.js'
import type { LuvusLocalConfig } from '../../src/connector/luvus/types.js'
import { unknownSchemaBundle } from '../native-contract/unknown-schema-fixture.js'

/** 为被测安装生成原字节摘要，与任何内嵌发行版摘要无关。 */
function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 合成私有目录只含无害 CLI 脚本与测试 schema，清理由本测试负责。 */
function fixture() {
  const root = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.native-discovery-')
  )
  for (const name of ['home', 'home/config', 'home/data', 'home/cache', 'home/runtime', 'state', 'cwd', 'control']) {
    mkdirSync(join(root, name), { mode: 0o700 })
  }
  const schema =
    readFileSync(new URL('../fixtures/luvus/0.14.3/linux/schema-bundle.json', import.meta.url), 'utf8') + '\n'
  writeFileSync(join(root, 'schema.json'), schema, { mode: 0o600 })
  const binary = join(root, 'synthetic-luvus')
  const source = `#!/bin/sh
case "$*" in
--version) printf 'luvus synthetic-future-version\\n' ;;
'--session synthetic uhp schema') /bin/cat '${root.replaceAll("'", "'\\''")}/schema.json' ;;
'--session synthetic session list --json') printf '{"sessions":[]}\\n' ;;
*) exit 99 ;;
esac
`
  writeFileSync(binary, source, { mode: 0o500 })
  const config: LuvusLocalConfig = {
    target: {
      machine_id: 'synthetic-machine',
      provider_id: 'synthetic-provider',
      profile: 'session',
      session: 'synthetic'
    },
    binding_revision: 1,
    config_ref: 'synthetic-config',
    binary,
    binary_sha256: hash(source),
    state_root: join(root, 'state'),
    home: join(root, 'home'),
    cwd: join(root, 'cwd'),
    transport: 'ipc',
    allow_terminal_execution: false
  }
  return { root, schema, config }
}

test(
  'Luvus accepts an actual installation hash and retains an unfamiliar version for diagnostics',
  /** 只执行合成版本、schema 和空列表命令；不存在可接管或启动的原生会话。 */ async () => {
    const f = fixture()
    try {
      assert.equal(await readLuvusVersion(f.config, new AbortController().signal), 'synthetic-future-version')
      const root = await initializeManagedLuvusRoot({
        record_path: join(f.root, 'control', 'root.json'),
        config: f.config,
        custody_policy: { scopes: ['read'], methods: ['automation.list'], max_token_ttl_s: 60 }
      })
      assert.equal(root.config.binary_sha256, hash(readFileSync(f.config.binary)))
      assert.equal(root.config.allow_terminal_execution, false)
      root.close()
      // 已越过安装/版本/schema 接纳，按实际空列表报告目标不可用，未启动 native server。
      await assert.rejects(attachExistingLuvus(f.config), { code: 'native_session_unavailable' })
      const declared = { ...f.config, binary_sha256: '0'.repeat(64) }
      const discovered = await discoverLuvusInstallation(declared, {
        revision: MANAGED_LUVUS_REVISION,
        signal: new AbortController().signal
      })
      assert.equal(discovered.config.binary_sha256, f.config.binary_sha256)
      assert.equal(discovered.config.allow_terminal_execution, false)
      const frame = JSON.parse(
        readFileSync(new URL('../fixtures/luvus/0.14.3/linux/session-capabilities.json', import.meta.url), 'utf8')
      )
      frame.result.session = 'synthetic'
      const observed = observedLuvusContract(
        discovered.config,
        discovered.compiled,
        { frame, result: frame.result },
        'synthetic-future-version'
      )
      assert.equal(observed.wire.source.binary_version, 'synthetic-future-version')
      assert.equal(observed.wire.source.server_version, null)
      assert.equal(observed.wire.source.schema_sha256, hash(f.schema))
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

test(
  'Luvus compiles an unknown RPC schema without optional terminal, event or access interfaces',
  /** 未命中资产的合成契约必须真实编译完整根，仍检查请求/响应约束。 */ async () => {
    const bundle = JSON.parse(unknownSchemaBundle())
    bundle.protocol.minor = 9
    for (const name of ['terminal', 'event', 'event_catalog', 'access']) {
      delete bundle[name]
    }
    for (const key of Object.keys(bundle.documents)) {
      if (!key.endsWith('/request.schema.json') && !key.endsWith('/response.schema.json')) {
        delete bundle.documents[key]
      }
    }
    const bytes = JSON.stringify(bundle)
    const result = await compileBundle(bytes, {
      identity: { binary_sha256: 'd'.repeat(64), schema_sha256: hash(bytes), revision: 'synthetic' }
    })
    assert(result.ok, JSON.stringify(result))
    const validator = createNativeValidator(result.value)
    assert(
      validator.checkResponseShape({
        id: 'synthetic',
        error: { code: 'synthetic', message: '😀a', data: { preserved: true } }
      }).ok
    )
    assert(
      !validator.checkResponseShape({
        id: 'synthetic',
        error: { code: 'synthetic', message: 'a', data: { preserved: true } }
      }).ok
    )
  }
)

test(
  'Luvus keeps RPC capabilities usable without terminal metadata and still enforces the general frame limit',
  /** 仅合成协议数据进入真实校验器；省略可选终端接口不解除普通 RPC 限额。 */ async () => {
    const bundle = JSON.parse(unknownSchemaBundle())
    bundle.response.properties = { id: { type: 'string' }, result: { type: 'object' } }
    bundle.response.required = ['id', 'result']
    bundle.documents[bundle.response.$id] = bundle.response
    const bytes = JSON.stringify(bundle)
    const compiled = await compileBundle(bytes, {
      identity: { binary_sha256: 'd'.repeat(64), schema_sha256: hash(bytes), revision: 'synthetic' }
    })
    assert(compiled.ok)
    const validator = createNativeValidator(compiled.value)
    const target = { machine_id: 'synthetic', profile: 'session' as const, session: 'synthetic' }
    const caps = {
      id: 'synthetic',
      result: {
        type: 'uhp_capabilities',
        protocol: { name: 'luvus-uhp', major: 1, minor: 0 },
        session: 'synthetic',
        server_generation: 'synthetic',
        methods: ['synthetic.packaging'],
        method_contracts: [{ method: 'synthetic.packaging', access: 'read', scope: 'workspace', idempotent: true }],
        limits: { frame_bytes: 256 }
      }
    }
    const source = {
      authenticated: true,
      source_verified: true,
      binding: {
        kind: 'luvus' as const,
        provider_id: 'synthetic',
        binding_revision: 1,
        contract_source_ref: 'synthetic',
        target,
        server_generation: 'synthetic',
        connection_epoch: 'synthetic',
        recovery_generation: 'synthetic',
        capability_revision: 'synthetic',
        caller_policy_revision: 'synthetic',
        local_policy_revision: 'synthetic',
        classification_revision: 'synthetic',
        contract: compiled.value.identity
      }
    }
    const view = validator.bindCapabilities(caps, source)
    assert(view.ok, JSON.stringify(view))
    assert(validator.checkRequest(view.value, { id: 'synthetic', method: 'synthetic.packaging', params: {} }).ok)
    assert(
      !validator.checkRequest(view.value, {
        id: 'synthetic',
        method: 'synthetic.packaging',
        params: { text: 'x'.repeat(300) }
      }).ok
    )
    caps.result.limits.frame_bytes = 0
    assert(!validator.checkCapabilitiesShape(caps, { target, server_generation: 'synthetic' }).ok)
  }
)

test(
  'Luvus version-command absence or a slow diagnostic does not block compatible interfaces',
  /** 仅执行本例拥有的无害退出/sleep 进程；父信号取消仍须原样失败。 */ async () => {
    const f = fixture()
    try {
      for (const program of ['#!/bin/sh\nexit 2\n', '#!/bin/sh\nexec /bin/sleep 5\n']) {
        chmodSync(f.config.binary, 0o700)
        writeFileSync(f.config.binary, program)
        chmodSync(f.config.binary, 0o500)
        const config = { ...f.config, binary_sha256: hash(program) }
        assert.equal(await readLuvusVersion(config, new AbortController().signal), 'unavailable')
      }
      const signal = new AbortController()
      signal.abort('cancelled')
      const config = { ...f.config, binary_sha256: hash(readFileSync(f.config.binary)) }
      await assert.rejects(readLuvusVersion(config, signal.signal), { code: 'native_cancelled' })
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  }
)

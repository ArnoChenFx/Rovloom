// 提供 P0 样本、真实内存校验句柄及合成可信上下文工厂，供原生契约离线测试复用。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { compileBundle, createNativeValidator } from '../../src/native-contract/index.js'
import type {
  CapabilityView,
  Check,
  DispatchAuthorization,
  DispatchCandidate,
  NativeBinding,
  CheckedRequest,
  RawRequestCandidate,
  SafetyClassification,
  TrustedNativeContext
} from '../../src/native-contract/index.js'

// fixture 中只有 P0 自建内容；测试工厂的可信标志不代表生产认证实现。
export const fixtureRoot = new URL('../fixtures/luvus/0.14.3/linux/', import.meta.url)
// 读取并解码指定 P0 JSON 样本，为测试提供独立输入。
export const json = (name: string): any => JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8'))
// 通过 JSON 往返复制测试数据，去除原对象引用与内存句柄身份。
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export const bytes = readFileSync(new URL('schema-bundle.json', fixtureRoot))
export const identity = {
  binary_sha256: '895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9',
  schema_sha256: createHash('sha256').update(bytes).digest('hex'),
  revision: 'luvus-0.14.3-review-1'
}
// 断言 Check 成功并提取值，失败时输出结构化诊断。
export function unwrap<T>(result: Check<T>): T {
  assert(result.ok, JSON.stringify(result))
  return result.value
}
// 断言 Check 失败且失败码与预期一致。
export function rejects(result: Check<unknown>, code: string): void {
  assert.equal(result.ok, false, JSON.stringify(result))
  if (!result.ok) {
    assert.equal(result.error.code, code)
  }
}
export const compiled = unwrap(await compileBundle(bytes, { identity }))
export const validator = createNativeValidator(compiled)
export const G = '0'.repeat(32)
export const T = '1'.repeat(32)
// 构造指定 profile 和代次的测试可信来源，供离线校验场景使用。
export function source(profile: 'session' | 'host' = 'session', generation = G): TrustedNativeContext {
  return {
    authenticated: true,
    source_verified: true,
    binding: {
      kind: 'luvus',
      provider_id: 'p1',
      binding_revision: 1,
      contract_source_ref: 'test-reviewed-luvus-source',
      target:
        profile === 'session' ? { machine_id: 'm1', profile, session: 'synthetic' } : { machine_id: 'm1', profile },
      server_generation: profile === 'session' ? generation : null,
      connection_epoch: 'e1',
      recovery_generation: 'recovery1',
      capability_revision: 'caps1',
      caller_policy_revision: 'caller1',
      local_policy_revision: 'local1',
      classification_revision: 'review1',
      contract: clone(identity)
    }
  }
}
// 按指定 profile 和代次调整能力样本，并建立真实能力视图句柄。
export function view(profile: 'session' | 'host' = 'session', generation = G): CapabilityView {
  const response = json(profile === 'session' ? 'session-capabilities.json' : 'host-capabilities.json')
  if (profile === 'session') {
    response.result.server_generation = generation
    response.result.session = 'synthetic'
  }
  return unwrap(validator.bindCapabilities(response, source(profile, generation)))
}
// 根据候选的方法描述构造测试评审分类，补齐管理、确认和秘密结果要求。
export function reviewed(candidate: DispatchCandidate): SafetyClassification {
  const descriptor = unwrap(validator.describe(candidateView(candidate), candidate.method))
  const admin = descriptor.native_contract.scope === 'admin'
  const credential = candidate.method.startsWith('uhp.token.')
  return {
    method: candidate.method,
    revision: candidate.binding.classification_revision,
    contract: clone(candidate.binding.contract),
    native: clone(descriptor.native_contract),
    transport:
      descriptor.transport === 'unclassified'
        ? candidate.binding.target.profile === 'host'
          ? 'host_stdio_proxy'
          : 'single_request_rpc'
        : descriptor.transport,
    effect: descriptor.native_contract.access === 'read' ? 'read' : 'execute',
    requires_owner: false,
    management_permission: admin ? 'admin-test' : null,
    confirmation_required: [
      'host.update.install',
      'integration.install',
      'integration.uninstall',
      'skill.enable',
      'skill.disable'
    ].includes(candidate.method),
    result: {
      boundary: credential ? 'protected_secret' : 'ordinary',
      sensitivity: credential ? 'credential' : 'potentially_sensitive',
      read_authorization: 'required',
      retention: credential ? 'none' : 'caller_policy',
      delivery: credential ? 'custody' : 'ordinary'
    }
  }
}
// 只在测试工厂登记，不向生产 handle 注入可伪造字段。
const candidateViews = new WeakMap<object, CapabilityView>()
// 在测试专用映射中登记候选来源视图，并原样返回候选。
export function register<T extends DispatchCandidate>(candidate: T, from: CapabilityView): T {
  candidateViews.set(candidate, from)
  return candidate
}
// 读取候选在测试工厂登记的来源视图，缺失时触发断言。
export function candidateView(candidate: DispatchCandidate): CapabilityView {
  const value = candidateViews.get(candidate)
  assert(value)
  return value
}
// 构造仅覆盖当前目标与方法的双方策略和默认严格授权上下文。
export function auth(candidate: DispatchCandidate): DispatchAuthorization {
  const policy = {
    machines: [candidate.binding.target.machine_id],
    sessions: candidate.binding.target.profile === 'session' ? [candidate.binding.target.session] : [],
    methods: [candidate.method],
    host: candidate.binding.target.profile === 'host'
  }
  return {
    source: { authenticated: true, source_verified: true, binding: candidate.binding },
    principal_id: 'synthetic',
    classification_source_verified: true,
    classifications: [reviewed(candidate)],
    caller_policy: clone(policy),
    local_policy: clone(policy),
    permissions: [],
    owner: false,
    confirmation_verified: false,
    custody_available: false,
    result_channel: 'ordinary',
    mode: 'strict',
    raw_requested: false,
    now: 100,
    supported_transports: ['single_request_rpc', 'host_stdio_proxy', 'persistent_local_stream']
  }
}
// 在默认上下文上开启 Owner 显式 raw 模式，并授予当前候选范围的限时 grant。
export function raw(candidate: DispatchCandidate): DispatchAuthorization {
  return {
    ...auth(candidate),
    owner: true,
    mode: 'raw_contract',
    raw_requested: true,
    raw_grant: {
      id: 'raw-test',
      source_verified: true,
      principal_id: 'synthetic',
      binding: clone(candidate.binding),
      methods: [candidate.method],
      expires_at: 200
    }
  }
}
export function request(from: CapabilityView, value: unknown): CheckedRequest
export function request(from: CapabilityView, value: unknown, rawCandidate: true): CheckedRequest | RawRequestCandidate
// 按所选普通或 raw 路径校验请求，并登记候选与来源视图的测试关联。
export function request(
  from: CapabilityView,
  value: unknown,
  rawCandidate = false
): CheckedRequest | RawRequestCandidate {
  return register(
    unwrap(rawCandidate ? validator.checkRawRequest(from, value) : validator.checkRequest(from, value)),
    from
  )
}
// 将现有绑定包装为测试可信来源，保留完整绑定身份。
export function sourceFor(binding: NativeBinding): TrustedNativeContext {
  return { authenticated: true, source_verified: true, binding }
}

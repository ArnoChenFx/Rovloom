/** 固定 Herdr 首个产品切片的版本、完整原生来源与逐方法评审；不授予身份或策略。 */
import type { ContractSource } from '../../wire/types.js'

/** 固定版本的精确评审，不能替代 registry、安装、peer 或当前本地授权。 */
export const HERDR_READONLY_REVIEW = Object.freeze({
  version: '0.9.5',
  protocol: 22,
  binary_sha256: '14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d',
  schema_sha256: '9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b',
  adapter_revision: 'herdr-ping-2',
  classification_revision: 'herdr-0.9.5-ping-2',
  methods: Object.freeze(['ping']),
  protocol_methods: Object.freeze(['ping', 'session.snapshot']),
  frame_bytes: 65_536,
  guarantees: Object.freeze({
    event_recovery: 'unavailable',
    terminal_fence: 'unavailable',
    cancel: 'unavailable',
    prompt_completion: 'unavailable'
  })
})

/** 只有与这个完整来源完全相同的安装契约才属于当前 ping 产品切片。 */
export function fixedHerdrSource(): ContractSource {
  const review = HERDR_READONLY_REVIEW
  return {
    provider_kind: 'herdr',
    protocol_family: 'herdr-json',
    binary_version: review.version,
    binary_sha256: review.binary_sha256,
    schema_sha256: review.schema_sha256,
    schema_origin: 'installed_cli',
    schema_command: 'herdr api schema --json',
    server_version: review.version,
    native_protocol_version: String(review.protocol),
    runtime_generation: null,
    adapter_revision: review.adapter_revision,
    classification_revision: review.classification_revision,
    support_basis: 'schema_and_version'
  }
}

/** 对已严格解析的固定来源逐字段比较，研究字符串不能补造 endpoint 或 peer 身份。 */
export function isReviewedHerdrSource(source: ContractSource): boolean {
  const fixed = fixedHerdrSource()
  const keys = Object.keys(fixed) as (keyof ContractSource)[]
  return (
    Object.keys(source).length === keys.length &&
    keys.every(/** 所有来源字段必须与当前评审完全一致。 */ (key) => source[key] === fixed[key])
  )
}

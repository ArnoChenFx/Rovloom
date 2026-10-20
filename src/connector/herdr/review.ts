/** Herdr 已接入操作、历史 fixture 来源与逐方法分类；不授予身份或策略。 */
import type { ContractSource } from '../../wire/types.js'
import { HERDR_WORKFLOW_METHODS } from './methods.js'

/** 已接入操作及历史证据常量，不能替代实际 registry、安装、peer 或当前本地授权。 */
export const HERDR_READONLY_REVIEW = Object.freeze({
  version: '0.9.5',
  protocol: 22,
  binary_sha256: '14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d',
  schema_sha256: '9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b',
  adapter_revision: 'herdr-workflow-4',
  classification_revision: 'herdr-0.9.5-workflow-4',
  methods: HERDR_WORKFLOW_METHODS,
  protocol_methods: HERDR_WORKFLOW_METHODS,
  frame_bytes: 65_536,
  guarantees: Object.freeze({
    event_recovery: 'unavailable',
    terminal_fence: 'unavailable',
    cancel: 'unavailable',
    prompt_completion: 'unavailable'
  })
})

/** 返回历史离线 fixture 的完整来源，生产安装使用本轮实际观测。 */
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

/** 核对已接入的协议族与分类来源；实际 schema/协议由编译器复核，研究字符串不授予实例身份。 */
export function isReviewedHerdrSource(source: ContractSource): boolean {
  return (
    source.provider_kind === 'herdr' &&
    source.protocol_family === 'herdr-json' &&
    source.schema_origin === 'installed_cli' &&
    source.schema_command === 'herdr api schema --json' &&
    source.adapter_revision === HERDR_READONLY_REVIEW.adapter_revision &&
    source.classification_revision === HERDR_READONLY_REVIEW.classification_revision &&
    source.runtime_generation === null &&
    source.support_basis === 'schema_and_version' &&
    /^\d+$/u.test(source.native_protocol_version ?? '')
  )
}

/** 从本轮实际安装与编译 schema 记录诊断信息；历史固定 fixture 不再决定安装接纳。 */
export function observedHerdrSource(
  version: string,
  binarySha256: string,
  schemaSha256: string,
  protocol: number
): ContractSource {
  return {
    ...fixedHerdrSource(),
    binary_version: version,
    server_version: version,
    binary_sha256: binarySha256,
    schema_sha256: schemaSha256,
    native_protocol_version: String(protocol)
  }
}

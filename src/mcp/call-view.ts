// 两种MCP服务共用同一调用元数据投影；原文及结果句柄必须另经当前内容门禁。
import type { Call } from '../store.js'
import type { CallView } from './types.js'

// 只投影同一次已授权读取的公开字段，不混合前后两个账本状态。
export function publicCallView(call: Call): CallView {
  return {
    call_id: call.call_id,
    target: JSON.parse(call.target_json),
    provider_kind: call.provider_kind,
    binding_revision: call.binding_revision,
    contract_ref: null,
    state: call.state,
    delivery:
      call.state === 'created' || call.state === 'not_dispatched'
        ? 'not_dispatched'
        : call.state === 'responded'
          ? 'responded'
          : 'possibly_dispatched',
    content_status: call.content_status,
    content_delivery: 'unavailable',
    content_expires_at: call.content_expires
  }
}

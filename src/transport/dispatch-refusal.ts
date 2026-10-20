// 仅信任当前 provider 的真实本机异常类型及确定未写出语义；普通 Error 和原生回包不能生成拒绝。
import { HerdrLocalError } from '../connector/herdr/local.js'
import { LuvusAdapterError } from '../connector/luvus/types.js'
import type { AttemptBinding, DispatchRefusalCode, ProviderKind } from '../wire/types.js'

export interface DispatchRefusalLedger {
  /** 在原 Store writer 事务核验完整锚点并提交确定拒绝，已 unknown/终态不得倒退。 */
  commitDispatchRefusal(binding: AttemptBinding, code: DispatchRefusalCode): void
}

/** 固定白名单只覆盖终端最终门禁；未知、可能已写出或其它 provider 的异常仍走保守失败路径。 */
export function dispatchRefusal(error: unknown, kind: ProviderKind): DispatchRefusalCode | undefined {
  if (
    ((kind === 'herdr' && error instanceof HerdrLocalError) ||
      (kind === 'luvus' && error instanceof LuvusAdapterError)) &&
    error.outcome === 'not_dispatched' &&
    error.code === 'terminal_execution_disabled'
  ) {
    return error.code
  }
  return undefined
}

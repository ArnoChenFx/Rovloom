// Luvus 登记前复用既有请求结构校验，不建立调用、来源、候选或执行许可。
import { GatewayError } from '../contracts.js'
import { createNativeValidator } from '../native-contract/index.js'
import type { CompiledContract } from '../native-contract/index.js'

export class NativeRequestPreflightError extends GatewayError {
  readonly outcome = 'not_dispatched' as const

  /** 仅由登记前 schema 拒绝产生固定错误，不携带参数、路径或原生输出。 */
  constructor() {
    super('native_request_invalid')
  }
}

/** Store 首次登记事务传入其分配的真实原生 ID，失败回滚原登记，不触及 transport。 */
export function createLuvusRequestPreflight(contract: CompiledContract): (request: unknown) => void {
  const validator = createNativeValidator(contract)
  return /** 结构检查不替代后续原 Wire、在线能力、raw 授权、分类及紧贴 IO 的最终复验。 */ (request) => {
    const checked = validator.checkRequestShape(request)
    if (!checked.ok) {
      if (checked.error.code === 'native_request_invalid') {
        throw new NativeRequestPreflightError()
      }
      throw new GatewayError(checked.error.code)
    }
  }
}

// 严格比较有界 SemVer；忽略构建元数据，稳定发行优于同核心版本的预发行。
import { UpdateError } from './contract.js'

const pattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

// 限制版本串长度并验证所有数字标识符，避免宽松解析接受路径或非法 SemVer。
function parse(version: string): RegExpExecArray {
  const result = version.length <= 128 ? pattern.exec(version) : null
  if (!result) {
    throw new UpdateError('invalid_current_version')
  }
  return result
}

// 检查 Release 版本不含预发行字段；构建元数据不影响稳定性。
export function stableVersion(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  try {
    return parse(value)[4] === undefined
  } catch {
    return false
  }
}

// 按 SemVer 比较核心、稳定性及预发行标识符，不使用浮点版本运算。
export function compareVersions(left: string, right: string): number {
  const a = parse(left)
  const b = parse(right)
  for (let i = 1; i <= 3; i++) {
    const x = BigInt(a[i]!)
    const y = BigInt(b[i]!)
    if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  if (a[4] === b[4]) {
    return 0
  }
  if (a[4] === undefined || b[4] === undefined) {
    return a[4] === undefined ? 1 : -1
  }
  const x = a[4].split('.')
  const y = b[4].split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i]
    const q = y[i]
    if (p === q) {
      continue
    }
    if (p === undefined || q === undefined) {
      return p === undefined ? -1 : 1
    }
    const numericP = /^\d+$/u.test(p)
    const numericQ = /^\d+$/u.test(q)
    if (numericP && numericQ) {
      return BigInt(p) > BigInt(q) ? 1 : -1
    }
    if (numericP !== numericQ) {
      return numericP ? -1 : 1
    }
    return p > q ? 1 : -1
  }
  return 0
}

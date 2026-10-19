// 复用发布端的单一规范版本语法，仅补充默认更新需要的稳定性和先后比较。
import { parseReleaseVersion, type ReleaseVersion } from '../release/contract.js'
import { UpdateError } from './contract.js'

// 把共享版本拒绝投影为更新命令的固定公共错误。
function parse(version: string): ReleaseVersion {
  try {
    return parseReleaseVersion(version)
  } catch {
    throw new UpdateError('invalid_current_version')
  }
}

// 更新默认只接纳无预发行字段的规范版本；发布端可用同一语法支持预发行。
export function stableVersion(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  try {
    return parseReleaseVersion(value).prerelease.length === 0
  } catch {
    return false
  }
}

// 按规范 SemVer 比较安全整数核心与预发行标识符；不接受 +build 别名。
export function compareVersions(left: string, right: string): number {
  const a = parse(left)
  const b = parse(right)
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) {
      return a.core[i]! > b.core[i]! ? 1 : -1
    }
  }
  const x = a.prerelease
  const y = b.prerelease
  if (x.length === 0 || y.length === 0) {
    return x.length === y.length ? 0 : x.length === 0 ? 1 : -1
  }
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
      return Number(p) > Number(q) ? 1 : -1
    }
    if (numericP !== numericQ) {
      return numericP ? -1 : 1
    }
    return p > q ? 1 : -1
  }
  return 0
}

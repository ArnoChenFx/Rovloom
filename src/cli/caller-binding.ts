// 将当前POSIX身份映射到受保护文件中的已有principal；只做本机绑定，不创建身份、策略或管理员会话。
import { userInfo } from 'node:os'
import type { LocalOsIdentity, StdioCallerProvider } from '../mcp/types.js'
import { CliError, readProtectedJson } from './config.js'

export type LocalCallerBinding = Readonly<{
  ref: string
  uid: number
  gid: number
  principal_id: string
}>
export type LocalCallerBindings = Readonly<{
  schema_version: 1
  bindings: readonly LocalCallerBinding[]
}>

const identifier = /^[a-zA-Z0-9_-]{1,128}$/

// 校验实际POSIX数字ID，不接受字符串、通配组或浮点值。
function posixId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 0xffffffff
}

// 检查整个绑定文件的精确结构与歧义；任一非法记录都使本次身份解析失败关闭。
function bindings(value: unknown): LocalCallerBindings {
  const file = value as Record<string, unknown> | null
  if (
    !file ||
    typeof file !== 'object' ||
    Array.isArray(file) ||
    file.schema_version !== 1 ||
    Object.keys(file).length !== 2 ||
    !Array.isArray(file.bindings) ||
    file.bindings.length > 256
  ) {
    throw new CliError('invalid_config')
  }
  const seen = new Set<string>()
  for (const entry of file.bindings) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 4 ||
      Object.keys(entry).some(
        /* 绑定不能附带权限、管理员声明、秘密或可执行路径。 */ (key) =>
          !['ref', 'uid', 'gid', 'principal_id'].includes(key)
      ) ||
      typeof entry.ref !== 'string' ||
      !identifier.test(entry.ref) ||
      typeof entry.principal_id !== 'string' ||
      !identifier.test(entry.principal_id) ||
      !posixId(entry.uid) ||
      !posixId(entry.gid)
    ) {
      throw new CliError('invalid_config')
    }
    const key = `${entry.ref}:${entry.uid}:${entry.gid}`
    if (seen.has(key)) {
      throw new CliError('invalid_config')
    }
    seen.add(key)
  }
  return file as LocalCallerBindings
}

// 只允许受信宿主指定文件及非秘密引用；每次请求重读保护与绑定，不缓存已经撤销的身份。
export function createLocalCallerProvider(path: string, bindingRef: string): StdioCallerProvider {
  if (typeof bindingRef !== 'string' || !identifier.test(bindingRef)) {
    throw new CliError('invalid_config')
  }
  return {
    resolve: /* 对照当前真实OS身份和私有绑定文件；缺失、失效或保护不合格一律返回未认证。 */ (
      identity: LocalOsIdentity
    ) => {
      try {
        const os = userInfo()
        if (
          process.platform === 'win32' ||
          !posixId(identity.uid) ||
          !posixId(identity.gid) ||
          identity.uid !== os.uid ||
          identity.gid !== os.gid
        ) {
          return null
        }
        const file = bindings(readProtectedJson(path))
        const selected = file.bindings.find(
          /* 只有同一条完整ref/uid/gid记录可选中principal，不跨记录拼接身份。 */ (entry) =>
            entry.ref === bindingRef && entry.uid === identity.uid && entry.gid === identity.gid
        )
        return selected ? Object.freeze({ principal_id: selected.principal_id }) : null
      } catch {
        return null
      }
    }
  }
}

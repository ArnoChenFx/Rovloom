// 校验并持久读写 Linux 受限凭据文件，提供固定身份的一次性专用文件交付。
import { constants, closeSync, fstatSync, openSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createPrivate, privateFile, privatePath, syncParentDirectory } from '../storage/files.js'
import { fields, object, id, fail, boundedJson } from '../wire/index.js'
import type { DeviceCredential } from './identity.js'
import type { CredentialDeliveryContext, CredentialDeliveryAck } from './custody.js'

/** 严格校验凭据文件字段、稳定身份和 secret 编码，拒绝额外字段及无界输入。 */
function validate(value: unknown): DeviceCredential {
  const v = object(value)
  fields(v, ['machine_id', 'recovery_generation', 'credential'])
  id(v.machine_id)
  id(v.recovery_generation)
  if (typeof v.credential !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(v.credential)) {
    fail('invalid_device_credential')
  }
  return v as DeviceCredential
}
/** 在受限 Linux 路径独占创建或原子替换凭据，并同步文件和父目录；不会自动放宽现有权限。 */
export function saveCredential(path: string, input: DeviceCredential, replace = false): void {
  privatePath(path)
  const raw = boundedJson(validate(input), 4096)
  if (!replace) {
    createPrivate(path, raw)
    syncParentDirectory(path, true)
    return
  }
  privateFile(path)
  const temporary = path + '.' + randomUUID()
  try {
    createPrivate(temporary, raw)
    renameSync(temporary, path)
    syncParentDirectory(path, true)
  } finally {
    try {
      unlinkSync(temporary)
    } catch {
      /* 原子替换成功时临时名字已消失。 */
    }
  }
}

/** 创建绑定固定路径与预期身份的一次性交付 sink，路径不由业务请求选择。 */
export function createFileCredentialSink(
  path: string,
  expected: { machine_id: string; recovery_generation: string },
  replace = false
) {
  privatePath(path)
  id(expected.machine_id)
  id(expected.recovery_generation)
  let closed = false
  let used = false
  return {
    /** 核对身份、恢复代次和中止状态，持久写入完成后才返回准确的交付确认。 */
    async deliver(
      input: DeviceCredential,
      signal: AbortSignal,
      context: CredentialDeliveryContext
    ): Promise<CredentialDeliveryAck> {
      if (closed || used || signal.aborted) {
        fail('credential_sink_closed')
      }
      if (input.machine_id !== expected.machine_id || input.recovery_generation !== expected.recovery_generation) {
        fail('credential_sink_mismatch')
      }
      used = true
      saveCredential(path, input, replace)
      return { ...context, machine_id: input.machine_id, recovery_generation: input.recovery_generation }
    },
    /** 关闭一次性 sink，使后续交付在接触文件前被拒绝。 */
    close() {
      closed = true
    }
  }
}
/** 以 no-follow 方式读取受限单链接文件，重新核对权限、大小和内容后返回启动凭据。 */
export function loadCredential(path: string): DeviceCredential {
  privatePath(path)
  privateFile(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      // Windows 没有 POSIX mode/uid，访问由用户主目录的 ACL 约束。
      (process.platform !== 'win32' && ((st.mode & 0o777) !== 0o600 || st.uid !== process.getuid?.())) ||
      st.size > 4096
    ) {
      fail('unsafe_storage_file')
    }
    try {
      return validate(JSON.parse(readFileSync(fd, 'utf8')))
    } catch {
      fail('invalid_device_credential')
    }
  } finally {
    closeSync(fd)
  }
}

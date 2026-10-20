// service复用Gateway的同fd Darwin ACL检查；只核验对象身份与权限，不创建目录或改写ACL。
import { constants, openSync, closeSync, lstatSync, fstatSync } from 'node:fs'
import { macosPermissionPaths } from './security.js'
import { assertMacosDescriptorAcl } from '../storage/macos-acl.js'
import { ServiceError } from './types.js'

// 逐个打开叶节点及祖先，ACL核验前后都核对同一对象；privatePaths只限制明确的配置/状态叶节点。
export async function verifyMacosServicePaths(
  paths: readonly string[],
  privatePaths: readonly string[] = []
): Promise<void> {
  for (const path of macosPermissionPaths(paths)) {
    const before = lstatSync(path, { bigint: true })
    if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
      throw new ServiceError('unsafe_installation')
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const actual = fstatSync(fd, { bigint: true })
      if (actual.dev !== before.dev || actual.ino !== before.ino) {
        throw new ServiceError('unsafe_installation')
      }
      assertMacosDescriptorAcl(fd, privatePaths.includes(path))
      const after = lstatSync(path, { bigint: true })
      if (after.isSymbolicLink() || after.dev !== actual.dev || after.ino !== actual.ino) {
        throw new ServiceError('unsafe_installation')
      }
    } catch {
      throw new ServiceError('unsafe_installation')
    } finally {
      closeSync(fd)
    }
  }
}

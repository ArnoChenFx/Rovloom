// Gateway Windows 私有数据只接受本地规范 DOS 路径；纯解析不读取磁盘或赋予执行权限。
import { win32 } from 'node:path'
import { GatewayError } from '../contracts.js'

// 拒绝 ADS、UNC/设备命名空间、路径折叠及保留文件名，保留卷根供祖先句柄验证。
export function windowsStoragePath(value: string): string {
  const root = typeof value === 'string' ? win32.parse(value).root : ''
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^[A-Za-z]:\\/u.test(value) ||
    win32.normalize(value) !== value ||
    value.slice(3).includes(':') ||
    /[<>"|?*]/u.test(value) ||
    (value !== root && value.endsWith('\\')) ||
    Array.from(value).some(
      /* 控制字符不能在 Win32 UTF16 参数中隐藏路径边界。 */ (char) =>
        char.codePointAt(0)! < 32 || char.codePointAt(0) === 127
    ) ||
    value
      .slice(3)
      .split('\\')
      .some(
        /* 拒绝 Windows 会忽略的尾点/空格与 DOS 设备别名，包括上标数字形式。 */ (part) =>
          part.length > 255 ||
          /[. ]$/u.test(part) ||
          /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$|CLOCK\$)(?:\.|$)/iu.test(part)
      )
  ) {
    throw new GatewayError('invalid_storage_path')
  }
  return value
}

// 从卷根到指定目录逐级给出同卷规范组件；调用者必须对每级实际打开的句柄作身份/ACL 检查。
export function windowsStorageAncestors(directory: string): readonly string[] {
  windowsStoragePath(directory)
  const root = win32.parse(directory).root
  const chain = [directory]
  while (chain[0] !== root) {
    chain.unshift(win32.dirname(chain[0]!))
  }
  return Object.freeze(chain)
}

// 普通只读查询LocalService的系统profile路径，供服务配置复用唯一角色路径规则。
import { execFileSync } from 'node:child_process'
import { win32 } from 'node:path'
import { ServiceError } from './types.js'

// 账户固定为LocalService；注册表值只作为路径数据，不执行表达式、不创建profile或登录token。
const PROFILE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$base = $null
$key = $null
try {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
  $key = $base.OpenSubKey('SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-19', $false)
  if ($null -eq $key) { exit 1 }
  $kind = $key.GetValueKind('ProfileImagePath')
  $path = $key.GetValue('ProfileImagePath', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($path -isnot [string] -or $kind -notin @([Microsoft.Win32.RegistryValueKind]::String, [Microsoft.Win32.RegistryValueKind]::ExpandString)) { exit 1 }
  if ($kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString -and $path.StartsWith('%SystemRoot%\\', [StringComparison]::OrdinalIgnoreCase)) {
    $path = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows) + $path.Substring(12)
  }
  [Console]::Write($path)
} catch { exit 1 }
finally {
  if ($null -ne $key) { $key.Dispose() }
  if ($null -ne $base) { $base.Dispose() }
}
`

// 使用系统PowerShell的固定CLR调用，不依赖cmdlet自动加载、调用者HOME或环境变量展开。
function readLocalServiceHome(): string {
  return execFileSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      Buffer.from(PROFILE_SCRIPT, 'utf16le').toString('base64')
    ],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

// 只接受系统账户的单个规范绝对home；失败要求显式配置，不回退安装管理员的用户目录。
export function windowsServiceHome(read: () => string = readLocalServiceHome): string {
  let home: string
  try {
    home = read().replace(/^\uFEFF/u, '')
  } catch {
    throw new ServiceError('config_path_required')
  }
  if (
    !/^[A-Za-z]:\\/u.test(home) ||
    home.length > 4096 ||
    win32.normalize(home) !== home ||
    win32.parse(home).root === home ||
    home.includes('%') ||
    home.slice(3).includes(':') ||
    Array.from(home).some(
      /* 控制字符不能拼入角色配置文件名。 */ (value) => value.charCodeAt(0) < 32 || value.charCodeAt(0) === 127
    )
  ) {
    throw new ServiceError('config_path_required')
  }
  return home
}

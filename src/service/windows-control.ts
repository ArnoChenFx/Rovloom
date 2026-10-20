// 只读核验Windows控制目录与全部祖先；不创建目录、不设置ACL，也不代替目标服务账户的资源验证。
import { win32 } from 'node:path'
import { checkedCommand, type CommandRunner } from './runner.js'
import { ServiceError } from './types.js'

// 只接受普通allow/deny ACE；祖先只证明不可替换，叶目录还须防止向普通账户泄露或继承控制文件权限。
export const WINDOWS_CONTROL_ACL = `
function Test-ControlAcl([Security.AccessControl.RawSecurityDescriptor]$sd,[bool]$leaf) {
  $trusted=@('S-1-5-18','S-1-5-32-544')
  if (!$leaf) { $trusted+= 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464' }
  if ($null -eq $sd.Owner -or $sd.Owner.Value -notin $trusted -or $null -eq $sd.DiscretionaryAcl -or $sd.DiscretionaryAcl.Count -gt 1024) { return $false }
  foreach ($ace in $sd.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -notin @([Security.AccessControl.AceQualifier]::AccessAllowed,[Security.AccessControl.AceQualifier]::AccessDenied)) { return $false }
    if ($ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessDenied) { continue }
    if ($ace.SecurityIdentifier.Value -in $trusted) { continue }
    if ($leaf) { return $false }
    if (($ace.AceFlags -band [Security.AccessControl.AceFlags]::InheritOnly) -ne 0) { continue }
    $mask=[int64]$ace.AccessMask -band 4294967295
    if (($mask -band 0x500d0152) -ne 0) { return $false }
  }
  return $true
}
`

// 固定CLR接口避开cmdlet自动加载；参数始终来自stdin JSON，不拼进脚本表达式。
export const WINDOWS_CONTROL_SCRIPT = `
$ErrorActionPreference='Stop'
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json=[System.Web.Script.Serialization.JavaScriptSerializer]::new()
${WINDOWS_CONTROL_ACL}
try {
  $p=$json.DeserializeObject([Console]::In.ReadToEnd())
  $current=[IO.Path]::GetFullPath($p.directory)
  $leaf=$true
  while ($null -ne $current) {
    $attributes=[IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0) { exit 1 }
    $acl=[IO.Directory]::GetAccessControl($current,[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)
    $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
    if (!(Test-ControlAcl $raw $leaf)) { exit 1 }
    $parent=[IO.Directory]::GetParent($current)
    $current=if ($null -eq $parent) { $null } else { $parent.FullName }
    $leaf=$false
  }
  [Console]::Write('control_directory_valid')
} catch { exit 1 }
`

// 只接受系统固定根所用的规范本地DOS目录；不探测相对路径、UNC或任意设备命名空间。
export async function verifyWindowsControlDirectory(run: CommandRunner, directory: string): Promise<void> {
  if (
    !/^[A-Za-z]:\\/u.test(directory) ||
    win32.normalize(directory) !== directory ||
    directory.slice(3).includes(':') ||
    /[<>"|?*]/u.test(directory) ||
    Array.from(directory).some(
      /* 固定目录不可包含NUL或系统控制字符。 */ (c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127
    ) ||
    directory
      .slice(3)
      .split('\\')
      .some(
        /* Win32不得折叠尾点、空格或保留设备名。 */ (part) =>
          /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu.test(part)
      )
  ) {
    throw new ServiceError('unsafe_installation')
  }
  const result = await checkedCommand(run, {
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      Buffer.from(WINDOWS_CONTROL_SCRIPT, 'utf16le').toString('base64')
    ],
    input: JSON.stringify({ directory }),
    timeout: 10000
  })
  if (result.stdout !== 'control_directory_valid' || result.stderr !== '') {
    throw new ServiceError('unsafe_installation')
  }
}

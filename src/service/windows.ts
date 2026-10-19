// 通过系统自带 PowerShell 的固定脚本调用 Task Scheduler COM；数据走 stdin，绝不生成脚本表达式。
import { manifest, parseManifest, serviceName } from './spec.js'
import { renderTask } from './render.js'
import { checkedCommand, type CommandRunner } from './runner.js'
import { ServiceError, type ServiceRole, type ServiceSnapshot, type ServiceSpec } from './types.js'

// 脚本只接受固定项目角色与动作；TASK_CREATE 防止检查后竞态覆盖其它任务。
export const TASK_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $p = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($p.name -notmatch '^rovloom-(gateway|connector)$') { throw 'service_conflict' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'permission_denied' }
  $s = New-Object -ComObject 'Schedule.Service'
  $s.Connect()
  $folder = $s.GetFolder('\\')
  if ($p.op -eq 'authorize') { @{ok=$true} | ConvertTo-Json -Compress; exit 0 }
  $t = $null
  try { $t = $folder.GetTask($p.name) }
  catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
  if ($p.op -eq 'read') {
    if ($null -eq $t) { @{absent=$true} | ConvertTo-Json -Compress; exit 0 }
    @{marker=$t.Definition.RegistrationInfo.Description} | ConvertTo-Json -Compress; exit 0
  }
  if ($p.op -eq 'create') {
    if ($null -ne $t) { throw 'service_conflict' }
    $null = $folder.RegisterTask($p.name, $p.xml, 2, 'S-1-5-19', $null, 5, 'D:P(A;;FA;;;SY)(A;;FA;;;BA)')
    @{ok=$true} | ConvertTo-Json -Compress; exit 0
  }
  if ($null -eq $t) { throw 'service_conflict' }
  $expected = $s.NewTask(0)
  $expected.XmlText = $p.xml
  $expected.Principal.LogonType = 5
  [xml]$a = $t.Xml
  [xml]$b = $expected.XmlText
  foreach ($doc in @($a,$b)) {
    $ns = [Xml.XmlNamespaceManager]::new($doc.NameTable)
    $ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
    foreach ($node in @($doc.SelectNodes('/t:Task/t:RegistrationInfo/t:URI | /t:Task/t:RegistrationInfo/t:Date', $ns))) { $null = $node.ParentNode.RemoveChild($node) }
    $enabled = $doc.SelectSingleNode('/t:Task/t:Triggers/t:BootTrigger/t:Enabled', $ns)
    if ($null -ne $enabled) { $enabled.InnerText = 'true' }
  }
  if ($a.OuterXml -cne $b.OuterXml -or $t.Definition.RegistrationInfo.Description -cne $p.marker) { throw 'service_conflict' }
  if ([int]$t.State -notin @(1,2,3,4)) { throw 'system_command_failed' }
  switch ($p.op) {
    'inspect' { }
    'enable' {
      $definition = $t.Definition
      $boot = $definition.Triggers.Item(1)
      $boot.Enabled = [bool]$p.enabled
      $security = $t.GetSecurityDescriptor(7)
      $t = $folder.RegisterTaskDefinition($p.name, $definition, 52, 'S-1-5-19', $null, 5, $security)
    }
    'start' { $null = $t.Run($null) }
    'stop' { $t.Stop(0) }
    'remove' {
      if ([int]$t.State -notin @(1,3) -or $t.GetInstances(0).Count -ne 0) { @{retained=$true} | ConvertTo-Json -Compress; exit 0 }
      if ($t.Definition.Triggers.Item(1).Enabled) { throw 'service_conflict' }
      $folder.DeleteTask($p.name, 0)
      @{absent=$true} | ConvertTo-Json -Compress; exit 0
    }
    default { throw 'invalid_arguments' }
  }
  @{state=[int]$t.State; instances=[int]$t.GetInstances(0).Count; enabled=[bool]$t.Definition.Triggers.Item(1).Enabled; exitCode=[long]$t.LastTaskResult} | ConvertTo-Json -Compress
} catch {
  $code = 'system_command_failed'
  if ($_.Exception.Message -in @('permission_denied','service_conflict','service_busy','invalid_arguments')) { $code = $_.Exception.Message }
  elseif ($_.Exception.HResult -eq -2147024891) { $code = 'permission_denied' }
  @{error=$code} | ConvertTo-Json -Compress
  exit 1
}
`

// 使用固定脚本及显式 UTF-16LE EncodedCommand；Unicode 路径在 JSON stdin 中往返。
export async function taskCall(
  run: CommandRunner,
  op: string,
  role: ServiceRole,
  spec?: ServiceSpec,
  enabled?: boolean
): Promise<Record<string, unknown>> {
  const result = await run({
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(TASK_SCRIPT, 'utf16le').toString('base64')
    ],
    input: JSON.stringify({
      op,
      name: serviceName(role, 'win32'),
      xml: spec ? renderTask(spec) : undefined,
      marker: spec ? manifest(spec) : undefined,
      enabled
    })
  })
  let value: Record<string, unknown>
  try {
    value = JSON.parse(result.stdout.replace(/^\uFEFF/u, ''))
  } catch {
    throw new ServiceError('system_command_failed', result.code)
  }
  if (value.error === 'permission_denied' || value.error === 'service_conflict' || value.error === 'service_busy') {
    throw new ServiceError(value.error, result.code)
  }
  if (result.code !== 0 || value.error) {
    throw new ServiceError('system_command_failed', result.code)
  }
  return value
}

// 先读取所有权清单，再让 Scheduler 自己规范化预期 XML 并核对完整执行声明。
export async function inspectTask(run: CommandRunner, role: ServiceRole): Promise<ServiceSnapshot | undefined> {
  const found = await taskCall(run, 'read', role)
  if (found.absent === true) {
    return undefined
  }
  if (typeof found.marker !== 'string') {
    throw new ServiceError('service_conflict')
  }
  const spec = parseManifest(found.marker, role, 'win32')
  const actual = await taskCall(run, 'inspect', role, spec)
  if (
    !Number.isInteger(actual.state) ||
    ![1, 2, 3, 4].includes(actual.state as number) ||
    typeof actual.enabled !== 'boolean' ||
    !Number.isSafeInteger(actual.exitCode) ||
    !Number.isSafeInteger(actual.instances) ||
    (actual.instances as number) < 0
  ) {
    throw new ServiceError('system_command_failed')
  }
  // QUEUED 的实例也可能被计数，必须先判 starting；Count>0 不能把排队误报为运行成功。
  const state =
    actual.state === 2
      ? 'starting'
      : actual.state === 4 || (actual.instances as number) > 0
        ? 'running'
        : actual.exitCode === 0 || actual.exitCode === 0x41303 || actual.exitCode === 0x41306
          ? 'stopped'
          : 'failed'
  return { spec, state, enabled: actual.enabled, exitCode: actual.exitCode as number }
}

// 校验预先准备的 Windows 控制目录仅由管理员/SYSTEM 管理；不创建目录或修改 ACL。
export async function verifyWindowsControlDirectory(run: CommandRunner, directory: string): Promise<void> {
  const script = `
$ErrorActionPreference='Stop'
$p=[Console]::In.ReadToEnd() | ConvertFrom-Json
$acl=Get-Acl -LiteralPath $p.directory
$trusted=@('S-1-5-18','S-1-5-32-544')
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { exit 1 }
foreach ($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
 if ($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin $trusted) { exit 1 }
}
$item=Get-Item -Force -LiteralPath $p.directory
if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { exit 1 }
`
  await checkedCommand(run, {
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    input: JSON.stringify({ directory })
  })
}

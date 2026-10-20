// 通过系统自带 PowerShell 的固定脚本调用 Task Scheduler COM；数据走 stdin，绝不生成脚本表达式。
import { manifest, parseManifest, serviceName } from './spec.js'
import { renderTask } from './render.js'
import { type CommandRunner } from './runner.js'
import { ServiceError, type ServiceRole, type ServiceSnapshot, type ServiceSpec } from './types.js'

// 生产和只读原生探针共用账户与执行声明比较，测试无需复制验证逻辑。
export const TASK_DEFINITION_FUNCTIONS = `
# 正常解析既有用户身份，不读取profile、密码、ACL或额外账户配置。
function userSid($account) {
  try {
    if ($account -match '^S-1-') {
      $identifier = [Security.Principal.SecurityIdentifier]::new($account)
      $null = $identifier.Translate([Security.Principal.NTAccount])
      $sid = $identifier.Value
    }
    else { $sid = ([Security.Principal.NTAccount]::new($account)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($sid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { throw 'invalid_arguments' }
    return $sid
  } catch { throw 'invalid_arguments' }
}
# COM属性读取包含系统默认值；只比较实际执行声明，不把节点顺序和调度引擎默认选择误判为异物。
function declaration($definition) {
  if ($definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Type -ne 0 -or $definition.Triggers.Count -ne 1 -or $definition.Triggers.Item(1).Type -ne 8) { throw 'service_conflict' }
  $action = $definition.Actions.Item(1)
  $boot = $definition.Triggers.Item(1)
  $settings = $definition.Settings
  return $json.Serialize(@(
    (userSid $definition.Principal.UserId), [int]$definition.Principal.LogonType, [int]$definition.Principal.RunLevel,
    $action.Path, $action.Arguments, $action.WorkingDirectory,
    $boot.Delay, $boot.StartBoundary, $boot.EndBoundary, $boot.ExecutionTimeLimit,
    $boot.Repetition.Interval, $boot.Repetition.Duration, [bool]$boot.Repetition.StopAtDurationEnd,
    [int]$settings.MultipleInstances, [bool]$settings.DisallowStartIfOnBatteries, [bool]$settings.StopIfGoingOnBatteries,
    [bool]$settings.AllowHardTerminate, [bool]$settings.StartWhenAvailable, [bool]$settings.RunOnlyIfNetworkAvailable,
    [bool]$settings.AllowDemandStart, [bool]$settings.Enabled, [bool]$settings.RunOnlyIfIdle, $settings.ExecutionTimeLimit,
    [bool]$settings.IdleSettings.StopOnIdleEnd, [bool]$settings.IdleSettings.RestartOnIdle,
    $settings.RestartCount, $settings.RestartInterval, $settings.DeleteExpiredTaskAfter,
    [bool]$settings.WakeToRun, $definition.RegistrationInfo.Description
  ))
}
`

// 脚本只接受固定项目角色与动作；TASK_CREATE 防止检查后竞态覆盖其它任务。
export const TASK_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
# 固定CLR序列化器绕开cmdlet自动加载；JSON始终为数据，不执行表达式。
function emit($value) { [Console]::Write($json.Serialize($value)) }
${TASK_DEFINITION_FUNCTIONS}

try {
  $p = $json.DeserializeObject([Console]::In.ReadToEnd())
  if ($p.name -notmatch '^rovloom-(gateway|connector)$') { throw 'service_conflict' }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'permission_denied' }
  $s = [Activator]::CreateInstance([Type]::GetTypeFromProgID('Schedule.Service', $true))
  $s.Connect()
  $folder = $s.GetFolder('\\')
  if ($p.op -eq 'authorize') { emit @{ok=$true}; exit 0 }
  if ($p.op -eq 'validate') { $null = userSid $p.account; emit @{ok=$true}; exit 0 }
  $t = $null
  try { $t = $folder.GetTask($p.name) }
  catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
  if ($p.op -eq 'read') {
    if ($null -eq $t) { emit @{absent=$true}; exit 0 }
    emit @{marker=$t.Definition.RegistrationInfo.Description}; exit 0
  }
  if ($p.op -eq 'create') {
    if ($null -ne $t) { throw 'service_conflict' }
    $definition = $s.NewTask(0)
    $definition.XmlText = $p.xml
    $definition.Principal.UserId = userSid $p.account
    $definition.Principal.LogonType = 2
    $null = $folder.RegisterTaskDefinition($p.name, $definition, 2, $definition.Principal.UserId, $null, 2, $null)
    emit @{ok=$true}; exit 0
  }
  if ($null -eq $t) { throw 'service_conflict' }
  $expected = $s.NewTask(0)
  $expected.XmlText = $p.xml
  $expected.Principal.UserId = userSid $p.account
  $expected.Principal.LogonType = 2
  if ((declaration $t.Definition) -cne (declaration $expected) -or $t.Definition.RegistrationInfo.Description -cne $p.marker) { throw 'service_conflict' }
  if ([int]$t.State -notin @(1,2,3,4)) { throw 'system_command_failed' }
  switch ($p.op) {
    'inspect' { }
    'enable' {
      $definition = $t.Definition
      $boot = $definition.Triggers.Item(1)
      $boot.Enabled = [bool]$p.enabled
      $security = $t.GetSecurityDescriptor(7)
      $t = $folder.RegisterTaskDefinition($p.name, $definition, 52, $expected.Principal.UserId, $null, 2, $security)
    }
    'start' { $null = $t.Run($null) }
    'remove' {
      if ([int]$t.State -notin @(1,3) -or $t.GetInstances(0).Count -ne 0) { emit @{retained=$true}; exit 0 }
      if ($t.Definition.Triggers.Item(1).Enabled) { throw 'service_conflict' }
      $folder.DeleteTask($p.name, 0)
      emit @{absent=$true}; exit 0
    }
    default { throw 'invalid_arguments' }
  }
  emit @{state=[int]$t.State; instances=[int]$t.GetInstances(0).Count; enabled=[bool]$t.Definition.Triggers.Item(1).Enabled; exitCode=[long]$t.LastTaskResult}
} catch {
  $code = 'system_command_failed'
  if ($_.Exception.Message -in @('permission_denied','service_conflict','service_busy','invalid_arguments')) { $code = $_.Exception.Message }
  elseif ($_.Exception.HResult -eq -2147024891) { $code = 'permission_denied' }
  emit @{error=$code}
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
      '-STA',
      '-EncodedCommand',
      Buffer.from(TASK_SCRIPT, 'utf16le').toString('base64')
    ],
    input: JSON.stringify({
      op,
      name: serviceName(role, 'win32'),
      xml: spec ? renderTask(spec) : undefined,
      marker: spec ? manifest(spec) : undefined,
      account: spec?.account,
      enabled
    })
  })
  let value: Record<string, unknown>
  try {
    value = JSON.parse(result.stdout.replace(/^\uFEFF/u, ''))
  } catch {
    throw new ServiceError('system_command_failed', result.code)
  }
  if (
    value.error === 'permission_denied' ||
    value.error === 'service_conflict' ||
    value.error === 'service_busy' ||
    value.error === 'invalid_arguments'
  ) {
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

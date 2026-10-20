// 仅在GitHub托管临时VM中实装本轮Gateway服务并验证五项CLI语义；不接触用户机器、既有登记或真实凭据。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { join } from 'node:path'
import { CLI_ERROR_CODES, configDocument, configTemplate } from '../../src/cli/config.ts'
import { renderDefinition, windowsQuote } from '../../src/service/render.ts'
import { fileURLToPath } from 'node:url'
import { createNativeServiceBackend } from '../../src/service/native.ts'
import { manifest } from '../../src/service/spec.ts'
import { runSystemCommand } from '../../src/service/runner.ts'

if (
  process.env.GITHUB_ACTIONS !== 'true' ||
  process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
  process.env.ROVLOOM_NATIVE_SERVICE_CI !== '1' ||
  !['linux', 'darwin', 'win32'].includes(process.platform)
) {
  throw new Error('native_service_requires_disposable_github_vm')
}
const executable = realpathSync(process.env.ROVLOOM_SERVICE_EXECUTABLE ?? '')
const windows = process.platform === 'win32'
const user = userInfo()
if (!windows) {
  assert(user.uid > 0)
}
const root = mkdtempSync(join(process.cwd(), '.rovloom-native-service-'))
const config = join(root, 'gateway.json')
const state = join(root, 'state')
const keep = join(root, 'keep-user-data.txt')
const spec = {
  version: 1,
  platform: process.platform,
  role: 'gateway',
  executable,
  config,
  directory: root,
  account: user.username
}
const definition =
  process.platform === 'linux'
    ? '/etc/systemd/system/rovloom-gateway.service'
    : '/Library/LaunchDaemons/io.rovloom.gateway.plist'
const expected = renderDefinition(spec)
const native = windows ? createNativeServiceBackend({ platform: 'win32' }) : undefined
let attempted = false
let cleaned = false
let failure
let phase = 'preflight'

// 云CI明确使用已有免密码sudo授权；产品代码本身不调用提权，不继承测试之外的环境配置。
function command(file, args) {
  if (windows) {
    const result = spawnSync(file, args, {
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    if (result.error || result.signal) {
      throw new Error('native_service_command_incomplete')
    }
    return result
  }
  const result = spawnSync('/usr/bin/sudo', ['-n', '--', file, ...args], {
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 1024 * 1024,
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }
  })
  if (result.error || result.signal) {
    throw new Error('native_service_command_incomplete')
  }
  return result
}

// 只解析唯一产品CLI的固定监管结果；不把systemctl/launchctl成功误作HTTP可用。
function service(action, install = false) {
  phase = action
  const result = command(executable, [
    'service',
    action,
    '--role',
    'gateway',
    ...(install ? ['--config', config, '--workdir', root, '--user', user.username] : [])
  ])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
  return JSON.parse(result.stderr)
}

// 精确比对本轮登记后才允许收尾，绝不对同名既有服务发卸载/停止请求。
async function owned() {
  if (native) {
    const found = await native.inspect('gateway')
    return found !== undefined && manifest(found.spec) === manifest(spec)
  }
  const result = command('/bin/cat', [definition])
  return result.status === 0 && result.stdout === expected
}

// 向内核借用回环端口后立即释放，不扫描或复用用户监听器。
async function port() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const value = server.address().port
  server.close()
  await once(server, 'close')
  return value
}

// 已运行Gateway必须真实响应401，证明后台宿主活着且基础MCP鉴权没有被测试关闭。
async function reachable(url) {
  const deadline = performance.now() + 10000
  while (performance.now() < deadline) {
    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(1000) })
    } catch {
      await new Promise(/* 仅重试回环只读探针，不重试系统变更。 */ (resolve) => setTimeout(resolve, 100))
      continue
    }
    assert.equal(response.status, 401)
    await response.body?.cancel()
    return
  }
  throw new Error('native_gateway_http_timeout')
}

// 失败时只读本轮精确清单的临时任务；保留原生序列化差异，不读取配置正文或接管未知任务。
async function taskDiagnostic() {
  const script = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json=[System.Web.Script.Serialization.JavaScriptSerializer]::new()
$p=$json.DeserializeObject([Console]::In.ReadToEnd())
$s=[Activator]::CreateInstance([Type]::GetTypeFromProgID('Schedule.Service',$true))
$s.Connect()
$t=$s.GetFolder('\\').GetTask('rovloom-gateway')
if ($t.Definition.RegistrationInfo.Description -cne $p.marker) { exit 1 }
$e=$s.NewTask(0)
$e.XmlText=$p.xml
$e.Principal.UserId=([Security.Principal.NTAccount]::new($p.account)).Translate([Security.Principal.SecurityIdentifier]).Value
$e.Principal.LogonType=2
[Console]::Write($json.Serialize(@{actual=$t.Xml;expected=$e.XmlText;state=[int]$t.State;result=[long]$t.LastTaskResult}))
`
  const result = await runSystemCommand({
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    input: JSON.stringify({ marker: manifest(spec), xml: expected, account: user.username }),
    timeout: 10000
  })
  if (result.code === 0) {
    // 这些XML只包含本轮fixture路径及公开启动声明；不包含配置文件内容、密码或token。
    process.stderr.write(
      JSON.stringify({ scope: 'disposable-native-task-definition', phase, ...JSON.parse(result.stdout) }) + '\n'
    )
  }
}

// 仅原任务已退出且清单完全一致时，在同一S4U账户启动一次手动诊断任务；不重试原service动作。
async function startDiagnostic() {
  const observed = await native.inspect('gateway')
  assert.equal(manifest(observed.spec), manifest(spec))
  assert.equal(observed.state, 'failed')
  const resultFile = join(root, 'start-diagnostic-result.json')
  const requestFile = join(root, 'start-diagnostic-request.json')
  const argumentsText = ['gateway', '--config', config].map(windowsQuote).join(' ')
  writeFileSync(
    requestFile,
    JSON.stringify({
      scope: 'disposable-native-service-start',
      executable,
      config,
      directory: root,
      arguments: argumentsText,
      result: resultFile,
      errorCodes: [...CLI_ERROR_CODES, 'runtime_failed', 'config_valid', 'pairing_required'],
      plans: [
        { operation: 'version', arguments: windowsQuote('--version'), timeout: 2000 },
        {
          operation: 'config_check',
          arguments: ['config', 'check', '--path', config].map(windowsQuote).join(' '),
          timeout: 2000
        },
        { operation: 'gateway', arguments: argumentsText, timeout: 3000 }
      ]
    }),
    'utf8'
  )
  const script = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json=[System.Web.Script.Serialization.JavaScriptSerializer]::new()
$p=$json.DeserializeObject([Console]::In.ReadToEnd())
$s=[Activator]::CreateInstance([Type]::GetTypeFromProgID('Schedule.Service',$true))
$s.Connect()
$folder=$s.GetFolder('\\')
$original=$folder.GetTask('rovloom-gateway')
if ($original.Definition.RegistrationInfo.Description -cne $p.marker -or [int]$original.State -notin @(1,3) -or $original.GetInstances(0).Count -ne 0) { exit 1 }
$definition=$s.NewTask(0)
$definition.XmlText=$original.Xml
$definition.RegistrationInfo.Description=$p.diagnosticMarker
$definition.Triggers.Clear()
$definition.Actions.Clear()
$definition.Settings.ExecutionTimeLimit='PT20S'
$action=$definition.Actions.Create(0)
$action.Path='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
$action.Arguments=$p.arguments
$action.WorkingDirectory=$p.directory
$task=$folder.RegisterTaskDefinition($p.name,$definition,2,$definition.Principal.UserId,$null,2,$null)
try {
  $null=$task.Run($null)
  $until=[DateTime]::UtcNow.AddSeconds(15)
  while (![IO.File]::Exists($p.result) -and [DateTime]::UtcNow -lt $until) { [Threading.Thread]::Sleep(100) }
  if ([IO.File]::Exists($p.result)) { [Console]::Write([IO.File]::ReadAllText($p.result,[Text.UTF8Encoding]::new($false))) }
  else { [Console]::Write($json.Serialize(@{phase='diagnostic_result_missing';state=[int]$task.State;exitCode=[long]$task.LastTaskResult})) }
} finally {
  # 只回收本次TASK_CREATE成功且仍持有同一诊断清单的任务，不触碰同名未知对象。
  $current=$folder.GetTask($p.name)
  if ($current.Definition.RegistrationInfo.Description -cne $p.diagnosticMarker) { throw 'diagnostic_task_conflict' }
  if ($current.GetInstances(0).Count -gt 0 -or [int]$current.State -in @(2,4)) { $current.Stop(0) }
  if ($current.GetInstances(0).Count -eq 0 -and [int]$current.State -in @(1,3)) { $folder.DeleteTask($p.name,0) }
}
`
  const result = await runSystemCommand({
    executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    input: JSON.stringify({
      marker: manifest(spec),
      diagnosticMarker: 'Rovloom disposable start diagnostic ' + root,
      name: 'rovloom-start-diagnostic-' + root.split(/[\\/]/u).at(-1),
      directory: root,
      result: resultFile,
      arguments: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-File',
        fileURLToPath(new URL('./windows-start-diagnostic.ps1', import.meta.url)),
        '-RequestPath',
        requestFile
      ]
        .map(windowsQuote)
        .join(' ')
    }),
    timeout: 20000
  })
  if (result.stdout) {
    process.stderr.write(
      JSON.stringify({ scope: 'disposable-native-service-start', ...JSON.parse(result.stdout) }) + '\n'
    )
  }
  assert.equal(result.code, 0)
}

try {
  if (native) {
    await native.authorize()
    assert.equal(await native.inspect('gateway'), undefined, 'native_service_name_collision')
  } else {
    assert.equal(existsSync(definition), false, 'native_service_name_collision')
  }
  if (process.platform === 'linux') {
    const probe = command('/usr/bin/systemctl', [
      '--system',
      'show',
      '--property=LoadState',
      '--value',
      'rovloom-gateway.service'
    ])
    assert([0, 4].includes(probe.status) && probe.stdout.trim() === 'not-found', 'native_service_name_collision')
  } else if (process.platform === 'darwin') {
    const probe = command('/bin/launchctl', ['list'])
    assert.equal(probe.status, 0)
    assert(
      !probe.stdout
        .split('\n')
        .some(/* 既有标签不能被本轮试验接管。 */ (line) => line.trim().split(/\s+/u).at(-1) === 'io.rovloom.gateway'),
      'native_service_name_collision'
    )
  }
  const mcp = await port()
  let device = await port()
  while (device === mcp) {
    device = await port()
  }
  const bytes = JSON.stringify(
    configDocument({
      ...configTemplate('gateway'),
      state_dir: state,
      mcp_port: mcp,
      device_port: device,
      management_enabled: false
    })
  )
  // 普通新fixture沿用当前角色文件生成权限；没有修改任何既有对象权限或额外ACL。
  writeFileSync(config, bytes, { mode: 0o600 })
  writeFileSync(keep, 'fixture-user-data')
  attempted = true
  const installed = service('install', true)
  assert.equal(installed.state, 'stopped')
  assert.equal(installed.bootEnabled, true)
  assert.equal(service('install', true).changed, false)
  assert.equal(service('start').state, 'running')
  const url = `http://127.0.0.1:${mcp}/mcp`
  await reachable(url)
  assert.equal(existsSync(join(state, 'gateway.db')), true)
  assert.equal(existsSync(join(state, 'identity.db')), true)
  const removed = service('uninstall')
  assert.equal(removed.state, 'running')
  assert.equal(removed.bootEnabled, false)
  assert.equal(removed.stopMode, 'not_requested')
  await reachable(url)
  assert.equal(service('start').changed, false)
  const restarted = service('restart')
  assert.equal(restarted.state, 'running')
  assert.equal(restarted.bootEnabled, false)
  await reachable(url)
  assert.equal(service('stop').state, 'absent')
  assert.equal(service('uninstall').changed, false)
  assert.equal(readFileSync(config, 'utf8'), bytes)
  assert.equal(readFileSync(keep, 'utf8'), 'fixture-user-data')
  assert.equal(existsSync(join(state, 'gateway.db')), true)
  assert.equal(existsSync(join(state, 'identity.db')), true)
  assert.equal(existsSync(join(state, 'gateway.db.lock')), false)
  assert.equal(existsSync(join(state, 'identity.db.lock')), false)
  assert.equal(await owned(), false)
  cleaned = true
} catch (error) {
  failure = error
  if (native) {
    try {
      const observed = await native.inspect('gateway')
      // 只记录本轮固定阶段、监管退出码与锁是否存在，不输出角色配置或凭据。
      process.stderr.write(
        JSON.stringify({
          scope: 'disposable-native-service-failure',
          phase,
          state: observed?.state ?? 'absent',
          exitCode: observed?.exitCode ?? null,
          gatewayLock: existsSync(join(state, 'gateway.db.lock')),
          identityLock: existsSync(join(state, 'identity.db.lock'))
        }) + '\n'
      )
    } catch {
      // 诊断查询失败不改变原测试失败，也不被解释为登记缺失。
    }
    try {
      await taskDiagnostic()
    } catch {
      // 只读诊断失败不替代最初失败；未知任务不输出或修改。
    }
    if (phase === 'start') {
      try {
        await startDiagnostic()
      } catch {
        process.stderr.write('disposable_native_start_diagnostic_failed\n')
      }
    }
  }
}

// 收尾结果独立核对，既保留原失败，也不以finally控制流掩盖清理失败。
try {
  if (!attempted) {
    cleaned = true
  } else if (await owned()) {
    let failed = false
    for (const action of ['uninstall', 'stop']) {
      try {
        service(action)
      } catch {
        failed = true
      }
    }
    cleaned = !failed && !(await owned())
  } else if (native ? (await native.inspect('gateway')) === undefined : !existsSync(definition)) {
    cleaned = true
  }
  if (cleaned && !failure) {
    rmSync(root, { recursive: true, force: true })
  } else if (!cleaned) {
    throw new Error('native_service_cleanup_unconfirmed_fixture_retained')
  }
} catch (error) {
  failure = failure ? new AggregateError([failure, error], 'native_service_and_cleanup_failed') : error
}
if (failure) {
  throw failure
}
process.stdout.write(
  JSON.stringify({
    scope: 'disposable-native-service',
    platform: process.platform,
    binarySha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
    lifecycle: 'passed',
    mcpAuthentication: 'required',
    userData: 'preserved',
    reboot: 'not_exercised'
  }) + '\n'
)

// 使用实际宿主的原生解析器只读核对声明；不注册任务、不加载系统单元、不提权或改变权限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { spawn, type SpawnOptions } from 'node:child_process'
import { renderDefinition } from '../../src/service/render.js'
import { createSystemCommandRunner, runSystemCommand, type CommandPlan } from '../../src/service/runner.js'
import { sampleSpec } from './helpers.js'
import { taskCall, TASK_DEFINITION_FUNCTIONS } from '../../src/service/windows.js'

// 只观察本次桥已有的stderr和子进程阶段；不另起观察进程，不注册任务，也不重试失败操作。
async function bridgeProbe(plan: CommandPlan) {
  const stages = ['script_started', 'serializer_loaded', 'input_read', 'scheduler_connected', 'validated']
  const began = performance.now()
  const beganWall = Date.now()
  // 所有接收事件共用同一单调时钟，避免混用子进程创建和脚本执行时长。
  const elapsed = () => Math.round(performance.now() - began)
  const times: Record<string, number> = {}
  // 只读既定系统工具的PE标头，区分本机ARM64与模拟执行，不通过PATH选择其他Shell。
  const image = readFileSync(plan.executable)
  const header = image.readUInt32LE(0x3c)
  assert.equal(image.readUInt32LE(header), 0x00004550)
  const machine = image.readUInt16LE(header + 4)
  const toolArch = machine === 0xaa64 ? 'arm64' : machine === 0x8664 ? 'x64' : machine === 0x14c ? 'x86' : 'unknown'
  const diagnosticDirectory = mkdtempSync(join(tmpdir(), 'rovloom-powershell-timing-'))
  const firstStatement = join(diagnosticDirectory, 'first-statement.txt')
  let phase = 'not_started'
  let progress = ''
  let script = Buffer.from(plan.args.at(-1)!, 'base64').toString('utf16le')
  for (const [before, stage] of [
    ["$ErrorActionPreference = 'Stop'", 'script_started'],
    ['$json = ', 'serializer_loaded'],
    ['  if ($p.name', 'input_read'],
    ['[IO.File]::WriteAllText($p.PhasePath,', 'input_read'],
    ["[IO.File]::WriteAllText($p.PhasePath,'connected')", 'scheduler_connected'],
    ['  $folder = ', 'scheduler_connected'],
    ["[Console]::Write('native_format_valid')", 'validated']
  ]) {
    script = script.replace(before!, `[Console]::Error.WriteLine('rovloom_probe_${stage}')\n${before}`)
  }
  // 首句文件独立于stderr，防止把流尚未交付误判为PowerShell脚本尚未执行。
  script = `[IO.File]::WriteAllText($env:ROVLOOM_TEST_SERVICE_PHASE,[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString())\n${script}`
  const run = createSystemCommandRunner({
    start: /* 仅在测试中读取固定进度标记，不记录系统正文、路径或输入JSON。 */ ((
      file: string,
      args: readonly string[],
      options: SpawnOptions
    ) => {
      const child = spawn(file, args, {
        ...options,
        env: { ...options.env, ROVLOOM_TEST_SERVICE_PHASE: firstStatement }
      })
      child.once(
        'spawn',
        /* 记录操作系统接受启动的耗时，不当成脚本ready。 */ () => {
          times.spawn = elapsed()
        }
      )
      child.stdin?.once(
        'finish',
        /* 输入已交付仍不能证明PowerShell已读取。 */ () => {
          times.input_finished = elapsed()
        }
      )
      child.once(
        'exit',
        /* 与close分别记录，识别退出后流回收延迟。 */ () => {
          times.exit = elapsed()
        }
      )
      child.once(
        'close',
        /* 只观察本次直接子进程，不按PID查询或另起观察器。 */ () => {
          times.close = elapsed()
        }
      )
      child.stderr?.on(
        'data',
        /* 进度观察有界，失败时只保留固定阶段。 */ (bytes: Buffer) => {
          progress = (progress + bytes.toString('utf8')).slice(-512)
          for (const stage of stages) {
            if (progress.includes('rovloom_probe_' + stage)) {
              phase = stage
              times[stage] ??= elapsed()
            }
          }
        }
      )
      return child
    }) as typeof spawn
  })
  try {
    const result = await run({
      ...plan,
      args: [...plan.args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')],
      // 仅诊断同一个只读进程，沿用生产35秒硬界限观察真实启动；十秒验收判据仍在下面强制失败。
      timeout: 35000
    })
    assert(elapsed() <= 10000, 'native_probe_original_10000ms_limit_exceeded')
    return result
  } catch (error) {
    throw new Error('native_powershell_phase_' + phase, { cause: error })
  } finally {
    // 只输出固定工具选择、架构和时长；不输出账户、PID、参数、系统正文或stdin数据。
    let scriptStatementObserved = false
    let scriptFirstStatementMs: number | undefined
    try {
      const recorded = readFileSync(firstStatement, 'utf8')
      scriptStatementObserved = /^\d+$/.test(recorded)
      if (scriptStatementObserved) {
        scriptFirstStatementMs = Number(recorded) - beganWall
      }
    } catch {
      // 没有首句文件与没有stderr标记分别保留，不能据单一流推断未运行。
    }
    process.stderr.write(
      JSON.stringify({
        scope: 'readonly-powershell-timing',
        tool: 'System32/WindowsPowerShell/v1.0/powershell.exe',
        bunArch: process.arch,
        toolArch,
        elapsedMs: elapsed(),
        times,
        scriptStatementObserved,
        scriptFirstStatementMs
      }) + '\n'
    )
    rmSync(diagnosticDirectory, { recursive: true, force: true })
  }
}

test(
  '实际宿主原生解析器接受开机声明且不执行注册或启动',
  // Windows诊断观察至原生产35秒上限，但超过原十秒仍失败；POSIX不改变工具与外层期限。
  { timeout: process.platform === 'win32' ? 37000 : 12000 },
  /* 一个原生平台只证明自己的格式解析能力。 */ async () => {
    const platform = process.platform
    assert(['linux', 'darwin', 'win32'].includes(platform))
    const spec = {
      ...sampleSpec(platform as 'linux' | 'darwin' | 'win32'),
      executable: process.execPath,
      ...(platform === 'win32' ? { account: userInfo().username } : {})
    }
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-service-parse-'))
    try {
      if (platform === 'win32') {
        const script = `
$ErrorActionPreference = 'Stop'
${TASK_DEFINITION_FUNCTIONS}
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[void][Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
$p=$json.DeserializeObject([Console]::In.ReadToEnd())
[IO.File]::WriteAllText($p.PhasePath,'input_read')
if (!$env:USERPROFILE -or !$env:TEMP) { exit 2 }
[IO.File]::WriteAllText($p.PhasePath,'environment_ready')
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($p.PhasePath,'encoding_set')
$xml=[IO.File]::ReadAllText($p.XmlPath,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($p.PhasePath,'xml_read')
$null=[object]::new()
[IO.File]::WriteAllText($p.PhasePath,'clr_ready')
$s=[Activator]::CreateInstance([Type]::GetTypeFromProgID('Schedule.Service',$true))
[IO.File]::WriteAllText($p.PhasePath,'connecting')
$s.Connect()
[IO.File]::WriteAllText($p.PhasePath,'connected')
$t=$s.NewTask(0)
[IO.File]::WriteAllText($p.PhasePath,'definition_created')
$t.XmlText=$xml
[IO.File]::WriteAllText($p.PhasePath,'xml_parsed')
$t.Principal.LogonType=2
$sid=$t.Principal.UserId
if ($sid -notmatch '^S-1-') { $sid=([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value }
if ($t.Triggers.Count -ne 1 -or $t.Triggers.Item(1).Type -ne 8 -or $sid -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $t.Principal.LogonType -ne 2) { exit 1 }
if ($t.Actions.Count -ne 1 -or $t.Settings.ExecutionTimeLimit -ne 'PT0S' -or !$t.Settings.AllowDemandStart) { exit 1 }
# 系统登记的子项顺序和缺省值不改变执行；不同参数、提权及额外动作仍必须拒绝。
$reference=declaration $t
[xml]$reordered=$t.XmlText
$ns=[Xml.XmlNamespaceManager]::new($reordered.NameTable)
$ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
foreach ($node in @($reordered.SelectNodes('/t:Task/t:Principals/t:Principal/t:RunLevel | /t:Task/t:Triggers/t:BootTrigger/t:Enabled',$ns))) { $null=$node.ParentNode.RemoveChild($node) }
$root=$reordered.DocumentElement
$null=$root.AppendChild($root.SelectSingleNode('t:Triggers',$ns))
$copy=$s.NewTask(0)
$copy.XmlText=$reordered.OuterXml
if ((declaration $copy) -cne $reference) { exit 1 }
$copy.Principal.RunLevel=1
if ((declaration $copy) -ceq $reference) { exit 1 }
$copy.Principal.RunLevel=0
$copy.Actions.Item(1).Arguments += ' --foreign'
if ((declaration $copy) -ceq $reference) { exit 1 }
$null=$copy.Actions.Create(0)
try { $null=declaration $copy; exit 1 } catch { if ($_.Exception.Message -cne 'service_conflict') { throw } }
[Console]::Write('native_format_valid')
[IO.File]::WriteAllText($p.PhasePath,'validated')
`
        // 与生产一致使用EncodedCommand及stdin JSON，XML仍从自有UTF-8文件读取；不执行临时脚本文件。
        const xmlFile = join(directory, 'task.xml')
        const phaseFile = join(directory, 'phase.txt')
        writeFileSync(xmlFile, renderDefinition(spec), 'utf8')
        const result = await bridgeProbe({
          executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64')
          ],
          input: JSON.stringify({ XmlPath: xmlFile, PhasePath: phaseFile }),
          timeout: 10000
        }).catch(
          /* 失败只报告固定阶段，临时诊断随 fixture 清理，不反射路径或系统错误正文。 */ (error) => {
            let phase = 'not_started'
            try {
              const value = readFileSync(phaseFile, 'utf8')
              if (
                [
                  'input_read',
                  'environment_ready',
                  'encoding_set',
                  'xml_read',
                  'clr_ready',
                  'connecting',
                  'connected',
                  'definition_created',
                  'xml_parsed',
                  'validated'
                ].includes(value)
              ) {
                phase = value
              }
            } catch {
              // 缺少文件阶段时仍保留固定stderr进度及工具cause，不能直接断言脚本未启动。
            }
            throw new Error('native_format_phase_' + phase, { cause: error })
          }
        )
        assert.equal(result.code, 0, result.stderr)
        assert.equal(result.stdout, 'native_format_valid')
      } else {
        const file = join(directory, platform === 'linux' ? 'rovloom-connector.service' : 'io.rovloom.connector.plist')
        writeFileSync(file, renderDefinition(spec))
        const result = await runSystemCommand({
          executable: platform === 'linux' ? '/usr/bin/systemd-analyze' : '/usr/bin/plutil',
          args: platform === 'linux' ? ['verify', '--man=no', file] : ['-lint', file],
          timeout: 10000
        })
        assert.equal(result.code, 0, result.stderr)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

// 独立调用验证stdin JSON与只读COM授权，不能把两次工具预算塞进同一个格式探针外层期限。
if (process.platform === 'win32') {
  test(
    'Windows固定JSON桥独立完成只读授权，不注册任务',
    { timeout: 37000 },
    /* 测试限定自身工具预算十秒，生产默认期限不变；失败照常让整体CI失败。 */ async () => {
      assert.deepEqual(await taskCall(bridgeProbe, 'authorize', 'gateway'), { ok: true })
    }
  )
}

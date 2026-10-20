// 使用实际宿主的原生解析器只读核对声明；不注册任务、不加载系统单元、不提权或改变权限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type SpawnOptions } from 'node:child_process'
import { renderDefinition } from '../../src/service/render.js'
import { createSystemCommandRunner, runSystemCommand, type CommandPlan } from '../../src/service/runner.js'
import { sampleSpec } from './helpers.js'
import { taskCall } from '../../src/service/windows.js'

// 只观察本次桥已有的stderr和子进程阶段；不另起观察进程，不注册任务，也不重试失败操作。
async function bridgeProbe(plan: CommandPlan) {
  const stages = ['script_started', 'serializer_loaded', 'input_read', 'scheduler_connected']
  let phase = 'not_started'
  let progress = ''
  let script = Buffer.from(plan.args.at(-1)!, 'base64').toString('utf16le')
  for (const [before, stage] of [
    ["$ErrorActionPreference = 'Stop'", 'script_started'],
    ['$json = ', 'serializer_loaded'],
    ['  if ($p.name', 'input_read'],
    ['  $folder = ', 'scheduler_connected']
  ]) {
    script = script.replace(before!, `[Console]::Error.WriteLine('rovloom_probe_${stage}')\n${before}`)
  }
  const run = createSystemCommandRunner({
    start: /* 仅在测试中读取固定进度标记，不记录系统正文、路径或输入JSON。 */ ((
      file: string,
      args: readonly string[],
      options: SpawnOptions
    ) => {
      const child = spawn(file, args, options)
      child.stderr?.on(
        'data',
        /* 进度观察有界，失败时只保留固定阶段。 */ (bytes: Buffer) => {
          progress = (progress + bytes.toString('utf8')).slice(-512)
          for (const stage of stages) {
            if (progress.includes('rovloom_probe_' + stage)) {
              phase = stage
            }
          }
        }
      )
      return child
    }) as typeof spawn
  })
  try {
    return await run({
      ...plan,
      args: [...plan.args.slice(0, -1), Buffer.from(script, 'utf16le').toString('base64')],
      timeout: 10000
    })
  } catch (error) {
    throw new Error('native_bridge_phase_' + phase, { cause: error })
  }
}

test(
  '实际宿主原生解析器接受开机声明且不执行注册或启动',
  // 工具自身预算为十秒；外层仅留回收余量，不能先被 Bun 默认五秒截断而遗失原生错误。
  { timeout: 12000 },
  /* 一个原生平台只证明自己的格式解析能力。 */ async () => {
    const platform = process.platform
    assert(['linux', 'darwin', 'win32'].includes(platform))
    const spec = { ...sampleSpec(platform as 'linux' | 'darwin' | 'win32'), executable: process.execPath }
    const directory = mkdtempSync(join(tmpdir(), 'rovloom-service-parse-'))
    try {
      if (platform === 'win32') {
        const script = `
param([string]$XmlPath,[string]$PhasePath)
$ErrorActionPreference='Stop'
[IO.File]::WriteAllText($PhasePath,'script_started')
if (!$env:USERPROFILE -or !$env:TEMP) { exit 2 }
[IO.File]::WriteAllText($PhasePath,'environment_ready')
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($PhasePath,'encoding_set')
$xml=[IO.File]::ReadAllText($XmlPath,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($PhasePath,'xml_read')
$null=[object]::new()
[IO.File]::WriteAllText($PhasePath,'clr_ready')
$s=[Activator]::CreateInstance([Type]::GetTypeFromProgID('Schedule.Service',$true))
[IO.File]::WriteAllText($PhasePath,'connecting')
$s.Connect()
[IO.File]::WriteAllText($PhasePath,'connected')
$t=$s.NewTask(0)
[IO.File]::WriteAllText($PhasePath,'definition_created')
$t.XmlText=$xml
[IO.File]::WriteAllText($PhasePath,'xml_parsed')
$t.Principal.LogonType=5
$sid=$t.Principal.UserId
if ($sid -notmatch '^S-1-') { $sid=([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value }
if ($t.Triggers.Count -ne 1 -or $t.Triggers.Item(1).Type -ne 8 -or $sid -ne 'S-1-5-19') { exit 1 }
if ($t.Actions.Count -ne 1 -or $t.Settings.ExecutionTimeLimit -ne 'PT0S' -or !$t.Settings.AllowDemandStart) { exit 1 }
[Console]::Write('native_format_valid')
[IO.File]::WriteAllText($PhasePath,'validated')
`
        // 原生格式探针从自有 UTF-8 文件读取，参数单独传递；不依赖 PowerShell 的 stdin 文本宿主。
        const xmlFile = join(directory, 'task.xml')
        const scriptFile = join(directory, 'parse.ps1')
        const phaseFile = join(directory, 'phase.txt')
        writeFileSync(xmlFile, renderDefinition(spec), 'utf8')
        writeFileSync(scriptFile, script, 'utf8')
        const result = await runSystemCommand({
          executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-File',
            scriptFile,
            '-XmlPath',
            xmlFile,
            '-PhasePath',
            phaseFile
          ],
          timeout: 10000
        }).catch(
          /* 失败只报告固定阶段，临时诊断随 fixture 清理，不反射路径或系统错误正文。 */ (error) => {
            let phase = 'not_started'
            try {
              const value = readFileSync(phaseFile, 'utf8')
              if (
                [
                  'script_started',
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
              // 缺少阶段表示 PowerShell 尚未执行探针第一条语句。
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
    { timeout: 12000 },
    /* 测试限定自身工具预算十秒，生产默认期限不变；失败照常让整体CI失败。 */ async () => {
      assert.deepEqual(await taskCall(bridgeProbe, 'authorize', 'gateway'), { ok: true })
    }
  )
}

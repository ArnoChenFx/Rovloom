// 使用实际宿主的原生解析器只读核对声明；不注册任务、不加载系统单元、不提权或改变权限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderDefinition } from '../../src/service/render.js'
import { runSystemCommand } from '../../src/service/runner.js'
import { sampleSpec } from './helpers.js'

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
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($PhasePath,'encoding_set')
$xml=[IO.File]::ReadAllText($XmlPath,[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($PhasePath,'xml_read')
$s=New-Object -ComObject 'Schedule.Service'
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
                  'encoding_set',
                  'xml_read',
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

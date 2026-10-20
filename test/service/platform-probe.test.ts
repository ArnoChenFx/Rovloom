// 使用实际宿主的原生解析器只读核对声明；不注册任务、不加载系统单元、不提权或改变权限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
param([string]$XmlPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$xml=[IO.File]::ReadAllText($XmlPath,[Text.UTF8Encoding]::new($false))
$s=New-Object -ComObject 'Schedule.Service'
$s.Connect()
$t=$s.NewTask(0)
$t.XmlText=$xml
$t.Principal.LogonType=5
$sid=$t.Principal.UserId
if ($sid -notmatch '^S-1-') { $sid=([Security.Principal.NTAccount]::new($sid)).Translate([Security.Principal.SecurityIdentifier]).Value }
if ($t.Triggers.Count -ne 1 -or $t.Triggers.Item(1).Type -ne 8 -or $sid -ne 'S-1-5-19') { exit 1 }
if ($t.Actions.Count -ne 1 -or $t.Settings.ExecutionTimeLimit -ne 'PT0S' -or !$t.Settings.AllowDemandStart) { exit 1 }
[Console]::Write('native_format_valid')
`
        // 原生格式探针从自有 UTF-8 文件读取，参数单独传递；不依赖 PowerShell 的 stdin 文本宿主。
        const xmlFile = join(directory, 'task.xml')
        const scriptFile = join(directory, 'parse.ps1')
        writeFileSync(xmlFile, renderDefinition(spec), 'utf8')
        writeFileSync(scriptFile, script, 'utf8')
        const result = await runSystemCommand({
          executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptFile, '-XmlPath', xmlFile],
          timeout: 10000
        })
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

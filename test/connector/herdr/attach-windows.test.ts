/**
 * Windows 上附着真实官方 Herdr：命名管道端点、管道服务端 pid、镜像身份。
 * 需要真实 herdr.exe（CI 提供 ROVLOOM_HERDR_WINDOWS）；其它平台或未提供时跳过。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import { herdrServerPresent } from '../../../src/cli/herdr-attached.js'
import { observeHerdrServer } from '../../../src/connector/herdr/attach.js'
import { HerdrInstallation } from '../../../src/connector/herdr/installation.js'
import { herdrEnvironment, isHerdrInstanceBinding, pinHerdrConfig } from '../../../src/connector/herdr/local.js'
import type { HerdrLocalConfig } from '../../../src/connector/herdr/local.js'

const executable = process.env.ROVLOOM_HERDR_WINDOWS
const enabled = process.platform === 'win32' && !!executable

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-attach-'))
  for (const name of ['home', 'roaming', 'local', 'cache', 'tmp', 'work', 'bin']) {
    mkdirSync(join(root, name))
  }
  // 官方压缩包的整个目录（herdr.exe + conpty）必须在一起。
  cpSync(dirname(executable!), join(root, 'bin'), { recursive: true })
  const binary = join(root, 'bin', 'herdr.exe')
  copyFileSync(executable!, binary)
  const config: HerdrLocalConfig = pinHerdrConfig({
    target: { machine_id: 'm', provider_id: 'p', profile: 'session', session: 'default' },
    binding_revision: 1,
    config_ref: 'attach-windows',
    binary,
    home: join(root, 'home'),
    config_home: join(root, 'roaming'),
    state_home: join(root, 'local'),
    cache_home: join(root, 'cache'),
    temporary_home: join(root, 'tmp'),
    cwd: join(root, 'work'),
    attach: true
  })
  const children: ChildProcess[] = []
  /** 像用户那样运行 `herdr server`（默认会话）。 */
  async function serve(): Promise<ChildProcess> {
    const child = spawn(binary, ['server'], {
      cwd: config.cwd,
      env: herdrEnvironment(config),
      stdio: 'ignore',
      windowsHide: true
    })
    children.push(child)
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await herdrServerPresent(config).catch(() => false)) {
        return child
      }
      await pause(100)
    }
    throw new Error('herdr server did not start')
  }
  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await once(child, 'close')
    }
  }
  return {
    config,
    serve,
    stop,
    close: async () => {
      await Promise.all(children.map(stop))
      try {
        // herdr 的 ConPTY 辅助进程可能稍晚才释放工作目录；清理只是尽力而为，不能掩盖真正的断言结果。
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      } catch {
        // 临时目录由 runner 回收。
      }
    }
  }
}

test('Windows：已运行的官方 herdr 被证明后附着并可打开安装；进程消失后不再存在', { skip: !enabled }, async () => {
  const f = fixture()
  try {
    assert.equal(await herdrServerPresent(f.config), false)
    const server = await f.serve()
    const binding = await observeHerdrServer(f.config)
    assert(isHerdrInstanceBinding(binding))
    assert.equal(binding.pid, server.pid)
    binding.assert(f.config)
    const installation = await HerdrInstallation.open(f.config, binding)
    installation.close()
    await f.stop(server)
    assert.throws(() => binding.assert(f.config), { code: 'herdr_native_instance_untrusted' })
    // 服务端退出后管道消失：没有遗留端点被当作存在（记录文件可能还在）。
    assert.equal(await herdrServerPresent(f.config), false)
    await assert.rejects(observeHerdrServer(f.config))
  } finally {
    await f.close()
  }
})

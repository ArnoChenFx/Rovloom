/** 附着已运行的 Herdr：用真实 unix socket 服务进程验证对端身份证明；不执行任何真实 native。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { observeHerdrServer } from '../../../src/connector/herdr/attach.js'
import { herdrServerPresent } from '../../../src/cli/herdr-attached.js'
import {
  HerdrAttachedBinding,
  HerdrLocalError,
  inspectHerdrPath,
  isHerdrInstanceBinding,
  pinHerdrConfig
} from '../../../src/connector/herdr/local.js'
import type { HerdrLocalConfig } from '../../../src/connector/herdr/local.js'
import { privateHerdrTestRoot } from './private-root.js'

const linux = process.platform === 'linux' && process.arch === 'x64'
const python = '/usr/bin/python3'
const script =
  'import socket,os\\ns=socket.socket(socket.AF_UNIX);p=os.environ["FIXTURE_SOCKET"]\\ns.bind(p);os.chmod(p,0o600);s.listen(4)\\nprint("up",flush=True)\\nwhile True:\\n    c,_=s.accept()\\n'

/** 用 python3 的拷贝充当“已安装的 herdr”：其 /proc/<pid>/exe 就是这份拷贝，命令行为 `herdr server`。 */
function fixture() {
  const root = privateHerdrTestRoot('.attach-')
  for (const name of ['home', 'state', 'cache', 'tmp', 'work', 'bin']) {
    mkdirSync(join(root, name), { mode: 0o700 })
  }
  // 用户真实的配置目录：常见 0755，由用户自己（而非产品）创建。
  mkdirSync(join(root, 'config'), { mode: 0o755 })
  mkdirSync(join(root, 'config', 'herdr'), { mode: 0o755 })
  const binary = join(root, 'bin', 'herdr')
  copyFileSync(python, binary)
  chmodSync(binary, 0o700)
  writeFileSync(join(root, 'work', 'server'), script.replace(/\\n/gu, '\n'))
  const config: HerdrLocalConfig = pinHerdrConfig({
    target: { machine_id: 'm', provider_id: 'p', profile: 'session', session: 'default' },
    binding_revision: 1,
    config_ref: 'attach-test',
    binary,
    home: join(root, 'home'),
    config_home: join(root, 'config'),
    state_home: join(root, 'state'),
    cache_home: join(root, 'cache'),
    temporary_home: join(root, 'tmp'),
    cwd: join(root, 'work'),
    attach: true
  })
  const socket = join(root, 'config', 'herdr', 'herdr.sock')
  const children: ChildProcess[] = []
  /** 启动一个监听默认端点的服务进程；args 为 herdr 之后的参数。 */
  async function serve(executable = binary, args: string[] = ['server']): Promise<ChildProcess> {
    const child = spawn(executable, args, {
      cwd: join(root, 'work'),
      env: { PATH: '/usr/bin:/bin', FIXTURE_SOCKET: socket },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    children.push(child)
    await once(child.stdout!, 'data')
    return child
  }
  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'close')
    }
    rmSync(socket, { force: true })
  }
  return {
    root,
    config,
    binary,
    socket,
    serve,
    stop,
    close: async () => {
      await Promise.all(children.map(stop))
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('已运行的 herdr 服务端被证明后得到绑定；进程消失或被换成新实例后绑定失效', { skip: !linux }, async () => {
  const f = fixture()
  try {
    const first = await f.serve()
    const binding = await observeHerdrServer(f.config)
    assert(isHerdrInstanceBinding(binding))
    assert.equal(binding.pid, first.pid)
    binding.assert(f.config)
    // 配置被改动同样失效。
    assert.throws(() => binding.assert({ ...f.config, binding_revision: 2 }), {
      code: 'herdr_native_instance_untrusted'
    })
    await f.stop(first)
    assert.throws(() => binding.assert(f.config), { code: 'herdr_native_instance_untrusted' })
    // 同一路径上起来的新进程是另一个实例：旧绑定不能复活，重新观察得到新绑定。
    const second = await f.serve()
    assert.throws(() => binding.assert(f.config), { code: 'herdr_native_instance_untrusted' })
    const next = await observeHerdrServer(f.config)
    assert.equal(next.pid, second.pid)
    assert.notEqual(next.pid, binding.pid)
  } finally {
    await f.close()
  }
})

test('端点没有监听者、或监听者不是已安装的 herdr，一律不附着', { skip: !linux }, async () => {
  const f = fixture()
  try {
    await assert.rejects(observeHerdrServer(f.config), HerdrLocalError)
    // 另一份二进制（不同 inode）在同一端点监听：不是配置里那个 herdr。
    const impostor = join(f.root, 'bin', 'impostor')
    copyFileSync(python, impostor)
    chmodSync(impostor, 0o700)
    const fake = await f.serve(impostor)
    await assert.rejects(observeHerdrServer(f.config), { code: 'herdr_native_instance_untrusted' })
    await f.stop(fake)
    // 同一个二进制但命令行不是 server：不是服务端进程。
    writeFileSync(join(f.root, 'work', 'other'), readFileSync(join(f.root, 'work', 'server')))
    const wrong = spawn(f.binary, ['other', 'extra'], {
      cwd: join(f.root, 'work'),
      env: { PATH: '/usr/bin:/bin', FIXTURE_SOCKET: f.socket },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    await once(wrong.stdout!, 'data')
    await assert.rejects(observeHerdrServer(f.config), { code: 'herdr_native_instance_untrusted' })
    await f.stop(wrong)
  } finally {
    await f.close()
  }
})

test('受信绑定只能由本模块签发，自造的同形对象和未设置 attach 的配置都被拒绝', { skip: !linux }, async () => {
  const f = fixture()
  try {
    assert.equal(isHerdrInstanceBinding({ assert() {} }), false)
    assert.equal(isHerdrInstanceBinding(Object.create(HerdrAttachedBinding.prototype)), false)
    const { attach: _omit, ...managed } = f.config
    await assert.rejects(observeHerdrServer(managed as HerdrLocalConfig), { code: 'herdr_native_instance_untrusted' })
    assert.throws(() => pinHerdrConfig({ ...f.config, attach: false as unknown as true }), {
      code: 'herdr_local_config_invalid'
    })
  } finally {
    await f.close()
  }
})

test('shared_directory 接受用户自己的 0755 目录，拒绝组/其他可写、符号链接与非目录', { skip: !linux }, () => {
  const root = privateHerdrTestRoot('.attach-dir-')
  try {
    const shared = mkdtempSync(join(root, 'ok-'))
    chmodSync(shared, 0o755)
    assert.doesNotThrow(() => inspectHerdrPath(shared, 'shared_directory'))
    assert.throws(() => inspectHerdrPath(shared, 'directory'), { code: 'herdr_local_path_untrusted' })
    const writable = mkdtempSync(join(root, 'w-'))
    chmodSync(writable, 0o775)
    assert.throws(() => inspectHerdrPath(writable, 'shared_directory'), { code: 'herdr_local_path_untrusted' })
    const link = join(root, 'link')
    symlinkSync(shared, link)
    assert.throws(() => inspectHerdrPath(link, 'shared_directory'), { code: 'herdr_local_path_untrusted' })
    const file = join(root, 'file')
    writeFileSync(file, '')
    assert.throws(() => inspectHerdrPath(file, 'shared_directory'), { code: 'herdr_local_path_untrusted' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('herdrServerPresent：无端点、遗留的无监听 socket 文件都算没有实例，能连上才算有', { skip: !linux }, async () => {
  const f = fixture()
  try {
    assert.equal(await herdrServerPresent(f.config), false)
    const child = await f.serve()
    assert.equal(await herdrServerPresent(f.config), true)
    // 进程被强杀后 socket 文件原样遗留，但没有监听者：应触发自建而不是当成实例存在。
    child.kill('SIGKILL')
    await once(child, 'close')
    assert.equal(await herdrServerPresent(f.config), false)
  } finally {
    await f.close()
  }
})

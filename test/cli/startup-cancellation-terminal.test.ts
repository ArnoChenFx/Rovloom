// 正式production runtime与真实TTY验证启动失败的优先级；工厂只注入失败，不启动native或创建真实身份。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { saveCredential } from '../../src/transport/credentials.js'

const marker = 'SYNTHETIC_PRIVATE_NATIVE_FAILURE'

// 子进程运行真正runCli、CliSetup和production工厂；只在可信来源边界交付同一个合成失败对象。
const startupFixture = `
import { chmodSync } from 'node:fs'
import { runCli } from ${JSON.stringify(fileURLToPath(new URL('../../src/cli/run.ts', import.meta.url)))}
import { CliSetup } from ${JSON.stringify(fileURLToPath(new URL('../../src/cli/setup-runtime.ts', import.meta.url)))}
import { createProductionCliRuntime } from ${JSON.stringify(fileURLToPath(new URL('../../src/cli/production.ts', import.meta.url)))}
import { LuvusProductionStartupError } from ${JSON.stringify(fileURLToPath(new URL('../../src/runtime/production-luvus.ts', import.meta.url)))}
import { HerdrProductionStartupError } from ${JSON.stringify(fileURLToPath(new URL('../../src/cli/production-herdr.ts', import.meta.url)))}
import { LuvusAdapterError } from ${JSON.stringify(fileURLToPath(new URL('../../src/connector/luvus/types.ts', import.meta.url)))}
const [path, kind, cancellation, fault] = process.argv.slice(1)
const stop = new AbortController()
const onSignal = () => stop.abort()
process.once('SIGTERM', onSignal)
const setup = new CliSetup()
let releaseCalls = 0
const startup = new Error(${JSON.stringify(marker)})
const cleanup = new Error(${JSON.stringify(marker)})
const shutdown = { release: async () => { releaseCalls++ }, status: () => ({ launch_uncertain: false, exit_confirmed: false, owner_held: true }) }
const original = kind === 'startup'
  ? new LuvusProductionStartupError(startup, shutdown, cleanup)
  : kind === 'herdr' ? new HerdrProductionStartupError(startup, shutdown, cleanup)
  : kind === 'adapter' ? new LuvusAdapterError('synthetic_startup_failed') : startup
let preserved = false
const runtime = createProductionCliRuntime({
  connector: async () => {
    if (cancellation === 'sigterm') {
      await new Promise(resolve => {
        stop.signal.addEventListener('abort', resolve, { once: true })
        process.stderr.write('fixture_factory_waiting\\n')
      })
    }
    if (fault === 'owner') chmodSync(path, 0o644)
    throw original
  }
}, setup)
const connector = runtime.connector
runtime.connector = async config => {
  try { return await connector(config) }
  catch (error) { preserved = error === original; throw error }
}
try {
  const exit = await runCli(['connector', '--config', path], {
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, signal: stop.signal
  }, runtime)
  process.exitCode = exit
  process.stdout.write(JSON.stringify({
    exit, preserved, releaseCalls, cancelled: stop.signal.aborted,
    owner_preserved: (kind !== 'startup' && kind !== 'herdr') ||
      (original.shutdown === shutdown && original.startupError === startup && original.cleanupError === cleanup)
  }))
} finally {
  setup.close()
  process.off('SIGTERM', onSignal)
}
`

// OS PTY只转发固定结果；真实SIGTERM在工厂已进入等待后发出，日志不包含私有异常或TTY正文。
const terminal = String.raw`
import os,pty,subprocess,sys,select,time,json,signal,fcntl,termios
master,slave=pty.openpty()
inspection=os.dup(slave)
original_flags=termios.tcgetattr(slave)[3]
child=None;data=bytearray()
def own_terminal():
 fcntl.ioctl(0,termios.TIOCSCTTY,0)
try:
 child=subprocess.Popen([sys.argv[1],'--no-env-file','--eval',sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5],sys.argv[6]],stdin=slave,stderr=slave,stdout=subprocess.PIPE,start_new_session=True,preexec_fn=own_terminal)
 os.close(slave);slave=None
 if sys.argv[5]=='sigterm':
  until=time.monotonic()+10
  while b'fixture_factory_waiting' not in data:
   if child.poll() is not None:raise RuntimeError('fixture_factory_exited')
   if time.monotonic()>until:raise RuntimeError('fixture_factory_timeout')
   if select.select([master],[],[],0.05)[0]:data.extend(os.read(master,4096))
   if len(data)>65536:raise RuntimeError('fixture_output_limit')
  child.send_signal(signal.SIGTERM)
 stdout,_=child.communicate(timeout=10)
 while select.select([master],[],[],0)[0]:
  data.extend(os.read(master,4096))
  if len(data)>65536:raise RuntimeError('fixture_output_limit')
 if child.returncode!=1:raise RuntimeError('fixture_exit_'+str(child.returncode))
 if b'runtime_failed' not in data:raise RuntimeError('fixture_failure_not_reported')
 if b'SYNTHETIC_PRIVATE_NATIVE_FAILURE' in data or b'SYNTHETIC_PRIVATE_NATIVE_FAILURE' in stdout:raise RuntimeError('fixture_private_error_reflected')
 mask=termios.ICANON|termios.ECHO
 if termios.tcgetattr(inspection)[3]&mask!=original_flags&mask:raise RuntimeError('fixture_terminal_not_restored')
 print(json.dumps(json.loads(stdout)))
finally:
 if child is not None and child.poll() is None:
  child.send_signal(signal.SIGTERM)
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:child.kill();child.wait()
 for fd in [master,slave,inspection]:
  if fd is not None:os.close(fd)
`

for (const [kind, cancellation, fault] of [
  ['ordinary', 'none', 'none'],
  ['startup', 'none', 'none'],
  ['ordinary', 'sigterm', 'none'],
  ['startup', 'sigterm', 'none'],
  ['adapter', 'sigterm', 'none'],
  ['herdr', 'none', 'none'],
  ['herdr', 'sigterm', 'none'],
  ['herdr', 'none', 'owner'],
  ['startup', 'none', 'owner']
]) {
  test(
    `真实PTY production ${kind}/${cancellation}/${fault}诊断不能替换原工厂失败或原清理owner`,
    { timeout: 30_000 },
    /* 已配置状态和设备值仅为自有合成fixture；生产工厂失败发生在任何网络连接或native动作之前。 */ async () => {
      if (process.platform !== 'linux' || !process.versions.bun) {
        return
      }
      const root = mkdtempSync(join(tmpdir(), 'rovloom-startup-cancellation-'))
      const state = join(root, 'state')
      const managed = join(state, 'managed')
      privateDirectory(state)
      privateDirectory(managed)
      const path = join(root, 'connector.json')
      const device = join(managed, 'device.json')
      writeFileSync(
        path,
        JSON.stringify(
          configDocument({ ...configTemplate('connector'), state_dir: state, gateway_url: 'ws://127.0.0.1:1' })
        ),
        { mode: 0o600 }
      )
      writeFileSync(
        join(managed, 'providers.json'),
        JSON.stringify({
          schema_version: 1,
          role: 'connector',
          providers: [{ reference: 'synthetic_failure', value: {} }]
        }),
        { mode: 0o600 }
      )
      saveCredential(device, {
        machine_id: 'synthetic_machine',
        recovery_generation: 'synthetic_generation',
        credential: 'SYNTHETIC_INVALID_DEVICE_CREDENTIAL'.padEnd(48, 'x')
      })
      const before = readFileSync(device)
      try {
        const child = spawn(
          'python3',
          ['-c', terminal, process.execPath, startupFixture, path, kind!, cancellation!, fault!],
          {
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
        let output = ''
        let errors = ''
        child.stdout.on('data', /* 只收集原错误身份、取消状态和释放次数等非秘密事实。 */ (data) => (output += data))
        child.stderr.on('data', /* Python只报告固定边界错误，不转发终端正文。 */ (data) => (errors += data))
        const [code] = await once(child, 'exit')
        assert.equal(code, 0, errors)
        assert.deepEqual(JSON.parse(output), {
          exit: 1,
          preserved: true,
          releaseCalls: 0,
          cancelled: cancellation === 'sigterm',
          owner_preserved: true
        })
        assert.deepEqual(readFileSync(device), before)
        assert.deepEqual(readdirSync(managed).sort(), ['device.json', 'providers.json'])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}

// 正式本机PTY覆盖提示期间编辑配置和两种终止信号；不输入有效配对码、不创建身份或执行native。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { privateDirectory } from '../../src/cli/first-config.js'

// 每个Gateway使用内核分配的不同临时回环端口，避免触碰默认安装或外部服务。
async function port(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  server.close()
  await once(server, 'close')
  return address.port
}

// Python只提供内核控制PTY和固定阶段断言；终端正文不写入测试日志，合成无效码不会送到网络。
const promptTerminal = String.raw`
import os,pty,subprocess,sys,select,time,json,signal,fcntl,termios
master,slave=pty.openpty()
inspection=os.dup(slave)
original_flags=termios.tcgetattr(slave)[3]
child=None
data=bytearray()
def own_terminal():
 fcntl.ioctl(0,termios.TIOCSCTTY,0)
def prompt(marker):
 until=time.monotonic()+10
 while time.monotonic()<until:
  if marker in data:return
  if child.poll() is not None:raise RuntimeError('fixture_prompt_exited')
  if select.select([master],[],[],0.05)[0]:
   data.extend(os.read(master,4096))
   if len(data)>65536:raise RuntimeError('fixture_output_limit')
 raise RuntimeError('fixture_prompt_timeout')
try:
 command=[sys.argv[7]] if sys.argv[7] else [sys.argv[1],'--no-env-file',sys.argv[2]]
 child=subprocess.Popen(command+[sys.argv[4],'--config',sys.argv[3]],stdin=slave,stderr=slave,stdout=subprocess.PIPE,start_new_session=True,preexec_fn=own_terminal,env={**os.environ,'ROVLOOM_LANG':'en'})
 os.close(slave);slave=None
 stage=sys.argv[5];action=sys.argv[6]
 if stage=='gateway':prompt(b'Pair one Connector')
 else:
  prompt(b'Gateway address')
  if stage=='edit':
   document=json.load(open(sys.argv[3]))
   document['native']={'runtime_bin_dirs':['/opt/rovloom-test-runtime'],'agent_bin_dirs':['/opt/rovloom-test-agent']}
   edited=(json.dumps(document,indent=1)+'\n').encode()
   target=sys.argv[3]+'.edited' if action=='replace' else sys.argv[3]
   with open(target,'wb') as stream:stream.write(edited)
   os.chmod(target,0o600)
   if action=='replace':os.replace(target,sys.argv[3])
   os.write(master,b'ws://127.0.0.1:1\n')
  elif stage!='address':
   os.write(master,b'ws://127.0.0.1:1\n')
   prompt(b'One-time pairing code')
   if stage=='trust':
    os.write(master,b'synthetic_machine.synthetic_attempt.'+b'x'*32+b'\n')
    prompt(b'Trust this Gateway')
 before=open(sys.argv[3],'rb').read()
 if stage!='edit':
  if action=='ctrl-c':os.write(master,b'\x03')
  else:child.send_signal(signal.SIGTERM)
 child.wait(timeout=10)
 while select.select([master],[],[],0)[0]:
  data.extend(os.read(master,4096))
  if len(data)>65536:raise RuntimeError('fixture_output_limit')
 expected=2 if stage=='edit' else 0
 if child.returncode!=expected:raise RuntimeError('fixture_exit_'+str(child.returncode))
 if open(sys.argv[3],'rb').read()!=before:raise RuntimeError('fixture_config_overwritten')
 if child.stdout.read():raise RuntimeError('fixture_stdout_not_empty')
 if stage=='edit':
  if b'config_changed' not in data:raise RuntimeError('fixture_conflict_not_reported')
  if b'One-time pairing code' in data:raise RuntimeError('fixture_pairing_started')
 elif b'runtime_failed' in data or b'configuration_required' in data:
  raise RuntimeError('fixture_cancellation_reported_as_failure')
 mask=termios.ICANON|termios.ECHO
 if termios.tcgetattr(inspection)[3]&mask!=original_flags&mask:raise RuntimeError('fixture_terminal_not_restored')
 print(json.dumps({'exit':expected,'config_preserved':True,'terminal_restored':True}))
finally:
 if child is not None and child.poll() is None:
  child.send_signal(signal.SIGTERM)
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:child.kill();child.wait()
 for fd in [master,slave,inspection]:
  if fd is not None:os.close(fd)
`

// 每个探针独立创建私有角色文件；实际正式入口负责问答、错误分类、关闭和终端恢复。
async function probe(stage: string, action: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-setup-prompt-'))
  const state = join(root, 'state')
  privateDirectory(state)
  const role = stage === 'gateway' ? 'gateway' : 'connector'
  const path = join(root, role + '.json')
  const config = configTemplate(role)
  let document = configDocument({ ...config, state_dir: state })
  if (config.role === 'gateway') {
    const mcp = await port()
    let devices = await port()
    while (devices === mcp) {
      devices = await port()
    }
    document = configDocument({
      ...config,
      state_dir: state,
      mcp_port: mcp,
      device_port: devices,
      management_enabled: false
    })
  }
  writeFileSync(path, JSON.stringify(document), { mode: 0o600 })
  try {
    const child = spawn(
      'python3',
      [
        '-c',
        promptTerminal,
        process.execPath,
        fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url)),
        path,
        role,
        stage,
        action,
        process.env.ROVLOOM_TEST_STANDALONE ?? ''
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let output = ''
    let errors = ''
    child.stdout.on('data', /* 只收集固定布尔结果。 */ (data) => (output += data))
    child.stderr.on('data', /* Python异常只有固定阶段，不回显终端正文。 */ (data) => (errors += data))
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, errors)
    assert.deepEqual(JSON.parse(output), {
      exit: stage === 'edit' ? 2 : 0,
      config_preserved: true,
      terminal_restored: true
    })
    const managed = join(state, 'managed')
    assert.deepEqual(existsSync(managed) ? readdirSync(managed) : [], [])
    if (stage === 'edit') {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(saved.gateway.url, '')
      assert.deepEqual(saved.native, {
        runtime_bin_dirs: ['/opt/rovloom-test-runtime'],
        agent_bin_dirs: ['/opt/rovloom-test-agent']
      })
    }
    if (role === 'gateway') {
      const database = new DatabaseSync(join(state, 'gateway.db'), { readOnly: true })
      try {
        assert.equal(Number(database.prepare('SELECT count(*) AS n FROM machines').get()!.n), 0)
      } finally {
        database.close()
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

for (const action of ['in-place', 'replace']) {
  test(
    `真实PTY地址提示期间${action}修改native目录保留原文件，拒绝旧快照写回且不进入配对`,
    { timeout: 30_000 },
    /* 两种真实文件修改方式都必须被提示前代次挡住，不依赖假的文件stamp或问答来源。 */ async () => {
      if (process.platform === 'linux' && process.versions.bun) {
        await probe('edit', action)
      }
    }
  )
}

for (const stage of ['gateway', 'address', 'code', 'trust']) {
  for (const action of ['ctrl-c', 'sigterm']) {
    test(
      `真实PTY ${stage}问答${action}正常退出、恢复终端并保留配置且不创建身份`,
      { timeout: 30_000 },
      /* 覆盖两角色所有配对前提示，不用已进入运行态的信号测试代替等待中的取消。 */ async () => {
        if (process.platform === 'linux' && process.versions.bun) {
          await probe(stage, action)
        }
      }
    )
  }
}

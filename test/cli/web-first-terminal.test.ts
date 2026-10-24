// 真实TTY Gateway拒绝终端配对后保持运行：管理页路径完成首台配对（管理员可配对前创建，设备在线认领）。
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { buildManagementAssets } from './management-assets-fixture.js'

before(buildManagementAssets)

// 内核分配临时回环端口；不访问外部网络。
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

// Python只驱动真实PTY与轮询固定结果；终端正文与口令不进入测试日志。
const terminal = String.raw`
import os,pty,subprocess,sys,select,time,json,re,base64,urllib.request,urllib.error
master,slave=pty.openpty()
child=None;data=bytearray()
def own_terminal():
 fcntl.ioctl(0,termios.TIOCSCTTY,0)
import fcntl,termios
def read_until(pattern,deadline=20):
 end=time.monotonic()+deadline
 while time.monotonic()<end:
  found=re.search(pattern,bytes(data))
  if found:return found
  if child.poll() is not None:raise RuntimeError('fixture_cli_exited:'+str(child.returncode)+':'+pattern.decode('utf8','replace'))
  if select.select([master],[],[],0.05)[0]:
   data.extend(os.read(master,4096))
   if len(data)>131072:raise RuntimeError('fixture_output_limit')
 raise RuntimeError('fixture_prompt_timeout:'+pattern.decode('utf8','replace'))
try:
 child=subprocess.Popen([sys.argv[1],'--no-env-file',sys.argv[2],'gateway','--config',sys.argv[3]],stdin=slave,stderr=slave,stdout=subprocess.PIPE,start_new_session=True,preexec_fn=own_terminal,env={**os.environ,'ROVLOOM_LANG':'en'})
 os.close(slave);slave=None
 read_until(rb'Pair one Connector.*\[y/N\] ')
 os.write(master,b'n\n')
 read_until(rb'Gateway stays unpaired')
 read_until(rb'rovloom admin create')
 # Gateway 进程必须保持运行：管理页与设备 listener 持续可用。
 time.sleep(1.0)
 if child.poll() is not None:raise RuntimeError('fixture_gateway_exited_after_decline')
 # 预配对创建管理员：口令只在stdout一次，stderr只含固定诊断。
 created=subprocess.run([sys.argv[1],'--no-env-file',sys.argv[2],'admin','create','--config',sys.argv[3]],capture_output=True,timeout=20,env={**os.environ,'ROVLOOM_LANG':'en'})
 if created.returncode!=0:raise RuntimeError('fixture_admin_create_failed:'+created.stderr.decode('utf8','replace')[:80])
 secret=created.stdout.decode().strip()
 if not re.fullmatch(r'[A-Za-z0-9_-]{43}',secret):raise RuntimeError('fixture_admin_secret_shape')
 # 页面请求带管理员 Basic 凭据后可登录（lease bootstrap 交付带 bootstrap meta 的页面）。
 management='http://127.0.0.1:'+sys.argv[4]+'/'
 auth='Basic '+base64.b64encode(('admin:'+secret).encode()).decode()
 req=urllib.request.Request(management,headers={'authorization':auth})
 try:
  with urllib.request.urlopen(req,timeout=10) as response:
   body=response.read(); status=response.status
 except urllib.error.HTTPError as error:
  body=error.read(); status=error.code
 if status!=200 or b'rovloom-management' not in body:raise RuntimeError('fixture_page_not_delivered:'+str(status))
 # 拒绝后没有注册过任何设备，也没有 setup 计划文件。
 import sqlite3
 db=sqlite3.connect(sys.argv[5])
 count=db.execute('SELECT count(*) FROM machines').fetchone()[0]
 db.close()
 if count!=0:raise RuntimeError('fixture_machine_registered')
 print(json.dumps({'running':True,'admin_login':True,'machines':count,'secret_len':len(secret)}))
finally:
 if child is not None and child.poll() is None:
  child.terminate()
  try:child.wait(timeout=5)
  except subprocess.TimeoutExpired:child.kill();child.wait()
 for fd in [master,slave]:
  if fd is not None:
   try:os.close(fd)
   except OSError:pass
`

test(
  '拒绝终端配对的Gateway保持运行，管理页管理员可配对前创建并登录',
  { timeout: 60_000 },
  /* 真实TTY、真实production工厂与真实管理来源文件；不配对设备、不启动native。 */ async () => {
    if (process.platform !== 'linux' || !process.versions.bun) {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'rovloom-web-first-terminal-'))
    const state = join(root, 'gateway')
    privateDirectory(state)
    const mcp = await port()
    const devices = await port()
    let management = await port()
    while (management === mcp || management === devices) {
      management = await port()
    }
    const configPath = join(root, 'gateway.json')
    writeFileSync(
      configPath,
      JSON.stringify(
        configDocument({
          ...configTemplate('gateway'),
          state_dir: state,
          mcp_port: mcp,
          device_port: devices,
          management_enabled: true,
          management_port: management
        })
      ),
      { mode: 0o600 }
    )
    try {
      const child = spawn(
        'python3',
        [
          '-c',
          terminal,
          process.execPath,
          fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url)),
          configPath,
          String(management),
          join(state, 'gateway.db')
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let output = ''
      let errors = ''
      child.stdout.on('data', (data: Buffer) => (output += data))
      child.stderr.on('data', (data: Buffer) => (errors += data))
      const [code] = await once(child, 'exit')
      assert.equal(code, 0, errors)
      assert.deepEqual(JSON.parse(output), {
        running: true,
        admin_login: true,
        machines: 0,
        secret_len: 43
      })
      // 拒绝路径不写任何 setup 计划或凭据文件。
      const managed = readdirSync(join(state, 'managed')).sort()
      assert.deepEqual(managed, ['management.json', 'mcp-callers.json'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

// 隔离PTY运行正式双角色入口并拒绝native初始化，验证真实本地确认/持久配对/关闭；不启动native或调用模型。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { configDocument, configTemplate } from '../../src/cli/config.js'
import { privateDirectory } from '../../src/cli/first-config.js'
import { loadCredential } from '../../src/transport/credentials.js'
import { privateHerdrTestRoot } from '../connector/herdr/private-root.js'

// 内核分配临时回环端口；不访问外部网络，也不假定默认端口空闲。
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

// Python标准库只提供测试OS PTY；secret始终留在该临时fixture内存，不向测试日志输出终端正文。
const terminal = String.raw`
import os,pty,subprocess,sys,select,time,json,re,signal,fcntl,termios,urllib.request,urllib.error,base64,sqlite3,array
children=[]
fds=[]
cleanup=[]
mode=sys.argv[6] if len(sys.argv)>6 else 'decline'
def own_terminal():
 fcntl.ioctl(0,termios.TIOCSCTTY,0)
def process_observation(child,fd):
 queued=array.array('i',[0])
 try:fcntl.ioctl(fd,termios.FIONREAD,queued,True)
 except OSError:queued[0]=-1
 try:
  with open('/proc/'+str(child.pid)+'/wchan') as stream:waiting=stream.read().strip()
 except OSError:waiting='unavailable'
 return {'exited':child.poll() is not None,'tty_queued_bytes':queued[0],'waiting':waiting}
def native_read(phase='initial'):
 # 只对该合成身份刚获批准的实际MCP endpoint做只读原生调用；不创建Agent、不发送模型prompt。
 gateway_config=json.load(open(sys.argv[3]))
 root=gateway_config['data']['directory']
 credential=json.load(open(root+'/managed/mcp-client.json'))
 providers=json.load(open(root+'/managed/providers.json'))['providers']
 endpoint=credential['resource']
 session=None; sequence=0;current_kind='none';rpc_observations=[]
 def rpc(method,params,notification=False):
  nonlocal session,sequence
  sequence+=1
  message={'jsonrpc':'2.0','method':method,'params':params}
  if not notification:message['id']=sequence
  headers={'content-type':'application/json','accept':'application/json, text/event-stream','authorization':'Bearer '+credential['token']}
  if session:headers.update({'mcp-session-id':session,'mcp-protocol-version':'2025-11-25'})
  request=urllib.request.Request(endpoint,data=json.dumps(message).encode(),headers=headers,method='POST')
  started=time.monotonic()
  with urllib.request.urlopen(request,timeout=10) as response:
   session=session or response.headers.get('mcp-session-id')
   if notification:return None
   if response.headers.get('content-type','').startswith('text/event-stream'):
    size=0
    while True:
     line=response.readline(1048577);size+=len(line)
     if size>1048576:raise RuntimeError('fixture_mcp_size')
     if not line:raise RuntimeError('fixture_mcp_sse_ended')
     if line.startswith(b'data: '):
      packet=json.loads(line[6:])
      if packet.get('id')==sequence:break
   else:
    content=response.read(1048577)
    if len(content)>1048576:raise RuntimeError('fixture_mcp_size')
    packet=json.loads(content)
   rpc_observations.append({'method':method,'elapsed_ms':round((time.monotonic()-started)*1000),'sse':response.headers.get('content-type','').startswith('text/event-stream')})
   if 'error' in packet:raise RuntimeError('fixture_mcp_rpc_error')
   return packet['result']
 def tool(name,arguments):
  try:result=rpc('tools/call',{'name':name,'arguments':arguments})
  except TimeoutError:
   try:
    with sqlite3.connect('file:'+root+'/gateway.db?mode=ro',uri=True,timeout=0.1) as database:
     # 只输出固定状态/本例两种方法，不输出call ID、epoch、身份、原请求/响应或secret。
     states=database.execute('SELECT provider_kind,method,state,content_status,response_category,response_bytes FROM calls ORDER BY created LIMIT 8').fetchall()
   except sqlite3.Error:states='metadata_unavailable'
   observation={'phase':phase,'kind':current_kind,'tool':name,'states':states,'previous_rpc':rpc_observations[-8:],
    'gateway':process_observation(gateway,gfd),'connector':process_observation(connector,cfd)}
   raise RuntimeError('fixture_mcp_timeout '+json.dumps(observation)) from None
  if result.get('isError'):raise RuntimeError('fixture_mcp_tool_error: '+str(result.get('structuredContent',{}).get('gateway_error',{}).get('code','unknown')))
  return result['structuredContent']['data']
 rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'isolated-first-pairing','version':'1'}})
 rpc('notifications/initialized',{},True)
 for entry in providers:
  provider=entry['value']; luvus=provider['kind']=='luvus'
  current_kind=provider['kind']
  config=provider if luvus else provider['config']
  target=config['target']; revision=config['binding']['binding_revision'] if luvus else config['binding_revision']
  method='pane.list' if luvus else 'workspace.list'; params={'all_tabs':True} if luvus else {}
  description=tool('runtime_describe',{'target':target,'expected_binding_revision':revision,'method':method})
  call=tool('runtime_call',{'target':target,'expected_binding_revision':revision,'contract_ref':description['contract_ref'],'native_request':{'method':method,'params':params},'validation':'strict','deadline':int(time.time()*1000)+10000,'wait_ms':1000})
  for _ in range(10):
   if call['state']=='responded':break
   call=tool('runtime_call_get',{'call_id':call['call_id'],'wait_ms':500})
  if call['state']!='responded':raise RuntimeError('fixture_native_result_not_responded')
  result=tool('runtime_result_read',{'result_id':call['result']['result_id'],'max_bytes':4096})
  if not result['eof']:raise RuntimeError('fixture_native_result_incomplete')
  raw=base64.b64decode(result['chunk']) if result['encoding']=='base64' else result['chunk'].encode()
  if ('panes' if luvus else 'workspaces') not in json.loads(raw)['result']:raise RuntimeError('fixture_native_result_shape')
 # 结束本例MCP session不会停止Gateway，也不撤销native工作。
 request=urllib.request.Request(endpoint,headers={'authorization':'Bearer '+credential['token'],'mcp-session-id':session,'mcp-protocol-version':'2025-11-25'},method='DELETE')
 with urllib.request.urlopen(request,timeout=5) as response:response.read()
def launch(path):
 master,slave=pty.openpty()
 command=[sys.argv[7]] if len(sys.argv)>7 and sys.argv[7] else [sys.argv[1],'--no-env-file',sys.argv[2]]
 if mode=='cancel-schema-unconfirmed' and path[0]=='connector':command=[sys.argv[1],'--no-env-file','--preload',sys.argv[9],sys.argv[2]]
 child=subprocess.Popen(command+[path[0],'--config',path[1]],stdin=slave,stderr=slave,stdout=subprocess.PIPE,start_new_session=True,preexec_fn=own_terminal)
 os.close(slave); children.append(child); fds.append(master)
 return child,master,bytearray()
def read_until(child,fd,data,pattern):
 end=time.monotonic()+15
 while time.monotonic()<end:
  found=re.search(pattern,bytes(data))
  if found:return found
  if child.poll() is not None:raise RuntimeError('fixture_cli_exited: '+pattern.decode())
  watch=[fd]
  if child is globals().get('gateway') and 'cfd' in globals():watch.append(cfd)
  ready,_,_=select.select(watch,[],[],0.05)
  if 'cfd' in globals() and cfd in ready and cfd!=fd:
   try:cdata.extend(os.read(cfd,4096))
   except OSError:pass
  if fd in ready:
   try:chunk=os.read(fd,4096)
   except OSError:chunk=b''
   data.extend(chunk)
   if len(data)>65536:raise RuntimeError('fixture_output_limit')
 combined=bytes(data)+(bytes(cdata) if 'cdata' in globals() else b'')
 codes=re.findall(rb'(?:runtime_failed|configuration_required|backend_unavailable|native_unavailable [a-z_]+|connector_transport [a-z_]+ provider_ready=(?:true|false)(?: reason=[a-z_]+)?|gateway_waiting_for_connector|connector_authenticated native_pending|setup_observation_unavailable)',combined)
 raise RuntimeError('fixture_prompt_timeout: '+pattern.decode()+' fixed_codes='+str(codes))
try:
 gateway,gfd,gdata=launch(('gateway',sys.argv[3]))
 read_until(gateway,gfd,gdata,rb'Pair one Connector.*\[y/N\] ')
 os.write(gfd,b'y\n')
 found=read_until(gateway,gfd,gdata,rb'([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{32,256})\r?\n')
 code=found.group(1)
 connector,cfd,cdata=launch(('connector',sys.argv[4]))
 read_until(connector,cfd,cdata,rb'Gateway address.*: ')
 os.write(cfd,sys.argv[5].encode()+b'\n')
 read_until(connector,cfd,cdata,rb'One-time pairing code.*: ')
 os.write(cfd,code+b'\n')
 read_until(connector,cfd,cdata,rb'Trust this Gateway.*\[y/N\] ')
 os.write(cfd,b'y\n')
 read_until(connector,cfd,cdata,rb'pairing_completed')
 native=len(sys.argv)>6 and sys.argv[6]=='native'
 if native:
  provider=json.load(open(sys.argv[4])).get('native',{}).get('provider','luvus')
  selected=['luvus','herdr'] if provider=='mixed' else [provider]
  for kind in selected:
   read_until(connector,cfd,cdata,rb'Discover this '+kind.capitalize().encode()+rb'.*\[y/N\] ')
   os.write(cfd,b'y\n')
  read_until(gateway,gfd,gdata,rb'Allow this paired device.*\[y/N\] ')
  os.write(gfd,b'y\n')
  read_until(connector,cfd,cdata,rb'Native state prepared')
  read_until(gateway,gfd,gdata,rb'connector_ready')
  native_read()
  os.write(cfd,b'\x03');connector.wait(timeout=15)
  if connector.returncode!=0:raise RuntimeError('fixture_connector_exit')
  # 正式入口重开原凭据与账本，不再配对或创建第二份初始化记录。
  connector,cfd,cdata=launch(('connector',sys.argv[4]))
  read_until(connector,cfd,cdata,rb'connector_transport ready provider_ready=true')
  native_read('restarted')
  os.write(cfd,b'\x03');connector.wait(timeout=15)
  if connector.returncode!=0:raise RuntimeError('fixture_connector_restart_exit')
 elif mode.startswith('cancel-schema'):
  read_until(connector,cfd,cdata,rb'Discover this Herdr.*\[y/N\] ')
  os.write(cfd,b'y\n')
  until=time.monotonic()+10
  while not os.path.exists(sys.argv[8]):
   if time.monotonic()>until:raise RuntimeError('fixture_schema_not_entered')
   time.sleep(0.01)
  with open(sys.argv[8]) as stream:pid=int(stream.read())
  pidfd=os.pidfd_open(pid)
  saved_path=json.load(open(sys.argv[4]))['data']['directory']+'/managed/device.json'
  original_credential=open(saved_path,'rb').read()
  try:
   connector.send_signal(signal.SIGTERM)
   if mode=='cancel-schema-unconfirmed':
    # 此分支故意拒绝产品kill；只有测试自己持有的pidfd才能做故障后的最终清理。
    read_until(connector,cfd,cdata,rb'runtime_failed\r?\n')
    if select.select([pidfd],[],[],0)[0]:raise RuntimeError('fixture_expected_live_command')
    signal.pidfd_send_signal(pidfd,signal.SIGKILL)
    connector.wait(timeout=15)
    if connector.returncode!=1:raise RuntimeError('fixture_unconfirmed_cleanup_hidden')
   else:
    connector.wait(timeout=15)
    if connector.returncode!=0:raise RuntimeError('fixture_cancelled_schema_exit')
   if not select.select([pidfd],[],[],0)[0]:raise RuntimeError('fixture_schema_child_not_exited')
  finally:
   if not select.select([pidfd],[],[],0)[0]:signal.pidfd_send_signal(pidfd,signal.SIGKILL)
   os.close(pidfd)
  if os.path.exists(os.path.dirname(saved_path)+'/herdr-setup.json'):raise RuntimeError('fixture_cancelled_journal_created')
  connector,cfd,cdata=launch(('connector',sys.argv[4]))
  read_until(connector,cfd,cdata,rb'Discover this Herdr.*\[y/N\] ')
  os.write(cfd,b'n\n');connector.wait(timeout=15)
  if connector.returncode!=2:raise RuntimeError('fixture_retry_decline_exit')
  if open(saved_path,'rb').read()!=original_credential:raise RuntimeError('fixture_retry_identity_replaced')
 else:
  # 默认回归不批准native初始化；没有执行其schema/version或启动server的路径。
  os.write(cfd,b'n\n')
  connector.wait(timeout=15)
  if connector.returncode!=2:raise RuntimeError('fixture_connector_exit')
 # Gateway仍真实运行，Ctrl-C必须从readline原始模式交回唯一CLI信号处理并释放双库。
 if gateway.poll() is not None:raise RuntimeError('fixture_gateway_stopped_early')
 os.write(gfd,b'\x03')
 gateway.wait(timeout=15)
 if gateway.returncode!=0:raise RuntimeError('fixture_gateway_exit')
 if code in bytes(cdata):raise RuntimeError('fixture_secret_echoed')
 if connector.stdout.read() or gateway.stdout.read():raise RuntimeError('fixture_stdout_not_empty')
 print(json.dumps({'paired':True,'native_ready':native,'gateway_exit':0,'connector_exit':connector.returncode,'secret_echoed':False}))
finally:
 for child in children:
  forced=False
  if child.poll() is None:
   child.send_signal(signal.SIGTERM)
   try:child.wait(timeout=3)
   except subprocess.TimeoutExpired:forced=True;child.kill();child.wait()
  cleanup.append({'exit':child.returncode,'forced':forced})
 if sys.exc_info()[0] is not None:sys.stderr.write('fixture_cleanup '+json.dumps(cleanup)+'\n')
 for fd in fds:os.close(fd)
`

test(
  '正式TTY双角色兑换原enrollment并持久保存，拒绝native后不伪报ready且Ctrl-C正常回收唯一writer',
  { timeout: 60_000 },
  /* 测试只创建自有临时合成身份；不提供假的authorize/credential sink或native成功回调。 */ async () => {
    if (process.platform !== 'linux' || !process.versions.bun) {
      return
    }
    const root = mkdtempSync(join(tmpdir(), 'rovloom-pairing-terminal-'))
    const gatewayState = join(root, 'gateway')
    const connectorState = join(root, 'connector')
    for (const path of [gatewayState, connectorState]) {
      privateDirectory(path)
    }
    const mcp = await port()
    let devices = await port()
    while (devices === mcp) {
      devices = await port()
    }
    const gatewayPath = join(root, 'gateway.json')
    const connectorPath = join(root, 'connector.json')
    writeFileSync(
      gatewayPath,
      JSON.stringify(
        configDocument({
          ...configTemplate('gateway'),
          state_dir: gatewayState,
          mcp_port: mcp,
          device_port: devices,
          management_enabled: false
        })
      ),
      { mode: 0o600 }
    )
    writeFileSync(
      connectorPath,
      JSON.stringify(configDocument({ ...configTemplate('connector'), state_dir: connectorState })),
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
          gatewayPath,
          connectorPath,
          'ws://127.0.0.1:' + devices
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let output = ''
      let errors = ''
      child.stdout.on(
        'data',
        /* Python只输出固定结果，没有终端正文或secret。 */ (data) => {
          output += data
        }
      )
      child.stderr.on(
        'data',
        /* Python固定异常码可定位边界，不输出已捕获TTY正文。 */ (data) => {
          errors += data
        }
      )
      const [code] = await once(child, 'exit')
      assert.equal(code, 0, errors)
      assert.deepEqual(JSON.parse(output), {
        paired: true,
        native_ready: false,
        gateway_exit: 0,
        connector_exit: 2,
        secret_echoed: false
      })
      const saved = loadCredential(join(connectorState, 'managed', 'device.json'))
      const local = JSON.parse(readFileSync(join(connectorState, 'managed', 'pairing.json'), 'utf8'))
      assert.equal(local.machine_id, saved.machine_id)
      assert.equal(local.phase, 'paired')
      assert.deepEqual(readdirSync(join(connectorState, 'managed')).sort(), ['device.json', 'pairing.json'])
      const active = JSON.parse(readFileSync(join(gatewayState, 'managed', 'setup-active.json'), 'utf8'))
      const plan = JSON.parse(
        readFileSync(join(gatewayState, 'managed', 'setup_' + active.attempt_id + '.json'), 'utf8')
      )
      assert.equal(plan.phase, 'paired')
      assert.equal(plan.machine_id, saved.machine_id)
      const database = new DatabaseSync(join(gatewayState, 'gateway.db'), { readOnly: true })
      try {
        assert.equal(Number(database.prepare('SELECT count(*) AS n FROM machines').get()!.n), 1)
        assert.equal(Number(database.prepare('SELECT count(*) AS n FROM providers').get()!.n), 0)
      } finally {
        database.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

// 显式提供真实安装时才运行native验收；默认CI不把未执行的官方安装探针记为通过或skip。
async function nativeProbe(
  provider: 'luvus' | 'herdr' | 'mixed',
  binaryDirectory: string,
  mode: 'native' | 'cancel-schema' | 'cancel-schema-unconfirmed' = 'native'
): Promise<void> {
  const root = mkdtempSync(join(dirname(dirname(binaryDirectory)), 'rvl-'))
  const gatewayState = join(root, 'gateway')
  const connectorState = join(root, 'connector')
  for (const path of [gatewayState, connectorState]) {
    privateDirectory(path)
  }
  const mcp = await port()
  let devices = await port()
  while (devices === mcp) {
    devices = await port()
  }
  const gatewayPath = join(root, 'gateway.json')
  const connectorPath = join(root, 'connector.json')
  writeFileSync(
    gatewayPath,
    JSON.stringify(
      configDocument({
        ...configTemplate('gateway'),
        state_dir: gatewayState,
        mcp_port: mcp,
        device_port: devices,
        management_enabled: false
      })
    ),
    { mode: 0o600 }
  )
  writeFileSync(
    connectorPath,
    JSON.stringify(
      configDocument({
        ...configTemplate('connector'),
        state_dir: connectorState,
        native: { runtime_bin_dir: binaryDirectory, ...(provider !== 'luvus' ? { provider } : {}) }
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
        gatewayPath,
        connectorPath,
        'ws://127.0.0.1:' + devices,
        mode,
        process.env.ROVLOOM_TEST_STANDALONE ?? '',
        join(binaryDirectory, 'schema.pid'),
        join(binaryDirectory, 'kill-failure.mjs')
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let output = ''
    let errors = ''
    child.stdout.on(
      'data',
      /* 只收集不含secret的固定测试结果。 */ (data) => {
        output += data
      }
    )
    child.stderr.on(
      'data',
      /* 只收集Python固定异常码，不输出TTY正文。 */ (data) => {
        errors += data
      }
    )
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, errors)
    assert.deepEqual(JSON.parse(output), {
      paired: true,
      native_ready: mode === 'native',
      gateway_exit: 0,
      connector_exit: mode === 'native' ? 0 : 2,
      secret_echoed: false
    })
    const pairing = JSON.parse(readFileSync(join(connectorState, 'managed', 'pairing.json'), 'utf8'))
    assert.equal(pairing.phase, mode === 'native' ? 'configured' : 'paired')
    if (mode !== 'native') {
      assert.deepEqual(readdirSync(join(connectorState, 'managed')).sort(), ['device.json', 'pairing.json'])
      assert.equal(existsSync(join(connectorState, 'managed', 'herdr-setup.json')), false)
      const database = new DatabaseSync(join(gatewayState, 'gateway.db'), { readOnly: true })
      try {
        assert.equal(Number(database.prepare('SELECT count(*) AS n FROM machines').get()!.n), 1)
        assert.equal(Number(database.prepare('SELECT count(*) AS n FROM providers').get()!.n), 0)
      } finally {
        database.close()
      }
      return
    }
    const registry = JSON.parse(readFileSync(join(connectorState, 'managed', 'providers.json'), 'utf8'))
    const kinds = provider === 'mixed' ? ['luvus', 'herdr'] : [provider]
    assert.deepEqual(
      registry.providers.map(
        /* 每份记录保留自己的来源kind，不合并成隐式混合provider。 */ (entry: any) => entry.value.kind
      ),
      kinds
    )
    for (const entry of registry.providers) {
      const value = entry.value
      if (value.kind === 'herdr') {
        assert.equal(value.config.connector.local.allow_terminal_execution, false)
        assert.equal(value.config.connector.receipts.mode, 'open')
        assert.equal(value.config.connector.claims.mode, 'open')
        assert.equal(
          createHash('sha256').update(readFileSync(value.config.schema_path)).digest('hex'),
          value.config.expected_source.schema_sha256
        )
        continue
      }
      assert.equal(value.storage_mode, 'open')
      const record = JSON.parse(readFileSync(value.native.root_record, 'utf8'))
      assert.equal(
        record.config.binary_sha256,
        createHash('sha256')
          .update(readFileSync(join(binaryDirectory, 'luvus')))
          .digest('hex')
      )
      assert.equal(record.config.allow_terminal_execution, false)
    }
    const active = JSON.parse(readFileSync(join(gatewayState, 'managed', 'setup-active.json'), 'utf8'))
    const plan = JSON.parse(readFileSync(join(gatewayState, 'managed', 'setup_' + active.attempt_id + '.json'), 'utf8'))
    assert.equal(plan.phase, 'ready')
    assert.deepEqual(plan.providers, kinds)
    const database = new DatabaseSync(join(gatewayState, 'gateway.db'), { readOnly: true })
    try {
      assert.equal(Number(database.prepare('SELECT count(*) AS n FROM machines').get()!.n), 1)
      assert.equal(Number(database.prepare('SELECT count(*) AS n FROM providers').get()!.n), kinds.length)
    } finally {
      database.close()
    }
    const user = JSON.parse(readFileSync(connectorPath, 'utf8'))
    assert.deepEqual(Object.keys(user).sort(), ['data', 'gateway', 'native', 'role', 'schema_version'])
    assert.deepEqual(user.native, { runtime_bin_dir: binaryDirectory, ...(provider !== 'luvus' ? { provider } : {}) })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

for (const mode of ['cancel-schema', 'cancel-schema-unconfirmed'] as const) {
  test(
    `Herdr固定schema问答后SIGTERM ${mode}区分实际回收与故障，保留原配对身份且不创建journal`,
    { timeout: 60_000 },
    /* 真实CLI/TTY及真实静态命令child；故障分支仅阻断kill，不提供native或身份成功替身。 */ async () => {
      if (process.platform !== 'linux' || !process.versions.bun) {
        return
      }
      const root = privateHerdrTestRoot('.schema-cancel-')
      const binaryDirectory = join(root, 'bin')
      privateDirectory(binaryDirectory)
      const binary = join(binaryDirectory, 'herdr')
      const pid = join(binaryDirectory, 'schema.pid').replaceAll("'", "'\\''")
      writeFileSync(
        binary,
        `#!/bin/sh\ncase "$*" in\n--version) printf 'herdr synthetic-cancel\\n' ;;\n'api schema --json') printf '%s' "$$" > '${pid}'; exec /bin/sleep 30 ;;\n*) exit 99 ;;\nesac\n`,
        { mode: 0o700 }
      )
      writeFileSync(
        join(binaryDirectory, 'kill-failure.mjs'),
        `import {ChildProcess} from 'node:child_process';\nconst original=ChildProcess.prototype.kill;\nChildProcess.prototype.kill=function(signal){\n if(this.spawnargs?.[0]===${JSON.stringify(binary)} && this.spawnargs.slice(1).join(' ')==='api schema --json') return false;\n return original.call(this,signal);\n};\n`,
        { mode: 0o600 }
      )
      try {
        await nativeProbe('herdr', binaryDirectory, mode)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}

for (const provider of ['luvus', 'herdr', 'mixed'] as const) {
  const directory = provider === 'luvus' ? process.env.ROVLOOM_TEST_LUVUS_DIR : process.env.ROVLOOM_TEST_HERDR_DIR
  if (directory) {
    test(
      `隔离官方${provider}安装经正式TTY配对、实测发现、HTTP MCP只读调用及原状态重启，未调用模型`,
      { timeout: 60_000 },
      /* 安装目录只写入正式业务配置；真实生产factory负责来源、进程及账本，不替换授权或回调成功。 */ async () => {
        await nativeProbe(provider, directory)
      }
    )
  }
}

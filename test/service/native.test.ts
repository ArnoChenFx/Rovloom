// 通过受控 runner 与内存注册表检验原生命令计划和所有权边界；不模拟成三平台实机验收。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeServiceBackend } from '../../src/service/native.js'
import { registrationFiles, type RegistrationFiles } from '../../src/service/files.js'
import { renderDefinition } from '../../src/service/render.js'
import { manifest } from '../../src/service/spec.js'
import { checkedCommand, runSystemCommand, type CommandPlan, type CommandRunner } from '../../src/service/runner.js'
import { inspectTask, taskCall, TASK_SCRIPT } from '../../src/service/windows.js'
import { sampleSpec } from './helpers.js'

// 仅在内存记录注册的独占写和精确删除，不向原生系统路径写入。
function memoryFiles() {
  const data = new Map<string, string>()
  const removed: string[] = []
  const files: RegistrationFiles = {
    verify: /* 受控测试中不检查宿主系统控制目录。 */ async () => {},
    read: /* 从内存注册表读取固定文件。 */ async (name) => data.get(name),
    create: /* 模拟独占创建，禁止覆盖。 */ async (name, content) => {
      assert(!data.has(name))
      data.set(name, content)
    },
    remove: /* 删除时核对完整内容，记录精确删除范围。 */ async (name, content) => {
      assert.equal(data.get(name), content)
      removed.push(name)
      data.delete(name)
    },
    lock: /* 该文件只检验命令计划，状态机并发由独立测试验证。 */ async (_name, operation) => operation()
  }
  return { data, removed, files }
}

test(
  'systemd plans target only the owned system unit, never --now or user startup',
  /* 核对注册、开机启用、独立启停和精确卸载的 argv。 */ async () => {
    const memory = memoryFiles()
    const spec = sampleSpec()
    let loaded = false
    let running = false
    let enabled = false
    const plans: CommandPlan[] = []
    const runner: CommandRunner = /* 模拟 systemd 的固定属性与工具退出码。 */ async (plan) => {
      plans.push(plan)
      if (plan.args.includes('show')) {
        const present = memory.data.has('rovloom-connector.service') && loaded
        return {
          code: present ? 0 : 4,
          stdout: present
            ? `LoadState=loaded\nActiveState=${running ? 'active' : 'inactive'}\nSubState=${running ? 'running' : 'dead'}\nFragmentPath=/etc/systemd/system/rovloom-connector.service\nDropInPaths=\nExecMainStatus=0\nUnitFileState=${enabled ? 'enabled' : 'disabled'}\n`
            : 'LoadState=not-found\nFragmentPath=\nDropInPaths=\n',
          stderr: ''
        }
      }
      if (plan.args.includes('daemon-reload')) {
        loaded = memory.data.has('rovloom-connector.service')
      }
      if (plan.args.includes('enable')) {
        enabled = true
      }
      if (plan.args.includes('disable')) {
        enabled = false
      }
      if (plan.args.includes('start')) {
        running = true
      }
      if (plan.args.includes('stop')) {
        running = false
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const native = createNativeServiceBackend({
      platform: 'linux',
      runner,
      files: memory.files,
      verifyRuntime: /* 只用于该受控命令计划测试。 */ async () => {}
    })
    await native.authorize()
    assert.equal(await native.inspect('connector'), undefined)
    await native.create(spec)
    await native.enable(spec, true)
    assert.equal((await native.inspect('connector'))?.enabled, true)
    assert.equal(running, false)
    await native.start(spec)
    await native.stop(spec)
    await native.enable(spec, false)
    await native.remove(spec)
    assert.deepEqual(memory.removed, ['rovloom-connector.service'])
    assert(plans.every(/* 每次执行均使用固定系统工具。 */ (p) => p.executable === '/usr/bin/systemctl'))
    assert(
      plans.every(
        /* 不使用登录域、隐式启动、全局停止或宽泛目标。 */ (p) =>
          !p.args.some(
            /* 检查潜在扩大范围的参数。 */ (a) => ['--user', '--now', 'stop-all', 'rovloom-gateway.service'].includes(a)
          )
      )
    )
  }
)

test(
  'systemd rejects foreign files, hidden drop-ins, aliased fragments and nonzero queries',
  /* 不因同名或单独标记而接管已有系统服务。 */ async () => {
    const m = memoryFiles()
    const spec = sampleSpec()
    m.data.set('rovloom-connector.service', renderDefinition(spec))
    let stdout =
      'LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/etc/systemd/system/rovloom-connector.service\nDropInPaths=/etc/systemd/system/override.conf\nExecMainStatus=0\nUnitFileState=enabled\n'
    let code = 0
    const backend = createNativeServiceBackend({
      platform: 'linux',
      files: m.files,
      runner: /* 返回受控系统查询，不调用真实 systemd。 */ async () => ({ code, stdout, stderr: 'private' }),
      verifyRuntime: /* 模拟宿主端口。 */ async () => {}
    })
    await assert.rejects(/* 附加 drop-in 会改变运行账户或命令。 */ () => backend.inspect('connector'), {
      code: 'service_conflict'
    })
    stdout = stdout
      .replace('DropInPaths=/etc/systemd/system/override.conf', 'DropInPaths=')
      .replace(
        'FragmentPath=/etc/systemd/system/rovloom-connector.service',
        'FragmentPath=/usr/lib/systemd/system/foreign.service'
      )
    await assert.rejects(/* 同名 alias 指向其它文件不能接管。 */ () => backend.inspect('connector'), {
      code: 'service_conflict'
    })
    m.data.set('rovloom-connector.service', renderDefinition(spec).replace('User=rovloom', 'User=root'))
    await assert.rejects(/* 保留项目标记但修改执行声明仍拒绝。 */ () => backend.inspect('connector'), {
      code: 'service_conflict'
    })
    m.data.set('rovloom-connector.service', renderDefinition(spec))
    code = 1
    stdout = 'LoadState=not-found\n'
    await assert.rejects(/* 权限/DBus 查询错误不能被当作未安装。 */ () => backend.inspect('connector'), {
      code: 'system_command_failed',
      nativeExitCode: 1
    })
  }
)

test(
  'LaunchDaemon uses system domain, install does not bootstrap, stop bootouts and uninstall retains data',
  /* 只验证 launchctl 计划，实际 macOS 输出兼容仍须实机核验。 */ async () => {
    const memory = memoryFiles()
    const spec = sampleSpec('darwin')
    let loaded = false
    let enabled = true
    const commands: string[][] = []
    const runner: CommandRunner = /* 模拟公开 list 表格和受控 print 诊断。 */ async (plan) => {
      assert.equal(plan.executable, '/bin/launchctl')
      commands.push([...plan.args])
      const op = plan.args[0]
      if (op === 'list') {
        return {
          code: 0,
          stdout: 'PID\tStatus\tLabel\n' + (loaded ? '200\t0\tio.rovloom.connector\n' : ''),
          stderr: ''
        }
      }
      if (op === 'print') {
        return {
          code: 0,
          stdout: 'system/io.rovloom.connector = {\n path = /Library/LaunchDaemons/io.rovloom.connector.plist\n}\n',
          stderr: ''
        }
      }
      if (op === 'print-disabled') {
        return {
          code: 0,
          stdout: `disabled services = {\n "io.rovloom.connector" => ${enabled ? 'false' : 'true'}\n}\n`,
          stderr: ''
        }
      }
      if (op === 'bootstrap') {
        loaded = true
      }
      if (op === 'bootout') {
        loaded = false
      }
      if (op === 'disable') {
        enabled = false
      }
      if (op === 'enable') {
        enabled = true
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const native = createNativeServiceBackend({
      platform: 'darwin',
      runner,
      files: memory.files,
      verifyRuntime: /* 测试中不装配真实角色。 */ async () => {}
    })
    await native.create(spec)
    await native.enable(spec, true)
    assert(!commands.some(/* 安装不可隐式启动 RunAtLoad job。 */ (c) => c[0] === 'bootstrap'))
    await native.start(spec)
    assert.equal((await native.inspect('connector'))?.state, 'running')
    await native.stop(spec)
    await native.enable(spec, false)
    await native.remove(spec)
    assert(
      commands.some(
        /* start 只 bootstrap 项目系统域 plist。 */ (c) =>
          JSON.stringify(c) ===
          JSON.stringify(['bootstrap', 'system', '/Library/LaunchDaemons/io.rovloom.connector.plist'])
      )
    )
    assert(
      commands.some(
        /* stop 只 bootout 项目标签。 */ (c) =>
          JSON.stringify(c) === JSON.stringify(['bootout', 'system/io.rovloom.connector'])
      )
    )
    assert.deepEqual(memory.removed, ['io.rovloom.connector.plist'])
  }
)

test(
  'unknown macOS diagnostics fail closed and a foreign loaded label is not absent',
  /* 不猜测本地化错误码或未知输出格式。 */ async () => {
    const memory = memoryFiles()
    const native = createNativeServiceBackend({
      platform: 'darwin',
      files: memory.files,
      runner: /* 返回未知格式。 */ async () => ({ code: 0, stdout: 'unknown format', stderr: '' }),
      verifyRuntime: /* 测试宿主端口。 */ async () => {}
    })
    await assert.rejects(/* 未来格式变化只能明确失败。 */ () => native.inspect('connector'), {
      code: 'system_command_failed'
    })
  }
)

test(
  'Windows COM plans keep script constant and stdin data separate; creation is never SCM or SYSTEM',
  /* 核对 Task Scheduler 原生 API 计划与低权限账户。 */ async () => {
    const spec = sampleSpec('win32')
    const plans: CommandPlan[] = []
    const runner: CommandRunner = /* 记录固定脚本，不执行 PowerShell。 */ async (p) => {
      plans.push(p)
      const data = JSON.parse(p.input!)
      return {
        code: 0,
        stdout: JSON.stringify(
          data.op === 'read' ? { marker: manifest(spec) } : { state: 4, enabled: true, exitCode: 0 }
        ),
        stderr: ''
      }
    }
    assert.equal((await inspectTask(runner, 'connector'))?.state, 'running')
    await taskCall(runner, 'create', 'connector', spec)
    for (const p of plans) {
      assert.equal(p.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      assert.equal(Buffer.from(p.args.at(-1)!, 'base64').toString('utf16le'), TASK_SCRIPT)
      assert(!p.args.join(' ').includes(spec.config))
    }
    assert(TASK_SCRIPT.includes("RegisterTask($p.name, $p.xml, 2, 'S-1-5-19', $null, 5"))
    assert(TASK_SCRIPT.includes('$t.Stop(0)'))
    assert(!TASK_SCRIPT.includes('sc.exe'))
    const backend = createNativeServiceBackend({
      platform: 'win32',
      files: memoryFiles().files,
      runner,
      verifyRuntime: /* 提供后台能力但故意缺少 ACL 证明。 */ async () => {}
    })
    await assert.rejects(/* 缺 Windows 账户/路径 ACL 验证器时不能注册。 */ () => backend.preflight(spec), {
      code: 'backend_unavailable'
    })
  }
)

test(
  'Windows foreign marker, access denial and malformed output remain distinct failures',
  /* 不把失败查询视为未安装，也不公开私密错误原文。 */ async () => {
    const foreign: CommandRunner = /* 模拟同名非项目任务。 */ async () => ({
      code: 0,
      stdout: '{"marker":"foreign"}',
      stderr: ''
    })
    await assert.rejects(/* 同名异物必须拒绝。 */ () => inspectTask(foreign, 'connector'), { code: 'service_conflict' })
    const denied: CommandRunner = /* 模拟 COM 明确的权限错误。 */ async () => ({
      code: 1,
      stdout: '{"error":"permission_denied"}',
      stderr: ''
    })
    await assert.rejects(/* 保留权限错误类别。 */ () => taskCall(denied, 'read', 'connector'), {
      code: 'permission_denied'
    })
    const malformed: CommandRunner = /* 模拟非 JSON 输出。 */ async () => ({
      code: 1,
      stdout: 'private output',
      stderr: ''
    })
    await assert.rejects(/* 未知诊断只报告固定码。 */ () => taskCall(malformed, 'read', 'connector'), {
      code: 'system_command_failed'
    })
  }
)

test(
  'registration lock is cross-instance and preserves unrelated files; symlink registrations are refused',
  /* 在临时目录验证真实文件锁，不触及系统注册目录。 */ async () => {
    const root = await mkdtemp(join(tmpdir(), 'rovloom-service-files-'))
    const files = registrationFiles(root)
    const second = registrationFiles(root)
    try {
      await writeFile(join(root, 'keep.db'), 'user data')
      await files.lock(
        'rovloom-connector',
        /* 持有首个文件锁时检查第二实例。 */ async () => {
          await assert.rejects(
            /* 第二实例不删除旧锁也不继续操作。 */ () =>
              second.lock('rovloom-connector', /* 冲突时该操作不可运行。 */ async () => assert.fail()),
            { code: 'service_busy' }
          )
        }
      )
      await second.lock('rovloom-connector', /* 前一个实例释放后可安全重入。 */ async () => {})
      await symlink(join(root, 'keep.db'), join(root, 'rovloom-connector.service'))
      await assert.rejects(/* 注册符号链接不能转向用户数据。 */ () => files.read('rovloom-connector.service'), {
        code: 'service_conflict'
      })
      assert.equal(await readFile(join(root, 'keep.db'), 'utf8'), 'user data')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }
)

test(
  'real controlled runner preserves argv, propagates exit status, bounds time and output',
  /* 只启动隔离 Bun 子进程验证执行器，绝不调用服务设施。 */ async () => {
    const arg = '汉字 space $HOME `literal` "quote"'
    const result = await runSystemCommand({
      executable: process.execPath,
      args: ['--no-env-file', '-e', 'console.log(JSON.stringify(process.argv.slice(1)));process.exit(23)', arg]
    })
    assert.deepEqual(JSON.parse(result.stdout), [arg])
    assert.equal(result.code, 23)
    await assert.rejects(
      /* 非零退出码由内部命令检查器传播。 */ () =>
        checkedCommand(/* 固定受控退出码。 */ async () => result, { executable: '/unused', args: [] }),
      { code: 'system_command_failed', nativeExitCode: 23 }
    )
    await assert.rejects(
      /* 超时子进程被直接回收。 */ () =>
        runSystemCommand({
          executable: process.execPath,
          args: ['--no-env-file', '-e', 'setInterval(()=>{},1000)'],
          timeout: 50
        }),
      { code: 'service_timeout' }
    )
    await assert.rejects(
      /* 双流总输出超限时失败且释放子进程。 */ () =>
        runSystemCommand({
          executable: process.execPath,
          args: ['--no-env-file', '-e', 'process.stdout.write("x".repeat(1100000));setInterval(()=>{},1000)']
        }),
      { code: 'system_command_failed' }
    )
  }
)

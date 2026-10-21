/** 只收集事实：官方 Luvus 在 Windows 上的 server 启动方式、状态目录、IPC 端点形式与 session list 输出（#173）。
 * 用法：bun scripts/windows/luvus-probe.mjs <含 luvus.exe 的目录>
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
const exe = join(dir, 'luvus.exe')
const out = (title, value) =>
  console.log(`\n### ${title}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
const run = (args, options = {}) => {
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 20_000, ...options })
  return {
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout ?? '').slice(0, 3000),
    stderr: (result.stderr ?? '').slice(0, 3000),
    error: result.error?.message
  }
}
const ps = (script) =>
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60_000 }).stdout

/** 递归列出目录（深度有限），含类型与大小。 */
function tree(root, depth = 4) {
  const rows = []
  const walk = (path, level) => {
    let names
    try {
      names = readdirSync(path)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(path, name)
      let info
      try {
        info = lstatSync(full)
      } catch {
        continue
      }
      rows.push(
        `${info.isDirectory() ? 'd' : info.isSymbolicLink() ? 'l' : info.isSocket() ? 's' : 'f'} ${info.size} ${full}`
      )
      if (info.isDirectory() && level < depth) {
        walk(full, level + 1)
      }
    }
  }
  walk(root, 0)
  return rows
}

out('files in luvus dir', readdirSync(dir))
out('--version', run(['--version']))
out('--help', run(['--help']))
out('server --help', run(['server', '--help']))
out('session --help', run(['session', '--help']))

const home = process.env.USERPROFILE
const roots = [join(home, '.luvus'), process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)
const before = new Set(roots.flatMap((root) => tree(root, 3)))
out('session list --json (no server)', run(['session', 'list', '--json']))

const child = spawn(exe, ['--session', 'default', 'server'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let log = ''
child.stdout.on('data', (chunk) => (log += chunk))
child.stderr.on('data', (chunk) => (log += chunk))
await new Promise((resolve) => setTimeout(resolve, 6000))
out('server pid / exited', { pid: child.pid, exitCode: child.exitCode, log: log.slice(0, 3000) })

const after = roots.flatMap((root) => tree(root, 3))
out('new files after server start', after.filter((row) => !before.has(row)).slice(0, 200))
out('~/.luvus tree', existsSync(join(home, '.luvus')) ? tree(join(home, '.luvus'), 5) : 'missing')
out(
  'named pipes matching luvus',
  ps("[System.IO.Directory]::GetFiles('\\\\.\\pipe\\') | Where-Object { $_ -match 'luvus' }")
)
out('all named pipes (count)', ps("([System.IO.Directory]::GetFiles('\\\\.\\pipe\\')).Count"))
out(
  'server process',
  ps(
    `Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}" | Select-Object ProcessId,ExecutablePath,CommandLine | Format-List | Out-String`
  )
)
out(
  'listening tcp ports of server',
  ps(
    `Get-NetTCPConnection -OwningProcess ${child.pid} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,State | Format-Table | Out-String`
  )
)
out('session list --json (server up)', run(['session', 'list', '--json']))
out('session list (server up)', run(['session', 'list']))

// 若有 socket 文件，试 AF_UNIX 连接；若有命名管道，试用 net.connect 打开。
for (const row of after) {
  const match = /\.sock$/u.exec(row)
  if (!match) {
    continue
  }
  const path = row.split(' ').slice(2).join(' ')
  const verdict = await new Promise((resolve) => {
    import('node:net').then(({ connect }) => {
      const socket = connect(path)
      const timer = setTimeout(() => {
        socket.destroy()
        resolve('timeout')
      }, 3000)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.destroy()
        resolve('connected')
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        resolve(`error ${error.code}`)
      })
    })
  })
  out(`AF_UNIX connect ${path}`, verdict)
}
child.kill()
out('after kill: session list --json', run(['session', 'list', '--json']))
out(
  'after kill: files',
  roots
    .flatMap((root) => tree(root, 3))
    .filter((row) => !before.has(row))
    .slice(0, 200)
)

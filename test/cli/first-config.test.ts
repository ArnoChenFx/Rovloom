// 首次配置只使用测试自有HOME；真实Gateway保持未配对且不签发身份、密钥或调用模型。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { configDocument, configTemplate, readConfig } from '../../src/cli/config.js'
import { readOrCreateRoleConfig } from '../../src/cli/first-config.js'
import { createProductionCliRuntime } from '../../src/cli/production.js'
import { createProductSources } from '../../src/cli/product-sources.js'
import { runCli } from '../../src/cli/run.js'

// 临时HOME及其全部生成内容仅归本例拥有。
function temporary(check: (home: string) => void | Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'rovloom-first-role-'))
  return Promise.resolve()
    .then(/* 统一处理同步和异步测试。 */ () => check(home))
    .finally(/* 清理自有配置和状态。 */ () => rmSync(home, { recursive: true, force: true }))
}

test(
  '缺失默认与显式角色文件均生成单文件0600配置，已有坏文件不覆盖',
  /* 不调用运行宿主，证明配置生成不创建凭据或状态文档。 */ async () => {
    await temporary(
      /* 独立HOME可核对生成的真实绝对数据目录。 */ (home) => {
        for (const role of ['gateway', 'connector'] as const) {
          const path = join(home, '.config', 'rovloom', role + '.json')
          const config = readOrCreateRoleConfig(role, path, { home, platform: process.platform })
          assert.equal(config.state_dir, join(home, '.local', 'share', 'rovloom', role))
          assert.deepEqual(readConfig(path), config)
          assert.equal(statSync(path).mode & 0o777, 0o600)
          assert.equal(statSync(join(home, '.config', 'rovloom')).mode & 0o777, 0o700)
          assert.equal(existsSync(join(home, '.local')), false)
          const original = readFileSync(path)
          readOrCreateRoleConfig(role, path, { home, platform: process.platform })
          assert.deepEqual(readFileSync(path), original)
          writeFileSync(path, '{"incomplete":')
          assert.throws(/* 已存在的坏文件只拒绝，不恢复默认。 */ () => readOrCreateRoleConfig(role, path), {
            code: 'invalid_config'
          })
          assert.equal(readFileSync(path, 'utf8'), '{"incomplete":')
        }
        const explicit = join(home, 'custom folder', 'selected.json')
        readOrCreateRoleConfig('gateway', explicit, { home, platform: process.platform })
        assert.equal(readConfig(explicit).role, 'gateway')
        assert.equal(existsSync(join(home, 'custom folder', 'gateway.json')), false)
      }
    )
  }
)

test(
  '首次Connector在非TTY生成配置后立即返回待配置，不等待stdin或创建身份',
  /* 真实main使用空输入和短超时；没有地址、配对或模型权限。 */ async () => {
    await temporary(
      /* 子进程只访问本例HOME。 */ (home) => {
        const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
        const result = spawnSync(process.execPath, ['--no-env-file', main, 'connector'], {
          env: { PATH: process.env.PATH ?? '', HOME: home },
          timeout: 5000,
          encoding: 'utf8',
          input: ''
        })
        assert.equal(result.error, undefined)
        assert.equal(result.status, 2)
        assert.equal(result.stdout, '')
        assert.match(result.stderr, /^configuration_required\n/)
        assert.equal(readConfig(join(home, '.config', 'rovloom', 'connector.json')).role, 'connector')
        assert.equal(existsSync(join(home, '.local')), false)
      }
    )
  }
)

test(
  '首次配置写入失败不发布空文件或残片，解除限额后可正常重试',
  /* 实际子进程文件大小限额覆盖零字节和部分写入，不用mock替代write/fsync边界。 */ async () => {
    await temporary(
      /* 所有受限写入只发生在本例HOME，失败不留下用户配置或临时文件。 */ (root) => {
        const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
        for (const limit of ['0', '1']) {
          const home = limit === '0' ? join(root, 'zero') : join(root, ...Array(12).fill('long-' + 'x'.repeat(105)))
          mkdirSync(home, { recursive: true, mode: 0o700 })
          const env = { PATH: process.env.PATH ?? '', HOME: home, NO_COLOR: '1' }
          const failed = spawnSync(
            '/bin/sh',
            [
              '-c',
              'trap "" XFSZ; ulimit -f "$1"; shift; exec "$@"',
              'config-write-limit',
              limit,
              process.execPath,
              '--no-env-file',
              main,
              'connector'
            ],
            { env, input: '', timeout: 5000, encoding: 'utf8' }
          )
          assert.equal(failed.error, undefined)
          assert.equal(failed.signal, null)
          assert.equal(failed.status, 2)
          assert.equal(failed.stdout, '')
          assert.equal(failed.stderr, 'config_unreadable\n')
          const directory = join(home, '.config', 'rovloom')
          assert.equal(existsSync(join(directory, 'connector.json')), false)
          assert.deepEqual(readdirSync(directory), [])
          const retried = spawnSync(process.execPath, ['--no-env-file', main, 'connector'], {
            env,
            input: '',
            timeout: 5000,
            encoding: 'utf8'
          })
          assert.equal(retried.error, undefined)
          assert.equal(retried.status, 2)
          assert.match(retried.stderr, /^configuration_required\n/)
          assert.equal(
            readConfig(join(directory, 'connector.json')).state_dir,
            join(home, '.local', 'share', 'rovloom', 'connector')
          )
          assert.deepEqual(readdirSync(directory), ['connector.json'])
        }
      }
    )
  }
)

test(
  '并发首次启动只发布完整的获胜配置，已有文件的字节与inode均保留',
  /* 八个真实入口竞争同一文件，不通过顺序函数调用模拟并发。 */ async () => {
    await temporary(
      /* 全部子进程仅生成本例Connector文件，无网络和身份操作。 */ async (home) => {
        const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
        const children = Array.from(
          { length: 8 },
          /* 同时启动同一缺失角色文件的独立进程。 */ () => {
            const child = spawn(process.execPath, ['--no-env-file', main, 'connector'], {
              env: { PATH: process.env.PATH ?? '', HOME: home, NO_COLOR: '1' },
              stdio: ['pipe', 'pipe', 'pipe']
            })
            let out = ''
            let err = ''
            child.stdout.on(
              'data',
              /* 不向控制台交付实际配置，只断言协议通道为空。 */ (chunk) => {
                out += chunk
              }
            )
            child.stderr.on(
              'data',
              /* 收集固定诊断，验证每个竞争者读到完整文档。 */ (chunk) => {
                err += chunk
              }
            )
            child.stdin.end()
            return {
              child,
              closed: once(child, 'close'),
              output: /* 返回已结束子进程的固定输出。 */ () => ({ out, err })
            }
          }
        )
        for (const entry of children) {
          const [code, signal] = await entry.closed
          assert.equal(code, 2)
          assert.equal(signal, null)
          assert.equal(entry.output().out, '')
          assert.match(entry.output().err, /^configuration_required\n/)
        }
        const directory = join(home, '.config', 'rovloom')
        const path = join(directory, 'connector.json')
        assert.equal(readConfig(path).role, 'connector')
        assert.deepEqual(readdirSync(directory), ['connector.json'])
        const custom =
          JSON.stringify(
            configDocument({ ...configTemplate('connector'), state_dir: join(home, 'chosen-data') }),
            null,
            '\t'
          ) + '\n'
        writeFileSync(path, custom)
        const inode = statSync(path).ino
        const result = spawnSync(process.execPath, ['--no-env-file', main, 'connector'], {
          env: { PATH: process.env.PATH ?? '', HOME: home },
          input: '',
          timeout: 5000,
          encoding: 'utf8'
        })
        assert.equal(result.status, 2)
        assert.match(result.stderr, /^configuration_required\n/)
        assert.equal(readFileSync(path, 'utf8'), custom)
        assert.equal(statSync(path).ino, inode)
        assert.deepEqual(readdirSync(directory), ['connector.json'])
      }
    )
  }
)

// 仅向内核申请并释放动态回环端口，测试不探测用户服务。
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

test(
  '空状态Gateway用真实双库及HTTP/WS启动，未配对MCP拒绝认证并正常关闭',
  /* 只调整动态端口并关闭管理页以避免依赖预先构建前端；其余正式入口和工厂保持真实。 */ async () => {
    await temporary(
      /* 角色文件与实际数据库均在同一测试HOME。 */ async (home) => {
        const ports = new Set<number>()
        while (ports.size < 2) {
          ports.add(await port())
        }
        const [mcp, devices] = [...ports] as [number, number]
        const state = join(home, 'gateway')
        const path = join(home, 'gateway.json')
        const config = {
          ...configTemplate('gateway'),
          state_dir: state,
          mcp_port: mcp,
          device_port: devices,
          management_enabled: false
        }
        writeFileSync(path, JSON.stringify(configDocument(config)), { mode: 0o600 })
        const signal = new AbortController()
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        let diagnostic = ''
        let ready!: () => void
        const listening = new Promise<void>(
          /* 真实listener就绪后才发请求。 */ (resolve) => {
            ready = resolve
          }
        )
        stderr.on(
          'data',
          /* 只观察固定的未配对提示，不输出状态内容。 */ (chunk) => {
            diagnostic += chunk
            if (diagnostic.includes('pairing_required\n')) {
              ready()
            }
          }
        )
        const running = runCli(
          ['gateway', '--config', path],
          { stdin, stdout, stderr, signal: signal.signal },
          createProductionCliRuntime(createProductSources())
        )
        try {
          await Promise.race([
            listening,
            running.then(
              /* 启动提前失败应立即结束测试。 */ (code) => {
                throw new Error('gateway_early_exit_' + code)
              }
            )
          ])
          const denied = await fetch(`http://127.0.0.1:${mcp}/mcp`)
          assert.equal(denied.status, 401)
          assert.equal(existsSync(join(state, 'gateway.db')), true)
          assert.equal(existsSync(join(state, 'runtime.json')), false)
          assert.equal(existsSync(join(state, 'refs')), false)
          assert.equal(existsSync(join(state, 'managed', 'mcp-callers.json')), false)
          assert.equal(stdout.read(), null)
        } finally {
          signal.abort()
          assert.equal(await running, 0)
          stdin.destroy()
          stdout.destroy()
          stderr.destroy()
        }
      }
    )
  }
)

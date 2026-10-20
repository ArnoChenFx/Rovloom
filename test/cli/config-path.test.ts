// 验证统一CLI的角色默认路径、显式优先及私有文件边界；真实入口缺后端仍拒绝，不提供服务stub。
import { configDocument } from '../../src/cli/config.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { configTemplate } from '../../src/cli/config.js'
import { resolveRoleConfigPath, type ConfigPathEnvironment } from '../../src/cli/config-path.js'
import { parseCommand, runCli } from '../../src/cli/run.js'

// 只在本例私有目录建立非秘密配置，结束后删除全部自有输入。
async function temporary(check: (home: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-default-config-'))
  const home = join(directory, '测试 用户')
  mkdirSync(home, { mode: 0o700 })
  try {
    await check(home)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// 写入角色匹配的无密钥配置，位置可以是默认目录或显式覆盖目录。
function configFile(home: string, role: 'gateway' | 'connector', folder = '.config/rovloom') {
  const directory = join(home, folder)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${role}.json`)
  const config = { ...configTemplate(role), state_dir: join(home, 'state', role), gateway_url: 'ws://localhost:9443' }
  writeFileSync(path, JSON.stringify(configDocument(config)), {
    mode: 0o600
  })
  return path
}

// 捕获唯一分派器的固定输出；没有注入角色宿主，合法配置也不能假报启动成功。
async function capture(args: string[], environment: ConfigPathEnvironment) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', /* 观察协议通道是否保持空白。 */ (chunk) => (out += chunk))
  stderr.on('data', /* 观察固定诊断且不读取后端异常。 */ (chunk) => (err += chunk))
  stdin.end()
  const code = await runCli(args, { stdin, stdout, stderr, signal: new AbortController().signal }, {}, environment)
  return { code, stdout: out, stderr: err }
}

test(
  '两角色按home/.config/rovloom选默认文件，路径保留空格Unicode且不改用AppData',
  /* POSIX和Windows只改变路径分隔符；默认文件名严格绑定命令角色。 */ async () => {
    for (const role of ['gateway', 'connector'] as const) {
      assert.equal(
        resolveRoleConfigPath(role, undefined, { home: '/home/测试 用户', platform: 'darwin' }),
        `/home/测试 用户/.config/rovloom/${role}.json`
      )
      assert.equal(
        resolveRoleConfigPath(role, undefined, { home: 'C:\\Users\\测试 用户', platform: 'win32' }),
        `C:\\Users\\测试 用户\\.config\\rovloom\\${role}.json`
      )
    }
    await temporary(
      /* 两个默认文件同时存在，选择结果仍须匹配各自role并执行相同的缺后端拒绝。 */ async (home) => {
        for (const role of ['gateway', 'connector'] as const) {
          const path = configFile(home, role)
          const environment = { home, platform: process.platform }
          assert.deepEqual(parseCommand([role], environment), { action: role, path })
          assert.deepEqual(await capture([role], environment), {
            code: 3,
            stdout: '',
            stderr: 'backend_unavailable\n'
          })
          assert.equal(existsSync(join(home, 'state')), false)
        }
      }
    )
  }
)

test(
  '显式配置覆盖坏默认文件且不要求home，错误显式路径不回退默认文件',
  /* 显式路径先于home解析；固定路径校验继续拒绝相对路径及空值。 */ async () => {
    await temporary(
      /* 默认文件故意损坏，覆盖文件仍必须独立通过私有配置校验。 */ async (home) => {
        for (const role of ['gateway', 'connector'] as const) {
          const defaultPath = configFile(home, role)
          writeFileSync(defaultPath, '{"invalid":"SYNTHETIC_DO_NOT_PRINT"}')
          const path = configFile(home, role, '显式 配置')
          assert.equal(resolveRoleConfigPath(role, path, { home: undefined, platform: process.platform }), path)
          assert.deepEqual(await capture([role, '--config', path], { home: undefined, platform: process.platform }), {
            code: 3,
            stdout: '',
            stderr: 'backend_unavailable\n'
          })
          assert.deepEqual(await capture([role, '--config', ''], { home, platform: process.platform }), {
            code: 2,
            stdout: '',
            stderr: 'invalid_config_path\n'
          })
        }
      }
    )
  }
)

test(
  '缺home返回固定诊断，角色缺文件时生成默认配置且不读取另一角色',
  /* 帮助不需要home；生成不会调用stdin或凭据初始化。 */ async () => {
    for (const home of [undefined, '', 'relative', '/home/invalid\nvalue']) {
      assert.deepEqual(await capture(['gateway'], { home, platform: process.platform }), {
        code: 2,
        stdout: '',
        stderr: 'config_home_unavailable\n'
      })
    }
    assert.equal((await capture(['--help'], { home: undefined, platform: process.platform })).code, 0)
    await temporary(
      /* 两个角色各自生成，不把Connector当作Gateway默认文件。 */ async (home) => {
        for (const role of ['gateway', 'connector'] as const) {
          const result = await capture([role], { home, platform: process.platform })
          assert.equal(result.code, role === 'gateway' ? 3 : 2)
          assert.match(result.stderr, role === 'gateway' ? /^backend_unavailable\n$/ : /^configuration_required\n/)
          const saved = JSON.parse(readFileSync(join(home, '.config', 'rovloom', role + '.json'), 'utf8'))
          assert.equal(saved.role, role)
          assert.deepEqual(saved.data, { directory: join(home, '.local', 'share', 'rovloom', role) })
        }
        assert.equal(existsSync(join(home, '.local')), false)
      }
    )
  }
)

test(
  '默认与显式文件继续核对role和私有权限，文件名不能赋予另一角色能力',
  /* 相同读取边界覆盖角色冲突和宽松权限，不调用任何角色后端。 */ async () => {
    await temporary(
      /* 用完整有效的Connector配置覆盖Gateway文件，区分角色冲突与普通语法错误。 */ async (home) => {
        const gateway = configFile(home, 'gateway')
        const connector = configFile(home, 'connector')
        writeFileSync(
          gateway,
          JSON.stringify(configDocument({ ...configTemplate('connector'), state_dir: join(home, 'state') }))
        )
        for (const args of [['gateway'], ['gateway', '--config', connector]]) {
          assert.deepEqual(await capture(args, { home, platform: process.platform }), {
            code: 2,
            stdout: '',
            stderr: 'config_role_mismatch\n'
          })
        }
        configFile(home, 'gateway')
        chmodSync(gateway, 0o644)
        assert.deepEqual(await capture(['gateway'], { home, platform: process.platform }), {
          code: 2,
          stdout: '',
          stderr: 'config_not_protected\n'
        })
      }
    )
  }
)

test(
  '唯一真实CLI入口按系统home选角色文件且显式覆盖仍优先',
  /* 子进程只读自有角色不匹配文件，避免启动真实listener。 */ async () => {
    await temporary(
      /* 通过角色冲突证明实际main读到精确文件。 */ (home) => {
        const entry = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
        for (const role of ['gateway', 'connector'] as const) {
          const path = configFile(home, role)
          writeFileSync(
            path,
            JSON.stringify(
              configDocument({
                ...configTemplate(role === 'gateway' ? 'connector' : 'gateway'),
                state_dir: join(home, 'state')
              })
            )
          )
          for (const args of [[role], [role, '--config', path]]) {
            const result = spawnSync(process.execPath, ['--no-env-file', entry, ...args], {
              encoding: 'utf8',
              timeout: 5000,
              env: { PATH: process.env.PATH ?? '', HOME: home }
            })
            assert.equal(result.error, undefined)
            assert.equal(result.status, 2)
            assert.equal(result.stdout, '')
            assert.equal(result.stderr, 'config_role_mismatch\n')
          }
        }
      }
    )
  }
)

test(
  '无参数check分别检查两份默认用户文件，缺失也不创建目录或配置',
  /* 同时验证直接分派和实际main，不以启动命令的自动生成替代只读检查。 */ async () => {
    await temporary(
      /* 整个HOME起初没有.config，两种检查均保持原样。 */ async (home) => {
        const environment = { home, platform: process.platform }
        for (const action of ['check', 'check-runtime']) {
          assert.deepEqual(await capture(['config', action], environment), {
            code: 2,
            stdout: '',
            stderr: 'gateway config_not_found\nconnector config_not_found\n'
          })
          assert.deepEqual(await capture(['config', action, '--role', 'gateway'], environment), {
            code: 2,
            stdout: '',
            stderr: 'config_not_found\n'
          })
          assert.equal(existsSync(join(home, '.config')), false)
        }
        const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
        const actual = spawnSync(process.execPath, ['--no-env-file', main, 'config', 'check'], {
          env: { PATH: process.env.PATH ?? '', HOME: home },
          input: '',
          timeout: 5000,
          encoding: 'utf8'
        })
        assert.equal(actual.status, 2)
        assert.equal(actual.stdout, '')
        assert.equal(actual.stderr, 'gateway config_not_found\nconnector config_not_found\n')
        assert.equal(existsSync(join(home, '.config')), false)
      }
    )
  }
)

test(
  'check按role单选或显式覆盖，两份中一份无效仍报告另一份且不覆盖既有用户文件',
  /* 每个路径选择均有角色核验，不隐式把Gateway当作唯一默认角色。 */ async () => {
    await temporary(
      /* 两份同目录用户文件就是默认位置的配置，不另外建立defaults文件。 */ async (home) => {
        const environment = { home, platform: process.platform }
        const gateway = configFile(home, 'gateway')
        const connector = configFile(home, 'connector')
        assert.deepEqual(await capture(['config', 'check'], environment), {
          code: 0,
          stdout: '',
          stderr: 'gateway config_valid\nconnector config_valid\n'
        })
        writeFileSync(gateway, '{"incomplete":')
        assert.deepEqual(await capture(['config', 'check'], environment), {
          code: 2,
          stdout: '',
          stderr: 'gateway invalid_config\nconnector config_valid\n'
        })
        assert.equal(readFileSync(gateway, 'utf8'), '{"incomplete":')
        for (const action of ['check', 'check-runtime']) {
          const diagnostic = action === 'check' ? 'config_valid\n' : 'runtime_config_valid\n'
          assert.deepEqual(await capture(['config', action, '--role', 'connector'], environment), {
            code: 0,
            stdout: '',
            stderr: diagnostic
          })
          assert.deepEqual(
            await capture(['config', action, '--config', connector], { home: undefined, platform: process.platform }),
            {
              code: 0,
              stdout: '',
              stderr: diagnostic
            }
          )
          assert.deepEqual(await capture(['config', action, '--role', 'gateway', '--config', connector], environment), {
            code: 2,
            stdout: '',
            stderr: 'config_role_mismatch\n'
          })
        }
        for (const options of [
          ['--role', 'unknown'],
          ['--role'],
          ['--role', 'gateway', '--role', 'connector'],
          ['--config', connector, '--config', gateway]
        ]) {
          assert.deepEqual(await capture(['config', 'check', ...options], environment), {
            code: 2,
            stdout: '',
            stderr: 'invalid_arguments\n'
          })
        }
        assert.equal(existsSync(join(home, 'state')), false)
        const main = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
        configFile(home, 'gateway')
        const actual = spawnSync(process.execPath, ['--no-env-file', main, 'config', 'check'], {
          env: { PATH: process.env.PATH ?? '', HOME: home },
          input: '',
          timeout: 5000,
          encoding: 'utf8'
        })
        assert.equal(actual.status, 0)
        assert.equal(actual.stdout, '')
        assert.equal(actual.stderr, 'gateway config_valid\nconnector config_valid\n')
      }
    )
  }
)

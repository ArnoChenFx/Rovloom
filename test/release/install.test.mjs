/** 安装器只接触独占临时目录和假下载器；不访问真实 Release 或创建服务/凭据。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dir, '../..')
const shell = join(root, 'scripts/install.sh')
const payload = Buffer.from('synthetic release bytes, never executed\n')
const digest = createHash('sha256').update(payload).digest('hex')

/** 假命令只选择合成资产；补充可信 POSIX 工具路径，原隔离 PATH 的 Node 拒绝 shim 仍优先。 */
function fixture({ os = 'Linux', arch = 'x86_64', libc = 'glibc 2.39', failure = '' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rovloom-install-'))
  const commands = join(directory, 'commands')
  const home = join(directory, 'user home')
  const install = join(home, 'bin with spaces')
  mkdirSync(commands)
  mkdirSync(home)
  mkdirSync(install)
  const binary = join(directory, 'binary')
  const checksums = join(directory, 'checksums')
  const requests = join(directory, 'requests')
  writeFileSync(binary, payload)
  const selectedOs = os === 'Darwin' ? 'darwin' : 'linux'
  const selectedArch = ['arm64', 'aarch64'].includes(arch) ? 'arm64' : 'x64'
  const asset = `rovloom-0.1.0-${selectedOs}-${selectedArch}`
  let sums = `${digest}  ${asset}\n`
  if (failure === 'hash') {
    sums = `${'a'.repeat(64)}  ${asset}\n`
  }
  if (failure === 'duplicate') {
    sums += sums
  }
  if (failure === 'malformed') {
    sums = `${digest} ${asset}\n`
  }
  if (failure === 'missing') {
    sums = `${digest}  rovloom-other\n`
  }
  writeFileSync(checksums, sums)
  writeFileSync(
    join(commands, 'uname'),
    '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "$FIXTURE_OS";; -m) printf "%s\\n" "$FIXTURE_ARCH";; *) exit 9;; esac\n'
  )
  writeFileSync(join(commands, 'getconf'), '#!/bin/sh\nprintf "%s\\n" "$FIXTURE_LIBC"\n')
  writeFileSync(
    join(commands, 'curl'),
    `#!/bin/sh
set -eu
output=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2;;
    --proto|--proto-redir|--connect-timeout|--max-time|--max-filesize) shift 2;;
    --fail|--silent|--show-error|--location) shift;;
    https://*) url=$1; shift;;
    *) exit 90;;
  esac
done
printf '%s\\n' "$url" >> "$FIXTURE_REQUESTS"
case "$url" in
  https://github.com/ArnoChenFx/Rovloom/releases/download/v0.1.0/SHA256SUMS)
    [ "$FIXTURE_FAILURE" != checksums-404 ] || exit 22
    /bin/cp "$FIXTURE_CHECKSUMS" "$output" ;;
  "https://github.com/ArnoChenFx/Rovloom/releases/download/v0.1.0/$FIXTURE_ASSET")
    [ "$FIXTURE_FAILURE" != binary-404 ] || exit 22
    /bin/cp "$FIXTURE_BINARY" "$output" ;;
  *) exit 91;;
esac
`
  )
  for (const name of ['curl', 'uname', 'getconf']) {
    chmodSync(join(commands, name), 0o755)
  }
  if (failure === 'rename') {
    writeFileSync(join(commands, 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  }
  const env = {
    ...process.env,
    PATH: `${commands}:${process.env.PATH ?? ''}:/usr/bin:/bin`,
    HOME: home,
    FIXTURE_OS: os,
    FIXTURE_ARCH: arch,
    FIXTURE_LIBC: libc,
    FIXTURE_FAILURE: failure,
    FIXTURE_CHECKSUMS: checksums,
    FIXTURE_BINARY: binary,
    FIXTURE_ASSET: asset,
    FIXTURE_REQUESTS: requests
  }
  return {
    directory,
    home,
    install,
    asset,
    requests,
    run: /** 所有 argv 独立传入，不拼接 shell 命令文本。 */ (args = []) =>
      spawnSync('/bin/sh', [shell, ...args], { env, encoding: 'utf8', timeout: 10_000 }),
    close: /** 只回收本例拥有的合成目录。 */ () => rmSync(directory, { recursive: true, force: true })
  }
}

if (process.platform !== 'win32') {
  test(
    'shell installer selects the four native POSIX release assets and rejects unsupported hosts',
    /** uname/getconf 是明确假输入；不把目标资产选择测试说成四平台真实安装验收。 */ () => {
      for (const [os, arch, expected] of [
        ['Linux', 'x86_64', 'linux-x64'],
        ['Linux', 'aarch64', 'linux-arm64'],
        ['Darwin', 'x86_64', 'darwin-x64'],
        ['Darwin', 'arm64', 'darwin-arm64']
      ]) {
        const f = fixture({ os, arch })
        try {
          const result = f.run(['--print-asset'])
          assert.equal(result.status, 0, result.stderr)
          assert.equal(result.stdout, `rovloom-0.1.0-${expected}\n`)
          assert.equal(existsSync(f.requests), false)
        } finally {
          f.close()
        }
      }
      for (const input of [{ os: 'Windows_NT' }, { arch: 'armv7l' }, { libc: 'musl 1.2' }]) {
        const f = fixture(input)
        try {
          assert.notEqual(f.run(['--print-asset']).status, 0)
          assert.equal(existsSync(f.requests), false)
        } finally {
          f.close()
        }
      }
    }
  )

  test(
    'shell installer validates official bytes before replacing a program in a path containing spaces',
    /** 旧程序保持到校验通过后原子替换；合成字节从不执行。 */ () => {
      const f = fixture()
      try {
        const program = join(f.install, 'rovloom')
        writeFileSync(program, 'previous program')
        const result = f.run(['--install-dir', f.install])
        assert.equal(result.status, 0, result.stderr)
        assert.deepEqual(readFileSync(program), payload)
        assert.deepEqual(readdirSync(f.install), ['rovloom'])
        assert.deepEqual(readFileSync(f.requests, 'utf8').trim().split('\n'), [
          'https://github.com/ArnoChenFx/Rovloom/releases/download/v0.1.0/SHA256SUMS',
          `https://github.com/ArnoChenFx/Rovloom/releases/download/v0.1.0/${f.asset}`
        ])
      } finally {
        f.close()
      }
    }
  )

  test(
    'shell installer defaults to the user directory and allows an explicitly pinned stable version',
    /** 显式版本只做离线名称检查；不下载尚未存在的官方版本。 */ () => {
      const f = fixture()
      try {
        const selected = f.run(['--version', 'v1.2.3', '--print-asset'])
        assert.equal(selected.status, 0, selected.stderr)
        assert.equal(selected.stdout, 'rovloom-1.2.3-linux-x64\n')
        const installed = f.run()
        assert.equal(installed.status, 0, installed.stderr)
        assert.deepEqual(readFileSync(join(f.home, '.local/bin/rovloom')), payload)
      } finally {
        f.close()
      }
    }
  )

  test(
    'failed downloads, wrong, duplicate and malformed checksums preserve the old program and clean staging',
    /** 所有故障都发生于合成下载，失败后文件字节和执行权限均保持。 */ () => {
      for (const failure of ['checksums-404', 'binary-404', 'hash', 'duplicate', 'malformed', 'missing', 'rename']) {
        const f = fixture({ failure })
        try {
          const program = join(f.install, 'rovloom')
          writeFileSync(program, 'old program', { mode: 0o755 })
          const result = f.run(['--install-dir', f.install])
          assert.notEqual(result.status, 0, failure)
          assert.equal(readFileSync(program, 'utf8'), 'old program', failure)
          assert.deepEqual(readdirSync(f.install), ['rovloom'], failure)
        } finally {
          f.close()
        }
      }
    }
  )

  test(
    'invalid versions, relative paths and symlink destinations fail before download or mutation',
    /** 不通过隐式源替换或文件链接写入安装目标之外。 */ () => {
      const f = fixture()
      try {
        for (const args of [
          ['--version', '../main'],
          ['--version', '01.2.3'],
          ['--version', 'latest'],
          ['--version', '1.2.3+build'],
          ['--install-dir', 'relative/path'],
          ['--unknown'],
          ['--version']
        ]) {
          assert.notEqual(f.run(args).status, 0)
          assert.equal(existsSync(f.requests), false)
        }
        const outside = join(f.directory, 'outside')
        writeFileSync(outside, 'keep')
        symlinkSync(outside, join(f.install, 'rovloom'))
        assert.notEqual(f.run(['--install-dir', f.install]).status, 0)
        assert.equal(readFileSync(outside, 'utf8'), 'keep')
        assert.equal(existsSync(f.requests), false)
      } finally {
        f.close()
      }
    }
  )
}

if (process.platform === 'win32') {
  test(
    'PowerShell installer verifies native Windows selection, atomic replace and failure preservation',
    /** 本例须由 Windows CI 原生执行；其他宿主不据文本检查宣称通过 Windows 安装验收。 */ () => {
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-File', join(root, 'test/release/install-windows.ps1')],
        {
          encoding: 'utf8',
          timeout: 30_000
        }
      )
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /windows_installer_fixture_pass/)
    }
  )
}

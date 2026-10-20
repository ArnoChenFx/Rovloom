/** 纯文件与渲染回归核对免费模型、原代理引用和禁止覆盖；不联网、执行 binary 或启动 native。 */
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { prepareIsolatedOpenCode, renderIsolatedOpenCodeSetup } from '../../scripts/runtime/opencode-smoke-setup.mjs'

/** 只建立自有 0700 临时目录；合成 binary 字节必不匹配官方摘要，不会执行。 */
function fixture() {
  const root = mkdtempSync(
    join(process.env.LUVUS_TEST_ROOT ?? fileURLToPath(new URL('../../', import.meta.url)), '.opencode-setup-')
  )
  const home = join(root, 'home')
  const state_root = join(root, 'native')
  for (const path of [home, state_root, join(home, 'config')]) {
    mkdirSync(path, { mode: 0o700 })
  }
  const binary = join(root, 'untrusted-binary')
  writeFileSync(binary, 'not an official executable\n', { mode: 0o500 })
  return {
    root,
    home,
    state_root,
    binary,
    /** 仅删除本例自有且从未启动过程序的目录。 */
    close() {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test(
  'isolated OpenCode profile pins main, small and all real builtin helpers to the only free candidate',
  /** 标题、摘要和压缩不能另选未指定或收费模型。 */ () => {
    const content = renderIsolatedOpenCodeSetup({ binary: '/isolated/opencode', environment: {} })
    const profile = JSON.parse(content.profile)
    assert.equal(profile.model, 'opencode/big-pickle')
    assert.equal(profile.small_model, profile.model)
    assert.deepEqual(profile.enabled_providers, ['opencode'])
    assert.deepEqual(profile.provider, { opencode: { whitelist: ['big-pickle'] } })
    assert.deepEqual(Object.keys(profile.agent), [
      'build',
      'plan',
      'general',
      'explore',
      'title',
      'summary',
      'compaction'
    ])
    for (const agent of Object.values(profile.agent)) {
      assert.deepEqual(agent, { model: profile.model })
    }
    assert.deepEqual(profile.compaction, { auto: false })
    assert.equal(profile.autoupdate, false)
    assert.equal(profile.share, 'disabled')
    assert.deepEqual(JSON.parse(content.native), { shell: '/bin/bash' })
  }
)

test(
  'isolated OpenCode bashrc preserves exact proxy bytes, empty and unset variables using POSIX single quotes',
  /** 引号、换行和命令替换字样都只能是原环境文本，不扩展 shell 指令。 */ () => {
    const environment = {
      HTTP_PROXY: 'http://proxy.example:8080',
      HTTPS_PROXY: "http://proxy.example:8080/path?value=one'$(never-run)",
      ALL_PROXY: '',
      NO_PROXY: "one.example,two.example ' quoted\n$(never-run)",
      SSL_CERT_FILE: "/isolated/a'certificate.pem"
    }
    const { rc } = renderIsolatedOpenCodeSetup({ binary: "/isolated/bin'ary/opencode", environment })
    assert(rc.includes("export HTTP_PROXY='http://proxy.example:8080'\n"))
    assert(rc.includes("export HTTPS_PROXY='http://proxy.example:8080/path?value=one'\\''$(never-run)'\n"))
    assert(rc.includes("export ALL_PROXY=''\n"))
    assert(rc.includes("export NO_PROXY='one.example,two.example '\\'' quoted\n$(never-run)'\n"))
    assert(rc.includes("export SSL_CERT_FILE='/isolated/a'\\''certificate.pem'\n"))
    assert(rc.includes('unset SSL_CERT_DIR\n'))
    assert(rc.includes("export OPENCODE_DISABLE_MODELS_FETCH='1'\n"))
    assert(rc.includes("export OPENCODE_DISABLE_AUTOUPDATE='1'\n"))
    assert(rc.includes("  command '/isolated/bin'\\''ary/opencode' \"$@\"\n"))
    assert.equal(Object.hasOwn(environment, 'SSL_CERT_DIR'), false)
  }
)

for (const value of [
  'http://user:secret@proxy.example',
  'http://@proxy.example',
  'socks5://%75ser@proxy.example',
  'not-a-url'
]) {
  test(
    'isolated OpenCode rejects unsafe proxy input without exposing its value ' + value.startsWith('not-'),
    /** 代理 userinfo 或无法确定的格式必须失败，不能变成直连回退。 */ () => {
      assert.throws(
        /** 纯渲染拒绝输入，不进行任何网络操作或写入。 */ () =>
          renderIsolatedOpenCodeSetup({ binary: '/isolated/opencode', environment: { HTTPS_PROXY: value } }),
        /** 错误只含固定码，不能拼接 proxy、用户名或密码。 */ (error) =>
          /^opencode_setup_proxy_(?:credentials_forbidden|invalid)$/.test(error.message) &&
          !error.message.includes(value)
      )
    }
  )
}

test(
  'isolated OpenCode setup verifies real binary bytes before creating any configuration',
  /** 假 binary 的摘要失败后不得写 profile、shell 配置或 bashrc。 */ () => {
    const f = fixture()
    try {
      assert.throws(
        /** 只核文件，不执行合成 binary。 */ () => prepareIsolatedOpenCode(f),
        /opencode_setup_binary_mismatch/
      )
      for (const path of [
        join(f.home, '.bashrc'),
        join(f.state_root, 'config.json'),
        join(f.home, 'config', 'opencode')
      ]) {
        assert.equal(existsSync(path), false)
      }
    } finally {
      f.close()
    }
  }
)

test(
  'isolated OpenCode setup refuses existing or symlinked configuration without overwriting private contents',
  /** 全量预查发生在 binary 核验之前，任何已有配置都保持原字节。 */ () => {
    const f = fixture()
    try {
      const rc = join(f.home, '.bashrc')
      writeFileSync(rc, 'existing private setup\n', { mode: 0o600 })
      assert.throws(
        /** 已有文件不允许作为本轮空白 lab 配置。 */ () => prepareIsolatedOpenCode(f),
        /opencode_setup_file_exists/
      )
      assert.equal(readFileSync(rc, 'utf8'), 'existing private setup\n')
      unlinkSync(rc)
      const file = join(f.state_root, 'config.json')
      symlinkSync(join(f.root, 'missing'), file)
      assert.throws(
        /** 断链也不能被视为可覆盖的新文件。 */ () => prepareIsolatedOpenCode(f),
        /opencode_setup_file_exists/
      )
    } finally {
      f.close()
    }
  }
)

test(
  'isolated OpenCode setup requires private distinct HOME and native state directories',
  /** 仅本机属主 0700 根能写入配置；错误不暴露原始路径。 */ () => {
    const f = fixture()
    try {
      chmodSync(f.home, 0o755)
      assert.throws(
        /** 宽权限 HOME 不能充当隔离根。 */ () => prepareIsolatedOpenCode(f),
        /opencode_setup_root_untrusted/
      )
      chmodSync(f.home, 0o700)
      assert.throws(
        /** 同一目录不能同时承担 HOME 和 native 状态根。 */ () => prepareIsolatedOpenCode({ ...f, state_root: f.home }),
        /opencode_setup_root_overlap/
      )
    } finally {
      f.close()
    }
  }
)

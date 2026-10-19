/** 只为自有空白 native lab 写入固定免费 OpenCode 配置与原代理环境，不安装、联网或执行任何程序。 */
import { createHash } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, parse } from 'node:path'

const binarySha256 = '179ca421d61eefeadfa0c50e084a6e79c1623734732f0f4593f81ccfd3ab7ee9'
const model = 'opencode/big-pickle'
const forwarded = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
const proxies = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'])

/** 所有公开失败只使用固定码，避免 proxy URL、私有路径和底层异常进入普通报告。 */
function fail(code) {
  throw new Error(code)
}

/** 逐字符使用 POSIX 单引号，命令替换、引号和换行均保持原环境值，不能用 JSON 转义替代。 */
function quote(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    fail('opencode_setup_value_invalid')
  }
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/** 只接受规范绝对路径，不解析 HOME、相对目录、符号链接或父目录跳转。 */
function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || path.includes('\0')) {
    fail('opencode_setup_path_invalid')
  }
}

/** 单链接和身份戳覆盖 no-follow fd 与路径，读 binary 期间替换文件也会拒绝。 */
function stamp(entry) {
  return [entry.dev, entry.ino, entry.uid, entry.gid, entry.mode, entry.nlink, entry.size, entry.ctimeNs].join(':')
}

/** 仅允许当前用户拥有的 0700 目录；祖先不得可被其它用户改写或通过链接重定向。 */
function privateDirectory(path, privateLast = true) {
  canonical(path)
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    fail('opencode_setup_platform_unsupported')
  }
  const uid = process.getuid()
  const root = parse(path).root
  const rootUid = lstatSync(root).uid
  let current = root
  for (const part of path.slice(root.length).split('/')) {
    current = join(current, part)
    const entry = lstatSync(current)
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      (entry.mode & 0o022) !== 0 ||
      (entry.uid !== uid && entry.uid !== rootUid) ||
      (privateLast && current === path && (entry.uid !== uid || (entry.mode & 0o777) !== 0o700))
    ) {
      fail('opencode_setup_root_untrusted')
    }
  }
}

/** 连断链也视为已有配置，绝不跟随或覆盖；不读取配置正文或账户资料。 */
function absent(path) {
  try {
    lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return
    }
    throw error
  }
  fail('opencode_setup_file_exists')
}

/** 转交原环境时拒绝含 userinfo 或非 URL 的代理值，不尝试其它代理、直连地址或网络探测。 */
function environmentLines(environment) {
  return forwarded.map(
    /** 保留变量未设置、空值及精确字节；错误不携带值。 */ (name) => {
      const value = environment[name]
      if (value === undefined) {
        return 'unset ' + name
      }
      if (typeof value !== 'string' || value.includes('\0')) {
        fail('opencode_setup_environment_invalid')
      }
      if (proxies.has(name) && value !== '') {
        let parsed
        try {
          parsed = new URL(value)
        } catch {
          fail('opencode_setup_proxy_invalid')
        }
        const authority = /^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/.exec(value)?.[1]
        if (!authority || !parsed.hostname || authority.includes('@') || parsed.username || parsed.password) {
          fail('opencode_setup_proxy_credentials_forbidden')
        }
      }
      return 'export ' + name + '=' + quote(value)
    }
  )
}

/** 纯渲染供维护回归核对免费模型和 shell 引用；不写文件，也不改变调用进程环境。 */
export function renderIsolatedOpenCodeSetup({ binary, environment }) {
  canonical(binary)
  const profile = {
    $schema: 'https://opencode.ai/config.json',
    model,
    small_model: model,
    enabled_providers: ['opencode'],
    provider: { opencode: { whitelist: ['big-pickle'] } },
    agent: Object.fromEntries(
      ['build', 'plan', 'general', 'explore', 'title', 'summary', 'compaction'].map(
        /** 七个固定版本真实内置 Agent 均使用同一免费模型，包括自动标题与摘要任务。 */ (name) => [name, { model }]
      )
    ),
    compaction: { auto: false },
    autoupdate: false,
    share: 'disabled'
  }
  const rc = [
    '# 仅本次自有 native lab 使用；保留启动环境的原代理与证书配置。',
    ...environmentLines(environment),
    "export OPENCODE_DISABLE_MODELS_FETCH='1'",
    "export OPENCODE_DISABLE_AUTOUPDATE='1'",
    'opencode() {',
    '  command ' + quote(binary) + ' "$@"',
    '}',
    ''
  ].join('\n')
  return Object.freeze({ profile: JSON.stringify(profile, null, 2) + '\n', rc, native: '{"shell":"/bin/bash"}\n' })
}

/** 流式核对固定官方 release 的真实 binary，不执行它或接受配置自报的摘要。 */
function verifyBinary(binary) {
  canonical(binary)
  privateDirectory(dirname(binary), false)
  const named = lstatSync(binary, { bigint: true })
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    (named.mode & 0o022n) !== 0n ||
    (named.mode & 0o100n) === 0n
  ) {
    fail('opencode_setup_binary_untrusted')
  }
  const fd = openSync(binary, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(named)) {
      fail('opencode_setup_binary_changed')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.alloc(1_048_576)
    for (
      let count = readSync(fd, buffer, 0, buffer.length, null);
      count;
      count = readSync(fd, buffer, 0, buffer.length, null)
    ) {
      digest.update(buffer.subarray(0, count))
    }
    if (
      digest.digest('hex') !== binarySha256 ||
      stamp(fstatSync(fd, { bigint: true })) !== stamp(named) ||
      stamp(lstatSync(binary, { bigint: true })) !== stamp(named)
    ) {
      fail('opencode_setup_binary_mismatch')
    }
  } finally {
    closeSync(fd)
  }
}

/** 仅在既有私有目录内以 wx/0600 写入新文件并同步；失败不覆盖其它配置或启动 native。 */
function writePrivate(path, text) {
  privateDirectory(dirname(path))
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** initializeManagedLuvusRoot 后、native 启动前显式调用；原 proxy 值只写私有临时 bashrc，绝不返回或记录。 */
export function prepareIsolatedOpenCode({ binary, home, state_root }) {
  try {
    privateDirectory(home)
    privateDirectory(state_root)
    privateDirectory(join(home, 'config'))
    if (home === state_root || home.startsWith(state_root + '/') || state_root.startsWith(home + '/')) {
      fail('opencode_setup_root_overlap')
    }
    const environment = Object.fromEntries(
      forwarded.map(
        /** 在写文件前一次性捕获本保存环境的精确原值，不扩大整个父环境继承。 */ (name) => [name, process.env[name]]
      )
    )
    const content = renderIsolatedOpenCodeSetup({ binary, environment })
    const directory = join(home, 'config', 'opencode')
    const files = [join(directory, 'opencode.json'), join(home, '.bashrc'), join(state_root, 'config.json')]
    for (const path of files) {
      absent(path)
    }
    verifyBinary(binary)
    // mkdir 不覆盖已有目录；若调用方已创建空私有目录，只复核保护事实。
    try {
      mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error
      }
    }
    privateDirectory(directory)
    writePrivate(files[0], content.profile)
    writePrivate(files[1], content.rc)
    writePrivate(files[2], content.native)
    return Object.freeze({ binary_sha256: binarySha256, model })
  } catch (error) {
    if (error instanceof Error && /^opencode_setup_[a-z_]+$/.test(error.message)) {
      throw error
    }
    fail('opencode_setup_failed')
  }
}

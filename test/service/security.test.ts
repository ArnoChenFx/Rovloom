// 验证 macOS 扩展 ACL 的保守拒绝及全祖先覆盖，不修改任何真实系统 ACL。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { macosPermissionPaths, verifyMacosAcl } from '../../src/service/security.js'
import type { CommandRunner } from '../../src/service/runner.js'

for (const path of ['/opt/rovloom/app', '/opt', '/var/private/config.json', '/var/private']) {
  test(
    `macOS extended ACL on ${path} is rejected despite safe BSD mode`,
    /* 注入 mode 看似安全但含额外 ACE 的叶节点或祖先。 */ async () => {
      const calls: string[] = []
      const run: CommandRunner = /* 模拟 ls 的 ACL 长格式，不读取宿主文件。 */ async (p) => {
        assert.equal(p.executable, '/bin/ls')
        assert.deepEqual(p.args.slice(0, 1), ['-lde'])
        const current = p.args[1]!
        calls.push(current)
        return {
          code: 0,
          stdout:
            current === path
              ? '-rwxr-xr-x+ 1 root wheel 10 Oct 1 00:00 app\n 0: user:other allow write\n'
              : 'drwx------ 1 root wheel 10 Oct 1 00:00 item\n',
          stderr: ''
        }
      }
      await assert.rejects(
        /* 不允许扩展 ACL 绕过 root 所有权及 mode 检查。 */ () =>
          verifyMacosAcl(['/opt/rovloom/app', '/var/private/config.json'], run),
        { code: 'unsafe_installation' }
      )
      assert(calls.includes(path))
    }
  )
}

test(
  'macOS ACL inspection reaches root, accepts no-ACL xattrs and rejects missing/unknown evidence',
  /* 祖先不能遗漏，ACL 检查失败不能自动降级为只读 mode 位。 */ async () => {
    assert.deepEqual(macosPermissionPaths(['/opt/rovloom/app', '/opt/rovloom/config']), [
      '/opt/rovloom/app',
      '/opt/rovloom',
      '/opt',
      '/',
      '/opt/rovloom/config'
    ])
    const calls: string[] = []
    await verifyMacosAcl(
      ['/opt/rovloom/app'],
      /* 仅 xattr 的已知模式无需当作 ACL，但仍核验全部祖先。 */ async (p) => {
        calls.push(p.args[1]!)
        return { code: 0, stdout: '-rwxr-xr-x@ 1 root wheel 10 Oct 1 00:00 item\n', stderr: '' }
      }
    )
    assert(calls.includes('/'))
    for (const output of ['unknown', '', '-rwxr-xr-x+ 1 root wheel 10 Oct 1 item\n']) {
      await assert.rejects(
        /* 不接受未知输出或缺少 ACE 明细的 ACL 标记。 */ () =>
          verifyMacosAcl(['/opt/app'], /* 注入不可验证权限。 */ async () => ({ code: 0, stdout: output, stderr: '' })),
        { code: 'unsafe_installation' }
      )
    }
  }
)

// Windows控制目录模型与原生内存ACL探针；不创建目录、不写ACL、不注册服务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WINDOWS_CONTROL_ACL, verifyWindowsControlDirectory } from '../../src/service/windows-control.js'
import { runSystemCommand, type CommandRunner } from '../../src/service/runner.js'

test(
  '控制目录路径无效时不触发工具，成功必须完整读取固定回执',
  /* 只验证协议边界，正反权限由原生内存探针证明。 */ async () => {
    let calls = 0
    const run: CommandRunner = /* 受控命令端口只观察参数并返回固定成功事实。 */ async (plan) => {
      calls++
      assert.equal(plan.input, JSON.stringify({ directory: 'C:\\ProgramData\\Rovloom\\ServiceControl' }))
      assert.equal(plan.timeout, 10000)
      assert(plan.args.includes('-STA'))
      return { code: 0, stdout: 'control_directory_valid', stderr: '' }
    }
    for (const directory of ['relative', '\\\\server\\share', 'C:\\a\\..\\b', 'C:\\a:stream']) {
      await assert.rejects(
        /* 参数先拒绝，不能探测任意系统目录。 */ () => verifyWindowsControlDirectory(run, directory),
        {
          code: 'unsafe_installation'
        }
      )
    }
    assert.equal(calls, 0)
    await verifyWindowsControlDirectory(run, 'C:\\ProgramData\\Rovloom\\ServiceControl')
    assert.equal(calls, 1)
    await assert.rejects(
      /* 零退出也不能把缺少权限证明的空输出当成功。 */ () =>
        verifyWindowsControlDirectory(
          /* 受控空回执证明零退出不能代替权限核验。 */ async () => ({ code: 0, stdout: '', stderr: '' }),
          'C:\\ProgramData\\Rovloom\\ServiceControl'
        ),
      { code: 'unsafe_installation' }
    )
  }
)

if (process.platform === 'win32') {
  test(
    '真实CLR控制目录ACL核对覆盖叶保密、继承、祖先替换与未知owner',
    { timeout: 12000 },
    /* 描述符只存在内存，不对真实目录应用权限。 */ async () => {
      const script = `
$ErrorActionPreference='Stop'
${WINDOWS_CONTROL_ACL}
$cases=@(
  @('O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)',$true,$true),
  @('O:SYD:P(A;;FR;;;WD)',$true,$false),
  @('O:SYD:P(A;CIIO;FR;;;WD)',$true,$false),
  @('O:SYD:P(A;;FR;;;WD)',$false,$true),
  @('O:SYD:P(A;;WD;;;WD)',$false,$false),
  @('O:SYD:P(A;;DC;;;AU)',$false,$false),
  @('O:SYD:P(A;;0x4;;;AU)',$false,$true),
  @('O:SY',$false,$false),
  @('O:LSD:P(A;;FA;;;SY)',$false,$false)
)
foreach ($case in $cases) {
  $raw=[Security.AccessControl.RawSecurityDescriptor]::new([string]$case[0])
  if ((Test-ControlAcl $raw ([bool]$case[1])) -ne [bool]$case[2]) { exit 1 }
}
[Console]::Write('control_acl_valid')
`
      const result = await runSystemCommand({
        executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64')
        ],
        timeout: 10000
      })
      assert.equal(result.code, 0, result.stderr)
      assert.equal(result.stdout, 'control_acl_valid')
    }
  )
}

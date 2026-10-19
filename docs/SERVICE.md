# Boot service module / 开机服务模块

This module supplies `install`, `uninstall`, `start`, `restart`, and `stop` for a trusted CLI host.
It is an independent implementation slice, **not a deployable CLI release**. The single CLI remains
owned by its existing implementation; this change adds no second executable or parser for role commands.
Production background hosts, Windows runtime/config ACL validation and native OS acceptance remain required.

## English

| Platform | Boot registration | Runtime control | Account |
|---|---|---|---|
| Linux | `/etc/systemd/system/rovloom-{role}.service`, enabled for `multi-user.target` | system `systemctl` | Explicit existing non-root user; UID 0 aliases rejected |
| macOS | `/Library/LaunchDaemons/io.rovloom.{role}.plist`, system domain, `RunAtLoad` | `launchctl bootstrap`, `kickstart`, `bootout` | Explicit existing non-root user |
| Windows | Task Scheduler `\rovloom-{role}`, one `BootTrigger` | Native Task Scheduler COM via system Windows PowerShell | LocalService (`S-1-5-19`), no password, least privilege |

Boot means startup without an interactive login. No `ONLOGON`, LaunchAgent, default user systemd
unit, SCM registration of a console executable, service wrapper or additional installed runtime is used.
The Windows implementation uses Task Scheduler's native XML registration API with **TASK_CREATE**;
it never overwrites a task using `TASK_CREATE_OR_UPDATE`. Ordinary Bun executables do not implement
SCM's dispatcher protocol. Windows PowerShell is the built-in system bridge; no script receives interpolated paths.

`install` registers persistent boot startup and **does not start** the process. A repeat with the same
manifest repairs a disabled registration; a different executable/config/directory/account is a conflict.
For replacement, revoke boot startup with uninstall, explicitly stop the retained instance, then install the new manifest. A fresh macOS install writes/enables the
plist without bootstrapping it; `start` bootstraps it, so `RunAtLoad` does not blur installation and startup.

`start` on a running instance succeeds without duplicating it. `restart` waits for the old instance to
stop before starting. Starting/restarting an absent registration fails. Stopping an absent or stopped
registration succeeds. `stop` preserves boot enablement, so the next boot can start the service again.

`uninstall` only revokes future boot startup. It **never requests shutdown, termination or bootout**,
and it does not wait for a running/starting/stopping instance to exit. The protected declaration is retained
so later explicit stop remains authorized. Results distinguish `bootEnabled: false` from
`controlRetained: true`; `stopMode: "not_requested"` confirms that uninstall issued no stop request.
Repeated uninstall succeeds. Reinstalling the same manifest restores boot startup without restarting the instance.

Linux uninstall always retains its declaration, including inactive units: a boot job waiting on a dependency
can start between observation and unlink. Pending Unit.Job is reported as starting; only an explicit stop
issues systemctl stop to cancel such jobs before cleanup, then requires no Job and MainPID=0. Other already
quiescent disabled records may be removed after ownership/state checks. Linux requires inactive/dead,
MainPID=0 and no Job before treating a not-found unit as absent. Windows requires known task
state DISABLED/READY and no running instances before deletion; UNKNOWN/future states fail closed.
macOS retains even an exited **loaded** job, because cleanup must not bootout it; explicit stop may bootout
that job and then remove its disabled declaration. Natural exit followed by another uninstall can clean up
only a safely releasable record. A cleanup race retains the control record rather than interrupting work.

Configuration, databases, logs, credentials, accounts and user directories are never deleted or permission-adjusted.
A partial install that created its declaration but failed to enable can converge on repeat; unknown/corrupted
declarations and stale locks require administrator inspection.

Commands have bounded output (1 MiB combined) and time (normally 35 s per system request, 5 s for status
queries). The controller then observes status for at most 30 s, requiring one continuous second of
running status. A system request can consume its own bounded time before the observation deadline.
Results explicitly say `readiness: "not_checked"`: process supervision does not establish network,
application or provider readiness. Early exit/nonzero status and timeouts are failures. POSIX shutdown
uses the supervisor's SIGTERM then bounded forced-stop policy. **Windows explicit stop/restart may
terminate the task directly**; this is not a graceful application shutdown or a rollback of native work.
No PID/name-based process killing or network management endpoint is added.

Windows toggles only `BootTrigger.Enabled`, keeping the task enabled for demand Run and Stop. Task definition updates preserve the security descriptor and ignore registration triggers; no stop API is used for uninstall. Service-account logon is supplied through typed COM `LogonType=5` and registration arguments, not the XML logonType enum. Windows uses `ExecutionTimeLimit=PT0S`, `IgnoreNew`, demand start, no battery start/stop restrictions and
explicit `AllowHardTerminate=true`. LocalService has anonymous network credentials; runtimes requiring
interactive desktops, per-user native sessions, SMB identity, encrypted user files or broader rights
must be rejected by the trusted host. There is no silent promotion to SYSTEM/root or login startup.

### Host integration

Use [src/service/index.ts](../src/service/index.ts) as an importable Bun module. Before the existing
CLI parses role commands, call `handleServiceCommand(args, host)` and use a defined numeric return
as the command exit code; `undefined` leaves all unrelated commands to the existing parser.
The service help is `service --help`. Send its diagnostics to stderr; Gateway stdout is not an MCP transport.
This slice deliberately leaves the existing CLI files untouched until their owning change is integrated.

Supported parser forms (examples describe the host seam, not an available installed CLI):

```text
service install --role connector --executable /opt/rovloom/rovloom [--config /var/lib/rovloom/config.json] --workdir /var/lib/rovloom --user rovloom
service start --role connector
service restart --role connector
service stop --role connector
service uninstall --role connector
```

`--config` is optional only when the host supplies `resolveDefaultConfig(role)` from the **unique CLI's
verified identity/default-path helper**. The required default is `<verified-home>/.config/rovloom/gateway.json`
or `connector.json`, including Windows `<verified-home>\.config\rovloom\{role}.json`. An explicit path
wins without invoking the default resolver. The module never reads HOME/SUDO_USER to infer an original
user across elevation: a missing/unverifiable identity requires explicit `--config` (`config_path_required`, exit 2).
The resolved absolute path is frozen into the manifest before account/path preflight; boot/start/restart
never resolve it again using root/LocalService's home. No secret is copied or ACL adjusted to make a default work.

Both roles have fixed separate identities. `gateway` requires the unique CLI host to provide a persistent
Streamable HTTP MCP lifecycle, independent of stdin EOF. stdout is not an MCP protocol transport.
No stdio compatibility path, second MCP server or listener configuration is supplied by this module.
`verifyRuntime` is mandatory and must validate the actual single-file Rovloom executable, config role,
fixed absolute state/config paths and login-independent background behavior. It must reject the Bun
interpreter, arbitrary executables and unavailable role backends. This is a trusted code port, never a
configuration boolean or a caller-provided approval token.

POSIX native preflight independently checks the account's real UID, root-controlled executable and
ancestors, no symlinks or group/other-writable ancestors, private account-owned config and its parent,
and private account-owned working directory. All paths are absolute and canonical. It creates no users
and does not chmod/chown existing paths. macOS additionally inspects `ls -lde` for every relevant file,
control declaration and ancestor. The conservative default rejects **all extended ACLs**, including benign
deny entries; safe BSD mode alone is insufficient. A trusted host may provide `verifyMacosPermissions`
to prove effective permissions for the complete expanded path/ancestor list. Missing/unknown inspection
results fail closed, and this module never edits an ACL. Environment-dependent native discovery must also be rejected
or resolved by `verifyRuntime`; config paths alone do not prove native provider access.

Windows additionally requires `verifyWindowsInstallation`: validate executable/ancestor ACLs against
replacement by ordinary users, LocalService access to only the intended config/state resources, reparse
points, effective permissions and fixed control-directory ancestors. The module refuses registration
when this port is missing. Provision `C:\ProgramData\Rovloom\ServiceControl` separately with an
administrator/SYSTEM-only owner and ACL; the module validates its leaf ACL but **does not claim that this
alone proves effective ancestor/resource permissions**. Standard Windows system installation at
`C:\Windows` is currently required. No Windows ACL grant is performed by this module.

A fixed role lock spans the entire conversion and polling; unknown stale locks are not auto-deleted.
The ownership manifest and complete declaration are checked before each mutation. Linux rejects aliases,
different fragment paths and drop-ins. Windows compares Task Scheduler-normalized expected and actual
XML, ignoring only generated URI/date and the separate BootTrigger.Enabled bit; it does not ignore task-level enabled state. macOS verifies its loaded plist
path, accepts only the known true/false/enabled/disabled override values and fails closed on unknown formats. Administrator modification outside these controls
is not a hostile-root security boundary.

Exit codes: `0` successful/idempotent operation; `2` invalid arguments or unavailable verified default config path; `3` unsupported platform or
missing runtime/ACL backend; `1` permissions, ownership conflict, busy lock, timeout or other system
failure. Public diagnostics contain fixed codes only. The internal `ServiceError.nativeExitCode`
preserves available native command/process exit status without printing private command output.

### Validation boundary

`bun test ./test/service` uses in-memory backends and controlled runner mocks for all three OS plans,
plus temporary file locks, independent Python XML/plist parsing and a retained official XSD enum/cardinality semantic fragment (not a full XSD validation engine) and real isolated Bun subprocesses.
Those tests do not register services, reboot a system, prove PowerShell/COM XML normalization on Windows,
or prove current macOS `launchctl` output compatibility. Native acceptance must use separately approved,
recoverable disposable OS instances with a real background executable and verified account/filesystem
setup. Production readiness requires CLI/role assembly, Windows ACL/runtime integration and real
install/boot-without-login/start/restart/stop/uninstall acceptance on every supported OS.

## 简体中文

本模块提供供可信 CLI 宿主组合的五项操作，不增加第二入口。Linux 使用 systemd **系统**单元，
macOS 使用 `/Library/LaunchDaemons` 的 **system** 域，Windows 使用原生 Task Scheduler 的
**BootTrigger**；均为无需交互登录的开机启动。user unit、LaunchAgent 和 ONLOGON 不等价。
普通 Bun exe 不满足 SCM dispatcher 协议，不能直接通过 `sc create` 变成 Windows 服务。

`install` 仅持久注册/启用开机启动，不启动进程；同一完整清单重复执行幂等，改变清单即拒绝。
`start` 对已运行实例幂等，`restart` 必须先等旧实例停止，未安装时两者都失败。停止未安装或
已停止实例成功，`stop` 不取消下次开机启动。macOS 安装仅写 plist/enable，start 才 bootstrap。

`uninstall` 仅撤销未来开机启动，不请求 shutdown/kill/bootout，不等待当前实例退出。运行、启动中或
停止中的实例保留受保护控制记录，后续显式 stop 仍可核验并控制；重复卸载幂等，同清单重新安装只
恢复自启，不重启实例。结果以 `bootEnabled: false` 与 `controlRetained: true` 区分自启和控制记录，
卸载的 `stopMode` 始终为 `not_requested`。只有确认静止且可安全释放时才清理记录。

macOS 已退出但仍 loaded 的 job 也保留，绝不为卸载而 bootout；用户显式 stop 后才可卸载该 job 并
清理已禁用声明。Linux 卸载始终保留声明，避免待启动 boot Job 在观察和 unlink 间启动；Unit.Job 非零即
报告 starting，只有显式 stop 发出 systemctl stop 取消待执行 Job，并确认无 Job、MainPID=0 后
才清理。只有 inactive/dead、MainPID=0 且无 Job 才把 not-found 判为不存在，加载态与运行态不能混淆。Windows 只切换 BootTrigger.Enabled，保持 task 本身可用于显式 Run/Stop；删除前正向
核验 DISABLED/READY 且无实例，UNKNOWN、未来值或查询不完整均拒绝。ServiceAccount 使用 COM
类型值 5，XML 省略 LogonType，不使用非法枚举字符串。任何清理均保留 foreign/并发变更保护。
配置、数据库、日志、凭据、账户和用户数据永不删除或扩大权限。角色名称固定，不接收任意 service/task 名。

安装要求显式的非 root POSIX 账户或固定 LocalService SID `S-1-5-19`，不保存密码，不默认授予
SYSTEM/root 权限。可执行路径、配置路径、工作目录均固定为绝对规范路径。POSIX 预检检查真实
UID、可执行文件/祖先不可被普通用户替换、目标账户私有配置与工作目录；不创建账户，不修改既有
文件权限。macOS 额外核验相关文件及所有祖先的扩展 ACL，缺省保守拒绝任何 ACE（含合法 deny）；若要允许既有 ACL，可信宿主须通过 verifyMacosPermissions 证明完整有效权限。Windows 必须由可信宿主补全有效 ACL/祖先/重解析点及所需资源权限验证，缺少验证器
明确拒绝。LocalService 对网络提供匿名凭据，依赖交互桌面、用户 native session 或更广泛权限的
部署须由宿主拒绝；不能静默降级为登录启动或提升到 SYSTEM。

接线点为 `handleServiceCommand(args, host)`：现有唯一 CLI 应在原 parser 之前调用，有数字返回
时直接作为退出码，`undefined` 表示交还原 parser；诊断只走 stderr。后台程序验证器
`verifyRuntime` 必须核实真实单文件 Rovloom 产物、角色配置、固定状态根和无登录会话的后台能力，
拒绝 Bun 解释器、任意第三方程序及缺后端角色。Gateway 必须核验唯一 CLI 注入的持久
Streamable HTTP MCP 宿主，不依赖 stdin EOF，stdout 不承载 MCP；不保留 stdio 兼容，不另建
MCP 服务或监听配置。未接线前不能注册。`--config` 可省略，但须复用唯一 CLI 的受信身份/默认路径 resolver，默认是已验证 home 下
`.config/rovloom/gateway.json` 或 `connector.json`，Windows 同样如此；显式路径优先。不能确定提升前
真实用户时要求 `--config`，不盲信 HOME/SUDO_USER。解析后的绝对路径在安装时固化，开机/重启不会
再按 root/LocalService 的 HOME 展开；不会为适配默认路径修改 ACL 或复制秘密。Windows 另需 `verifyWindowsInstallation` 及预先准备的管理员/SYSTEM 专有控制目录；
本模块不把目录叶节点 ACL 检查冒充全部有效权限证明，也不自动设置 ACL。

系统命令有独立超时和输出上限；状态观测最多 30 秒，运行状态须连续稳定至少一秒。返回值明确
`readiness: not_checked`，系统监管状态不证明业务、网络或 provider 已就绪。非零退出、早退或
超时不会被当作启动成功。POSIX 由监管器先发 SIGTERM，必要时强制停止；**Windows 的 stop、
restart 可能直接终止任务，不能称为优雅关闭或原生工作的回滚**。uninstall 永不停止实例。未新增网络控制入口。

验证仅包括三平台模型/命令计划、临时锁文件、独立 XML/plist 解析和受控 Bun 子进程；没有实装
系统启动项或重启验收。完整可用功能仍依赖唯一 CLI 接线、真实后台角色、Windows 配置/ACL 接线，
以及获授权可恢复的一次性 Linux/macOS/Windows 环境中的无登录开机及全生命周期实测。

## Official references / 官方依据

- [systemd.service: execution prefixes and service lifecycle](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [systemd.exec: execution environment and user identity](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [systemctl: enable/disable versus start/stop](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)
- [Apple: Script management with launchd](https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b-5d5d-4d35-9c19-60f2397b2369/mac)
- [Apple: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [Apple Developer Technical Support: installing LaunchDaemon plists](https://developer.apple.com/forums/thread/771162)
- [Microsoft: SCM dispatcher requirements](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-startservicectrldispatchera)
- [Microsoft: BootTrigger](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger)
- [Microsoft: RegisterTask and TASK_CREATE](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskfolder-registertask)
- [Microsoft: LocalService account](https://learn.microsoft.com/en-us/windows/win32/services/localservice-account)
- [Microsoft: execution time limit](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-executiontimelimit)
- [Microsoft: AllowHardTerminate](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-allowhardterminate)
- [Apple forum: named print-disabled output](https://developer.apple.com/forums/thread/783433)
- [NIST Sequoia guidance, printed page 64](https://pages.nist.gov/macos_security/guidance-example.pdf#page=70)
- [Apple: ACL evaluation precedes BSD permissions](https://developer.apple.com/library/archive/documentation/Security/Conceptual/AuthenticationAndAuthorizationGuide/Permissions/Permissions.html)
- [Microsoft: task state enum](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_state)
- [Microsoft: trigger enablement](https://learn.microsoft.com/en-us/windows/win32/taskschd/trigger-enabled)
- [Microsoft: task schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema)
- [Microsoft: RegisteredTask.Stop](https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-stop)

## 安装更新会话

`ServiceManager.withBinaryUpdate(executable, operation)` 复用两个既有角色锁，在快照、静止、文件事务和恢复期间与所有正常服务命令互斥。它只处理指向该已验证安装的登记，不重建或清除注册。
会话提供 `quiesce`、`assertQuiescent` 和 `restore`；原本运行的角色需要独立业务就绪探针，监管 running 不能代替应用就绪。macOS 已加载但停止的 job 缺等价恢复保证时，在变更前拒绝。
`service_recovery_required` 表示操作需要持久恢复保护：关闭已静止的自有锁句柄并保留锁文件，而不是自动删锁。安装更新的文件边界、回滚、恢复记录和未支持平台见 [自更新模块](UPDATE.md)。
Windows 固定 helper 自己取得并持有两个既有角色锁，在内核证明直接父退出后才进行文件替换和角色恢复，不把角色锁跨进程转交。该 helper 的原生文件/进程样例与真实 Task Scheduler 生命周期验收分列，详见自更新模块。
install/uninstall 的 boot-only 语义不受更新会话改变。

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
Use uninstall followed by install for deliberate replacement. A fresh macOS install writes/enables the
plist without bootstrapping it; `start` bootstraps it, so `RunAtLoad` does not blur installation and startup.

`start` on a running instance succeeds without duplicating it. `restart` waits for the old instance to
stop before starting. Starting/restarting an absent registration fails. Stopping an absent or stopped
registration succeeds. `stop` preserves boot enablement, so the next boot can start the service again.

`uninstall` first disables boot startup, then stops the owned instance and removes only its registration.
This deliberate stop-before-remove rule is the same on all backends and prevents unmanaged orphan
instances (including macOS loaded jobs). If stopping fails, the **disabled registration is retained**.
Repeated uninstall succeeds. Configuration, databases, logs, credentials, accounts and user directories
are never deleted or permission-adjusted. A partial install that created its declaration but failed to
enable can converge on repeat; unknown/corrupted declarations and stale locks require administrator inspection.

Commands have bounded output (1 MiB combined) and time (normally 35 s per system request, 5 s for status
queries). The controller then observes status for at most 30 s, requiring one continuous second of
running status. A system request can consume its own bounded time before the observation deadline.
Results explicitly say `readiness: "not_checked"`: process supervision does not establish network,
application or provider readiness. Early exit/nonzero status and timeouts are failures. POSIX shutdown
uses the supervisor's SIGTERM then bounded forced-stop policy. **Windows stop/restart/uninstall may
terminate the task directly**; this is not a graceful application shutdown or a rollback of native work.
No PID/name-based process killing or network management endpoint is added.

Windows uses `ExecutionTimeLimit=PT0S`, `IgnoreNew`, demand start, no battery start/stop restrictions and
explicit `AllowHardTerminate=true`. LocalService has anonymous network credentials; runtimes requiring
interactive desktops, per-user native sessions, SMB identity, encrypted user files or broader rights
must be rejected by the trusted host. There is no silent promotion to SYSTEM/root or login startup.

### Host integration

Use [src/service/index.ts](../src/service/index.ts) as an importable Bun module. Before the existing
CLI parses role commands, call `handleServiceCommand(args, host)` and use a defined numeric return
as the command exit code; `undefined` leaves all unrelated commands to the existing parser.
The service help is `service --help`. Send its diagnostics to stderr, keeping MCP stdout separate.
This slice deliberately leaves the existing CLI files untouched until their owning change is integrated.

Supported parser forms (examples describe the host seam, not an available installed CLI):

```text
service install --role connector --executable /opt/rovloom/rovloom --config /var/lib/rovloom/config.json --workdir /var/lib/rovloom --user rovloom
service start --role connector
service restart --role connector
service stop --role connector
service uninstall --role connector
```

Both roles have fixed separate identities. `gateway` may be registered only after the host provides a
non-stdio background Gateway; the current stdio-only CLI preview must fail `verifyRuntime`.
`verifyRuntime` is mandatory and must validate the actual single-file Rovloom executable, config role,
fixed absolute state/config paths and login-independent background behavior. It must reject the Bun
interpreter, arbitrary executables and unavailable role backends. This is a trusted code port, never a
configuration boolean or a caller-provided approval token.

POSIX native preflight independently checks the account's real UID, root-controlled executable and
ancestors, no symlinks or group/other-writable ancestors, private account-owned config and its parent,
and private account-owned working directory. All paths are absolute and canonical. It creates no users
and does not chmod/chown existing paths. Environment-dependent native discovery must also be rejected
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
XML, ignoring only generated URI/date and the separate enabled bit. macOS verifies its loaded plist
path and fails closed on unknown `launchctl` formats. Administrator modification outside these controls
is not a hostile-root security boundary.

Exit codes: `0` successful/idempotent operation; `2` invalid arguments; `3` unsupported platform or
missing runtime/ACL backend; `1` permissions, ownership conflict, busy lock, timeout or other system
failure. Public diagnostics contain fixed codes only. The internal `ServiceError.nativeExitCode`
preserves available native command/process exit status without printing private command output.

### Validation boundary

`bun test ./test/service` uses in-memory backends and controlled runner mocks for all three OS plans,
plus temporary file locks, independent Python XML/plist parsing and real isolated Bun subprocesses.
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

卸载统一先禁用开机启动、停止本项目实例、再删除对应注册；停止失败则保留已禁用注册，便于
检查与重试。重复卸载成功。卸载绝不删除配置、数据库、日志、凭据、账户或用户数据，也不扩大
权限。名称按项目角色固定，不接收任意 service/task 名称。每次修改核对完整所有权清单及声明；
Linux 额外拒绝别名和 drop-in，Windows 核对 Scheduler 规范化 XML，macOS 核对加载来源并对
未知输出格式拒绝。角色文件锁贯穿操作与等待，不自动清理来源未知的旧锁。

安装要求显式的非 root POSIX 账户或固定 LocalService SID `S-1-5-19`，不保存密码，不默认授予
SYSTEM/root 权限。可执行路径、配置路径、工作目录均固定为绝对规范路径。POSIX 预检检查真实
UID、可执行文件/祖先不可被普通用户替换、目标账户私有配置与工作目录；不创建账户，不修改既有
文件权限。Windows 必须由可信宿主补全有效 ACL/祖先/重解析点及所需资源权限验证，缺少验证器
明确拒绝。LocalService 对网络提供匿名凭据，依赖交互桌面、用户 native session 或更广泛权限的
部署须由宿主拒绝；不能静默降级为登录启动或提升到 SYSTEM。

接线点为 `handleServiceCommand(args, host)`：现有唯一 CLI 应在原 parser 之前调用，有数字返回
时直接作为退出码，`undefined` 表示交还原 parser；诊断只走 stderr。后台程序验证器
`verifyRuntime` 必须核实真实单文件 Rovloom 产物、角色配置、固定状态根和无登录会话的后台能力，
拒绝 Bun 解释器、任意第三方程序及缺后端角色。当前 stdio Gateway 不满足后台服务要求，未接线
前不能注册。Windows 另需 `verifyWindowsInstallation` 及预先准备的管理员/SYSTEM 专有控制目录；
本模块不把目录叶节点 ACL 检查冒充全部有效权限证明，也不自动设置 ACL。

系统命令有独立超时和输出上限；状态观测最多 30 秒，运行状态须连续稳定至少一秒。返回值明确
`readiness: not_checked`，系统监管状态不证明业务、网络或 provider 已就绪。非零退出、早退或
超时不会被当作启动成功。POSIX 由监管器先发 SIGTERM，必要时强制停止；**Windows 的 stop、
restart 和 uninstall 可能直接终止任务，不能称为优雅关闭或原生工作的回滚**。未新增网络控制入口。

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
- [Microsoft: RegisteredTask.Stop](https://learn.microsoft.com/en-us/windows/win32/taskschd/registeredtask-stop)

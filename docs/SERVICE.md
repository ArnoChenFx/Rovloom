# Boot services / 开机服务

The CLI provides `service install`, `uninstall`, `start`, `restart`, and `stop` for
an explicit `gateway` or `connector` role. Linux product wiring uses systemd.
The macOS product wiring is delivered separately; Windows product wiring awaits
the normal role-file/startup implementation. Native command plans exist for all
three systems. Format/model tests do not establish a platform's actual lifecycle
or reboot acceptance.

## English

| Platform | Boot registration | Control | Account |
|---|---|---|---|
| Linux | `/etc/systemd/system/rovloom-{role}.service`, `multi-user.target` | system `systemctl` | Explicit existing non-root account |
| macOS | `/Library/LaunchDaemons/io.rovloom.{role}.plist`, system domain | `launchctl bootstrap`, `kickstart`, `kill`, `bootout` | Explicit existing non-root account |
| Windows | Task Scheduler `\rovloom-{role}`, `BootTrigger` | System Task Scheduler COM | LocalService (`S-1-5-19`) |

Boot startup does not require an interactive login. LaunchAgents, user login tasks
and `ONLOGON` are not used. A normal Bun executable is not registered as an SCM
service: the Windows backend uses a native boot-triggered task with no password.

- `install` enables future boot startup and does not start the role. Repeating the
  same registration is safe; another executable/config/account is a conflict.
- `start` starts an installed role; an already running role is not duplicated.
- `restart` waits for the old instance to stop, then starts it. macOS retains a
  loaded job during restart so a disabled boot policy need not be re-enabled.
- `stop` stops the selected role and preserves boot enablement.
- `uninstall` only disables future boot startup. It does not stop a running role.
  Its control record remains available for an explicit stop/restart as needed.

Linux retains disabled declarations until explicit stop also cancels any pending
systemd Job. macOS retains loaded jobs; Windows disables only the BootTrigger,
keeping demand Run/Stop available. Safe cleanup removes only this role's exact
registration, never configuration, databases, logs, accounts or user directories.
A same-name foreign/edited registration is a conflict and is not overwritten.

```sh
rovloom service install --role gateway --config /home/rovloom/.config/rovloom/gateway.json --workdir /home/rovloom --user rovloom
rovloom service start --role gateway
rovloom service restart --role gateway
rovloom service uninstall --role gateway
rovloom service stop --role gateway
```

Installation records the current standalone executable and absolute role config.
An explicit `--executable` must refer to that same product. Without `--config`,
the shared role-path helper uses the selected account's home, not the installer
HOME. `--workdir` must exist. Existing configuration is checked for JSON/role
errors; missing configuration is left for normal first startup to generate.
The service installer does not impose UID/mode, ACL, ancestor or file-ID rules,
change existing permissions, create accounts or automatically elevate itself.
Insufficient system-service privilege is an ordinary error; operators must
explicitly run the command with the required OS authorization.

Services receive no interactive input and do not enter CLI pairing/setup prompts.
Systemd uses null stdin, launchd uses `/dev/null`, and Windows runs under its
service account. Local native Connector capability remains Linux x64.
Starting a configured service is distinct from native-provider or Agent readiness.

System requests have bounded output/time; state observation is bounded and requires
one continuous second of running state. Results report `readiness: not_checked`.
POSIX uses the supervisor's normal termination policy; Windows stop/restart can
terminate the task directly. Unknown command cleanup retains the role lock and
returns a failure rather than silently retrying. Cross-process role locks prevent
duplicate controller operations; stale locks require explicit inspection.

### Host integration

`src/service/index.ts` exports `ServiceManager`, `createNativeServiceBackend` and
the CLI parser. The product uses one `CliRuntime.service` host. Its preflight
checks product/role/configuration support; there is no ACL/Authz installation port.
Ordinary registration file I/O retains exact-content checks, exclusive creation,
fsync and role mutual exclusion. `service --help` is available without OS access.
Errors use fixed codes and nonzero exit status. Installation itself does not
start Gateway, connect a provider, generate credentials or call a model.

Native CI format probes use systemd-analyze/plutil or an unregistered Task Scheduler
COM definition. The separate lifecycle script is restricted to explicitly enabled
GitHub-hosted temporary VMs: it checks for name collisions, uses the existing
runner account and a temporary Gateway dataset, explicitly invokes `sudo -n`,
and removes only its own registration. It checks real MCP 401, restart and data
preservation. Reboot acceptance is reported separately; the script never runs on
an ordinary user's machine or a self-hosted runner.

## 简体中文

五项命令均显式选择 `gateway` 或 `connector`。Linux 产品入口使用 systemd；macOS
产品接线单独交付，Windows 等普通角色文件/启动接口就绪。三平台已有原生命令计划，
不能把格式解析或状态模型通过当作实际安装、生命周期或重启验收通过。

- `install`：加入/启用未来开机自动启动，不立即启动。相同登记可重复，另一产物/配置/账户不能覆盖。
- `start`：启动已安装角色；已运行时不创建第二实例。
- `restart`：等待原实例停止再启动。macOS 重启保留 loaded job，避免暗中重新启用已撤销的开机策略。
- `stop`：停止所选角色，不取消开机启动。
- `uninstall`：只撤销未来开机启动，不停止当前实例；必要时保留控制记录供显式启停。

Linux 使用系统 unit，macOS 使用 system LaunchDaemon，Windows 使用 LocalService
开机任务，不使用登录任务或把普通控制台程序冒充 SCM 服务。系统服务需要正常 OS 授权；
CLI 不自动提权、不创建账户、不修改已有系统权限。

登记引用当前单文件及绝对角色配置；缺省配置路径按所选服务账户 home 复用唯一 helper。
工作目录应存在。已有文件检查 JSON/角色错误，缺失配置由正常首次启动生成。安装器不以
UID/mode、ACL、祖先防替换或文件 ID 作为前提。服务不进入交互配对/初始化；stdin 为空。
本机 native Connector 仍限 Linux x64，监管 running 不证明 provider/Agent 就绪。

卸载不删除用户配置、数据库、日志、凭据或目录。仅清理所选角色的精确登记；同名异物拒绝
覆盖。保留普通排他创建、fsync、数据库事务和必要互斥，防止重复操作与误删数据。
Windows 显式 stop/restart 可能直接终止任务，不应称为原生工作的回滚。

命令时间/输出和监管等待均有界；未知回收返回失败并保留角色锁，不静默重试。
`service --help` 可离线使用。云端原生生命周期回归只在显式启用的 GitHub-hosted 临时 VM
中，以既有 runner 账户、临时 Gateway 数据和明确的 sudo -n 操作执行；先排除同名登记，
结束只清理本轮服务。检查真实 MCP 401、重启与数据保留，开机重启实测另行标明。

## Official references / 官方依据

- [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)
- [launchctl](https://keith.github.io/xcode-man-pages/launchctl.1.html)
- [Task Scheduler BootTrigger](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger)
- [Task Scheduler service-account logon](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)

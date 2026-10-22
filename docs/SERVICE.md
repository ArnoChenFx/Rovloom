# Boot services / 开机服务

The `rovloom service` command registers a Gateway or Connector to start at boot. Commands: `install`, `uninstall`, `start`, `restart`, `stop`. Every command selects one role with `--role gateway|connector`.

`rovloom service` 命令把 Gateway 或 Connector 注册为开机自启。命令有 `install`、`uninstall`、`start`、`restart`、`stop`，每条命令用 `--role gateway|connector` 选择一个角色。

## English

| Platform | Boot registration | Control | Account |
|---|---|---|---|
| Linux | `/etc/systemd/system/rovloom-{role}.service`, `multi-user.target` | system `systemctl` | existing non-root account |
| macOS | `/Library/LaunchDaemons/io.rovloom.{role}.plist`, system domain | `launchctl` | existing non-root account |
| Windows | Task Scheduler `\rovloom-{role}`, `BootTrigger` | Task Scheduler | existing user, S4U |

Boot startup does not need an interactive login. LaunchAgents, login tasks and `ONLOGON` are not used.

On Windows the task runs as the chosen user with S4U, so no password is stored and no login is required. S4U runs on a non-interactive desktop, which limits access to network resources and encrypted files. A Connector service has no interactive desktop. It attaches to the persistent Luvus or Herdr processes, or starts them under that account, and provides no interactive terminal sessions.

### Commands

- `install` enables boot startup and does not start the role. Repeating the same registration is safe. A registration with a different executable, config or account is a conflict.
- `start` starts an installed role. A running role is not started twice.
- `restart` waits for the old instance to stop, then starts it.
- `stop` stops the role and keeps boot startup enabled.
- `uninstall` disables boot startup only. It does not stop a running instance and does not delete configuration, databases, logs, accounts or directories. It removes only the exact registration of the selected role. A registration with the same name that Rovloom did not create is a conflict and is not overwritten.

```sh
rovloom service install --role gateway --config /home/rovloom/.config/rovloom/gateway.json --workdir /home/rovloom --user rovloom
rovloom service start --role gateway
rovloom service restart --role gateway
rovloom service stop --role gateway
rovloom service uninstall --role gateway
```

### Installation

- `install` records the current standalone executable and the absolute path of the role config. An explicit `--executable` must be that same executable.
- Without `--config`, it uses the same current-user file as foreground startup. When running through sudo, pass the original user's absolute config path.
- `--user` selects the account the service runs as. It does not select another configuration directory.
- `--workdir` must exist. An existing config is checked for JSON and role errors. A missing config is generated at the first normal start.
- The installer does not create accounts, change existing permissions or elevate itself. Without enough system privileges the command fails, and you must run it with the required OS authorization.

### Running

- Services receive no interactive input and never enter pairing or setup prompts. systemd uses null stdin, launchd uses `/dev/null`, and Windows starts the role with `--non-interactive`. Pair the device in a real terminal first.
- A service does not restart a process that has exited. systemd uses `Restart=no` and launchd does not set `KeepAlive`.
- A native Connector service is supported on Linux x64 and Windows x64.
- Command output and waiting time are bounded. The result reports `readiness: not_checked`, so a running service does not prove that a provider or Agent is ready.
- On Windows, a running instance receives one stop request over a local named pipe and then runs its normal shutdown. If the pipe fails, the process is not killed. When a task is queued or starting, the command returns `service_busy`.
- Cross-process role locks prevent concurrent control operations. A stale lock needs manual inspection.

## 简体中文

| 平台 | 开机登记 | 控制方式 | 运行账户 |
|---|---|---|---|
| Linux | `/etc/systemd/system/rovloom-{role}.service`，`multi-user.target` | 系统 `systemctl` | 既有非 root 账户 |
| macOS | `/Library/LaunchDaemons/io.rovloom.{role}.plist`，system 域 | `launchctl` | 既有非 root 账户 |
| Windows | 任务计划程序 `\rovloom-{role}`，`BootTrigger` | 任务计划程序 | 既有用户，S4U |

开机启动不需要交互登录。不使用 LaunchAgent、登录任务和 `ONLOGON`。

Windows 以所选用户的 S4U 任务运行，不保存密码，也不要求先登录。S4U 运行在非交互桌面上，Windows 会限制它对网络资源和加密文件的访问。Connector 服务没有交互桌面，只附着 Luvus 或 Herdr 的持久进程（或在该账户下启动它们），不提供交互式终端会话。

### 命令

- `install`：启用开机自启，不立即启动。相同登记可重复执行。可执行文件、配置或账户不同的登记会报冲突。
- `start`：启动已安装的角色。已在运行时不会启动第二个实例。
- `restart`：等原实例停止后再启动。
- `stop`：停止角色，保留开机自启。
- `uninstall`：只取消开机自启，不停止正在运行的实例，也不删除配置、数据库、日志、账户或目录。它只清理所选角色的精确登记。同名但不是 Rovloom 创建的登记会报冲突，不会被覆盖。

示例见上方命令块。

### 安装

- `install` 记录当前单文件程序和角色配置的绝对路径。显式的 `--executable` 必须是这个程序。
- 省略 `--config` 时，使用与前台启动相同的当前用户配置文件。通过 sudo 安装时，请显式传入原用户配置文件的绝对路径。
- `--user` 只选择运行账户，不会另选配置目录。
- `--workdir` 必须存在。已有配置会检查 JSON 与角色错误，缺失的配置由首次正常启动生成。
- 安装器不创建账户、不修改已有权限、不自行提权。系统服务权限不足时命令失败，需要用有相应系统权限的方式重新运行。

### 运行

- 服务没有交互输入，不会进入配对或初始化提示。systemd 使用空 stdin，launchd 使用 `/dev/null`，Windows 以 `--non-interactive` 启动角色。请先在真实终端完成配对。
- 服务不会自动重启已退出的进程。systemd 为 `Restart=no`，launchd 不设置 `KeepAlive`。
- 原生 Connector 服务支持 Linux x64 与 Windows x64。
- 命令的输出和等待时间有上限。结果带 `readiness: not_checked`，服务处于运行状态不代表 provider 或 Agent 已就绪。
- Windows 上，运行中的实例通过本地命名管道收到一次停止请求，再执行正常关闭。管道失败时不会强杀进程。任务排队或正在启动时，命令返回 `service_busy`。
- 跨进程的角色锁防止并发的控制操作。遗留的锁需要人工检查。

## Official references / 官方依据

- [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
- [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)
- [launchctl](https://keith.github.io/xcode-man-pages/launchctl.1.html)
- [Task Scheduler BootTrigger](https://learn.microsoft.com/en-us/windows/win32/taskschd/boottrigger)
- [Task Scheduler service-account logon](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/ne-taskschd-task_logon_type)

# Connector 直接终端执行

本机配置只有一个可选布尔字段 `allow_terminal_execution`，省略或 `false` 时关闭；只有
机器所有者在受保护的 Connector 本地配置中写入 `true` 才开启。该字段已经由
`LuvusLocalConfig`、`HerdrLocalConfig` 和 Herdr provider ref 的 `connector.local` 接受。
下面是加入现有本地配置的字段片段，不是独立 CLI 配置文件：

```json
{
  "allow_terminal_execution": false
}
```

配置的其余 binary、Target、目录和来源字段仍须完整有效。字符串 `"true"`、数字与未知
字段不会转换成许可。唯一 CLI 加载、Gateway 目录和跨机器联合验收仍须完成产品接线，
此模块交付不表示任何现有机器已经开启远程执行。

## 检查范围

| 原生输入 | 开关范围 |
|---|---|
| Luvus `pane.run`、`pane.send_input`、`terminal.backend.create/control/type_literal/paste_text/submit_text/send_key` | 关闭时拒绝，不能改用另一输入方法绕过 |
| Luvus `module.action.invoke` | 可调用本地模块动作，按可执行入口拒绝 |
| Luvus `agent.report`、`pane.report_session`、`pane.report_event` | 可改变原生 Agent 判断，关闭时拒绝，避免先把 shell 标记为 Agent 再输入 |
| Luvus `agent.keys` | 仅有 report/session 等标签不能独立证明当前前台真 Agent，关闭时一律保守拒绝；开启时留下的旧报告、session 或 terminal fence 不能绕过随后关闭 |
| Luvus `task.add` / `task.start` | 非空白 `gate` / 自定义 `agent` 命令分别需要开启；普通无 gate 任务记录保持可用，`task.update` 不接受 gate，继续交给完整原生 schema 拒绝 |
| Luvus `task.done` / `task.retry` | 可分别执行已保存的 gate 或重启原 automation run；当前请求不包含完整执行来源，关闭时保守拒绝 |
| Herdr `pane.send_text/send_keys/send_input`、`pane.link.activate` | 关闭时拒绝；链接可调用本地处理器 |
| Agent 启动、workspace/tab/pane 创建及会话恢复/报告 | 非空 `command`、`args`、`env`、`resume_command`、`resume_argv` 需要开启；不能通过启动环境或恢复命令绕过 |
| 普通 Agent 文本对话、读取、无自定义启动参数的 `agent.start` | 保留已有独立原生门禁、分类和 caller/local grants，不由此开关默认禁用；Herdr 的 Agent 按键继续保留其原生运行进程检查 |

准确的方法/参数集合由 [共享判定](../src/connector/terminal-execution.ts)维护；目录对直接
方法使用 `requiresTerminalExecution(kind, method)`，具体参数预检使用
`terminalExecutionAllowed(kind, method, params, enabled)`。参数敏感方法可以继续描述，
其具体请求须再次预检。开关开启不能补齐未经适配的传输、缺失分类或原生 lease；例如
普通 RPC adapter 仍不能把 `terminal.backend.control` 当作单次 RPC 执行。

Luvus adapter 在发现前检查，在原 Wire、安装、peer、最终帧预算和持久唯一 claim 之后，
紧贴实际 write 再次检查。可选 `LuvusRpcHost.terminalExecution()` 是受保护同步配置
读取器，存在时替代固定本地值；角色宿主可经 session 资源同名字段交付它。Herdr 的
`createHerdrRuntime` 第四个可选同步读取器有同样用途，检查位于原
`exchangeHerdr.prepare.current()` 和 `beforeWrite()`。读取失败或非 `true` 不授予许可。
没有读取器时使用本轮已 pin 的本地配置，变更须重建对应宿主资源；不得只更新目录。

Luvus `is_agent_pane` 接纳报告和 session 标记，不是当前前台进程证明。故按键入口即使
面向真正 Agent，也须先开启此开关；不通过一次检查或旧报告发放后续按键许可。文本
`agent.send/prompt` 仍复用原生目标与 prompt-readiness 门禁；Connector 不将该门禁、
返回的状态或终端画面称为独立的实时前台身份核验，也不承诺隔离 Agent 内部工具。

## 执行环境与结果

Connector 的发现、schema 和代理子进程继续使用受保护的绝对 `cwd`、固定
`PATH=/usr/bin:/bin` 和显式最小环境，不复制 Connector 父进程的模型密钥、SSH 或其它
凭据。原生终端命令仍在目标 Luvus/Herdr 进程的 OS 账号及原生 shell 环境中执行；向已
运行的终端输入时，cwd/PATH 由该终端当前状态决定。`terminal.backend.create` 的 cwd
及 workspace/pane 的原生 cwd/env 语义不被重写，执行前应读取目标信息并明确指定需要
的新终端 cwd。可写位置由该账号的实际 OS 权限决定；安装应选择所有者明确准备的项目
或用户目录。本模块不提供文件系统沙箱、不自动提权、不安装 Agent、不配置模型凭据。
Agent 自身获授权后运行的内部工具也不受此开关隔离。

返回的 `native_response` 保留原生值。Herdr 的 `ok`、Luvus 的输入 queued/executed
仅说明原生输入操作，不能推断 shell 命令结束。PTY read/capture 是可能渲染和截断的
terminal output，保留原生截断/完整性信息，不能称为独立无损 stdout/stderr。Luvus RPC
结果中的外层 `exit_code` 属于固定 CLI proxy，IPC 为 `null`，不属于终端内命令。

当前不新增逐命令完成协议或独立作业框架。若后续采用 Luvus 每命令独立终端，必须显式
设置 `restore:false`，并另外验证短命令 create 竞态、末尾输出 drain 和真实
`terminal.exited` 的归属、可空 exit_code/signal；缺事件或断连保持未知，不能猜零。
关闭 pane、超时和取消均不证明命令成功或远端回滚。发送后结果未知不自动重发；持久
claim 已提交后才关闭开关，也不能清除墓碑重新执行旧 attempt。

## English configuration summary

Add the optional boolean `allow_terminal_execution` to the trusted Connector local configuration.
It defaults to `false`; only literal `true` enables direct terminal inputs and custom launch or
restore commands. Existing Agent conversations retain their separate native and caller/local
authorization. This switch is not an OS sandbox for Agent tools.
Luvus raw `agent.keys` requires the switch even with existing report/session labels, because
those labels do not prove the current foreground program. Ordinary native text prompts keep
their own admission path. Nonblank task gates, custom task worker commands, and task completion
or retry paths that can execute saved commands are also covered; plain task records remain usable.

Both adapters recheck the current local switch immediately before their existing native write.
Catalog filtering must use the same shared predicate. The CLI loader and joint catalog integration
remain separate product wiring work. Native replies and terminal truncation stay unchanged:
input acknowledgments never become command completion or a fabricated exit code. A lost reply
after dispatch remains unknown and is not replayed. No existing real machine is enabled by this change.

## 原生研究依据

- [Luvus 固定版本 Agent 判断与输入](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch/agents.rs)：Agent 输入不回退到普通 pane；报告状态也影响 `is_agent_pane`。
- [Luvus 固定版本任务分派](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch/orchestration.rs)：`task.add` 保存 gate，`task.start` 可提交自定义 agent 命令；`task.update` 不接收 gate。
- [Luvus 固定版本任务执行](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/board.rs)：任务完成可启动 shell gate，automation task retry 可重启原运行；不能仅从本次请求有无命令判断其可执行性。
- [Luvus 固定版本终端生命周期](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/backend.rs)：create 完成与短命令退出存在竞态，退出事件来自原生进程回收。
- [Herdr 固定版本 Agent 输入](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/agents.rs)：Agent target、运行态与输入成功独立检查，输入 ack 不提供 shell 命令退出证据。

# Connector 直接终端执行

标准 CLI 从唯一 Connector 用户文件（默认 `~/.config/rovloom/connector.json`）的根字段
`allow_terminal_execution` 读取开关。模板明确写 `false`，省略也关闭；只有字面量
`true` 开启。字符串、数字、null 或对象会被配置解析拒绝。无密钥完整模板及字段表见
[配置参考](CONFIGURATION-zh.md)。在现有 Connector 文档中设置：

```json
{
  "allow_terminal_execution": false
}
```

这只是字段片段；其余角色、data 和 Gateway 字段仍须有效。修改后重启 Connector，服务
安装用户使用现有 `rovloom service restart --role connector`。该设置不属于首次安装
`native` 目录设置，不要求修改受保护 root record、摘要或 provider ref；没有额外 argv
或 Gateway 开关，不会修改已有 caller/local grants、配对身份或安装 Agent。

CLI 将同一有效值交给 Luvus 与 Herdr 现有最终写前检查。直接使用底层库且未传入角色
开关时，仍使用 `LuvusLocalConfig` / `HerdrLocalConfig` 的原本地字段，默认也关闭。
已有机器不会因升级或目录查询自动开启远程执行。

Gateway 通过可选认证 Wire `terminal_execution_state` 接收原 provider 完整 binding 和
布尔观察值，只在当前设备、恢复代次、epoch 和配置仍有效时使用。没有协商、没有报告、
断连、配置变化或来源失效时状态为 unknown，目录隐藏直接终端写入。参数敏感方法保留
可用变体；例如关闭时 Luvus `agent.send/prompt` 的描述要求显式 `strict:true`。目录
游标包含本地状态，状态变化不能沿用旧页。这个观察值不是执行许可；Connector 在原
检查、持久 claim 与紧贴实际写入处仍检查本机开关，不能只靠隐藏工具禁止执行。

## 检查范围

| 原生输入 | 开关范围 |
|---|---|
| Luvus `pane.run`、`pane.send_input`、`terminal.backend.create/control/type_literal/paste_text/submit_text/send_key` | 关闭时拒绝，不能改用另一输入方法绕过 |
| Luvus `module.action.invoke` | 可调用本地模块动作，按可执行入口拒绝 |
| Luvus `agent.report`、`pane.report_session`、`pane.report_event` | 可改变原生 Agent 判断，关闭时拒绝，避免先把 shell 标记为 Agent 再输入 |
| Luvus `agent.keys` | 仅有 report/session 等标签不能独立证明当前前台真 Agent，关闭时一律保守拒绝；开启时留下的旧报告、session 或 terminal fence 不能绕过随后关闭 |
| Luvus `agent.send` / `agent.prompt` | 关闭时只接纳调用者显式 `strict:true` 的文本请求；省略或 `false` 沿用上游宽松语义，必须开启开关；不在最后 IO 临时补 strict |
| Luvus `task.add` / `task.start` | 非空白 `gate` / 自定义 `agent` 命令分别需要开启；普通无 gate 任务记录保持可用，`task.update` 不接受 gate，继续交给完整原生 schema 拒绝 |
| Luvus `task.done` / `task.retry` | 可分别执行已保存的 gate 或重启原 automation run；当前请求不包含完整执行来源，关闭时保守拒绝 |
| Herdr `pane.send_text/send_keys/send_input`、`pane.link.activate` | 关闭时拒绝；链接可调用本地处理器 |
| Agent 启动、workspace/tab/pane 创建及会话恢复/报告 | 非空 `command`、`args`、`env`、`resume_command`、`resume_argv` 需要开启；不能通过启动环境或恢复命令绕过 |
| 严格 Agent 文本对话、读取、无自定义启动参数的 `agent.start` | 保留已有独立原生门禁、分类和 caller/local grants；Herdr 的 Agent 文本及按键继续保留其原生运行进程检查 |

准确的方法/参数集合由 [共享判定](../src/connector/terminal-execution.ts)维护；目录使用
`terminalExecutionCatalog(kind, method, enabled)` 保留合法参数变体，具体参数预检使用
`terminalExecutionAllowed(kind, method, params, enabled)`。参数敏感方法可以继续描述，
其具体请求须再次预检。开关开启不能补齐未经适配的传输、缺失分类或原生 lease；例如
普通 RPC adapter 仍不能把 `terminal.backend.control` 当作单次 RPC 执行。
目录应保留支持 `strict:true` 的 Luvus 文本方法并说明该本地限制，不能仅按省略参数时的
默认请求判定隐藏全部严格对话；完整请求预检仍使用同一个参数判定。

Luvus adapter 在发现前检查，在原 Wire、安装、peer、最终帧预算和持久唯一 claim 之后，
紧贴实际 write 再次检查。可选 `LuvusRpcHost.terminalExecution()` 是受保护同步配置
读取器，存在时替代固定本地值；角色宿主可经 session 资源同名字段交付它。Herdr 的
`createHerdrRuntime` 第四个可选同步读取器有同样用途，检查位于原
`exchangeHerdr.prepare.current()` 和 `beforeWrite()`。读取失败或非 `true` 不授予许可。
没有读取器时使用本轮已 pin 的本地配置，变更须重建对应宿主资源；不得只更新目录。

Luvus `is_agent_pane` 接纳报告和 session 标记，不是当前前台进程证明。故按键入口即使
面向真正 Agent，也须先开启此开关；不通过一次检查或旧报告发放后续按键许可。文本
`agent.send/prompt` 在关闭时要求原请求显式 `strict:true`，保留原生目标与严格
prompt-readiness 门禁；不改写已验权、计算摘要及持久登记的参数。Connector 不将该门禁、
返回的状态或终端画面称为独立的实时前台身份核验，也不承诺隔离 Agent 内部工具。

## 执行环境与结果

在唯一 Connector 用户文件中，可选 `native.agent_bin_dir` 用于按原生命令名查找已安装
在用户目录的 Agent。下面只是完整用户文档中的字段片段：

```json
{
  "native": {"agent_bin_dir": "/home/owned/.local/bin"},
  "allow_terminal_execution": false
}
```

它是当前首次 Luvus 初始化的安装设置，由程序映射到受保护 root 配置，见
[配置参考](CONFIGURATION-zh.md)。用户不编辑 root record、摘要或 provider ref；Herdr
尚未加入首次引导。直接使用底层库时，对应参数为 `LuvusLocalConfig.agent_bin_dir` 或
`HerdrLocalConfig.agent_bin_dir`，Herdr 仍由其既有本地 provider 配置交付；它们不是另一个
CLI 用户文件入口。

填写单个规范绝对目录，不是可执行文件或 PATH 列表。相对路径、`~`、变量展开、路径
折叠、控制字符和平台 PATH 分隔符均不作为目录解析；空格和 Unicode 保留。Windows
路径使用 JSON 转义的反斜线及分号分隔，当前原生 owner 的验收范围仍仅为 Linux。
Rovloom 不创建目录、不安装 Agent，也不把安装目录当作终端执行许可。

Linux 启动 PATH 为 `<agent_bin_dir>:/usr/bin:/bin`，省略时保持 `/usr/bin:/bin`。
目录内同名程序优先，所以应使用机器所有者控制的安装目录。配置在 native owner 启动
前生效，启动后加载的 Agent 服务环境不能替代它。归属检查使用同一环境构造器；改变
配置须重启对应 owner，不能将存活进程重新解释为新配置。Luvus 首次登记时设置该值，
不手工给已登记 root record 补字段或修改其摘要。MCP/RPC 不接受这个本地配置入口。

Connector 的发现、schema 和代理子进程继续使用受保护的绝对 `cwd`、固定
系统 PATH（可由上述目录前置）和显式最小环境，不复制 Connector 父进程的模型密钥、SSH 或其它
凭据。原生终端命令仍在目标 Luvus/Herdr 进程的 OS 账号及原生 shell 环境中执行；向已
运行的终端输入时，cwd/PATH 由该终端当前状态决定。`terminal.backend.create` 的 cwd
及 workspace/pane 的原生 cwd/env 语义不被重写，执行前应读取目标信息并明确指定需要
的新终端 cwd。可写位置由该账号的实际 OS 权限决定；安装应选择所有者明确准备的项目
或用户目录。本模块不提供文件系统沙箱、不自动提权、不安装 Agent、不配置模型凭据。
Agent 自身获授权后运行的内部工具也不受此开关隔离。

普通 Luvus 入口已审核 `pane.run` 的有界子集 `{pane, command}`，必须显式指定目标 pane。
它使用原生 `workspace` write 契约及既有 Owner raw-contract 路径；generic schema 的事实
保持原样，不伪称完整参数 schema，不新增通用执行 RPC。既有配置可能仍缺该方法的
caller/local/raw-contract 授权，开关开启不补授权。该方法不接受新增 cwd/env/argv 字段；
输入写入原 pane，输出继续用 `pane.read` 读取。

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

Add the optional root boolean `allow_terminal_execution` to the single Connector user JSON file.
It defaults to `false`; only literal `true` enables direct terminal inputs and custom launch or
restore commands. Existing Agent conversations retain their separate native and caller/local
authorization. This switch is not an OS sandbox for Agent tools.
Optional local `agent_bin_dir` prepends one canonical absolute installation directory to the
native owner's fixed PATH. Set `native.agent_bin_dir` in the single Connector user file before native initialization;
omit it to retain the default PATH. Current first-time setup maps it to the protected Luvus root.
Herdr first-time setup is not wired; its existing local provider config supplies the library field. It is not an RPC option, does not
install software, and does not enable terminal execution. Restart the owner after a supported
configuration change; existing Luvus root records remain bound to their original config digest.
Luvus raw `agent.keys` requires the switch even with existing report/session labels, because
those labels do not prove the current foreground program. With the switch off, Luvus text
`agent.send/prompt` requires explicit `strict:true`; omitted or false needs the switch enabled.
The authorized request is never rewritten, and strict prompts keep their native readiness checks.
Nonblank task gates, custom task worker commands, and task completion
or retry paths that can execute saved commands are also covered; plain task records remain usable.

Both adapters recheck the current local switch immediately before their existing native write.
The standard CLI reads the root boolean in the one Connector user file, defaults it to false,
and forwards it independently of immutable installation settings. Edit the file and restart
Connector; there is no argv or Gateway switch. Current authenticated per-provider metadata
lets Gateway hide direct input while local state is off or unknown, without changing native
schemas or granting execution. Connection loss and provider fencing discard the observation.
Luvus `pane.run` accepts an explicit `pane` and bounded `command` through its existing raw-contract
path; prior caller/local/raw policies may still exclude it. Read output through `pane.read`.
Native replies and terminal truncation stay unchanged: input acknowledgments never become
command completion or a fabricated shell exit code. A lost reply after dispatch remains unknown
and is not replayed. No existing real machine is enabled by this change.

## 原生研究依据

- [Luvus 固定版本 pane 输入与读取](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch/topology.rs)：`pane.run` 写入 command 加回车，返回 `ok`；`pane.read` 读取终端画面，不提供逐命令退出码。
- [Luvus 固定版本 Agent 判断与输入](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch/agents.rs)：Agent 输入不回退到普通 pane；报告状态也影响 `is_agent_pane`。
- [Luvus 固定版本任务分派](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/dispatch/orchestration.rs)：`task.add` 保存 gate，`task.start` 可提交自定义 agent 命令；`task.update` 不接收 gate。
- [Luvus 固定版本任务执行](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/board.rs)：任务完成可启动 shell gate，automation task retry 可重启原运行；不能仅从本次请求有无命令判断其可执行性。
- [Luvus 固定版本终端生命周期](https://github.com/RizRiyz/luvus/blob/54003ce9568acb2977e4bbdbb30a61f99faa0465/src/app/backend.rs)：create 完成与短命令退出存在竞态，退出事件来自原生进程回收。
- [Herdr 固定版本 Agent 输入](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/api/agents.rs)：Agent target、运行态与输入成功独立检查，输入 ack 不提供 shell 命令退出证据。

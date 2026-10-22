# Rovloom 配置参考

[English](CONFIGURATION.md) · **简体中文** · [快速开始](QUICK-START-zh.md)

每个角色只有**一份用户 JSON 文件**：`~/.config/rovloom/gateway.json` 或
`~/.config/rovloom/connector.json`。默认文件和用户文件就是同一份。
启动时自动创建缺失的文件，无需复制模板或准备其他配置文件；已有文件严格读取，永不重置。
下列字段除特别说明均为必填。默认值表示新生成文档的值，不是已有文件遗漏字段时的
隐式补值。全部示例均不含凭据。

## 完整最小配置

Gateway，通常为 `~/.config/rovloom/gateway.json`：

```json
{
  "schema_version": 1,
  "role": "gateway",
  "data": {"directory": "/home/your-user/.local/share/rovloom/gateway"},
  "mcp": {"hostname": "127.0.0.1", "port": 9444},
  "devices": {"hostname": "127.0.0.1", "port": 9443},
  "management": {"enabled": true, "port": 9445}
}
```

Connector，通常为 `~/.config/rovloom/connector.json`：

```json
{
  "schema_version": 1,
  "role": "connector",
  "data": {"directory": "/home/your-user/.local/share/rovloom/connector"},
  "gateway": {"url": ""},
  "allow_terminal_execution": false
}
```

保存示例时将 `/home/your-user` 替换为真实 home。程序首次生成时会写入真实 home。
默认 Gateway 可在没有身份时本地启动；Connector 空地址可通过配置检查，本地真实终端会
询问地址，非 TTY 启动返回 `configuration_required`（2）。填写地址不等于已配对或安装原生 provider。

## 全部用户参数

| 字段 | 类型 / 必需性 | 生成默认值 / 作用 |
|---|---|---|
| `schema_version` | integer，必填 | 只能为 `1`。 |
| `role` | string，必填 | `gateway` 或 `connector`，须匹配命令。 |
| `data` | object，必填 | 仅含 `directory`。 |
| `data.directory` | 规范绝对路径 string，≤4096 字符，必填 | `<home>/.local/share/rovloom/<role>`；各角色独立私有数据。 |
| Gateway `mcp` | object，必填 | 含 `hostname`、`port`；Streamable HTTP `/mcp`。 |
| `mcp.hostname` | string，必填 | `127.0.0.1`，也接受 `::1`；仅回环。 |
| `mcp.port` | integer 1–65535，必填 | `9444`。 |
| `mcp.public_url` | 字符串，可选 | 反向代理 / TLS 终止后的受信对外地址，必须恰为 `https://host[:port]/mcp`（无凭据、查询或其它路径）。配置后 Gateway 额外接受 `Host` 为该主机的请求（及其 CORS 来源），其余 `Host` 仍被拒绝，也从不信任转发头；监听仍只在回环，仍需 Bearer。 |
| Gateway `devices` | object，必填 | 含 `hostname`、`port`；WS `/connector`。 |
| `devices.hostname` | string，必填 | `127.0.0.1`，也接受 `::1`、`0.0.0.0`、`::`；默认不接受远程设备。 |
| `devices.port` | integer 1–65535，必填 | `9443`。 |
| Gateway `management` | object，必填 | 含 `enabled`、`port`；本地 HTTP 管理页。 |
| `management.enabled` | boolean，必填 | `true`；`false` 关闭该监听。启用不授予管理员身份。 |
| `management.port` | integer 1–65535，关闭时也必填 | `9445`；监听地址固定 `127.0.0.1`。 |
| Connector `gateway` | object，必填 | 仅含 `url`。 |
| `gateway.url` | string，必填 | 初始化前为 `""`；其余为 ≤2048 字符的 WS/WSS origin，如 `ws://192.0.2.10:9443` 或 `wss://gateway.example`。不带凭据/查询/片段/路径，可带末尾 `/`；产品固定使用 `/connector`。 |
| Connector `allow_terminal_execution` | boolean，可选 | `false`；省略也关闭。只有字面量 `true` 开启直接终端输入及自定义启动/恢复命令。修改这一份用户文件并重启 Connector，不改变安装设置或 caller/local grants。 |
| Connector `native` | object，可选 | 默认省略，只接受以下来源选择及安装目录字段，在首次原生初始化时应用。 |
| `native.provider` | string enum，可选 | 省略时为 `luvus`；`herdr` 仅选 Herdr，`mixed` 各选一个。首次初始化前选定；已初始化选择的变更仍需未来的重配置流程。 |
| `native.runtime_bin_dirs` | 1–16 个互不重复的规范绝对目录 string 数组（每项≤4096字符），可选 | 查找所选 `luvus`/`herdr` 程序的位置。搜索顺序：数组内目录依序，其后是 Connector 启动时 `PATH` 中可用的条目，最后是 `/usr/bin:/bin`。不同程序可装在不同目录。不接受 shell 展开或可执行 argv。 |
| `native.agent_bin_dirs` | 1–16 个互不重复的规范绝对目录 string 数组（每项≤4096字符），可选 | 查找 Agent 程序的目录。原生初始化时 Agent PATH 固化为：数组内目录依序，其后是 Connector 启动时 `PATH` 中可用的条目，最后是 `/usr/bin:/bin`。不安装或认证 Agent。 |
| `native.herdr.mode` | `"attach"`（默认）或 `"managed"`，可选 | 仅 Herdr。`attach`：连接你已在运行的 Herdr，仅在没有实例时在你自己的配置目录里启动一个，实例消失后重新附着/重建。`managed`：Connector 私有、由它拥有的隔离实例。见[Herdr：附着或隔离](#herdr附着或隔离)。 |
| `native.luvus.mode` | `"attach"`（默认）或 `"managed"`，可选 | 仅 Luvus。`attach`：连接你自己的 `default` 会话，仅在没有运行的会话时在你自己的 `LUVUS_HOME` 里启动一个，消失后重新附着/重建。`managed`：Connector 私有的隔离实例（会话名 `rovloom`）。见[Luvus：附着或隔离](#luvus附着或隔离)。 |
| `native.luvus.state_root` | 规范绝对目录 string，可选 | 附着模式下你的 Luvus 状态目录（默认取 Connector 环境里的 `$LUVUS_HOME`，否则 `~/.luvus`）。不存在时以 0700 创建，且必须是私有目录。 |
| `native.herdr.config_home` | 规范绝对目录 string，可选 | 附着模式下你的 Herdr 使用的配置目录（默认 `$XDG_CONFIG_HOME`，否则 `~/.config`）。Connector 以服务运行、环境与你的终端不同时请显式设置。 |

Gateway 已启用的监听端口必须不同。未知字段、旧扁平字段、runtime/ref 选择、TLS/CA
路径、schema 摘要、binary pin 和凭据值均拒绝。用户参数不含原生 root、账本、绑定或
身份摘要。原生初始化后更改安装设置会拒绝；本预览没有引导式原生重配置。
已初始化 Connector 更改 Gateway URL 也会在向另一 origin 发送已保存设备凭据前拒绝。

路径为规范绝对路径，不相对 JSON 位置解析，不展开 `~` 或环境变量。默认角色文件始终
按进程用户 home 选择，Windows 也如此，不使用 AppData 或 XDG 覆盖。`--config` 接受
绝对文件路径，仅覆盖该文件位置；新生成数据目录仍按角色用户 home 选择。已有显式
文件不要求解析 home，缺失文件生成默认值时需要 home。

首次文件创建、角色文件检查和 Gateway 启动支持 Linux/macOS/Windows；首次配对审批和原生
Connector 仍要求 Linux。参见[平台可用性与状态检查](#平台可用性与状态检查)。
模板使用目标平台路径分隔符，文件访问沿用操作系统权限。新建文件/目录在支持的平台
请求 `0600`/`0700`，这是默认值，不是对已有文件的校验要求；不自动修复已有权限或
损坏文件。用户 JSON 上限 16 KiB，不支持注释，拒绝非法编码和重复键。

## 程序管理的数据与认证

用户只编辑角色文件。`data.directory` 指定 Rovloom 保存数据库、设备凭据和原生状态
的位置，默认是 `~/.local/share/rovloom/gateway` 或
`~/.local/share/rovloom/connector`；加载器内部将此值称为 `state_dir`。
程序在启动和批准的初始化中准备自己的数据，无需手工准备 `runtime.json`、`refs/`
目录、provider JSON 或凭据文件。它们不是额外的用户配置；旧 `runtime.json`/`refs/`
格式不再加载或迁移。

保留整个数据目录，包括数据库附属文件。不要修改内部记录，也不要为重试不确定的
初始化而删除数据。Herdr 在 `<data.directory>/hr/` 管理隔离的 `h/c/s/k/t/w/control` 目录及原 schema、claims；
这些不是额外用户配置。引导恢复尚不可用。
首次 Luvus 设置要求 `data.directory` 路径加 `/n` 不超过52个 UTF-8 字节，
如有需要，请在配对前选择更短的目录。

没有 caller 状态的 Gateway 以**待配对**状态运行，MCP 返回 401，管理页在创建管理员之前
只显示空壳、没有设备数据（见下）。既有 MCP 接入仍使用为精确 `http://<MCP-host>:<port>/mcp` 资源签发的 Bearer；
首次原生批准为精确审核 Target 创建一个本机 caller，Bearer 仅显示到已核验本地终端，
原值由 Rovloom 私密保留；复制到 MCP 客户端秘密存储。
默认有效期30天，可用 `rovloom token` 管理（见下）。设备凭据、
MCP Bearer 与独立管理证明互不替代。管理页使用独立的管理员密码，MCP Bearer 不能登录管理员；
首次引导不创建默认管理员，需要用 `rovloom admin create` 创建。

### 管理页管理员

```text
rovloom admin create [--principal admin] [--ttl-days 30]
rovloom admin list
rovloom admin revoke [--principal admin]
```

管理页（默认 `http://127.0.0.1:9445/`）用 HTTP Basic 登录：用户名是管理员 ID（默认 `admin`），密码是
`create` 写到 stdout 的那一串，**只显示一次**（其余信息写 stderr）。Gateway 只在 `managed/management.json`
保存它的 SHA-256 摘要。创建、重新签发和撤销都**无需重启**：对已有 ID 重新 `create`（忘记密码时的做法）会替换密码，
并使用旧密码已登录的浏览器会话立即失效；`revoke` 同样立即生效。管理员能查看并管理 Gateway 已知的全部设备和
provider，包括之后才配对的。管理员不能调用 MCP：MCP 调用方注册表里对应的条目策略为空、令牌无人知晓，
并且不出现在 `rovloom token list` 里。请在首次配对完成后再运行 `rovloom admin create`（它依赖配对创建的调用方注册表）。
Docker 里用 `docker compose exec gateway rovloom admin create`。

### Bearer 令牌管理

```text
rovloom token list
rovloom token create --principal worker --like owner [--ttl-days 30]
rovloom token renew  --principal owner [--ttl-days 30]
rovloom token rotate --principal owner [--ttl-days 30] [--grace-minutes 10]
rovloom token revoke --principal worker
```

令牌注册表（Gateway 状态目录下的 `managed/mcp-callers.json`）只保存 SHA-256 摘要、主体策略和固定到期；
Gateway 每次认证都重读它，因此创建、续期、轮换和吊销**无需重启**，吊销同时使已建立的 MCP 会话失效。
`create`/`rotate` 把新令牌原值只写到 stdout 一次（其余信息写 stderr）；新主体的权限克隆自 `--like`，不会扩大。
`rotate` 默认立即让旧令牌失效，`--grace-minutes` 给客户端一个有界的切换窗口。本机 `mcp-client.json`
属于同一主体时会同步更新。文件损坏时拒绝全部认证，修复后自动恢复。可选 OIDC 暂未提供。

Connector 需要可达 Gateway 地址和已完成的配对/原生状态。真实本地 TTY 上，Gateway
批准后签发五分钟一次性码；Connector 输入地址及不回显的码，兑换既有 enrollment，
先私密持久保存设备身份，再确认该次准确交付。实测安装还需独立
所有者确认，才建立 provider/caller 配置。非 TTY 不等待输入或创建这些权限；初始化
不会登录模型、创建 Agent 或证明模型回复。缺少 provider 状态表示待配置，
损坏或不安全状态会拒绝。`config check-runtime` 检查已有程序管理 provider registry，
不检查 caller 凭据、TLS 信任、原生 binary 或模型连接。

## 网络访问

Gateway 在本机/可信网络使用普通 HTTP/WS，公网 TLS 由外部标准 HTTPS/WSS 反向代理
终止。Connector WSS 始终使用系统证书验证，没有自定义 CA 或跳过验证选项。

## 原生安装与 pins

通过官方 [latest Luvus](https://github.com/RizRiyz/luvus/releases/latest) 或
[latest Herdr](https://github.com/herdrdev/herdr/releases/latest) 分发安装。兼容性按安装版协议、完整请求/响应
schema 和实际方法能力判断；版本标签只用于诊断，不要求固定原生发行版或预设 binary/schema
摘要。缺少或不兼容的可选接口仅使依赖操作不可用。

| 接入依据 | Luvus | Herdr |
|---|---|---|
| Schema 命令 | `luvus uhp schema` | `herdr api schema --json` |
| 协议依据 | UHP v1 信封及实际在线方法目录 | schema 中的实际协议和完整 JSON RPC 根 |
| Adapter revision | `managed-owned-luvus-0.14.3-1` | `herdr-workflow-4` |
| Classification revision | `managed-owned-rpc-1` | `herdr-0.9.5-workflow-4` |

revision 字符串标识 Rovloom 适配/分类代码，其中的历史版本文字不是原生安装要求。
程序管理的受保护状态与当前来源仍须一致指向实际 binary/schema 摘要、完整目标和 generation；
schema 输出保留原字节。已知预编译摘要只用于缓存命中，未知 schema 在同一编译预算内完整编译。
这些是接入检查，不是用户 JSON 字段。内部发现不等于用户侧 provider 初始化或安装原生程序；
首次生成配置文件不会准备原生设置或模型访问。

## Herdr：附着或隔离

**attach（默认）。** 初始化时记录你真实的 `HOME` 与 XDG 目录（取自 Connector 的环境，或 `native.herdr.config_home`）。每次启动 Connector 会：

1. 在默认会话的端点上寻找 Herdr 服务端；只有证明对端就是你已安装的 `herdr` 才附着：同一用户、进程可执行文件与配置的二进制是同一文件、
   命令行为 `herdr server`（或 `--session <名> server`）；
2. 没有实例才在你的配置目录里以脱离方式启动 `herdr --session <名> server`——Connector 退出后它继续运行（工作区也保留）；
3. 持续监视该实例。实例消失时，Connector 关闭旧资源、带退避地重新附着或启动新实例，并结束当前连接，使下一个认证周期使用新实例。此刻在途的调用保持
   `outcome_unknown`，不会重发。

**不是**你已安装 `herdr` 的监听者既不会被附着也不会被替换。Connector 启动的服务端继承你的 shell 与 Git 配置，但不继承其它环境变量（SSH agent、API key 等），
Agent 凭据请配置在 Agent 自己的文件里。远程调用会操作你的**真实**工作区，Gateway 授权与 `allow_terminal_execution` 仍是仅有的围栏。

**managed。** 在 Connector 数据目录下（`<data.directory>/hr`）的私有实例，由 Connector 拥有并随之停止，不共享你普通 home 里的任何东西。

## Luvus：附着或隔离

**attach（默认）。** Gateway 配对目标是你的 `default` 会话（Gateway 提示里显示 `session: default`）。初始化时记录你真实的
`HOME` 与状态目录（`native.luvus.state_root`，否则 `$LUVUS_HOME`，否则 `~/.luvus`）。每次启动 Connector 会：

1. 用固定的 `luvus` 列出会话（`session list --json`，以私有 HOME 运行，不读取其它内容）；只有 `default` 正在运行**且**其 socket
   对端被证明就是你已安装的 `luvus` 才附着：同一用户、进程可执行文件与配置的二进制是同一文件、命令行为
   `luvus [--session default] server`；
2. 否则以脱离方式启动 `luvus --session default server`，使用你真实的 `HOME`、shell 和 `LUVUS_HOME`（不带 SSH agent、API key
   等变量），Connector 退出后它继续运行；
3. 持续监视该实例。消失时带退避地重新附着或启动新实例，并结束当前连接，使下一个认证周期使用新实例。此刻在途的调用保持
   `outcome_unknown`，不会重发。

该端点上**不是**你已安装 `luvus` 的 server 既不会被附着也不会被替换。远程调用会操作你的**真实**工作区，Gateway 授权与
`allow_terminal_execution` 仍是仅有的围栏。

**managed。** 在 Connector 数据目录下的私有实例（会话名 `rovloom`），由 Connector 拥有并随之停止。数据目录路径加 `/n` 须不超过
52 字节，不共享你普通 home 里的任何东西。

## 崩溃后重启

Connector 被强杀（`kill -9`、掉电）后会遗留 owner 记录、native 端点 socket 和 claim 账本锁。
下次启动时，只有在**能证明旧 owner 已不存在**时 Connector 才会自行清理：owner 记录里的进程
已不存在（Linux，按 PID 与内核启动时间判断），且 native socket 上没有监听者。清理后向 stderr
输出 `herdr_crash_residue_cleared` 并正常启动。claim 账本及其中的派发记录不会被触碰，
可能已执行的调用不会被重发。若旧 owner 仍存活、仍有 native 进程在监听、记录来自旧版本或平台
不是 Linux，则与以前一样拒绝启动（退出码 3），需先停掉仍存活的进程。

Luvus 的两把崩溃锁（claim 账本锁、root 拥有锁）同理：锁里现在记录持有进程（PID 与内核启动时间）。
下次启动时，只有该进程已不存在才会移除锁；拥有锁还要求该会话的 Luvus socket 上无人监听（仍存活的孤儿
`luvus` server 会让启动继续被拒绝）。移除后向 stderr 输出 `luvus_crash_residue_cleared`。旧版本留下的空锁、
无法读取的锁和非 Linux 平台仍保持拒绝，需手工删锁。claim 账本及其派发记录始终不会被触碰。

## 程序与 Agent 安装目录

官方 runtime（`luvus`/`herdr`）和 Agent（如 OpenCode）可以装在机器上任意合适的位置，不必
同一目录。默认通过 Connector 启动时的 `PATH` 加 `/usr/bin:/bin` 查找它们。原生集成**不会**
使用登录 shell 的 PATH：首次原生初始化时一次性算出搜索路径，固化到受保护的安装记录，
之后每次启动都会复核。

`PATH` 里只有部分条目可用：规范绝对路径、真实存在的目录（不是符号链接、文件或缺失路径），
属于 root 或 Connector 用户，且组/其它用户不可写；其余条目静默跳过。最多保留 16 个目录，
显式目录在前。若服务管理器给 Connector 的 `PATH` 很精简，请在**批准原生初始化前**于唯一
Connector 用户文件里显式列出目录：

```json
{
  "native": {
    "runtime_bin_dirs": ["/opt/herdr/bin", "/home/your-user/.local/bin"],
    "agent_bin_dirs": ["/home/your-user/.local/bin", "/home/your-user/.opencode/bin"]
  }
}
```

两个字段都是可选的规范绝对目录数组（不接受 `~`、变量、相对路径、`..`、末尾斜杠或 `a:b`
式 PATH 字符串，不允许重复）。显式目录按所写原样信任，所以应由机器所有者控制；靠前目录里的
同名程序优先。这是原生安装设置，不是可执行文件路径、MCP 参数或命令行选项。不要修改 managed
root 记录或摘要来更换已初始化的安装。

Agent/模型访问配置位于 runtime 私有 HOME/XDG；首次设置的 HOME 为
`<data.directory>/h`（Luvus）或 `<data.directory>/hr/h`（Herdr），不会复制普通 home 中的登录。本预览没有这个隔离环境的模型
登录引导，因此全新模型设置仍需机器所有者准备。普通严格文本对话可保持本地
`allow_terminal_execution:false`，不要用任意 argv/env 或终端输入绕过缺失 PATH。
终端开关不会沙箱化 Agent 自身工具；binary/schema 校验或 `ready` 不证明模型已回复。

直接终端操作复用原生方法：Luvus `pane.run` 接受显式 `pane` 与 `command`，随后用
`pane.read` 读取终端输出。`ok` 仅确认 PTY 输入，不表示命令完成或 shell 退出码。
当前认证 Gateway 目录在本地开关关闭或未知时隐藏直接输入，保留并标明严格文本变体的
参数限制。已有初始化策略可能未包含 `pane.run`，开启本地开关不会修改它们。执行环境、
输出和未知结果语义见[终端执行](TERMINAL-EXECUTION.md)。

## 完整 CLI 参考

以下覆盖当前产品的全部命令形状。`ROLE` 表示 `gateway` 或 `connector`，`ABS` 表示
单独作为参数传入的规范绝对路径；请将示例路径换成自己的实际位置。命令及选项名区分大小写，
不支持 `--option=value`、组合短选项或未声明的额外参数。只有顶层帮助提供短选项。

### 帮助、版本与配置

| 命令 | 参数 / 选项 | 默认值 / 作用 | 合法示例 |
|---|---|---|---|
| `rovloom` | 无 | 输出顶层帮助，不启动角色。 | `rovloom` |
| `rovloom --help`、`rovloom -h`、`rovloom help` | 不接受额外参数 | 等价的离线帮助。 | `rovloom -h` |
| `rovloom --version` | 不接受额外参数 | 输出产品版本，没有 `-v` 别名。 | `rovloom --version` |
| `rovloom gateway --help`、`rovloom connector --help` | 仅一个 `--help` | 输出顶层帮助，不能与 `--config` 同用。 | `rovloom connector --help` |
| `rovloom config template ROLE` | 必填位置 enum `ROLE`，无选项 | 输出完整无秘密角色 JSON，不写文件。 | `rovloom config template gateway` |
| `rovloom config check [--role ROLE] [--config ABS]` | `--role`：可选 `gateway`/`connector`；`--config`：可选绝对路径 string | 无选项时读取两份默认用户文件并分别报告；role单选，显式文件覆盖路径。始终只读，不生成缺失文件。 | `rovloom config check` |
| `rovloom config check-runtime [--role ROLE] [--config ABS]` | 与 `check` 相同的可选role和路径选项 | 使用相同默认选择，额外检查已有程序管理 provider 状态；不创建、不加载凭据或确认 Agent 就绪。 | `rovloom config check-runtime --role connector` |

两种检查的 `--role` 和 `--config` 顺序可交换。仅指定文件时按文件内声明的角色检查；
同时指定角色时必须匹配。检查两份时一份错误不会跳过另一份，任一失败则退出非零。
检查均不创建缺失文件。

### 运行角色

| 命令 | 参数 / 选项 | 默认值 / 作用 | 合法示例 |
|---|---|---|---|
| `rovloom gateway [--config ABS]` | `--config`：可选路径 string | 默认使用当前用户 `~/.config/rovloom/gateway.json`，启动前台 Gateway。 | `rovloom gateway --config /home/rovloom/.config/rovloom/gateway.json` |
| `rovloom connector [--config ABS]` | `--config`：可选路径 string | 默认使用当前用户 `~/.config/rovloom/connector.json`，启动前台 Connector。 | `rovloom connector --config /home/rovloom/.config/rovloom/connector.json` |

显式路径优先，无效时不会回退。所选文件必须匹配角色。Linux/macOS/Windows 在所选位置生成缺失文件，不覆盖已有文件；
默认路径按进程用户解析。Ctrl-C 停止前台角色，没有独立的顶层
`start`、`stop` 或 `restart`。网络端口是 JSON 字段，不是 CLI 选项；provider 初始化仅接通
上述所选 Luvus/Herdr 的本地终端流程，Agent/模型登录仍需独立准备。

### Service 命令语法与当前可用性

`rovloom service --help` 可离线使用。Gateway连接Linux systemd、macOS系统LaunchDaemon或Windows用户开机任务；安装要求当前
Rovloom单文件、正常系统服务授权、既有非root账户及存在的工作目录。已有配置检查JSON/角色，
缺失配置留给正常首次启动生成；安装器不要求UID/mode/ACL或祖先防替换证明，不修改既有权限。
Windows使用显式选择的既有用户S4U及同一配置绝对路径；原生格式解析不等于生命周期验收。
见[服务前提与平台限制](SERVICE.md)。

| 命令形状 | 必填参数 | 动作含义 | Linux 语法示例 |
|---|---|---|---|
| `rovloom service install` | `--role`、`--workdir`、`--user`；`--executable`、`--config` 可选 | 加入/启用开机自动启动，**不会立即启动**。 | `rovloom service install --role gateway --executable /opt/rovloom/rovloom --config /home/rovloom/.config/rovloom/gateway.json --workdir /home/rovloom --user rovloom` |
| `rovloom service start` | 仅 `--role` | 立即启动已安装角色，不自动安装。 | `rovloom service start --role gateway` |
| `rovloom service restart` | 仅 `--role` | 停止已安装实例，再启动。 | `rovloom service restart --role connector` |
| `rovloom service stop` | 仅 `--role` | 立即停止，保留下次开机自动启动。 | `rovloom service stop --role connector` |
| `rovloom service uninstall` | 仅 `--role` | 删除未来开机自动启动，**不会停止**正在运行的实例，也不删除用户数据。 | `rovloom service uninstall --role gateway` |

每个服务动作只选择一个角色，另一角色需单独操作。没有默认角色、`all` 角色、`--now`、
`--force`、`--purge` 或 `service status` 命令；其他动作不接受仅安装适用的选项。

| 服务选项 | 类型 / 必需性 / 默认 | 用途 |
|---|---|---|
| `--role` | 必填 enum `gateway` 或 `connector`，无默认 | 选择要管理其自启/实例的角色。 |
| `--executable` | 仅 install，可选绝对路径 string，≤4096 字符，默认当前单文件程序 | 必须等于当前规范可执行路径；拒绝另一安装、shell 或解释器。Windows 路径须以 `.exe` 结尾。 |
| `--config` | 仅 install，可选绝对路径 string，≤4096 字符 | 省略时与前台使用当前用户同一份角色文件。安装固定其绝对路径，后台不另选home；通过sudo执行时显式传原用户文件的绝对路径。 |
| `--workdir` | 仅 install，必填绝对目录 string，≤4096 字符，无默认 | 服务工作目录，不设置或替代 JSON 的 `data.directory`。 |
| `--user` | 仅 install，必填账户 string，无默认 | Linux/macOS上既有非root账户；Windows既有用户名或用户SID，以S4U运行，不保存密码；不另选配置目录。 |

服务路径在安装时固定，后续开机/start/restart 使用已记录的绝对角色配置，不重新解析 home。
安装使用正常系统服务授权与明确的运行账户，不增加文件UID/mode/ACL或祖先限制；
不创建账户、不修改已有权限。Windows使用所选既有用户，不自动切换为系统服务账户。
运行账户不决定第二套配置目录。安装不启动角色，
不预先要求状态目录存在；角色正常启动继续处理配置与连接错误。
Linux 工作目录不得以空白或反斜杠结尾。

服务动作将安装和运行状态分开：install 后再 start 才分别请求开机自启和立即运行；
uninstall 后再 stop 才分别请求不再开机自启和立即停止。重复 start 不应产生重复实例，
start/restart 要求已有安装记录。stop 本身不删除开机自启。Windows stop/restart
可能直接终止任务，不能当作原生工作回滚。

### 平台可用性与状态检查

| 命令类别 | Linux | macOS | Windows |
|---|---|---|---|
| 帮助/版本/模板输出 | 可用 | 可用 | 可用 |
| `config check` | 普通操作系统文件访问 | 普通操作系统文件访问 | 普通操作系统文件访问 |
| 缺失角色文件创建 | 可用 | 可用 | 可用 |
| Gateway 启动 / `config check-runtime` | 可用 | 可用 | 可用 |
| 首次配对审批 | 要求本地终端 | 尚不可用 | 要求本地终端（x64） |
| 原生 Connector | Linux x64 | 不支持 | x64：附着用户已运行的 Herdr / Luvus（不存在才自建）；Windows 上不支持隔离 managed 模式 |
| Service 动作 | 生产systemd后端已连接；本机Connector限x64 | Gateway系统LaunchDaemon；本机Connector仍拒绝 | Gateway与x64本机Connector均用登录用户的BootTrigger开机任务（S4U） |
| `update --check` | x64/arm64，需要实测 glibc | x64/arm64 元数据检查 | x64/arm64 元数据检查 |

本预览没有可用的 Rovloom 服务状态查询，
请通过前台进程及 Quick Start 中的管理页/MCP 检查当前 runtime 就绪状态。
进程运行本身不证明 MCP 或 Agent 就绪，HTTP 客户端断开也不会停止 Gateway。

### Update 命令

| 命令 | 参数 / 选项 | 作用与当前限制 | 合法示例 |
|---|---|---|---|
| `rovloom update --help` | 无额外参数 | 离线更新帮助。 | `rovloom update --help` |
| `rovloom update --check` | `--check`：可选的仅检查 boolean 开关，不带值 | 经网络读取官方稳定发行元数据，不替换程序。 | `rovloom update --check` |
| `rovloom update` | 无参数 | 先检查；没有新版本时不替换并返回 0，存在新版本时因缺少替换后端返回 `replacement_unavailable`（5）。 | `rovloom update` |

目前没有公开发行，网络检查可能返回 `release_unavailable`。`update` 返回 0 不等于
安装了新程序。不接受 URL、镜像、版本选择器、下载路径、脚本或确认选项。
发行矩阵表示更新元数据目标，不代表完整 Gateway/Connector runtime 支持。

### 输出与退出码

帮助、版本、检查诊断、服务诊断和更新状态写入 **stderr**，模板 JSON 写入 **stdout**。
stdout 不是 MCP 传输。任何命令都不接受 Bearer、TLS 秘密、模型秘密或任意环境变量选项。
`init`、`pair`、`status`、`--token`、`--port`、`--env`、`--agent-bin-dir` 不属于此 CLI。

| 退出码 | 角色/配置/服务含义 | Update 含义 |
|---|---|---|
| `0` | 帮助/模板/检查成功、角色正常关闭；服务操作成功或幂等 | 检查成功或无需替换，实际替换目前未接通。 |
| `1` | 运行/关闭失败；已接后端时的服务操作失败 | 未预期的更新失败。 |
| `2` | 参数/配置错误；已接服务后端时的选项错误或缺少可信默认配置 | 参数/当前版本无效或平台不支持。 |
| `3` | 后端/运行时不可用或服务平台不支持 | 网络/发行/manifest/下载核验失败。 |
| `4` | 不是角色/配置/服务成功码 | 权限/暂存/锁/安装或 IO/清理未完成，不是成功。 |
| `5` | 这些命令不使用 | 替换后端不可用。 |
| `6` | 这些命令不使用 | 更新已回滚（替换模块结果）。 |
| `7` | 这些命令不使用 | 需要恢复（替换模块结果）。 |

产品先解析 service 选项，再校验授权。非法选项返回 `invalid_arguments`（2），Linux 权限
不足返回 `permission_denied`（1），不会调用 sudo。成功诊断以固定 JSON 写入 stderr，分别报告
`bootEnabled`、`controlRetained` 与 `readiness: "not_checked"`。求助时保留错误码，不上传真实配置或秘密。

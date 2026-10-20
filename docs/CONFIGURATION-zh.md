# Rovloom 配置参考

[English](CONFIGURATION.md) · **简体中文** · [快速开始](QUICK-START-zh.md)

每个角色在默认位置只有一份用户 JSON，不区分另一份defaults文件与用户文件。启动仅在文件缺失时生成；已有文件严格解析，永不重置。
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
  "gateway": {"url": ""}
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
| Gateway `devices` | object，必填 | 含 `hostname`、`port`；WS `/connector`。 |
| `devices.hostname` | string，必填 | `127.0.0.1`，也接受 `::1`、`0.0.0.0`、`::`；默认不接受远程设备。 |
| `devices.port` | integer 1–65535，必填 | `9443`。 |
| Gateway `management` | object，必填 | 含 `enabled`、`port`；本地 HTTP 管理页。 |
| `management.enabled` | boolean，必填 | `true`；`false` 关闭该监听。启用不授予管理员身份。 |
| `management.port` | integer 1–65535，关闭时也必填 | `9445`；监听地址固定 `127.0.0.1`。 |
| Connector `gateway` | object，必填 | 仅含 `url`。 |
| `gateway.url` | string，必填 | 初始化前为 `""`；其余为 ≤2048 字符的 WS/WSS origin，如 `ws://192.0.2.10:9443` 或 `wss://gateway.example`。不带凭据/查询/片段/路径，可带末尾 `/`；产品固定使用 `/connector`。 |
| Connector `native` | object，可选 | 默认省略，只接受以下两个安装目录字段，在首次 Luvus 初始化时应用。 |
| `native.runtime_bin_dir` | 规范绝对目录 string，≤4096字符，可选 | 省略时在 `/usr/bin:/bin` 查找 `luvus`；指定时先搜索该目录，再搜索固定系统目录。不接受 PATH 列表、shell 展开或可执行 argv。 |
| `native.agent_bin_dir` | 规范绝对目录 string，≤4096字符，可选 | 省略时原生/Agent PATH 为 `/usr/bin:/bin`；指定时只前置该单目录，不安装或认证 Agent。 |

Gateway 已启用的监听端口必须不同。未知字段、旧扁平字段、runtime/ref 选择、TLS/CA
路径、schema 摘要、binary pin 和凭据值均拒绝。用户参数不含原生 root、账本、绑定或
身份摘要。原生初始化后更改安装设置会拒绝；本预览没有引导式原生重配置。
已初始化 Connector 更改 Gateway URL 也会在向另一 origin 发送已保存设备凭据前拒绝。

路径为规范绝对路径，不相对 JSON 位置解析，不展开 `~` 或环境变量。默认角色文件始终
按进程用户 home 选择，Windows 也如此，不使用 AppData 或 XDG 覆盖。`--config` 接受
绝对文件路径，仅覆盖该文件位置；新生成数据目录仍按角色用户 home 选择。已有显式
文件不要求解析 home，缺失文件生成默认值时需要 home。

首次文件创建和 runtime 目前要求 Linux。受保护角色文件检查支持 POSIX，在 Windows
返回 `config_platform_unsupported`。模板使用目标平台路径分隔符。文件保持 `0600`，
所在私有目录保持 `0700`，属于进程用户；新建时使用这些权限，不自动修复已有权限或
损坏文件。用户 JSON 上限 16 KiB，不支持注释，拒绝非法编码和重复键。

## 程序管理的数据与认证

用户只编辑角色文件。Gateway 启动创建缺失的私有数据/控制目录并打开真实数据库。
下列布局仅用于识别，不是需要手工准备的文件清单：

```text
<Gateway data.directory>/
  gateway.db          设备、provider、调用和结果
  identity.db         设备身份状态
  managed/            私有程序管理 provider/caller/管理状态
<Connector data.directory>/
  managed/            已准备时的私有配对凭据和provider状态
  control/            受保护Luvus root记录、claims和admission账本
  n/                  隔离Luvus状态；该完整路径最多52个UTF-8字节
  h/                  隔离HOME及config/data/cache/runtime XDG子目录
  w/                  隔离原生工作目录
```

数据库可有 WAL/锁/控制附属文件，保留整个目录。不要编辑记录、编造凭据或重建缺失
账本。原生 runtime 自有状态及安装目录不属于用户配置；首次本地终端批准会准备上述
Luvus 资源，尚未接通 Herdr/混合首次引导。部分创建和不确定交付保留原非秘密 attempt
记录，不为启动成功而重建缺失账本；引导恢复尚不可用。
旧 `runtime.json` 和 `refs/` 不再加载，未发布预览不保留旧格式迁移。
已移除自管证书/CA 路径。

没有 caller 状态的 Gateway 以**待配对**状态运行，MCP 返回 401，管理页不创建管理员
会话。既有 MCP 接入仍使用为精确 `http://<MCP-host>:<port>/mcp` 资源签发的 Bearer；
首次原生批准为精确审核 Target 创建一个本机 caller，Bearer 仅显示到已核验本地终端，
原值保留于私有 `managed/mcp-client.json`（0600）；复制到 MCP 客户端秘密存储。
有效期30天，本预览没有续期引导。`managed/mcp-callers.json` 保存摘要和期限。设备凭据、
MCP Bearer 与独立管理证明互不替代。既有管理认证仍使用独立 principal/proof，
MCP Bearer 不能登录管理员；首次引导不创建管理 cookie 或默认管理员。

Connector 需要可达 Gateway 地址和已完成的配对/原生状态。真实本地 TTY 上，Gateway
批准后签发五分钟一次性码；Connector 输入地址及不回显的码，兑换既有 enrollment，
先把设备身份持久保存到 `managed/device.json`，再确认该次准确交付。实测安装还需独立
所有者确认，才建立 provider/caller 配置。非 TTY 不等待输入或创建这些权限；初始化
不会登录模型、创建 Agent 或证明模型回复。缺少 provider 状态表示待配置，
损坏或不安全状态会拒绝。`config check-runtime` 检查已有程序管理 provider registry，
不检查 caller 凭据、TLS 信任、原生 binary 或模型连接。

Gateway 在本机/可信网络使用普通 HTTP/WS，公网 TLS 由外部标准 HTTPS/WSS 反向代理
终止。Connector WSS 始终使用系统证书验证，没有自定义 CA 或跳过验证选项。

## 原生安装与 pins

通过官方 [Luvus](https://github.com/RizRiyz/luvus) 或
[Herdr](https://github.com/herdrdev/herdr/releases) 分发安装。兼容性按安装版协议、完整请求/响应
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

## Agent 安装目录

将官方 Agent（如 OpenCode）安装到机器所有者控制的目录。既有原生集成使用
`/usr/bin:/bin`，不继承登录 shell 的 PATH。所有者选择的 `agent_bin_dir` 可前置一个
规范绝对目录；它是原生安装设置，不是程序文件、PATH 列表、MCP 参数或
`--agent-bin-dir` 选项。首次原生初始化前，在唯一 Connector 用户文件加入可选片段：

```json
{
  "native": {
    "runtime_bin_dir": "/home/your-user/.local/bin",
    "agent_bin_dir": "/home/your-user/.local/bin"
  }
}
```

这是完整 Connector 文档中的可选片段。安装目录应由机器所有者控制；不要修改 managed
root 记录或摘要来更换已初始化的安装。

Agent/模型访问配置位于 runtime 私有 HOME/XDG。普通严格文本对话可保持本地
`allow_terminal_execution:false`，不要用任意 argv/env 或终端输入绕过缺失 PATH。
终端开关不会沙箱化 Agent 自身工具；binary/schema 校验或 `ready` 不证明模型已回复。

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

显式路径优先，无效时不会回退。所选文件必须匹配角色。Linux 在所选位置生成缺失文件，不覆盖已有文件；
默认路径按进程用户解析。Ctrl-C 停止前台角色，没有独立的顶层
`start`、`stop` 或 `restart`。网络端口是 JSON 字段，不是 CLI 选项；provider 初始化仅接通
上述本地终端 Luvus 流程，Agent/模型登录仍需独立准备。

### Service 命令语法与当前可用性

`rovloom service --help` 可离线使用。产品入口已连接 Linux systemd 后端；安装要求当前
Rovloom单文件、正常系统服务授权、既有非root账户及存在的工作目录。已有配置检查JSON/角色，
缺失配置留给正常首次启动生成；安装器不要求UID/mode/ACL或祖先防替换证明，不修改既有权限。
macOS产品接线单独交付，Windows等待普通角色启动接口；原生格式解析不等于生命周期验收。
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
| `--config` | 仅 install，可选绝对路径 string，≤4096 字符 | 显式角色配置。省略时从所选 `--user` 服务账户的系统记录取得 home，再复用共享的 `~/.config/rovloom/gateway.json` 或 `connector.json` 规则；无法验证身份时必须显式传入（`config_path_required`），不根据环境变量猜测提权前 home。 |
| `--workdir` | 仅 install，必填绝对目录 string，≤4096 字符，无默认 | 服务工作目录，不设置或替代 JSON 的 `data.directory`。 |
| `--user` | 仅 install，必填账户 string，无默认 | Linux/macOS 上既有非 root 账户；Windows 仅接受 LocalService SID `S-1-5-19`，不使用密码。 |

服务路径在安装时固定，后续开机/start/restart 使用已记录的绝对角色配置，不重新解析 home。
安装使用正常系统服务授权与明确的运行账户，不增加文件UID/mode/ACL或祖先限制；
不创建账户、不修改已有权限。Windows使用LocalService，不自动切换为SYSTEM。
Linux宿主从系统账户记录选择默认配置路径，不读取安装管理员HOME。安装不启动角色，
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
| `config check` | 受保护 POSIX 读取器 | 受保护 POSIX 读取器 | 拒绝：`config_platform_unsupported` |
| `config check-runtime`、真实角色启动 | 当前部署指引覆盖 Linux x64 | runtime 加载器拒绝该平台 | runtime 加载器拒绝该平台 |
| Service 动作 | 生产 systemd 后端已连接；Gateway 限 Linux，Connector 本机 owner 限 x64；仍需生命周期/开机验收 | 产品在系统访问前拒绝；runtime 未支持 | 产品在系统访问前拒绝；普通角色文件与启动接线未完成 |
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

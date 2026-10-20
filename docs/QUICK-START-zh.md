# Rovloom 快速开始

[English](QUICK-START.md) · **简体中文** · [配置参考](CONFIGURATION-zh.md)

一台 **Gateway** 提供 MCP 入口，每台运行 Luvus 或 Herdr 的机器启动一个主动出站的
**Connector**。每个角色只有一份用户配置，并使用独立的数据目录。

## 1. 安装并启动

当前预览的 runtime 要求 **Linux x64**。尚无公开安装包，请从管理员取得已批准的
单文件程序并放入 PATH。先运行 `rovloom --version` 和 `rovloom --help` 检查程序。

Gateway 机器运行：

```sh
rovloom gateway
```

原生运行机器运行：

```sh
rovloom connector
```

第一条命令会创建缺失的 `~/.config/rovloom/gateway.json`，启动本地 Gateway，输出
`gateway_listening` 和 `pairing_required`。默认 MCP 为 `http://127.0.0.1:9444/mcp`，
设备 WS 监听为 `127.0.0.1:9443`，本地管理页为 `http://127.0.0.1:9445/`。
未配对 Gateway 不授予 MCP 身份或管理员权限，打开页面不等于默认管理员登录。

第二条命令会创建缺失的 `~/.config/rovloom/connector.json`，然后以
`configuration_required`（2）退出。**输入地址/配对码的交互引导、一次性配对交付和
自动原生初始化尚未接通。** 本预览还不能让全新设备完成部署。既有安装仍需要已准备的
程序管理配对身份、provider 状态及 MCP caller 接入；编辑 JSON 或看到配对进度不代表
这些资源已建立。不要手工构造摘要、绑定或凭据。

非交互输入下 Connector 会立即返回，不等待 stdin。产品没有 `init` 或 `pair` 命令。
后续步骤适用于管理员已提供可用安装的情况，不表示全新设备已完成初始化。

## 2. 配置与网络

| 角色 | 用户配置 | 默认数据目录 |
|---|---|---|
| Gateway | `~/.config/rovloom/gateway.json` | `~/.local/share/rovloom/gateway` |
| Connector | `~/.config/rovloom/connector.json` | `~/.local/share/rovloom/connector` |

此处 `~` 表示当前进程用户的 home。默认位置与用户配置是同一份文件，角色只生成自己的缺失文件，不覆盖任何已有文件，
包括损坏文件。`--config /absolute/path.json` 选择该精确位置，首次创建也使用它。
没有工作目录搜索、跨角色回退或 AppData/XDG 覆盖。Windows 的默认路径约定相同，但
runtime 与首次文件创建目前要求 Linux；已有受保护角色 JSON 可在 POSIX 检查。
JSON 内路径必须是规范绝对路径，不展开 `~`、变量或相对配置文件的路径。

完整示例和所有参数见[配置参考](CONFIGURATION-zh.md)。文件权限为 `0600`，所在私有
目录为 `0700`，属于角色用户。程序管理的状态、数据库和凭据位于角色数据目录，
无需准备用户 `runtime.json`、ref 清单、CA 或证书文件。

另一台设备接入时，为 Gateway 的 `devices.hostname` 设置合适的监听地址，并把
Connector 的 `gateway.url` 设为可达的 `ws://host:port` 或 `wss://host:port` origin，
不带 `/connector`、凭据或查询参数。默认仅本机可达。本机或可信网络使用 HTTP/WS；
公网 TLS 由标准 HTTPS/WSS 反向代理终止。WSS 始终使用系统证书验证，没有自定义 CA
或跳过验证选项。MCP 保持回环 HTTP，远程 MCP 需管理员安排代理或隧道。

只检查已保存配置、不启动角色：

```sh
rovloom config check --role gateway
rovloom config check-runtime --role gateway
```

Connector 机器使用 `--role connector`。无选项检查读取两份默认用户文件并分别报告；
即使只使用一个角色，另一份缺失仍返回非零。`--role gateway` 或
`--role connector` 可单选，`--config /absolute/path.json` 可覆盖所选文件。两者同时
指定时核对文件角色。检查始终只读，不生成缺失文件、不配对、不加载凭据，也不证明 Agent 就绪。前台角色运行至 Ctrl-C；MCP 客户端断开不会停止 Gateway。

## 3. 准备原生程序

安装已批准的官方 Luvus 或 Herdr，以及计划使用的 Agent。当前原生版本/字节校验与
受控 PATH 见[原生安装要求](CONFIGURATION-zh.md#原生安装与-pins)。Rovloom 尚未自动
安装这些程序或配置模型访问。Gateway 已启动或配置通过不代表原生 provider 可用。

## 4. 配置 AI Agent 的 MCP 客户端

在支持 **Streamable HTTP** 的客户端中填写：

| 设置 | 模板值 |
|---|---|
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:9444/mcp` |
| Authorization header | `Bearer <EXISTING_MCP_BEARER>` |

使用为精确端点和 caller 提供的既有 Bearer，将它保存在客户端秘密存储中。
Gateway 在程序管理的身份状态中保存其摘要和有效期。管理证明和设备凭据是另外的凭据。
MCP 仅监听 loopback，远程客户端需要管理员安排本地/隧道访问方式。CLI 不是 stdio MCP 服务。

让客户端完成 MCP 初始化并加载**全部工具页**。在工具运行界面执行，或要求 Agent 依次完成：

1. 用 `machines_list`、`providers_list`、`providers_get` 选择实际 `machine_id` / `provider_id`，
   核对当前 `binding_revision` 和就绪状态。
2. 向管理员取得该 provider 的完整 Target：`machine_id`、`provider_id`、`profile`，
   session profile 还须有精确的 `session`。`providers_list` / `providers_get` 不返回
   `profile` 或 `session`，不要猜测或从 provider 名称推导 session。核对交付的设备/provider
   ID 与选择一致，再用此 Target 和实测 revision（作为 `expected_binding_revision`）
   调用 `runtime_discover`，遍历所有 `next_cursor`。
3. 对所选原生方法调用 `runtime_describe`，使用返回的 `contract_ref`、参数 schema 和校验要求。
4. 保留该完整 Target/revision/contract，仅提交一次 `runtime_call`。`deadline` 设为未来的绝对
   Unix 毫秒时间；`wait_ms`（0–5000）只控制前端短等。
5. 保存 `call_id`，用 `runtime_call_get` 观察。用 `runtime_result_read` 读取返回的
   `result.result_id`，沿 `next_cursor` 读至 `eof` 并按 `encoding` 处理。超时不代表允许重发。

先用 `workspace.list`，再用 `tab.list` / `pane.list`，参数以各 provider 的方法描述为准。
Luvus 的 `workspace.list` 等 generic 方法要求 `validation:"raw-contract"` 和明确 raw 授权；
Herdr 使用自身 schema 和 `validation:"strict"`。不要复制其他设备的 ID、revision 或摘要。

## 5. 选择 Agent 并对话

| 操作 | Luvus | Herdr |
|---|---|---|
| 选择窗口/pane | 保留实测 `workspace_id`、`tab_id`、terminal pane ID | 保留原生 workspace/tab/pane ID |
| 发现/检查 Agent | `agent.list`、`agent.get`、`agent.explain`、`agent.read` | 同名方法，参数以 provider 为准 |
| 需要时启动已安装 Agent | `agent.start`：`name`、`kind`、已发现的 `pane` | `agent.start`：`name`、`kind`、已发现的 `pane_id` |
| 发送文本 | `agent.prompt`：`target`、`text`、已发现的 `terminal_id`、**`strict:true`** | `agent.prompt`：`target`、`text`；可选 `wait` 是对象 |
| 检查回复 | `agent.get`、`agent.wait`、`agent.read` | 同名方法，保留原生 status/authority 信息 |

先描述方法，再通过 `runtime_call` 执行。Luvus 的 `pane.list`、`agent.prompt`、
`agent.send`、`agent.wait`、`agent.keys` 使用 strict 校验，其余已审普通方法需要 raw 授权。
本地 `allow_terminal_execution` 默认 false，关闭时仍可使用严格文本对话；自定义 argv/env
和直接终端输入需要明确本地许可。Agent 必须位于原生 runtime 的受控 PATH，并在私有 HOME 配好模型访问。
默认 PATH 是 `/usr/bin:/bin`。既有原生集成支持所有者选择一个 Agent 安装目录，
但新的用户初始化流程尚未接通这份本地 runtime 配置的创建。不要用任意 argv/env
绕过 `allow_terminal_execution:false`。见[原生安装要求](CONFIGURATION-zh.md#原生安装与-pins)。

发送含独特短语的无害首条消息，读取真实回复，再请同一个 Agent 回忆该短语。
保持完整 Target、generation、pane/Agent、terminal ID 及有返回时的原生 Agent session 一致。
`ready`、`queued`、`submitted`、终端回显或 idle 本身不能证明模型已回复。
Herdr 不保证 prompt completion 或原生取消。模型失败时如实报告，不自动重发或切换模型。

## 6. 关闭与排错

先 Ctrl-C 停止 Connector 并等待退出，再停止 Gateway。关闭不保证原生工作回滚；
关闭失败时保留数据。

Linux 产品 CLI 已连接 systemd install/uninstall/start/restart/stop。
使用当前单文件、root 授权和既有非 root 服务账户；先准备其受保护配置、数据与工作目录。
`service --help` 说明选项。install 加入开机自启但不立即启动，uninstall 取消未来开机自启但不立即停止。
macOS/Windows 产品服务动作仍不可用（`backend_unavailable`，3），尚不宣称开机/生命周期验收通过。
见[完整 CLI 参考](CONFIGURATION-zh.md#完整-cli-参考)和[服务前提](SERVICE.md)。
`update --check` 通过网络检查官方稳定发行，无已发布版本时可能返回
`release_unavailable`；实际替换升级后端尚未连接。

| 问题 | 处理 |
|---|---|
| `pairing_required` / `configuration_required` | Gateway 可以本地等待，但全新配对/原生初始化仍是产品缺口；只填写地址无法完成配对。 |
| home/路径/配置/角色错误 | 检查进程用户、精确角色文件和绝对路径，使用 `--config` 与配置检查；已有坏文件会保留。 |
| 不可读或权限不安全 | 检查所有者、私有目录与文件权限，避免链接；产品不会静默修复已有权限。 |
| 监听失败 | 检查端口、地址可用性和数据目录所有者。 |
| HTTP 401 | 检查精确 `/mcp` URL、既有 Bearer 与期限；未配对 Gateway 拒绝全部 caller。 |
| 离线/provider 未就绪 | 检查 WS/WSS 可达性、系统 TLS 信任、配对和原生安装。 |
| 权限/契约/revision 错误 | 刷新 provider/方法描述并核实授权。 |
| 找不到 Agent 程序 | 检查 runtime 受控 PATH 和私有 HOME 中的模型访问，不绕过终端开关。 |
| 调用结果不确定/存储错误 | 保留原调用与状态，不删除账本或盲目重发。 |

诊断写 stderr。角色退出码：0 正常关闭，2 参数/配置/待初始化，3 后端不可用，
1 运行或关闭失败。求助时提供错误码，保持秘密、实际配置与数据私有。

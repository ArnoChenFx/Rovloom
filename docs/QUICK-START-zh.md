# Rovloom 快速开始

[English](QUICK-START.md) · **简体中文** · [配置参考](CONFIGURATION-zh.md)

用一个 **Gateway** 提供 MCP 入口，在每台运行 Luvus 或 Herdr 的设备上运行一个主动出站
**Connector**。两个角色可以共用一台机器，但须使用独立状态目录。

## 1. 安装产品并准备接入资料

本预览的 Gateway/Connector runtime 目前要求 **Linux x64**，尚无已发布的 Rovloom
安装包。请向管理员取得已批准的单文件程序及匹配配置，放到私有且可执行的位置，例如
`/absolute/protected/rovloom/bin/rovloom`。下文 `rovloom` 表示 PATH 中的该程序，
也可以替换为它的绝对路径。先检查：

```sh
rovloom --version
rovloom --help
```

在每台 runtime 设备上安装已审核的 **Luvus 0.14.3** 或 **Herdr 0.9.5**，以及准备使用的
Agent。精确 binary/schema 要求和 Agent 受控 PATH 见[原生安装](CONFIGURATION-zh.md#原生安装与-pins)。
Rovloom 不会安装原生程序或配置其模型访问。

启动前，请向管理员取得 Gateway 地址、CA、已配对设备凭据、provider 配置及既有 MCP Bearer。
全新设备设置尚无完整的用户操作流程；缺少这些资料时，仅有配置模板不能建立可用连接。

## 2. 配置 Gateway 和 Connector

默认文件属于**实际运行角色的用户**：

| 角色 | 默认文件 | 主要设置 |
|---|---|---|
| Gateway | `~/.config/rovloom/gateway.json` | `state_dir`、loopback `mcp_hostname`、`mcp_port`、`authentication_ref` |
| Connector | `~/.config/rovloom/connector.json` | 独立 `state_dir`、`gateway_url`、`provider_config_refs` |

`~` 表示当前用户 home。Windows 使用同样的 home 下布局，但当前受保护 runtime 加载要求
Linux；没有 AppData/XDG 覆盖，不搜索工作目录或跨角色回退。
`--config /absolute/path.json` 覆盖默认位置。所有配置路径必须为规范绝对路径；
JSON 不展开 `~`、环境变量，也不相对于配置文件解析路径。

使用[完整最小配置及参数表](CONFIGURATION-zh.md)。每个角色还需要
`state_dir/runtime.json` 和管理员交付的 `state_dir/refs/` 文件。
角色配置目录和状态目录为私有 `0700`，文件为 `0600`，属主为运行角色的用户。
Gateway 与 Connector 状态应分开。空 provider 列表是模板，不能据此启动就绪的 Connector。

查看无秘密模板或检查已保存的配置：

```sh
rovloom config template gateway
rovloom config template connector
rovloom config template runtime gateway
rovloom config template runtime connector
rovloom config check --config /absolute/protected/gateway.json
rovloom config check-runtime --config /absolute/protected/gateway.json
```

请换成实际角色文件路径，并对 Connector 运行相同检查。
`config_valid`、`runtime_config_valid` 仅确认结构，不证明配对、凭据或 Agent 就绪。
模板命令不会修改已有文件。

## 3. 启动并连接

分别在 Gateway 机器和 runtime 设备上执行：

```sh
rovloom gateway
rovloom connector
```

保持两个前台进程运行。自定义文件位置使用
`rovloom gateway --config /absolute/protected/gateway.json` 和
`rovloom connector --config /absolute/protected/connector.json`。

模板 MCP 入口是 `http://127.0.0.1:9444/mcp`，独立的模板设备监听器使用 loopback
端口 9443 和 TLS。连接其他设备时，须显式配置可达的 WSS 监听地址和匹配的证书/CA。
Connector 的 `gateway_url` 是 `wss://gateway.example:9443` 这样的 origin，
不含凭据或端点路径；产品固定选择 `/connector`。

如果管理员启用了可选管理页，在 Gateway 打开
`http://127.0.0.1:<management-port>/`。管理端口没有默认值。
在浏览器登录提示中使用交付的 principal ID 和独立管理证明；MCP Bearer 不是管理登录凭据。
检查所选设备连接和 provider 就绪状态。配对进度需手动查询，pending 不表示已签发凭据。
有权限时可以禁用所选 provider，当前暂不能重新启用。管理会话过期后刷新并重新认证；
刷新不会延长上游登录有效期。pending 注册仍需完成配对，Connector 才能连接。

## 4. 配置 AI Agent 的 MCP 客户端

在支持 **Streamable HTTP** 的客户端中填写：

| 设置 | 模板值 |
|---|---|
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:9444/mcp` |
| Authorization header | `Bearer <EXISTING_MCP_BEARER>` |

使用为精确端点和 caller 提供的既有 Bearer，将它保存在客户端秘密存储中。
Gateway 通过 `authentication_ref` 保存其摘要和有效期。管理证明和设备凭据是另外的凭据。
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
和直接终端输入需要明确本地许可。官方 Agent 安装在用户目录时，将本地 `agent_bin_dir`
设为其安装目录；各 provider 的配置位置见 [Agent 安装目录](CONFIGURATION-zh.md#agent-安装目录)。
它会将一个目录前置到 `/usr/bin:/bin`，省略时保持默认。Luvus 的初始本地配置仍须由管理员
交付。Agent/模型配置放在 runtime 的私有 HOME；选择 Agent 目录无需安装到系统目录或
使用自定义 argv/env，`allow_terminal_execution` 可以保持 false。

发送含独特短语的无害首条消息，读取真实回复，再请同一个 Agent 回忆该短语。
保持完整 Target、generation、pane/Agent、terminal ID 及有返回时的原生 Agent session 一致。
`ready`、`queued`、`submitted`、终端回显或 idle 本身不能证明模型已回复。
Herdr 不保证 prompt completion 或原生取消。模型失败时如实报告，不自动重发或切换模型。

## 6. 关闭与排错

用 Ctrl-C 停止 Connector，等待退出，再停止 Gateway。断开 MCP 客户端不会停止 Gateway。
关闭不保证原生回滚；关闭失败时保留状态和归属记录。

本预览使用前台角色：产品 CLI 暂不提供 service install/uninstall/start/restart/stop，
即使存在 `service --help`，操作仍返回 `backend_unavailable`。
`update --check` 检查官方稳定发行，需要网络；没有已发布版本时可能返回 `release_unavailable`。
`update` 当前没有可用的替换/升级流程。

| 问题 | 处理 |
|---|---|
| 配置缺失 / home 不可用 | 核对用户和角色文件名，提供绝对 `--config`。 |
| 路径/配置/角色无效 | 删除未知字段，使用规范绝对路径，匹配角色与引用，运行配置检查。 |
| 配置不可读/保护不足 | 修正属主、0700 目录、0600 文件，避免 symlink 和 runtime 文件额外硬链接。 |
| 启动不可用/失败 | 检查交付的 refs、TLS/CA、已配对凭据、provider 安装及状态。 |
| HTTP 401 | 核对精确 `/mcp` URL、既有 Bearer 和有效期；管理证明是独立的。 |
| 设备离线 / provider 未就绪 | 检查 WSS 可达性、TLS 名称/CA、配对及原生 binary/schema 匹配。 |
| 权限/契约/revision 错误 | 刷新 provider 和方法描述，请管理员检查 grants。 |
| 找不到 Agent / `agent_bin_dir_invalid` | 核对本地 `agent_bin_dir` 为单个规范绝对安装目录，Agent/模型配置位于私有 HOME；重启已配置的 runtime。 |
| 调用结果不确定 / 存储错误 | 保留原调用及状态，请管理员恢复，不删除账本或盲目重发。 |

诊断输出到 stderr。角色退出码：0 成功/正常关闭，2 参数或配置错误，3 后端不可用，
1 运行/关闭失败。求助时提供错误码，勿公开凭据、真实配置、数据库和 runtime 输出。

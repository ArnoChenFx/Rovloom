# Rovloom 快速开始

[English](QUICK-START.md) · **简体中文** · [配置参考](CONFIGURATION-zh.md)

运行一个 **Gateway**，作为 AI 客户端的 MCP 入口。在每台运行 Luvus 或 Herdr 的机器上
运行一个 **Connector**，由它主动连接 Gateway。两个角色也可以运行在同一台机器上。

本预览可在 Linux x64 引导配对和首次 Luvus 设置。Gateway 也支持 Linux/macOS，
但首次配对审批仍要求 Linux。Windows runtime、Herdr/混合首次引导和 Agent/模型登录
引导尚不可用；全新安装目前还不能只靠 Rovloom 完成模型设置。

## 1. 准备程序

Rovloom 暂无公开安装包。请从管理员获取独立可执行程序，放入 PATH 后检查：

```sh
rovloom --version
rovloom --help
```

按下面的引导使用时，请在 Connector 机器安装官方 [latest Luvus](https://github.com/RizRiyz/luvus/releases/latest)。
需要对话时还应单独安装所选 Agent。Rovloom 不安装这些程序，也不会登录模型提供商。

默认在 `/usr/bin:/bin` 查找 Luvus 和 Agent。安装在其他目录时，在**批准原生初始化前**，
将 `native.runtime_bin_dir` 和/或 `native.agent_bin_dir` 写入 Connector 的唯一配置文件。
参见[安装目录设置](CONFIGURATION-zh.md#agent-安装目录)。普通 home 中的 Agent 登录
不会被沿用；请由机器所有者在 Rovloom 隔离的 Agent 环境准备模型访问。
该环境的登录引导目前仍缺失。

## 2. 启动并配对

在两个真实本地终端中运行，并保持两者开启：

| Gateway 机器 | Connector 机器 |
|---|---|
| `rovloom gateway` | `rovloom connector` |

1. 在 Gateway 终端同意配对，获取有效期五分钟的私密一次性码。
2. 在 Connector 终端输入 Gateway 地址。同机使用 `ws://127.0.0.1:9443`。
   粘贴一次性码，并确认信任这个 Gateway。
3. 在 Connector 同意发现并初始化已安装的 Luvus。然后回到 Gateway 终端，
   批准显示的安装和工作区/Agent 访问范围。
4. 将 Gateway 私密显示的 MCP 接入信息保存到 MCP 客户端的秘密存储。
   等待 **`connector_ready`** 后再尝试调用。

每个角色会自动创建缺失的用户文件，后续启动继续读取它。
**默认配置和用户配置是同一份文件**，无需准备其他配置文件。

| 角色 | 唯一用户配置 |
|---|---|
| Gateway | `~/.config/rovloom/gateway.json` |
| Connector | `~/.config/rovloom/connector.json` |

文件存在就读取，不会重置；文件出错时也不会被覆盖。需要更改安装目录时，
在原生批准前停止 Connector，编辑 `connector.json` 后重新启动。
[配置参考](CONFIGURATION-zh.md)列出完整示例和全部可配置参数。

Connector 在另一台设备时，先设置 Gateway `devices.hostname`，让它监听回环以外的地址，
再在 Connector 输入可达的 WS/WSS 地址。默认只接受本机连接。
公网访问需要管理员安排 HTTPS/WSS 代理或隧道，参见[网络设置](CONFIGURATION-zh.md#网络访问)。

## 3. 连接 MCP 客户端

在支持 **Streamable HTTP** 的 AI 客户端添加服务器：

| 客户端设置 | 值 |
|---|---|
| 传输 | Streamable HTTP |
| URL | Gateway 默认设置下为 `http://127.0.0.1:9444/mcp` |
| Authorization 请求头 | `Bearer <GATEWAY提供的MCP_BEARER>` |

使用 Gateway 批准后显示的 Bearer，或管理员为此端点提供的既有凭据。
配对码不是 MCP Bearer。Bearer 有效期30天，续期引导尚不可用。
远程客户端需要管理员安排代理或隧道，才能访问 Gateway 的回环 MCP 监听。
Rovloom 不是 stdio MCP 服务器。

等待客户端加载完服务器工具。让它列出已连接机器的工作区和窗格，再列出可用 Agent。
需要选择设备/runtime/会话时，使用 Gateway 显示的选择。
详细工具调用见 [MCP 参考](protocol/MCP-HTTP.md#client-call-sequence)。

Agent 和模型访问准备好后，选择一个 Agent，让它发送一句简短消息、读取回复，再继续
同一段对话。Connector 就绪或消息排队不代表模型已回复。调用结果不确定时，
先查询该次调用，再决定是否重发。

## 4. 检查、关闭与常见问题

修改后可检查已保存文件，不启动角色：

```sh
rovloom config check --role gateway
rovloom config check --role connector
```

在各机器只运行所安装角色的检查命令。不带选项的 `rovloom config check` 会读取
**两个默认文件**并分别报告，不会创建缺失文件。启动或检查时，可用
`--config /absolute/path.json` 选择其他文件。JSON 内的路径也必须是绝对路径，
其中的 `~` 和环境变量不会展开。

先在 Connector 按 Ctrl-C 并等待退出，再关闭 Gateway。下次使用相同用户文件和数据，
运行相同命令即可。本预览尚不能安装系统服务，也不能自动替换程序完成更新。

| 问题 | 处理方法 |
|---|---|
| `configuration_required` / `pairing_required` | 完成 Linux 本地终端的提问和批准。仅保存 Gateway 地址不会完成设备配对。 |
| 配置或权限错误 | 检查角色文件与绝对路径。文件应属于当前用户，权限 `0600`，所在目录 `0700`。已有错误不会被自动修复。 |
| `native_state_path_too_long` | 配对前选择更短的 `data.directory`；其路径加 `/n` 不得超过52个 UTF-8 字节。 |
| 地址占用或连接失败 | 检查端口、Gateway 监听地址和网络可达性。 |
| HTTP 401 | 检查 `/mcp` URL、Bearer 和有效期；配对必须已完成。 |
| 找不到 Agent 或没有模型回复 | 检查 Agent 安装目录和隔离 Agent 环境的模型登录；仅在普通 shell 登录并不足够。 |
| 初始化或关闭中断，结果不确定 | 保留已有数据并请管理员协助，不要删除数据后重新登记。 |

求助时保留错误代码，不要公开 Bearer 或私有数据。

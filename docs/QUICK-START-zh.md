# Rovloom 快速开始

[English](QUICK-START.md) · **简体中文** · [配置参考](CONFIGURATION-zh.md)

运行一个 **Gateway**，作为 AI 客户端的 MCP 入口。在每台运行 Luvus 或 Herdr 的机器上
运行一个 **Connector**，由它主动连接 Gateway。两个角色也可以运行在同一台机器上。

Gateway 支持 Linux/macOS/Windows，下面的首次配对和原生 Connector 引导要求 Linux x64。
Agent/模型登录引导尚不可用；全新安装目前还不能只靠 Rovloom
完成模型设置。

## 1. 准备程序

### Linux 与 macOS

在 x64 或 arm64 上安装最新稳定版；Linux 要求 glibc：

```sh
curl --fail --silent --show-error --location https://raw.githubusercontent.com/ArnoChenFx/Rovloom/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

默认安装到 `~/.local/bin/rovloom`。安装器需要 `curl` 和 `sha256sum` 或 `shasum`，
无需 Bun、Node 或 root 权限。

### Windows PowerShell

按操作系统原生 x64 或 arm64 架构安装最新稳定版：

```powershell
Invoke-RestMethod https://raw.githubusercontent.com/ArnoChenFx/Rovloom/main/scripts/install.ps1 | Invoke-Expression
$env:Path = "$env:LOCALAPPDATA\Rovloom\bin;$env:Path"
```

默认安装到 `%LOCALAPPDATA%\Rovloom\bin\rovloom.exe`。
两个安装器都会先按发行中的 `SHA256SUMS` 校验二进制，再替换已有程序。
它们只安装程序，不创建角色配置或系统服务。上面的 PATH 设置仅对当前终端生效；
后续终端需要将安装目录加入用户 PATH。安装后检查：

```sh
rovloom --version
rovloom --help
```

也可从[官方 Release](https://github.com/ArnoChenFx/Rovloom/releases/latest)手动下载二进制和
`SHA256SUMS`。安装器选项见[分发说明](DISTRIBUTION.md#用户安装器)。

### Linux Docker Gateway

在原生 Linux x64 或 arm64 主机安装 Docker Engine 和 Compose v2 后，
可直接运行 Gateway，无需在该主机安装二进制：

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/Rovloom/main/docker-compose.yaml
docker compose pull
docker compose up -d
docker compose ps
```

官方镜像为 `ghcr.io/arnochenfx/rovloom:latest`；要固定到已发布版本，
在此目录的 `.env` 写入 `ROVLOOM_VERSION=0.1.1` 后再拉取。
Compose 使用 Linux host 网络，以及分别保存配置和数据的持久卷。
需保持 9443、9444、9445 端口空闲，无需添加 `ports` 映射。
Rootless Docker 和 Docker Desktop 尚未作为部署目标验收。

管理页位于 `http://127.0.0.1:9445/`，MCP 位于 `http://127.0.0.1:9444/mcp`。
全新 Gateway 尚未配对：`healthy` 只说明监听已响应，未认证的 MCP 请求返回 401。
继续按下文在终端完成配对。Connector 仍运行在安装 Luvus/Herdr 的受支持 Linux x64 主机上。
配置、备份与升级见 [Docker 部署](DOCKER-zh.md)；`docker compose down` 保留卷，
`down -v` 会删除配置和数据。

### Luvus、Herdr 与 Agent

按下面的引导使用时，请在 Connector 机器安装官方 [latest Luvus](https://github.com/RizRiyz/luvus/releases/latest)、
[latest Herdr](https://github.com/herdrdev/herdr/releases/latest) 或两者。
需要对话时还应单独安装所选 Agent。Rovloom 不安装这些程序，也不会登录模型提供商。

默认通过 Connector 启动时的 `PATH` 加 `/usr/bin:/bin` 查找所选原生程序和 Agent。装在其他位置（或服务管理器
给的 `PATH` 很精简）时，在**批准原生初始化前**，将目录数组写入 Connector 唯一配置文件的
`native.runtime_bin_dirs` 和/或 `native.agent_bin_dirs`。
选择 Herdr 或两者时，在原生批准前将 `native.provider` 设为 `herdr` 或 `mixed`；省略时选 Luvus。
参见[安装目录设置](CONFIGURATION-zh.md#程序与-agent-安装目录)。

**Herdr 默认附着你自己的会话。** Connector 连接你已在运行的 Herdr（同一用户、同一个已安装二进制），
只有没有实例时才在你自己的配置目录里启动一个，它在 Connector 退出后继续运行。因此远程调用会直接操作你的
**真实**工作区，你普通 home 里的 Agent 登录也直接可用；实例消失后 Connector 会自行重新附着或重新启动。
想要私有隔离实例，把 `native.herdr.mode` 设为 `managed`（其中的 Agent 登录不共享，需另行准备）。
参见[Herdr：附着或隔离](CONFIGURATION-zh.md#herdr附着或隔离)。

**Luvus 同理。** 默认附着你自己的 `default` 会话（`luvus` 启动的那个；状态在 `~/.luvus` 或 `$LUVUS_HOME`），
没有才自建一个，它在 Connector 退出后继续运行，消失后会重新附着或重建。Gateway 的配对提示里会显示
`session: default`。想要原来的隔离实例（会话名 `rovloom`，状态放在 Connector 数据目录，路径须足够短以容纳 Unix socket），
把 `native.luvus.mode` 设为 `managed`。参见[Luvus：附着或隔离](CONFIGURATION-zh.md#luvus附着或隔离)。

## 2. 启动并配对

在两个真实本地终端中运行，并保持两者开启：

| Gateway 机器 | Connector 机器 |
|---|---|
| `rovloom gateway` | `rovloom connector` |

Docker Gateway 应在 Compose 目录的真实终端中，用以下命令代替 `rovloom gateway`：

```sh
docker compose stop gateway
docker compose run --rm gateway
```

前台实例复用同一组卷并显示配对提示，批准期间保持终端开启。
不要让两个 Gateway 同时使用同一数据目录。Connector 命令仍在容器外的原生主机执行。

1. 在 Gateway 终端同意配对，获取有效期五分钟的私密一次性码。
2. 在 Connector 终端输入 Gateway 地址。同机使用 `ws://127.0.0.1:9443`。
   粘贴一次性码，并确认信任这个 Gateway。
3. 在 Connector 依次同意发现并初始化所选已安装程序。然后回到 Gateway 终端，
   批准显示的安装和工作区/Agent 访问范围。
4. 将 Gateway 私密显示的 MCP 接入信息保存到 MCP 客户端的秘密存储。
   等待 **`connector_ready`** 后再尝试调用。

Docker 设置完成后，先停止 Connector，再按 Ctrl-C 停止前台 Gateway。
执行 `docker compose up -d`，然后在主机重新运行 `rovloom connector`；
卷中已保存的配对会保留。

每个角色会自动创建缺失的用户文件，后续启动继续读取它。
**默认配置和用户配置是同一份文件**，无需准备其他配置文件。

| 角色 | 唯一用户配置 |
|---|---|
| Gateway | `~/.config/rovloom/gateway.json` |
| Connector | `~/.config/rovloom/connector.json` |

Docker 的 Gateway 文件位于配置卷中的 `/home/rovloom/.config/rovloom/gateway.json`。

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
配对码不是 MCP Bearer。Bearer 默认有效期30天，用 `rovloom token renew/rotate` 续期或轮换（见配置说明）。
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
运行相同命令即可。Gateway也可使用Linux systemd或macOS系统LaunchDaemon；本机Connector
服务仍限Linux x64。[开机服务](SERVICE.md#简体中文)说明五项命令、正常系统授权及账户/配置选择。
Windows Gateway使用既有用户开机任务及同一配置文件；本机Connector服务仍限Linux x64。
自动替换程序更新仍不可用。

| 问题 | 处理方法 |
|---|---|
| `configuration_required` / `pairing_required` | 完成 Linux 本地终端的提问和批准。仅保存 Gateway 地址不会完成设备配对。 |
| 配置或权限错误 | 检查角色文件、绝对路径，以及当前账户能否按操作系统权限访问文件和数据目录。已有文件不会被自动重置。 |
| `native_state_path_too_long` | 配对前选择更短的 `data.directory`；Luvus 的路径加 `/n` 不得超过52个 UTF-8 字节；Herdr 的路径加 `/hr/c/herdr/herdr-client.sock` 不得超过107个 UTF-8 字节（Unix socket 上限）。 |
| 地址占用或连接失败 | 检查端口、Gateway 监听地址和网络可达性。 |
| HTTP 401 | 检查 `/mcp` URL、Bearer 和有效期；配对必须已完成。 |
| 找不到 Agent 或没有模型回复 | 检查 Agent 安装目录和隔离 Agent 环境的模型登录；仅在普通 shell 登录并不足够。 |
| 初始化或关闭中断，结果不确定 | 保留已有数据并请管理员协助，不要删除数据后重新登记。 |

求助时保留错误代码，不要公开 Bearer 或私有数据。

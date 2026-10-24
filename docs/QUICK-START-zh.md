# Rovloom 快速开始

[English](QUICK-START.md) · **简体中文** · [配置参考](CONFIGURATION-zh.md)

Rovloom 有两个角色：

- **Gateway**：AI 客户端访问的 MCP 入口。
- **Connector**：运行在每台装有 Herdr 或 Luvus 的机器上，主动连接 Gateway。

两个角色可以运行在同一台机器上。Gateway 支持 Linux、macOS 和 Windows；Connector 支持 Linux x64、macOS（x64、arm64）和 Windows x64；在 macOS 和 Windows 上附着你已在运行的 Herdr / Luvus。

## 1. 安装

**Linux / macOS**（x64 或 arm64；Linux 需要 glibc）。无需 Bun、Node 或 root 权限：

```sh
curl --fail --silent --show-error --location https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

**Windows PowerShell**（x64 或 arm64）：

```powershell
Invoke-RestMethod https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/scripts/install.ps1 | Invoke-Expression
$env:Path = "$env:LOCALAPPDATA\Rovloom\bin;$env:Path"
```

两个安装器都会按发行中的 `SHA256SUMS` 校验二进制，只安装程序
（`~/.local/bin/rovloom` 或 `%LOCALAPPDATA%\Rovloom\bin\rovloom.exe`），不创建配置或系统服务。
请把安装目录永久加入 PATH，然后检查：

```sh
rovloom --version
```

也可以从 [Release 页面](https://github.com/ArnoChenFx/rovloom/releases/latest)下载二进制；
安装器选项见[分发说明](DISTRIBUTION.md)。

**已经装了 Bun（1.4.3 及以上）？** Rovloom 发布在 npm 注册表上，可以全局安装，也可以不安装直接运行一次：

```sh
bun add -g rovloom
rovloom --version
bunx rovloom --version
```

需要锁定版本时，每个发行也附带同样的 npm 包 tarball 作为 Release 资产：

```sh
bun add -g https://github.com/ArnoChenFx/rovloom/releases/download/v<version>/rovloom-<version>.tgz
bunx --package https://github.com/ArnoChenFx/rovloom/releases/download/v<version>/rovloom-<version>.tgz rovloom --version
```

升级用 `bun update -g rovloom`（或用新发行的地址再执行一次 `bun add -g`）。这个包只能在 Bun 上运行，
`rovloom service install` 仍然需要上面的单文件二进制。

**Docker 运行 Gateway（Linux x64/arm64，Docker Compose v2）**——可选，无需在 Gateway 主机安装二进制：

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/docker-compose.yaml
docker compose pull
docker compose run --rm gateway config init gateway --container
```

9443、9444、9445 端口需要空闲（Compose 从 bridge 网络发布这三个端口），`config init gateway --container` 会在首次配置时准备容器监听。卷、备份和升级见 [Docker 部署](DOCKER-zh.md)。

## 2. 准备 Connector 所在机器

安装 [Herdr](https://github.com/herdrdev/herdr/releases/latest) 和/或
[Luvus](https://github.com/RizRiyz/luvus/releases/latest)，以及你要使用的 Agent，并登录模型服务。
Rovloom 不会安装这些程序。

Connector **附着到你已在运行的会话**，因此远程调用操作的是你真实的工作区和 Agent 登录；
只有没有运行实例时，才会在你自己的配置目录里启动一个。
程序通过 `PATH`（加上 `/usr/bin:/bin`）查找；其它位置见[安装目录](CONFIGURATION-zh.md#程序与-agent-安装目录)。

默认使用 Luvus。首次配对前，用以下命令选择 Herdr（两者都用则填 `mixed`）：

```sh
rovloom config init connector --provider herdr
```

只生成配置，不启动 Connector 或询问地址。已有配置不会覆盖；如果已选择其它 provider，命令返回 `config_exists`，请先核对再修改。

## 3. 配对

打开两个真实的本地终端并保持打开：

| Gateway 所在机器 | Connector 所在机器 |
|---|---|
| `rovloom gateway` | `rovloom connector` |

Docker Gateway：在 Compose 目录运行 `docker compose run --rm --service-ports gateway` 代替（先用 `docker compose stop gateway` 停掉正在运行的 Gateway）。

1. **Gateway 终端**：批准配对，得到一次性码（5 分钟有效）。
2. **Connector 终端**：输入 Gateway 地址（同一台机器用 `ws://127.0.0.1:9443`）和该码，并确认信任此 Gateway。
3. **Connector 终端**：批准发现 Herdr/Luvus 安装。
4. **Gateway 终端**：批准显示的安装及其工作区/Agent 访问。
5. 保存 Gateway 打印的 **MCP 地址和 Bearer**（以及只显示一次的管理员密码）。等待 `connector_ready`。

Connector 在另一台机器时，需设置 Gateway 的 `devices.hostname` 使其监听回环以外的地址；
跨出可信网络时在前面放 HTTPS/WSS，见[网络访问](CONFIGURATION-zh.md#网络访问)。

配对完成后，用 Ctrl-C 停止 Gateway 和 Connector。Docker 用户随后运行 `docker compose up -d`
并重新启动 `rovloom connector`；配对已保存在卷中。之后用同样的命令启动即可。

之后再新增设备不必停 Gateway：管理员在管理页新建配对申请，新设备运行
`rovloom connector --claim` 在线认领加入，见[配对](CONFIGURATION-zh.md#配对)。

## 4. 连接 MCP 客户端

在 AI 客户端添加一个 **Streamable HTTP** 服务：

| 设置 | 值 |
|---|---|
| URL | `http://127.0.0.1:9444/mcp`（默认） |
| Authorization 头 | `Bearer <Gateway 打印的 Bearer>` |

配对码不是 Bearer。Bearer 默认 30 天过期，用 `rovloom token renew` 或 `rovloom token rotate` 续期。
远程客户端通过你的代理或隧道访问 MCP 监听。Rovloom 不是 stdio MCP 服务。

然后让客户端列出这台机器的工作区和 Agent，并向某个 Agent 发一条短消息。
断线后结果不确定的调用会标为未知，不会自动重发。工具细节见 [MCP 参考](protocol/MCP-HTTP.md)。

管理页地址是 `http://127.0.0.1:9445/`，用户名 `admin`，密码为配对时打印的密码；
也可以用 `rovloom admin create` 重新签发。页面显示每台设备的连接状态，
可重命名、断开或撤销设备，以及停用 provider。

## 5. 日常操作

| 任务 | 做法 |
|---|---|
| 加入更多设备 | 停止 Gateway，运行 `rovloom gateway --add-device`，再按上面的步骤配对新机器。现有 Bearer 自动覆盖新设备；用 `rovloom token create --like` 克隆的令牌需要重新克隆。 |
| 凭据丢失或泄漏 | 停止该 Connector，运行 `rovloom gateway --repair-device`，再在该设备上运行 `rovloom connector --repair`。原生设置与授权保留，进行中的调用结果变为未知。 |
| 开机自启 | `rovloom service install --role gateway`（或 `connector`），见[开机服务](SERVICE.md)。 |
| 校验配置 | `rovloom config check --role gateway`（或 `connector`）。 |
| 令牌、备份、升级 | [运维指南](OPERATIONS.md) |

每个角色只有一份配置文件，首次运行时创建且不会被重置：
`~/.config/rovloom/gateway.json` 与 `~/.config/rovloom/connector.json`。
全部参数见[配置参考](CONFIGURATION-zh.md)。

## 排错

| 现象 | 处理 |
|---|---|
| `configuration_required` / `pairing_required` | 完成终端里的提示和批准；仅保存 Gateway 地址不会配对设备。 |
| 无法连接 / 地址被占用 | 检查端口、Gateway 监听地址和网络可达性。 |
| HTTP 401 | 检查 `/mcp` 地址、Bearer 及其有效期。 |
| `native_state_path_too_long` | 配对前换一个更短的 `data.directory`（Unix socket 路径长度限制）。 |
| `invalid_device_credential` | 用 `--repair-device` / `--repair` 重新配对同一台设备。已撤销的设备不能重新配对。 |
| Agent 没有回复 | 检查 Agent 的安装目录和模型登录；Connector 就绪不代表模型已回复。 |
| 安装或退出被中断且结果不确定 | 保留现有数据并联系管理员；不要删除后重新注册。 |

求助时请保留错误码，并保管好 Bearer。

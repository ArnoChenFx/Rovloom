# 运维指南

面向部署者：按场景列出日常操作，细节见各专项文档。系统语义见 [DESIGN](DESIGN.md)。

## 1. 角色与端口

| 角色 | 默认监听 | 说明 |
|---|---|---|
| Gateway · MCP | `127.0.0.1:9444`（`/mcp`） | 只在回环；远程客户端经反向代理 / 隧道（`mcp.public_url`，https） |
| Gateway · 设备通道 | `127.0.0.1:9443`（WS `/connector`） | 要接受别的机器的 Connector 就改 `devices.hostname`（`0.0.0.0` / `::`），公网用 WSS 代理 |
| Gateway · 管理页 | `127.0.0.1:9445` | 固定回环，HTTP Basic 登录（见 §4） |
| Connector | 无监听 | 只主动出站连 Gateway；Luvus / Herdr 留在本机 |

每个角色只有一份用户配置：`~/.config/rovloom/gateway.json` / `connector.json`（Windows 同样用用户 home）。参数全集见[配置参考](CONFIGURATION.md)。程序自己的数据在 `data.directory`（默认 `~/.local/share/rovloom/<role>`），**整个目录一起保留**，不要手改里面的文件。

> 加入更多设备：停止 Gateway，运行 `rovloom gateway --add-device`，在新机器上运行 `rovloom connector`，输入地址与一次性码（见[快速开始](QUICK-START-zh.md)）。现有 MCP Bearer 自动覆盖新设备；用 `token create --like` 克隆出的令牌需重新克隆。

## 2. 安装与升级

- 安装：`install.sh` / `install.ps1` 只安装单文件二进制并核对 `SHA256SUMS`，不建配置、不起服务（[快速开始](QUICK-START-zh.md)）。Docker 只用于 Linux Gateway（[Docker 部署](DOCKER-zh.md)）。
- 升级：先正常停 Connector 再停 Gateway，替换二进制（重新运行安装脚本，或 `docker compose pull && docker compose up -d`），再按原样启动。数据库 schema 兼容时配置与数据沿用；从 v0.1.x 升级先按下节建立新状态。脚本只安装官方 latest 稳定版；预发布版本从 Release 页面手动下载。
- 没有自更新。数据库版本不兼容时拒绝启动（`unsupported_database_version`），不会静默迁移。

## Upgrading from v0.1.x

v0.1.1 使用 Gateway schema 5，v0.2.0 使用 schema 6，设备身份、授权与 Connector 本机状态也已变化。**没有自动迁移器；不要修改数据库 version 数字来绕过检查。** 旧库启动时返回例如：

```text
unsupported_database_version found_schema=5 expected_schema=6 upgrade=https://github.com/ArnoChenFx/rovloom/blob/main/docs/OPERATIONS.md#upgrading-from-v01x
```

按以下流程在每台机器升级：

1. 先停止所有 Connector，再停止 Gateway。前台进程正常退出；已安装服务用 `rovloom service stop --role connector` / `--role gateway`（自定义配置加 `--config`）。Docker 用 `docker compose stop`。确认已退出，再操作状态文件。
2. 备份旧 Rovloom 二进制、两角色的配置文件及各自 **整个** `data.directory`，包括数据库、结果文件、managed 配置、凭据与 sidecar。备份只允许当前用户读取，不把含凭据的备份上传到 issue。默认配置在 `~/.config/rovloom`，数据在 `~/.local/share/rovloom`；自定义路径以实际配置为准。不要在进程运行时单独复制数据库文件。
3. 安装 v0.2.0 或更新版。保留旧配置/数据的备份，给新版使用新的空状态目录；也可在确认停止、备份完成后将旧 Rovloom 配置与状态目录重命名，让新版按默认路径重新创建。不要删除或重置 Luvus / Herdr 自己的数据、工作区或模型配置，不要把旧 managed 文件混入新状态。
4. 按[快速开始](QUICK-START-zh.md)运行 `rovloom gateway`，在每台机器运行 `rovloom connector`，逐台重新配对，并在 Connector 本机重新确认 provider 和授权。需要远程监听、反向代理、Herdr 或混合 provider 时，在新版配置中重新设置。新 MCP Bearer、管理员口令和设备凭据需要重新配置到客户端；旧凭据不导入。
5. 验证 machines → providers → discover / describe → 一次新的只读调用 → get / result_read，再安装或启动新版服务。核对服务的可执行文件和配置路径，避免旧服务继续启动备份版本。

Docker 升级同样需要离线备份实际挂载卷，再为新版选择一个新的空卷或空宿主目录，并重新初始化、配对；只改镜像 tag 不会转换旧库。不要用 `docker compose down -v` 作为升级步骤，它会删除数据卷。

旧结果、审计、调用 key 和未完成调用不会迁移到新状态。先核对旧的 unknown 调用在 native 侧是否执行过；重新配对或换版本都不是重做写入的授权。保留旧备份供离线检查。若放弃升级，先停新版，再成套恢复原二进制、原配置与完整旧状态；不要混用两个版本或在同一状态上并行运行。

## 3. 开机服务

`rovloom service install|start|stop|restart|uninstall --role gateway|connector`：Linux systemd、macOS LaunchDaemon、Windows 用户开机任务（S4U）。Connector 服务支持 Linux x64、macOS（x64、arm64）与 Windows x64，只在配对之后使用，因为首次配对需要真实终端。服务定义本身**不会**自动重拉退出的进程。详见 [SERVICE](SERVICE.md)。

## 4. 凭据

| 要做的事 | 命令 | 备注 |
|---|---|---|
| 查看 / 创建 / 续期 / 轮换 / 吊销 MCP 令牌 | `rovloom token list\|create\|renew\|rotate\|revoke` | 原值只在 create / rotate 时在 stdout 显示一次；热生效，无需重启 |
| 管理页管理员 | `rovloom admin create\|list\|revoke` | 首次配对完成时已自动创建 `admin`；丢了口令就再 create；热生效 |
| 加入更多设备 | Gateway：`rovloom gateway --add-device`；新机器：`rovloom connector` | 需要真实终端；先停止 Gateway |
| 设备凭据丢失 / 泄漏 | Gateway：`rovloom gateway --repair-device`；Connector：`rovloom connector --repair` | 同一设备重新配对，旧凭据立即失效，原生设置与 MCP 授权不变；先停该 Connector |
| 撤销设备 | 管理页 → 撤销 | 撤销后不能重新配对，需作为新设备重新首次配对 |

## 5. 备份与恢复

数据库快照只含脱敏的设备记录、调用状态与审计，**不含任何可用凭据**。从快照恢复后，每台设备都回到待配对状态：用 `--repair-device` / `--repair` 逐台重新配对，再逐个确认 provider。旧的调用与授权不会重新派发。因此快照的价值在于保留审计与调用历史，而不是快速回滚。步骤见 [存储](STORAGE.md#备份与恢复)。

Docker 部署的备份就是备份卷：`docker compose down` 保留卷，`down -v` 删除。

## 6. 排错

| 现象 | 先看 |
|---|---|
| Connector 一直 `disconnected` | Gateway 的 `devices.hostname` 是否允许远端；地址 / 防火墙；Gateway 判断线约 20 秒（空闲超时） |
| MCP 401 | Bearer 是否过期（默认 30 天，`rovloom token renew`）；`/mcp` URL 是否与 `mcp.public_url` 一致 |
| 调用停在 `dispatching` 很久 | 设备可能刚断网（Gateway 20 秒内发现后立即 `not_dispatched`）；已写出的调用是 `outcome_unknown`，**不会自动重发**，先核对再决定 |
| `invalid_device_credential` | 凭据被撤销或重配：`--repair-device` / `--repair` |
| `configuration_required` | 需要真实本地终端完成配对 / 批准；不要删数据后重登记，结果不确定时保留原状态 |
| Luvus / Herdr 不可用 | Connector 会按退避自动重新附着或重建；Linux 上附着要求对端是**你已安装的同一个**程序 |

保留错误码求助；Bearer、管理员口令、一次性码不要贴出来。

## 7. 验证你的部署

仓库的 [`e2e/`](../e2e/README.md) 是同一流程的自动化版本，覆盖真实终端配对、官方 MCP SDK、崩溃、断网、未知结果、撤销和两容器两机。跨机的 NAT、TLS 和防火墙需要你在自己的两台机器上按[快速开始](QUICK-START-zh.md)走一遍。

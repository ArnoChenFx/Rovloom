# 运维指南

面向部署者的总览：把日常要做的事按场景排好，细节指向各自的专项文档。系统语义以 [DESIGN](DESIGN.md) 为准。

## 1. 角色与端口

| 角色 | 默认监听 | 说明 |
|---|---|---|
| Gateway · MCP | `127.0.0.1:9444`（`/mcp`） | 只在回环；远程客户端经反向代理 / 隧道（`mcp.public_url`，https） |
| Gateway · 设备通道 | `127.0.0.1:9443`（WS `/connector`） | 要接受别的机器的 Connector 就改 `devices.hostname`（`0.0.0.0` / `::`），公网用 WSS 代理 |
| Gateway · 管理页 | `127.0.0.1:9445` | 固定回环，HTTP Basic 登录（见 §4） |
| Connector | 无监听 | 只主动出站连 Gateway；Luvus / Herdr 留在本机 |

每个角色只有一份用户配置：`~/.config/rovloom/gateway.json` / `connector.json`（Windows 同样用用户 home）。参数全集见[配置参考](CONFIGURATION.md)。程序自己的数据在 `data.directory`（默认 `~/.local/share/rovloom/<role>`），**整个目录一起保留**，不要手改里面的文件。

> 加入第二台及以后设备：停止 Gateway，运行 `rovloom gateway --add-device`，在新机器的 `rovloom connector` 输入地址与一次性码（详见 [Quick Start](QUICK-START-zh.md)）；现有 MCP Bearer 自动覆盖新设备，`token create --like` 克隆的令牌需重新克隆。

## 2. 安装与升级

- 安装：`install.sh` / `install.ps1` 只安装单文件二进制并核对 `SHA256SUMS`，不建配置、不起服务（[Quick Start](QUICK-START.md)）；Docker 只用于 Linux Gateway（[Docker 部署](DOCKER.md)）。
- 升级：先正常停 Connector 再停 Gateway，替换二进制（重新运行安装脚本，或 `docker compose pull && docker compose up -d`），再按原样启动。配置与数据沿用；脚本只跟随官方 latest 稳定版，预览版从 Release 页面手动下载（固定 tag，不会成为 latest）。
- 没有自更新。数据库版本不兼容会明确拒绝启动（`unsupported_database_version`），不会静默迁移。

## 3. 开机服务

`rovloom service install|start|stop|restart|uninstall --role gateway|connector`：Linux systemd、macOS LaunchDaemon、Windows 用户开机任务（S4U）。Connector 服务支持 Linux x64 与 Windows x64，且只用于配对之后——首次配对需要真实终端。服务定义本身**不会**自动重拉退出的进程。详见 [SERVICE](SERVICE.md)。

## 4. 凭据

| 要做的事 | 命令 | 备注 |
|---|---|---|
| 查看 / 创建 / 续期 / 轮换 / 吊销 MCP 令牌 | `rovloom token list\|create\|renew\|rotate\|revoke` | 原值只在 create / rotate 时在 stdout 显示一次；热生效，无需重启 |
| 管理页管理员 | `rovloom admin create\|list\|revoke` | 首次配对完成时已自动创建 `admin`；丢了口令就再 create；热生效 |
| 设备凭据丢失 / 泄漏 | Gateway：`rovloom gateway --repair-device`；Connector：`rovloom connector --repair` | 同一设备重新配对，旧凭据立即失效，原生设置与 MCP 授权不变；先停该 Connector |
| 撤销设备 | 管理页 → 撤销 | 撤销后不能重新配对，需作为新设备重新首次配对 |

## 5. 备份与恢复

状态库的备份只含最小历史与审计，**不含任何可用凭据**；恢复 = 逐设备重新配对（旧凭据与 enrollment 都失效），逐 provider 重新确认。因此备份的价值是保留审计与调用历史，不是快速回滚。步骤与边界见 [存储运行指引](STORAGE.md#备份与受控恢复)。Docker 部署备份就是备份卷（`docker compose down` 保留卷，`down -v` 删除）。

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

仓库的 [`e2e/`](../e2e/README.md) 是同一套流程的自动化版本（真实终端配对、官方 MCP SDK、崩溃 / 断网 / 未知结果 / 撤销、两容器两机）；跨机的 NAT / TLS / 防火墙需要你在自己的两台机器上跑一遍 Quick Start。

# Docker 部署

[English](DOCKER.md) · [用户快速开始](QUICK-START-zh.md)

Rovloom 的 Docker 方案运行 **Gateway**。Gateway 镜像保留管理页和 MCP 服务；Luvus/Herdr Connector 运行在原生程序所在的 Linux 主机上。

## 当前可用范围

目前尚无可用的正式镜像。只有官方 latest 稳定产品发行工作流全部通过、GitHub Release 已公开、后续 GHCR 工作流成功且包允许匿名拉取后，下面的命令才可使用。

支持目标为原生 Linux rootful Docker Engine 的 `linux/amd64` 和 `linux/arm64`。两种架构分别由对应原生 CI runner 启动实际镜像；没有通过的架构不能以编译成功替代运行验收。当前 Compose 使用 Linux host 网络保留产品的回环监听；尚未验收 rootless Engine 或 Docker Desktop。

## 从零启动 Gateway

前提：Linux 主机已安装并启动 Docker Engine，以及 Docker Compose v2。无需安装 Bun、Node、Luvus 或 Herdr来运行 Gateway 镜像。

发行和镜像可用后，在一个空目录保存 `main` 中维护的 Compose 文件并启动；它默认使用官方 latest 稳定镜像：

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/Rovloom/main/compose.yaml
docker compose pull
docker compose up -d
docker compose ps
```

默认镜像为 `ghcr.io/arnochenfx/rovloom:latest`，唯一镜像仓库是 GHCR。命名卷会分别保留用户配置与数据；普通 `docker compose down` 不删除它们。首次启动生成唯一用户配置 `/home/rovloom/.config/rovloom/gateway.json`，默认数据目录为 `/home/rovloom/.local/share/rovloom/gateway`。

默认本机入口：

| 用途 | 地址 | 首次启动状态 |
| --- | --- | --- |
| 管理页 | `http://127.0.0.1:9445/` | 匿名页面，没有管理员会话 |
| MCP | `http://127.0.0.1:9444/mcp` | 未认证请求返回 401 |
| Connector 设备监听 | `127.0.0.1:9443` | 仍须完成身份及 provider 配置 |

`healthy` 只说明 MCP 的真实认证监听已响应，不表示设备已经配对、管理员已登录或原生 Agent 已就绪。首次日志中的 `pairing_required` 是待配对状态。继续按[用户快速开始](QUICK-START-zh.md)核对当前已交付的配置与配对能力。

host 网络使这些监听直接使用主机端口，因此不要另加 `ports` 映射；运行前需确保上述端口空闲。默认没有公网监听。远程 Connector 的 TLS 入口须由用户另行明确配置标准反向代理，本文不会代配代理或修改网络设置。

## 配置、停止与更新

镜像以 UID/GID `10001:10001` 运行，根文件系统只读。默认命名卷已按该身份初始化；自定义 bind mount 时，目录应属于该 UID，配置目录为 `0700`，配置文件为 `0600`。不要以 `chmod 777` 解决权限问题。

导出当前配置进行编辑：

```sh
docker compose cp gateway:/home/rovloom/.config/rovloom/gateway.json ./gateway.json
chmod 600 gateway.json
```

保留单文件中的 `data`、`mcp`、`devices` 和 `management` 分组。编辑完成后，以容器原用户原子替换配置并重启：

```sh
docker compose exec -T gateway sh -c \
  'umask 077; cat > /home/rovloom/.config/rovloom/gateway.json.next && mv /home/rovloom/.config/rovloom/gateway.json.next /home/rovloom/.config/rovloom/gateway.json' \
  < gateway.json
docker compose restart gateway
```

修改 MCP 端口时，同时在 Compose 所在目录的 `.env` 设置 `ROVLOOM_MCP_PORT`，供健康检查使用；该变量不会修改配置中的端口。数据目录应保持在持久卷内。配置不包含旧 `runtime.json`、ref 清单或自管 CA 路径；身份/provider 状态由程序管理，不作为用户配置模板。

```sh
docker compose stop       # SIGTERM，等待正常关闭
docker compose start      # 复用原配置和数据
docker compose down       # 删除容器和网络，保留命名卷
```

`docker compose down -v` 会删除持久卷，包括配置和数据，仅在明确要丢弃这些数据时使用。升级前先正常停止并备份卷；将 `ROVLOOM_VERSION` 保持未设置或设为 `latest`，再执行 `docker compose pull && docker compose up -d`。Compose 默认使用 `latest`，发布流程仅让当前官方最新稳定版取得该标签。程序的 `--version` 仍报告实际发行版本。

## Connector 运行位置

本方案将 Connector 留在 Luvus/Herdr 所在的受支持 Linux x64 主机。当前原生进程所有者对其它架构仍明确拒绝；Linux arm64 Gateway 镜像不代表 arm64 原生 Connector 已可运行。Connector 必须验证真实原生 binary/schema、进程归属、私有文件权限、Unix socket peer 和实例生命周期。容器中的用户、PID 和路径空间与主机不同，单独挂载宿主 socket 不能证明这些条件成立。

因此，默认 Compose 不包含 Connector、不挂载 `/var/run/docker.sock`，也不要求 `privileged`、主机 PID 或额外 capability。要在容器内运行 Connector，需要在同一容器内正确安装和管理原生程序并完成独立验收；当前没有将该路径宣称为可用。

## 镜像发布与验收

PR 和 main 的容器工作流只构建并测试，不登录或推送 registry。正式发布只由官方 `Tagged product release` 成功完成后触发：先核验 tag、commit、已公开 Release、六平台清单和 `SHA256SUMS`，再使用其中两个 Linux 二进制构建镜像。每种架构原生测试通过后，发布 job 使用临时 `GITHUB_TOKEN` 和最小 `packages: write` 推送 GHCR，并创建带实际版本的多架构 manifest。对当前官方最新稳定版，`latest` 使用同批验收的这两个镜像 manifest。已有版本只有在两个完整镜像摘要与本次已验收产物精确相同时才可只读复用，继续补齐 latest；不同字节或不确定的 registry 查询会阻止覆盖。

GitHub说明首次 GHCR 包[默认可见性为 private](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。首次包的公开可见性和现有包的写入权限需要仓库维护者核对；工作流不会改变账号或包的设置。若匿名拉取被拒绝，先检查包是否公开及该仓库是否获准写入，不要在配置或文档中加入长期 token。

容器 smoke 使用无外网的临时容器与自有命名卷，核对非 root、准确二进制摘要、单文件首次配置、真实数据库、MCP 401、内置管理资源、正常终止和重启持久性；不调用模型或创建真实外部身份。原生 provider/Worker 的完整产品验收仍由前置发行门禁负责，容器首次未配对启动不替代它。

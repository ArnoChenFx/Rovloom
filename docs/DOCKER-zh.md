# Docker 部署

[English](DOCKER.md) · [快速开始](QUICK-START-zh.md)

Rovloom 的 Docker 方案运行 **Gateway**，包含管理页和 MCP 服务。Luvus/Herdr Connector 运行在原生程序所在的主机上（Linux x64、macOS 或 Windows x64）。

## 支持平台

官方镜像为 `ghcr.io/arnochenfx/rovloom`，公开，可匿名拉取。支持原生 Linux rootful Docker Engine 的 `linux/amd64` 与 `linux/arm64`。Compose 使用 bridge 网络并把 Gateway 的三个端口发布到宿主机。rootless Engine 与 Docker Desktop 不在 CI 验收范围内。

## 从零启动 Gateway

在 Linux 主机上安装 Docker Engine 与 Docker Compose v2。运行 Gateway 镜像不需要 Bun、Node、Luvus 或 Herdr。

在一个空目录保存维护的 Compose 文件并启动：

```sh
mkdir rovloom && cd rovloom
curl --fail --location --output docker-compose.yaml \
  https://raw.githubusercontent.com/ArnoChenFx/rovloom/main/docker-compose.yaml
docker compose pull
docker compose run --rm gateway config init gateway --container
docker compose up -d
docker compose ps
```

默认镜像为 `ghcr.io/arnochenfx/rovloom:latest`。要固定版本，拉取前在 Compose 目录的 `.env` 写入 `ROVLOOM_VERSION=<版本>`。两个命名卷分别保存配置与数据，`docker compose down` 不会删除它们。显式 init 命令生成 `/home/rovloom/.config/rovloom/gateway.json`，不会启动 Gateway，数据目录为 `/home/rovloom/.local/share/rovloom/gateway`。

> 版本说明：`config init gateway --container` 需要 v0.2.0 之后发布的版本；v0.2.0 镜像不包含该命令（运行会返回 `invalid_arguments`）。使用 v0.2.0 时跳过 init 命令，首次启动生成配置后，按下文的配置编辑步骤把三个监听改为 `0.0.0.0` 再重启。

默认本机入口：

| 用途 | 地址 | 首次启动状态 |
| --- | --- | --- |
| 管理页 | `http://127.0.0.1:9445/` | 空页面，尚无管理员 |
| MCP | `http://127.0.0.1:9444/mcp` | 未认证请求返回 401 |
| Connector 设备监听 | `127.0.0.1:9443` | 仍需配对 |

`healthy` 只说明 MCP 认证监听已响应，不表示设备已配对、管理员已存在或 Agent 已就绪。日志中的 `pairing_required` 表示等待配对。

`config init gateway --container` 把容器内部的三个监听设为 `0.0.0.0`。已有配置不会覆盖；旧版回环配置若返回 `config_exists`，请按下文的配置编辑步骤核对并修改。Compose 的发布范围是：

- `9443`（Connector 设备通道）发布到宿主机所有网卡，其它机器上的 Connector 才能连接。跨出可信网络时请前置 TLS 反向代理，并用宿主机防火墙收口。
- `9444`（MCP）与 `9445`（管理页）**只发布到宿主机回环**（`127.0.0.1`）。远程 MCP 客户端通过宿主机上转发到 `127.0.0.1:9444` 的反向代理访问，并设置 `mcp.public_url`（见[网络访问](CONFIGURATION-zh.md#网络访问)）。不要放宽这两个映射：监听是明文 HTTP，Host/Origin 校验只防浏览器 DNS 重绑定——网络上的客户端手工带回环 `Host` 头仍能走到 Bearer 或管理员密码这一步。

## 首次配对

后台服务没有交互终端。在 Compose 目录的真实终端中先停止后台服务，再用同一组卷启动前台 Gateway：

```sh
docker compose stop gateway
docker compose run --rm --service-ports gateway
```

必须带 `--service-ports`：`docker compose run` 默认不发布 Compose 里的端口，不带的话 Connector 连不上 Gateway。全新卷先执行上面的 init 命令。

保持这个终端开启，用于配对和原生安装批准。在 Connector 主机（Linux x64、macOS 或 Windows x64）的另一个本地终端运行 `rovloom connector`，按[配对](QUICK-START-zh.md#3-配对)继续。不要让第二个 Gateway 使用同一份数据。

到达 `connector_ready` 后，先停止 Connector，再按 Ctrl-C 停止前台 Gateway。执行 `docker compose up -d`，然后重新启动主机 Connector。配置和配对保留在卷中。

加入更多设备或重新配对某台设备时，先停止后台 Gateway，运行 `docker compose run --rm --service-ports gateway gateway --add-device`（或 `gateway --repair-device`），再按快速开始在 Connector 主机上继续。

## 配置、停止与升级

镜像以 UID/GID `10001:10001` 运行，根文件系统只读。默认命名卷已按该身份初始化；自定义 bind mount 时，目录应属于该 UID，配置目录为 `0700`，配置文件为 `0600`。不要用 `chmod 777`。

导出生成的配置进行编辑：

```sh
docker compose cp gateway:/home/rovloom/.config/rovloom/gateway.json ./gateway.json
chmod 600 gateway.json
```

保留 `data`、`mcp`、`devices` 和 `management` 分组，字段见[配置参考](CONFIGURATION-zh.md)。编辑完成后，以容器用户替换配置并重启：

```sh
docker compose exec -T gateway sh -c \
  'umask 077; cat > /home/rovloom/.config/rovloom/gateway.json.next && mv /home/rovloom/.config/rovloom/gateway.json.next /home/rovloom/.config/rovloom/gateway.json' \
  < gateway.json
docker compose restart gateway
```

修改 MCP 端口时，同时在 `.env` 设置 `ROVLOOM_MCP_PORT`，让健康检查跟随；该变量不会修改监听端口。数据目录应保持在持久卷内。

```sh
docker compose stop       # SIGTERM，等待正常关闭
docker compose start      # 复用原配置和数据
docker compose down       # 删除容器和网络，保留命名卷
```

`docker compose down -v` 会删除卷，包括配置和数据。升级时先正常停止并备份卷，再执行 `docker compose pull && docker compose up -d`。`latest` 始终指向最新稳定版；容器内 `rovloom --version` 报告实际版本。

## Connector 运行位置

Connector 应运行在 Luvus/Herdr 所在的主机上（Linux x64、macOS 或 Windows x64）。它要核验原生 binary 与 schema、进程归属、私有文件权限、Unix socket 对端和实例生命周期；容器内的用户、PID 和路径与主机不同，挂载宿主 socket 无法保持这些保证。因此 Compose 不含 Connector，不挂载 `/var/run/docker.sock`，也不要求 `privileged`、主机 PID 或额外 capability。

## 镜像构建

镜像由容器工作流用官方 Bun 镜像（`oven/bun:1-slim`，跟随 Bun 1.x 更新，本次构建只解析一次并供构建层与运行层复用）从源码构建，在产品发行成功后推送到 GHCR。维护者见 [DISTRIBUTION](DISTRIBUTION.md)。

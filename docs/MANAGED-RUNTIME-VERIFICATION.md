# 官方 Luvus 的构建产物宿主验收

`scripts/runtime/verify-managed-luvus.mjs`是可重复执行的隔离集成入口。
它只导入当前 `bun run build` 生成的 `dist` 模块，运行固定官方 Luvus 0.14.3，
经真实 WSS 握手连接 Gateway 与 Connector；原生 IPC 的实际 socket peer
继续由生产受控实例和官方 adapter 核对。它不实现或验收公开 CLI/HTTP MCP 入口。

## 环境与命令

需要 Linux x86_64、仓库固定 Bun 1.4.3、`/usr/bin/openssl`，以及用户已安装的官方
Luvus 0.14.3 binary。脚本不下载软件。binary 的 SHA-256 必须匹配代码固定值
`895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9`；
请以 `src/runtime/native-control.ts` 的 `FIXED_LUVUS_SHA256` 为准。

`--temporary-parent`必须是本用户拥有、所有父目录均不可被其它用户写入的受保护绝对目录。
脚本只在其下新建随机私有空白子目录；不要传入用户真实 HOME、原生 session 或现有产品状态根。
脚本不会从该父目录发现、导入或复用已有配置。

从仓库根执行，替换两处绝对路径：

```sh
bun --no-env-file install --frozen-lockfile
bun --no-env-file run build
bun --no-env-file scripts/runtime/verify-managed-luvus.mjs \
  --binary /absolute/protected/path/to/luvus \
  --temporary-parent /absolute/protected/test-parent \
  --acknowledge-nonproduction
```

参数顺序固定。若只想补充独立内核观测，可以用以下命令替换最后一步；trace只记录
`getsockopt`，不会记录进程参数、请求正文或凭据：

```sh
strace -f -qq -e trace=getsockopt -o /absolute/private/evidence/peer.trace \
  bun --no-env-file scripts/runtime/verify-managed-luvus.mjs \
  --binary /absolute/protected/path/to/luvus \
  --temporary-parent /absolute/protected/test-parent \
  --acknowledge-nonproduction
```

## 实际验证范围

成功时退出码为0，只输出一行安全 JSON，`checks: 14`和 `passed`数组来自实际通过的具名断言：

1. 受控官方 child 与真实短期 restricted custody 可用。
2. 合成管理主体与 MCP caller 独立。
3. Gateway 实际监听 WSS。
4. 真实认证通道双方达到 ready。
5. 首次唯一 Store 准入为 `created=true`。
6. 官方原生结果进入唯一 Store 的 `responded`提交。
7. 重复 key 为 `created=false`。
8. 重复 key 返回同一原 call。
9. 原 deadline 保持不变。
10. 当前 caller 经原 Wire 门禁读到实际 native result。
11. 真实持久 dispatch claims 中恰有一个发送墓碑。
12. Connector 独立 receipt 文件绑定原 call。
13. receipt 的 dedup 截止严格等于 Store 原锚点。
14. Connector 退出后 Gateway listener 仍持续运行。

这不是14个独立测试进程，而是一次完整集成执行中的14项具名断言。
脚本显式创建本轮空白 managed root、合成管理员会话/动作批准、设备 enrollment 和
120秒受限原生 delegation，仅执行本轮 `task.add`。管理凭据、设备身份和 MCP caller
各自有独立来源；合成身份不代表生产身份已配置。

正常关闭会先清理 Connector/Gateway，再释放本轮 claims、receipt、custody、受控 child
和 managed root，最后删除自有临时子目录。未确认 child 退出时保留其所有权与目录并报错，
不会通过删除状态掩盖未释放资源。失败只报告阶段与固定错误码，不打印原生响应、token、
配置或数据库。不要提交生成的私有文件、日志、trace 或数据库。

持久 root 重开、custody 到期/重复消费、拒绝边界和真实账号安装须分别验收；
本入口的成功也不代表公开 CLI、HTTP 鉴权产品流程或远端双机已验收。

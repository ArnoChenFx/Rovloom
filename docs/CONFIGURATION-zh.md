# Rovloom 配置参考

[English](CONFIGURATION.md) · **简体中文** · [快速开始](QUICK-START-zh.md)

使用本参考编辑为你的安装交付的配置。
JSON 不支持注释；角色/runtime 解析器拒绝未知字段。**必填字段没有隐式默认值**，
`config template` 生成的值只是示例，不会在字段缺失时自动补齐。所有示例均为无秘密占位配置。

## 最小无秘密配置

`~/.config/rovloom/gateway.json`：

```json
{
  "schema_version": 1,
  "role": "gateway",
  "state_dir": "/absolute/protected/rovloom/gateway",
  "mcp": "http",
  "mcp_hostname": "127.0.0.1",
  "mcp_port": 9444,
  "authentication_ref": "mcp-http"
}
```

`~/.config/rovloom/connector.json`：

```json
{
  "schema_version": 1,
  "role": "connector",
  "state_dir": "/absolute/protected/rovloom/connector",
  "gateway_url": "wss://localhost:9443",
  "provider_config_refs": []
}
```

`/absolute/protected/rovloom/gateway/runtime.json`：

```json
{
  "schema_version": 1,
  "role": "gateway",
  "authentication_ref": "mcp-http",
  "device_listener": {"hostname":"127.0.0.1","port":9443,"tls_ref":"device-tls"},
  "provider_config_refs": []
}
```

`/absolute/protected/rovloom/connector/runtime.json`：

```json
{
  "schema_version": 1,
  "role": "connector",
  "credential_ref": "device",
  "ca_ref": "gateway",
  "provider_config_refs": []
}
```

替换路径并设置权限后，这四份完整文档可以通过结构检查，但不会生成可用部署：Connector
必须选择真实 provider，两个角色也都需要下列资源。请使用独立状态目录。`state_dir`
没有默认值；除非显式设置，否则它并不是角色 JSON 所在目录。

## 角色与 runtime 参数

下文 `ref` 是匹配 `[A-Za-z0-9_-]{1,128}` 的非秘密字符串，不能是路径或 URL。
路径必须是规范绝对路径（不能包含字面量 `~`、相对路径、`..`、重复分隔符；角色路径不能只有根目录）。
不会展开环境变量，也不相对于配置文件解析。POSIX 和 Windows 的角色默认路径都来自当前
用户 home，忽略 XDG_CONFIG_HOME/AppData。角色读取器支持 POSIX、拒绝 Windows；
runtime 读取要求 Linux。

| 角色 JSON 字段 | 类型 / 必需性 | 模板值与作用 |
|---|---|---|
| `schema_version` | integer，必填 | 固定为 `1`。 |
| `role` | string，必填 | 固定为 `gateway` 或 `connector`，必须与命令匹配。 |
| `state_dir` | ≤4096 字符的绝对路径 string，必填 | 该角色的私有状态根目录。 |
| Gateway `mcp` | string，必填 | 固定为 `http`，没有 stdio 选项。 |
| Gateway `mcp_hostname` | string，必填 | 模板为 `127.0.0.1`，也可为 `::1`，仅 loopback。 |
| Gateway `mcp_port` | integer 1–65535，必填 | 模板为 `9444`，HTTP `/mcp` 端口。 |
| Gateway `authentication_ref` | ref，必填 | 模板为 `mcp-http`，引用既有 caller 来源。 |
| Connector `gateway_url` | ≤2048 字符的 WSS origin string，必填 | 模板为 `wss://localhost:9443`；允许末尾 `/`，不允许 userinfo/query/fragment/端点路径。 |
| Connector `provider_config_refs` | 不重复的 ref array，0–32，必填 | 模板为 `[]`，实际启动需要 provider。 |

| `state_dir/runtime.json` 字段 | 类型 / 必需性 | 模板值与作用 |
|---|---|---|
| `schema_version`、`role` | integer/string，必填 | `1` 和角色 JSON 中相同的 role。 |
| `provider_config_refs` | 不重复的 ref array，0–32，必填 | 模板为 `[]`；Connector 必须与角色列表**包括顺序完全相同**，Gateway 在此选择自己的 provider 引用。 |
| Gateway `authentication_ref` | ref，必填 | 必须与角色字段完全相同。 |
| Gateway `device_listener.hostname` | string，必填 | 模板为 `127.0.0.1`，也接受 `::1`、`0.0.0.0`、`::`；与 MCP 独立。 |
| Gateway `device_listener.port` | integer 1–65535，必填 | 模板为 `9443`，TLS WSS `/connector` 监听端口。 |
| Gateway `device_listener.tls_ref` | ref，必填 | 模板为 `device-tls`，证书/私钥文件名前缀。 |
| Gateway `management_ref` | ref，可选，默认缺省 | 启用独立认证的 loopback 管理监听器。 |
| Connector `credential_ref` | ref，必填 | 模板为 `device`，引用已配对设备凭据。 |
| Connector `ca_ref` | ref，必填 | 模板为 `gateway`，Gateway 证书信任锚。 |

角色/runtime JSON 没有 MCP 超时、自定义环境、服务监管或更新替换事务的配置项。
`agent_bin_dir` 位于下文的本地 provider 设置中，不应添加到这些角色/runtime 文档。
固定命令形状见 `rovloom --help`；
没有 `init`、`pair`、`--token` 或通用 shell-RPC 命令。

## 已有资源与文件布局

角色文件及其直接目录须属于当前用户且保持私有（建议 `0600` / `0700`），角色 JSON 上限
16 KiB。runtime/ref JSON 同样上限 16 KiB，文件必须准确为 0600、只有一个硬链接、无
symlink，直接目录为 0700；runtime 路径祖先必须是真实目录。原生安装路径检查更严格：
祖先目录不能允许 group/world 写入，放在 `/tmp` 下的私有子目录也不满足这一原生规则。

```text
~/.config/rovloom/
  gateway.json
  connector.json
<gateway state_dir>/
  runtime.json
  refs/
    mcp-http.json              既有 caller 身份和 token 摘要
    device-tls.cert.pem        既有 TLS 证书
    device-tls.key.pem         既有私钥（秘密）
    <provider-ref>.json        Gateway provider pin/配置
    <schema-ref>.json          引用时使用的 Luvus 原始 schema 字节
    <management-ref>.json      可选独立管理来源
  gateway.db                  业务状态、binding、调用和结果
  identity.db                 只保存摘要的设备身份状态
<connector state_dir>/
  runtime.json
  refs/
    device.json               已配对设备凭据（秘密）
    gateway.ca.pem            既有 CA 证书（可多张）
    <provider-ref>.json        Connector provider 配置
  luvus-claims.db             Luvus 派发 claims
  luvus-admissions.json       Luvus 准入回执
```

上述名称来自模板。ref 总是解析为 `state_dir/refs/<ref>.json`；TLS 使用
`.cert.pem`/`.key.pem`，CA 使用 `.ca.pem`，均不相对于角色文件。native root、native
HOME、schema 路径及 Herdr 账本是独立的显式路径，不会自动放入此树。数据库可能另有
WAL/锁/控制文件，应整体保留状态。

管理员须交付已完成配对的设备、已注册 provider binding、既有 Luvus root 记录和引用的
认证文件。仅编辑 provider JSON 不会注册或配对设备。`device.json` 必须包含 string
字段 `machine_id`、`recovery_generation`、`credential`；最后一个字段是已配对的
32–256 字符 base64url 秘密，不能自行编造。CA/TLS 文件必须与 Gateway 身份匹配，
每份 PEM 输入上限 64 KiB。请私密保存私钥和凭据。

首次账本创建选择 `create`，正常重启使用 `open`；请让管理员确认交付状态所处的阶段。
不要重建缺失或不确定的状态，也不要手改数据库和 root 归属记录。

## 认证与管理设置

`authentication_ref` 选择管理员交付的 caller 文件，绑定精确的
`http://<MCP-host>:<port>/mcp` URL（IPv6 host 加方括号）、既有 caller、权限、
Bearer 摘要和固定有效期。Bearer 原值只放在 MCP 客户端秘密存储中，ref 名称本身不是凭据。

可选 `management_ref` 选择独立交付的管理配置，包含显式 loopback 端口、已批准会话和
允许的操作。管理端口必须与 MCP、设备端口均不同。浏览器登录使用既有 principal ID
作为用户名，独立交付的管理证明作为密码，不复用 MCP Bearer。管理会话过期时刷新页面
并重新认证；刷新不会延长原始上游证明有效期。设备凭据、MCP Bearer 和管理证明是不同
资源。缺失或需续期时请联系管理员，修改安全记录不会创建身份、配对或确认。

provider policy 形状为 `{revision, grants}`，每条 grant 必须有
`{target, methods, actions}`：明确的完整 machine/provider/profile/session Target、
方法 string array 和动作 array（`dispatch`、`read`、`stream_input`、`cancel`）。
没有宽松默认权限。provider `policies` 包含 `caller`、`local` 两份 policy，
两者均须允许所请求的操作。

## 原生安装与 pins

通过原生程序的官方分发安装并核验精确字节。版本标签匹配还不够，不要改 pins 来接受另一份
binary。使用为该安装批准的官方 [Luvus](https://github.com/RizRiyz/luvus) 或
[Herdr](https://github.com/herdrdev/herdr/releases/tag/v0.9.5) 分发。
当前实际接受的 Linux x64 pins 如下：

| Pin | Luvus | Herdr |
|---|---|---|
| 版本 / 协议 | `0.14.3` / live UHP catalog | `0.9.5` / `22` |
| Binary SHA-256 | `895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9` | `14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d` |
| 原始 schema SHA-256 | `00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6` | `9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b` |
| Schema 命令 | `luvus uhp schema` | `herdr api schema --json` |
| Adapter revision | `managed-owned-luvus-0.14.3-1` | `herdr-workflow-4` |
| Classification revision | `managed-owned-rpc-1` | `herdr-0.9.5-workflow-4` |

schema 输出须保持原始字节，不能 JSON 解析后重新序列化。这些 pins 不暗示未经核验的
包管理器安装命令。

## Agent 安装目录

将官方 Agent（如 OpenCode）安装在机器所有者控制的目录中。如果它不在默认
`/usr/bin:/bin` 中，可在**本地 provider 配置**使用可选的 `agent_bin_dir` 指定安装目录：

| Provider | 配置位置 |
|---|---|
| Luvus | 管理员交付的本地 root 中的 `config.agent_bin_dir`，在初始本地设置时选定。当前仍没有完整用户初始化流程，请由管理员准备此设置。不要手工给已有 root 记录补字段或修改 digest。 |
| Herdr | `<connector state_dir>/refs/<provider-ref>.json` 中的 `config.connector.local.agent_bin_dir`。启动 Connector 前保存；更改后重启 Connector。 |

以下只是本地设置**片段**，不是完整 provider 文件：

```json
{
  "agent_bin_dir": "/home/your-user/.local/bin",
  "allow_terminal_execution": false
}
```

`agent_bin_dir` 是可选的 1–4096 字符 string，须为单个规范绝对**目录**，不是可执行
文件路径或 PATH 列表。请换成真实目录；不会展开 `~` 和环境变量，Linux 下不接受相对
路径、仅根目录、`.`/`..`、重复分隔符、控制字符和包含 `:` 的 PATH 列表。空格和 Unicode 保留。

设置后 Linux PATH 为 `<agent_bin_dir>:/usr/bin:/bin`；省略时仍为 `/usr/bin:/bin`，
不继承登录 shell 的 PATH。目录内同名程序优先，因此只使用所有者控制的安装目录。
Rovloom 不创建目录或安装 Agent。此设置不会开启终端执行，也不是 MCP/RPC 参数。
普通严格文本对话可保持 `allow_terminal_execution:false`。模型访问配置放在 runtime
的私有 HOME/XDG，终端执行开关不隔离 Agent 自身工具。

## Luvus provider 参数

每个 Connector 当前可以选择一个 managed Luvus 引用。Gateway 可以 attach 同机已有
root，或使用远端 pin；同一 machine 不能混用 attach 和 remote。

| Owner 引用字段 | 类型 / 必需性 / 默认 | 作用 |
|---|---|---|
| `kind`、`authentication` | 必填常量 | `luvus`、`local_owner`。 |
| `native.mode` | 必填 string | Connector 为 `managed`，同机 Gateway 为 `attach`。 |
| `native.root_record` | 必填绝对路径 string | 已有受保护 managed-root 记录。 |
| `native.expected_root_id`、`.expected_root_revision` | 必填 ID / 正 integer | 精确匹配已有 root，当前记录 revision 为 `1`。 |
| `peer_policy_revision`、`principal_id` | 必填 ID string | 预期 peer 策略与固定 caller 身份。 |
| `policies` | 必填 policy pair | 明确的 caller/local route grants。 |
| `storage_mode` | 必填 `create` 或 `open` | Connector claims/admissions 的首次创建或正常重开，没有自动回退。 |

管理员交付的 root 包含下列本地设置，不要手工构造或修改其身份、digest 和归属记录。

| Luvus root `config` 字段 | 类型 / 必需性 / 默认 | 作用 |
|---|---|---|
| `target` | 必填 object | `machine_id`、`provider_id`、`profile:"session"`、`session`；session 匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`。 |
| `binding_revision`、`config_ref` | 必填正 integer / string | 已注册 binding revision 和匹配的 ref 名称。 |
| `binary`、`binary_sha256` | 必填绝对路径 / SHA-256 | 已审核可执行文件及上述精确 pin。 |
| `state_root`、`home`、`cwd` | 必填绝对路径 string | 分离的私有原生状态、HOME、工作目录，并与控制目录分离；HOME 下有私有 `config`、`data`、`cache`、`runtime` 目录。 |
| `transport` | 必填 string | managed runtime 要求 `ipc`，请使用交付值。 |
| `agent_bin_dir` | 可选绝对目录 string，1–4096 字符，默认缺省 | 将一个 Agent 安装目录前置到 `/usr/bin:/bin`，在初始本地设置时选定。 |
| `allow_terminal_execution` | 可选 boolean，默认 `false` | 直接终端输入/自定义启动的本地许可，不扩大 caller ACL。 |
| `limits` | 可选 object，默认见下文 | 各项只能设为收紧默认值的正 safe integer。 |

本地 limit 默认值：`request_bytes:1048576`、`response_bytes:1048576`、
`stderr_bytes:65536`、`discovery_bytes:2097152`、`timeout_ms:30000`、`attempts:128`。
请选择短原生状态根；官方 socket 缩短规则可能将端点放到
root 外，适配器会拒绝（`endpoint_outside_state_root`）。

| 远端 Gateway 引用字段 | 类型 / 必需性 / 默认 | 作用 |
|---|---|---|
| `kind`、`authentication` | 必填常量 | `luvus`、`remote_connector`。 |
| `binding` | 必填 object | 已注册的 `machine_id`、`provider_id`、`kind:"luvus"`、匹配的 `config_ref`、正 `binding_revision`、boolean `enabled`。 |
| `target`、`peer_policy_revision` | 必填 Target / ID | 相同 session route 和预期 peer 策略。 |
| `contract` | 必填 object | pins 中精确的 `binary_version`、`binary_sha256`、`schema_sha256`、`adapter_revision`、`classification_revision`。 |
| `contract.schema_bundle_ref` | 使用文件间接引用时必填 ref | `refs/<ref>.json` 中的原始 schema，上限 2 MiB；也支持内联 `schema_bundle`，但不能与 ref 同时出现，外层 JSON 仍有 16 KiB 上限。 |
| `raw_grant` | 可选，缺省不授予 raw 权限 | 必填 `principal_id` 和从已审 Luvus 操作中选择的不重复 `methods` array；generic 方法需要明确的远端授权。 |

不要在静态配置添加 `runtime_generation`，它由当前连接的 runtime 提供。
选择器和 raw/strict 校验要求以 MCP 返回的方法描述为准。

## Herdr provider 参数

Gateway ref 封套准确为 `{kind:"herdr",config:{...}}`；Connector 封套准确为
`{kind:"herdr",config:{...},native:{mode:"managed"},policies:{...}}`。
每个角色当前选择一个 Herdr provider 引用。除标记可选外，下表所有字段必填、无默认。

| `config` 字段 | 类型 / 要求 | 作用 |
|---|---|---|
| `version` | integer `1` | 配置版本。 |
| `target`、`binding_revision`、`config_ref` | session Target / 正 integer / string | 已注册 binding，ref 名称匹配，session 语法与 Luvus 相同。 |
| `schema_path` | 规范绝对路径 string | 受保护的原始 schema 文件，Connector 上限 16 MiB，须匹配上述精确摘要。 |
| `peer_policy_revision` | ID string | 预期 peer 策略。 |
| `expected_source` | 精确来源 object | 必填固定字段见下文，任意版本/摘要更改都会被拒绝。 |
| `connector` | Gateway 可选，Connector 必填 | 本地安装、固定 caller 和持久账本。 |
| `connector.principal_id` | ID string | 固定既有 caller。 |
| `connector.local` | object | 必填且匹配外层的 `target`、`binding_revision`、`config_ref`；绝对路径 `binary`、`home`、`config_home`、`state_home`、`cache_home`、`temporary_home`、`cwd`；可选 boolean `allow_terminal_execution` 默认 false。所有目录为私有 0700。 |
| `connector.local.agent_bin_dir` | 可选绝对目录 string，1–4096 字符，默认缺省 | 将一个 Agent 安装目录前置到 `/usr/bin:/bin`，不改变终端执行许可。 |
| `connector.receipts`、`.claims` | 路径不同的 ledger object | 必填 `path`（绝对路径）、`mode`（`create`/`open`）、`ledger_id`（ID）、`limits:{entries,bytes}`。receipts entries 1–1024，claims entries 1–4096；bytes 262144–16777216。 |

`expected_source` 必须是以下精确无秘密对象，包括 JSON null：

```json
{
  "provider_kind": "herdr",
  "protocol_family": "herdr-json",
  "binary_version": "0.9.5",
  "binary_sha256": "14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d",
  "schema_sha256": "9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b",
  "schema_origin": "installed_cli",
  "schema_command": "herdr api schema --json",
  "server_version": "0.9.5",
  "native_protocol_version": "22",
  "runtime_generation": null,
  "adapter_revision": "herdr-workflow-4",
  "classification_revision": "herdr-0.9.5-workflow-4",
  "support_basis": "schema_and_version"
}
```

Herdr 默认 session socket 是 `<config_home>/herdr/herdr.sock`；其他 session 使用
`<config_home>/herdr/sessions/<session>/herdr.sock`。生产入口拒绝接管已有端点，
只跟踪自己管理的 child，不保证 prompt completion、原生取消、事件恢复或 terminal fencing。

## 完整 CLI 参考

以下覆盖当前产品的全部命令形状。`ROLE` 表示 `gateway` 或 `connector`，`ABS` 表示
单独作为参数传入的规范绝对路径；请将示例路径换成自己的实际位置。命令及选项名区分大小写，
不支持 `--option=value`、组合短选项或未声明的额外参数。只有顶层帮助提供短选项。

### 帮助、版本与配置

| 命令 | 参数 / 选项 | 默认值 / 作用 | 合法示例 |
|---|---|---|---|
| `rovloom` | 无 | 输出顶层帮助，不启动角色。 | `rovloom` |
| `rovloom --help`、`rovloom -h`、`rovloom help` | 不接受额外参数 | 等价的离线帮助。 | `rovloom -h` |
| `rovloom --version` | 不接受额外参数 | 输出产品版本，没有 `-v` 别名。 | `rovloom --version` |
| `rovloom gateway --help`、`rovloom connector --help` | 仅一个 `--help` | 输出顶层帮助，不能与 `--config` 同用。 | `rovloom connector --help` |
| `rovloom config template ROLE` | 必填位置 enum `ROLE`，无选项 | 输出完整无秘密角色 JSON，不写文件。 | `rovloom config template gateway` |
| `rovloom config template runtime ROLE` | 必填位置 enum `ROLE`，无选项 | 输出完整无秘密 runtime JSON，不写文件。 | `rovloom config template runtime connector` |
| `rovloom config check --config ABS` | `--config`：必填路径 string | 此命令没有默认路径，检查所选角色 JSON。 | `rovloom config check --config /home/rovloom/.config/rovloom/gateway.json` |
| `rovloom config check-runtime --config ABS` | `--config`：必填路径 string | 检查角色 JSON 和 `state_dir/runtime.json`，不加载凭据或确认 Agent 就绪。 | `rovloom config check-runtime --config /home/rovloom/.config/rovloom/connector.json` |

### 运行角色

| 命令 | 参数 / 选项 | 默认值 / 作用 | 合法示例 |
|---|---|---|---|
| `rovloom gateway [--config ABS]` | `--config`：可选路径 string | 默认使用当前用户 `~/.config/rovloom/gateway.json`，启动前台 Gateway。 | `rovloom gateway --config /home/rovloom/.config/rovloom/gateway.json` |
| `rovloom connector [--config ABS]` | `--config`：可选路径 string | 默认使用当前用户 `~/.config/rovloom/connector.json`，启动前台 Connector。 | `rovloom connector --config /home/rovloom/.config/rovloom/connector.json` |

显式路径优先，无效时不会回退。所选文件必须匹配角色。`--config` 指向角色 JSON，
不是 `runtime.json`；默认路径按进程用户解析。Ctrl-C 停止前台角色，没有独立的顶层
`start`、`stop` 或 `restart`。端口、provider 选择和 Agent 设置是 JSON 字段，不是 CLI 选项。

### Service 命令语法与当前可用性

`rovloom service --help` 可离线使用。服务接口识别下列五种动作，但**当前产品未连接
服务后端**，均返回 `backend_unavailable`、退出码 **3**，不会安装或管理系统服务。
下列示例用于说明语法，不是本预览可成功执行的安装教程；管理员权限也不能消除此限制。

| 命令形状 | 必填参数 | 动作含义 | 语法示例（当前不可用） |
|---|---|---|---|
| `rovloom service install` | `--role`、`--executable`、`--workdir`、`--user`；`--config` 可选 | 加入/启用开机自动启动，**不会立即启动**。 | `rovloom service install --role gateway --executable /opt/rovloom/rovloom --config /home/rovloom/.config/rovloom/gateway.json --workdir /home/rovloom --user rovloom` |
| `rovloom service start` | 仅 `--role` | 立即启动已安装角色，不自动安装。 | `rovloom service start --role gateway` |
| `rovloom service restart` | 仅 `--role` | 停止已安装实例，再启动。 | `rovloom service restart --role connector` |
| `rovloom service stop` | 仅 `--role` | 立即停止，保留下次开机自动启动。 | `rovloom service stop --role connector` |
| `rovloom service uninstall` | 仅 `--role` | 删除未来开机自动启动，**不会停止**正在运行的实例，也不删除用户数据。 | `rovloom service uninstall --role gateway` |

每个服务动作只选择一个角色，另一角色需单独操作。没有默认角色、`all` 角色、`--now`、
`--force`、`--purge` 或 `service status` 命令；其他动作不接受仅安装适用的选项。

| 服务选项 | 类型 / 必需性 / 默认 | 用途 |
|---|---|---|
| `--role` | 必填 enum `gateway` 或 `connector`，无默认 | 选择要管理其自启/实例的角色。 |
| `--executable` | 仅 install，必填绝对路径 string，≤4096 字符，无默认 | Rovloom 单文件程序，不是 shell 命令或解释器；Windows 路径须以 `.exe` 结尾。 |
| `--config` | 仅 install，可选绝对路径 string，≤4096 字符 | 显式角色配置。省略时需要已验证用户的 `~/.config/rovloom/gateway.json` 或 `connector.json`；无法验证身份时必须显式传入（`config_path_required`），不根据环境变量猜测提权前 home。 |
| `--workdir` | 仅 install，必填绝对目录 string，≤4096 字符，无默认 | 服务工作目录，不设置或替代 JSON 的 `state_dir`。 |
| `--user` | 仅 install，必填账户 string，无默认 | Linux/macOS 上既有非 root 账户；Windows 仅接受 LocalService SID `S-1-5-19`，不使用密码。 |

服务路径在安装时固定，后续开机/start/restart 使用已记录的绝对角色配置，不重新解析 home。
POSIX 安装要求 root 持有的受保护程序，以及属于所选非 root 账户的配置/工作目录；
不会创建账户或放宽权限。Windows 要求独立的受保护安装和 LocalService 访问权限。
这些检查不会使尚未连接的产品服务后端变为可用。

服务动作将安装和运行状态分开：install 后再 start 才分别请求开机自启和立即运行；
uninstall 后再 stop 才分别请求不再开机自启和立即停止。重复 start 不应产生重复实例，
start/restart 要求已有安装记录。stop 本身不删除开机自启。Windows stop/restart
可能直接终止任务，不能当作原生工作回滚。

### 平台可用性与状态检查

| 命令类别 | Linux | macOS | Windows |
|---|---|---|---|
| 帮助/版本/模板输出 | 可用 | 可用 | 可用 |
| `config check` | 受保护 POSIX 读取器 | 受保护 POSIX 读取器 | 拒绝：`config_platform_unsupported` |
| `config check-runtime`、真实角色启动 | 当前部署指引覆盖 Linux x64 | runtime 加载器拒绝该平台 | runtime 加载器拒绝该平台 |
| Service 动作 | 当前产品 CLI 不可用 | 不可用，runtime 也未支持 | 不可用，runtime/配置及安装 ACL 支持也未完成 |
| `update --check` | x64/arm64，需要实测 glibc | x64/arm64 元数据检查 | x64/arm64 元数据检查 |

本预览没有可用的 Rovloom 服务状态查询，
请通过前台进程及 Quick Start 中的管理页/MCP 检查当前 runtime 就绪状态。
进程运行本身不证明 MCP 或 Agent 就绪，HTTP 客户端断开也不会停止 Gateway。

### Update 命令

| 命令 | 参数 / 选项 | 作用与当前限制 | 合法示例 |
|---|---|---|---|
| `rovloom update --help` | 无额外参数 | 离线更新帮助。 | `rovloom update --help` |
| `rovloom update --check` | `--check`：可选的仅检查 boolean 开关，不带值 | 经网络读取官方稳定发行元数据，不替换程序。 | `rovloom update --check` |
| `rovloom update` | 无参数 | 先检查；没有新版本时不替换并返回 0，存在新版本时因缺少替换后端返回 `replacement_unavailable`（5）。 | `rovloom update` |

目前没有公开发行，网络检查可能返回 `release_unavailable`。`update` 返回 0 不等于
安装了新程序。不接受 URL、镜像、版本选择器、下载路径、脚本或确认选项。
发行矩阵表示更新元数据目标，不代表完整 Gateway/Connector runtime 支持。

### 输出与退出码

帮助、版本、检查诊断、服务诊断和更新状态写入 **stderr**，模板 JSON 写入 **stdout**。
stdout 不是 MCP 传输。任何命令都不接受 Bearer、TLS 秘密、模型秘密或任意环境变量选项。
`init`、`pair`、`status`、`--token`、`--port`、`--env`、`--agent-bin-dir` 不属于此 CLI。

| 退出码 | 角色/配置/服务含义 | Update 含义 |
|---|---|---|
| `0` | 帮助/模板/检查成功、角色正常关闭；服务帮助可成功 | 检查成功或无需替换，实际替换目前未接通。 |
| `1` | 运行/关闭失败；已接后端时的服务操作失败 | 未预期的更新失败。 |
| `2` | 参数/配置错误；已接服务后端时的选项错误或缺少可信默认配置 | 参数/当前版本无效或平台不支持。 |
| `3` | 后端不可用，当前产品的服务动作均返回此码 | 网络/发行/manifest/下载核验失败。 |
| `4` | 不是角色/配置/服务成功码 | 权限/暂存/锁/安装或 IO/清理未完成，不是成功。 |
| `5` | 这些命令不使用 | 替换后端不可用。 |
| `6` | 这些命令不使用 | 更新已回滚（替换模块结果）。 |
| `7` | 这些命令不使用 | 需要恢复（替换模块结果）。 |

未接通服务后端的检查发生在动作参数解析之前，所以当前即使传入畸形 service 动作也会返回
`backend_unavailable`，不能据此认为选项合法。求助时保留错误码，不上传真实配置或秘密。

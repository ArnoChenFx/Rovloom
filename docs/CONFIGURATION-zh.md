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

通过官方分发安装 Luvus 或 Herdr。兼容性由安装版协议、完整请求/响应 schema 和实际方法能力
判断；版本标签保留作提示与诊断，不要求指定 Luvus/Herdr 发行版或预设 binary/schema 摘要。
可选方法缺失或不兼容只影响依赖功能，其它健康方法继续可用。目录只展示已接入的方法和传输。

| 安装观测 | Luvus | Herdr |
|---|---|---|
| Schema 命令 | `luvus uhp schema` | `herdr api schema --json` |
| 协议依据 | UHP v1 信封及实际在线方法目录 | schema 中的实际协议与完整 JSON RPC 根 |
| Adapter revision | `managed-owned-luvus-0.14.3-1` | `herdr-workflow-4` |
| Classification revision | `managed-owned-rpc-1` | `herdr-0.9.5-workflow-4` |

revision 字符串标识 Rovloom 适配/分类代码，其中的历史版本文字不是原生安装要求。
摘要应取自**本机实际安装**，schema 输出保留原字节。受保护配置与当前来源仍须一致指向所选
binary/schema 和完整目标；文件替换或过期配置会拒绝。这些核对防止误投，不选择原生版本。
已知预编译摘要只用于缓存命中，未知 schema 在同一编译预算内从真实原字节完整编译。

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
| `binary`、`binary_sha256` | 必填绝对路径 / SHA-256 | 所选可执行文件及本机实际测量的 SHA-256；无预设发行版摘要。 |
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
| `contract` | 必填 object | 诊断用版本标签、实际 binary/schema SHA-256 及当前 adapter/classification revisions。 |
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
| `schema_path` | 规范绝对路径 string | 受保护的原始 schema 文件，Connector 上限 16 MiB，摘要记录于 `expected_source`；编译器另有 512 KiB 输入预算。 |
| `peer_policy_revision` | ID string | 预期 peer 策略。 |
| `expected_source` | 精确来源 object | 记录实际安装的必填来源字段见下文；无预设版本/摘要白名单。 |
| `connector` | Gateway 可选，Connector 必填 | 本地安装、固定 caller 和持久账本。 |
| `connector.principal_id` | ID string | 固定既有 caller。 |
| `connector.local` | object | 必填且匹配外层的 `target`、`binding_revision`、`config_ref`；绝对路径 `binary`、`home`、`config_home`、`state_home`、`cache_home`、`temporary_home`、`cwd`；可选 boolean `allow_terminal_execution` 默认 false。所有目录为私有 0700。 |
| `connector.local.agent_bin_dir` | 可选绝对目录 string，1–4096 字符，默认缺省 | 将一个 Agent 安装目录前置到 `/usr/bin:/bin`，不改变终端执行许可。 |
| `connector.receipts`、`.claims` | 路径不同的 ledger object | 必填 `path`（绝对路径）、`mode`（`create`/`open`）、`ledger_id`（ID）、`limits:{entries,bytes}`。receipts entries 1–1024，claims entries 1–4096；bytes 262144–16777216。 |

`expected_source` 记录所选实际安装（包括 JSON null）。以下历史 fixture 仅演示字段形状，应填写本机实际观测；版本标签用于来源诊断，不决定兼容性：

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

# Rovloom configuration reference

**English** · [简体中文](CONFIGURATION-zh.md) · [Quick Start](QUICK-START.md)

Use this reference to edit the configuration delivered for your installation.
JSON has no comments. Unknown role/runtime fields are rejected. **Required fields have no
implicit defaults**; values emitted by `config template` are examples, not
fallbacks when a field is omitted. All examples are non-secret placeholders.

## Minimal non-secret configurations

`~/.config/rovloom/gateway.json`:

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

`~/.config/rovloom/connector.json`:

```json
{
  "schema_version": 1,
  "role": "connector",
  "state_dir": "/absolute/protected/rovloom/connector",
  "gateway_url": "wss://localhost:9443",
  "provider_config_refs": []
}
```

`/absolute/protected/rovloom/gateway/runtime.json`:

```json
{
  "schema_version": 1,
  "role": "gateway",
  "authentication_ref": "mcp-http",
  "device_listener": {"hostname":"127.0.0.1","port":9443,"tls_ref":"device-tls"},
  "provider_config_refs": []
}
```

`/absolute/protected/rovloom/connector/runtime.json`:

```json
{
  "schema_version": 1,
  "role": "connector",
  "credential_ref": "device",
  "ca_ref": "gateway",
  "provider_config_refs": []
}
```

These four complete documents pass structural validation after replacing paths
and setting file permissions. They do not provision a working deployment: the
Connector must select a real provider, and both roles need the resources below.
Use separate state directories. `state_dir` has no default and is not the directory
containing the role JSON unless explicitly set that way.

## Role and runtime parameters

`ref` below means a non-secret string matching `[A-Za-z0-9_-]{1,128}`, never a
path or URL. Paths must be normalized absolute paths (no literal `~`, relative
paths, `..`, repeated separators or root-only role paths). No environment-variable
expansion or file-relative resolution is performed. Default role discovery uses
the current user's home on POSIX and Windows; it ignores XDG_CONFIG_HOME/AppData.
The role reader supports POSIX, rejects Windows; runtime reading requires Linux.

| Role JSON field | Type / required | Template value and effect |
|---|---|---|
| `schema_version` | integer, required | Exactly `1`. |
| `role` | string, required | Exactly `gateway` or `connector`; must match the command. |
| `state_dir` | absolute path string ≤4096 characters, required | Role-specific private state root. |
| Gateway `mcp` | string, required | Exactly `http`; no stdio option. |
| Gateway `mcp_hostname` | string, required | `127.0.0.1` (template) or `::1`; loopback only. |
| Gateway `mcp_port` | integer 1–65535, required | `9444` in template; HTTP `/mcp` port. |
| Gateway `authentication_ref` | ref, required | `mcp-http` in template; existing caller source. |
| Connector `gateway_url` | WSS origin string ≤2048 characters, required | `wss://localhost:9443`; optional trailing `/`, no userinfo/query/fragment/endpoint path. |
| Connector `provider_config_refs` | unique ref array, 0–32, required | `[]` in template; actual startup needs a provider. |

| `state_dir/runtime.json` field | Type / required | Template value and effect |
|---|---|---|
| `schema_version`, `role` | integer/string, required | `1` and the same role as the role JSON. |
| `provider_config_refs` | unique ref array, 0–32, required | `[]`; on Connector must equal the role list **including order**; Gateway selects its own provider references here. |
| Gateway `authentication_ref` | ref, required | Must exactly equal the role field. |
| Gateway `device_listener.hostname` | string, required | `127.0.0.1` in template; also `::1`, `0.0.0.0`, `::`. This is separate from MCP. |
| Gateway `device_listener.port` | integer 1–65535, required | `9443` in template; TLS WSS `/connector` listener. |
| Gateway `device_listener.tls_ref` | ref, required | `device-tls` in template; certificate/key basename. |
| Gateway `management_ref` | ref, optional; default absent | Enables independently authenticated loopback management listener. |
| Connector `credential_ref` | ref, required | `device` in template; existing device credential. |
| Connector `ca_ref` | ref, required | `gateway` in template; Gateway certificate trust anchors. |

The role/runtime JSON has no settings for MCP timeouts, custom environment,
service supervision or updater replacement. `agent_bin_dir` belongs in the local
provider settings described below, not in these role/runtime documents.
See `rovloom --help` for the fixed command shapes;
there is no `init`, `pair`, `--token` or generic shell-RPC command.

## Provisioned resources

Role files and their immediate directories must belong to the current user and
be private (use `0600` / `0700`); role JSON is limited to 16 KiB. Runtime/ref JSON
also has a 16 KiB limit, exact 0600 files, a single hard link, no symlinks, and
0700 immediate directories. Runtime path ancestors must be real directories.
Native installation paths add stricter checks: ancestors cannot be group/world
writable. A private subdirectory beneath `/tmp` does not satisfy that native rule.

```text
~/.config/rovloom/
  gateway.json
  connector.json
<gateway state_dir>/
  runtime.json
  refs/
    mcp-http.json              existing caller identities and token digests
    device-tls.cert.pem        existing TLS certificate
    device-tls.key.pem         existing private key (secret)
    <provider-ref>.json        Gateway provider pin/configuration
    <schema-ref>.json          original Luvus schema bytes, if referenced
    <management-ref>.json      optional independent management source
  gateway.db                  business state, bindings, calls and results
  identity.db                 hash-only device identity state
<connector state_dir>/
  runtime.json
  refs/
    device.json               existing paired device credential (secret)
    gateway.ca.pem            existing CA certificate(s)
    <provider-ref>.json        Connector provider configuration
  luvus-claims.db             Luvus dispatch claims
  luvus-admissions.json       Luvus admission receipts
```

Names above follow the templates; refs always resolve to `state_dir/refs/<ref>.json`,
except TLS `.cert.pem`/`.key.pem` and CA `.ca.pem`. Those files are not relative
to the role file. Native roots, native HOME, schema paths and Herdr ledgers are
explicit separate paths, not automatically placed in this tree. Databases can
have auxiliary WAL/lock/control files; preserve the state as a whole.

The administrator must supply completed device pairing, registered provider
bindings, the existing Luvus root record and the referenced authentication files.
Editing provider JSON alone does not register or pair a device. `device.json`
has required string fields `machine_id`, `recovery_generation`, `credential`;
the last is the existing paired 32–256 character base64url secret, not a value to
invent. CA/TLS files must already match the Gateway identity; each PEM input is
limited to 64 KiB. Keep keys and credentials private.

For initial ledger creation select `create`; use `open` for normal restarts.
Ask the administrator to confirm which stage the supplied state is in. Do not
recreate missing or uncertain state, or edit database and root ownership records.

## Authentication and management settings

`authentication_ref` selects an administrator-supplied caller file. It binds the
exact `http://<MCP-host>:<port>/mcp` URL (bracket IPv6 hosts), existing caller,
permissions, Bearer digest and fixed expiry. Put the original Bearer only in the
MCP client's secret storage. A ref name is not itself a credential.

Optional `management_ref` selects a separately supplied management configuration,
including its explicit loopback port, approved sessions and permitted operations.
The port must differ from both MCP and device ports. In the browser, use the
existing principal ID as username and the independently supplied management proof
as password. Do not reuse an MCP Bearer. Refresh the page and authenticate again
if the management session expires; refreshing does not extend the original
upstream proof's expiry. Device credentials, MCP Bearers and management proofs
are separate resources. Ask the administrator for missing or renewed resources;
editing security records does not create an identity, pairing or confirmation.

Provider policies are `{revision, grants}` objects. Each grant has required
`{target, methods, actions}`: an explicit full machine/provider/profile/session
Target, method string array and action array (`dispatch`, `read`, `stream_input`,
`cancel`). There are no permissive defaults. Provider `policies` contains both
`caller` and `local` policies; both must permit the requested operation.

## Native installation and pins

Install native programs through their official distribution and verify the exact
bytes. A matching version label alone is insufficient; do not edit pins to accept
another binary. Use the official [Luvus](https://github.com/RizRiyz/luvus) or
[Herdr](https://github.com/herdrdev/herdr/releases/tag/v0.9.5) distribution approved
for your installation.
The following are the actual currently accepted Linux x64 pins:

| Pin | Luvus | Herdr |
|---|---|---|
| Version / protocol | `0.14.3` / live UHP catalog | `0.9.5` / `22` |
| Binary SHA-256 | `895073022da8edd231c9d4c810d68627b954b61e4e9f9f2d5d19e2c2fcf282a9` | `14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d` |
| Original schema SHA-256 | `00e3bb8862b9f3602164bdbe3f11cd7b466e7f7098aa2942dd3878d0b1abdbe6` | `9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b` |
| Schema command | `luvus uhp schema` | `herdr api schema --json` |
| Adapter revision | `managed-owned-luvus-0.14.3-1` | `herdr-workflow-4` |
| Classification revision | `managed-owned-rpc-1` | `herdr-0.9.5-workflow-4` |

Preserve schema output as original bytes, not parsed/reserialized JSON. These
pins do not imply an unverified package-manager installation command.

## Agent installation directory

Install the official Agent, such as OpenCode, in a directory controlled by the
machine owner. If it is outside the default `/usr/bin:/bin`, select its directory
with optional `agent_bin_dir` in the **local provider configuration**:

| Provider | Configuration location |
|---|---|
| Luvus | The administrator-supplied local root's `config.agent_bin_dir`, selected during initial local setup. There is still no complete user-facing initialization flow; ask the administrator to prepare this setting. Do not add it to an existing root record or change its digest by hand. |
| Herdr | `<connector state_dir>/refs/<provider-ref>.json`, at `config.connector.local.agent_bin_dir`. Save the setting before starting Connector, or restart Connector after changing it. |

The following is a local settings **fragment**, not a complete provider file:

```json
{
  "agent_bin_dir": "/home/your-user/.local/bin",
  "allow_terminal_execution": false
}
```

`agent_bin_dir` is an optional string of 1–4096 characters: one normalized
absolute **directory**, not an executable path or PATH list. Substitute the real
directory; `~` and environment variables are not expanded, and relative paths,
root-only paths, `.`/`..`, redundant separators, control characters and `:` PATH
lists are not accepted on Linux. Spaces and Unicode are preserved.

When set, Linux PATH is `<agent_bin_dir>:/usr/bin:/bin`; when omitted, it remains
`/usr/bin:/bin`. It does not inherit your login shell's PATH. Programs in the
selected directory take precedence, so use only an owner-controlled installation
directory. Rovloom does not create it or install the Agent. The setting does not
enable terminal execution, and is not an MCP/RPC argument. Keep
`allow_terminal_execution:false` for ordinary strict text conversation.
Configure model access in the runtime's private HOME/XDG locations. The
terminal-execution switch does not sandbox the Agent's own tools.

## Luvus provider parameters

Each Connector can currently select one managed Luvus reference. Gateway can
attach to an existing same-host root or use remote pins; a machine cannot mix
attach and remote modes.

| Owner reference field | Type / required / default | Effect |
|---|---|---|
| `kind`, `authentication` | required constants | `luvus`, `local_owner`. |
| `native.mode` | required string | `managed` on Connector; `attach` on same-host Gateway. |
| `native.root_record` | required absolute path string | Existing protected managed-root record. |
| `native.expected_root_id`, `.expected_root_revision` | required ID / positive integer | Exact existing root; current record revision is `1`. |
| `peer_policy_revision`, `principal_id` | required ID strings | Expected peer policy and fixed caller identity. |
| `policies` | required policy pair | Explicit caller/local route grants. |
| `storage_mode` | required `create` or `open` | Connector claims/admissions initial creation or normal reopen. No automatic fallback. |

The administrator-supplied root carries the following local settings. Do not
construct or modify its identity, digest or ownership records by hand.

| Luvus root `config` field | Type / required / default | Effect |
|---|---|---|
| `target` | required object | `machine_id`, `provider_id`, `profile:"session"`, `session`; session matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. |
| `binding_revision`, `config_ref` | required positive integer / string | Registered binding revision and matching ref name. |
| `binary`, `binary_sha256` | required absolute path / SHA-256 | Approved executable and exact pin above. |
| `state_root`, `home`, `cwd` | required absolute path strings | Separate private native state, HOME and work directory; separate from the control directory. HOME contains private `config`, `data`, `cache`, `runtime` directories. |
| `transport` | required string | Managed runtime requires `ipc`; use the supplied setting. |
| `agent_bin_dir` | optional absolute-directory string, 1–4096 characters; default absent | Prepends one Agent installation directory to `/usr/bin:/bin`; selected during initial local setup. |
| `allow_terminal_execution` | optional boolean, default `false` | Local permission for direct terminal input/custom launches; does not broaden caller ACL. |
| `limits` | optional object; defaults below | May only tighten each positive safe integer. |

Local limit defaults: `request_bytes:1048576`, `response_bytes:1048576`,
`stderr_bytes:65536`, `discovery_bytes:2097152`, `timeout_ms:30000`, `attempts:128`.
Choose a short native state root: official socket shortening can place an endpoint
outside that root, which the adapter rejects (`endpoint_outside_state_root`).

| Remote Gateway reference field | Type / required / default | Effect |
|---|---|---|
| `kind`, `authentication` | required constants | `luvus`, `remote_connector`. |
| `binding` | required object | Registered `machine_id`, `provider_id`, `kind:"luvus"`, matching `config_ref`, positive `binding_revision`, boolean `enabled`. |
| `target`, `peer_policy_revision` | required Target / ID | Same session route and expected peer policy. |
| `contract` | required object | Exact `binary_version`, `binary_sha256`, `schema_sha256`, `adapter_revision`, `classification_revision` from pins. |
| `contract.schema_bundle_ref` | required ref when using file indirection | Original schema at `refs/<ref>.json`, up to 2 MiB. Alternative inline `schema_bundle` is supported, but cannot coexist with ref; the 16 KiB outer JSON limit still applies. |
| `raw_grant` | optional; absent grants no raw permission | Required `principal_id` and unique `methods` array selected from reviewed Luvus operations. Generic methods require this explicit remote authorization. |

Do not add `runtime_generation` to static configuration: the current connected
runtime supplies it. Use the method descriptions returned by MCP for selectors
and raw/strict validation requirements.

## Herdr provider parameters

The Gateway ref envelope is exactly `{kind:"herdr",config:{...}}`. The Connector
envelope is exactly `{kind:"herdr",config:{...},native:{mode:"managed"},policies:{...}}`.
Each role currently selects one Herdr provider reference. All fields below
are required without defaults unless marked optional.

| `config` field | Type / requirement | Effect |
|---|---|---|
| `version` | integer `1` | Configuration version. |
| `target`, `binding_revision`, `config_ref` | session Target / positive integer / string | Registered binding, matching ref name; same session syntax as Luvus. |
| `schema_path` | canonical absolute path string | Protected original schema file, up to 16 MiB on Connector; exact digest above. |
| `peer_policy_revision` | ID string | Expected peer policy. |
| `expected_source` | exact source object | Required fixed fields below; arbitrary version/hash changes are rejected. |
| `connector` | optional on Gateway; required on Connector | Local installation, fixed caller and persistent ledgers. |
| `connector.principal_id` | ID string | Fixed existing caller. |
| `connector.local` | object | Required `target`, `binding_revision`, `config_ref` matching outer values; absolute `binary`, `home`, `config_home`, `state_home`, `cache_home`, `temporary_home`, `cwd`; optional boolean `allow_terminal_execution` defaults false. All directories private 0700. |
| `connector.local.agent_bin_dir` | optional absolute-directory string, 1–4096 characters; default absent | Prepends one Agent installation directory to `/usr/bin:/bin`; does not change terminal-execution permission. |
| `connector.receipts`, `.claims` | distinct ledger objects | Required `path` (absolute), `mode` (`create`/`open`), `ledger_id` (ID), `limits:{entries,bytes}`. Entries 1–1024 for receipts, 1–4096 for claims; bytes 262144–16777216. |

`expected_source` is the following exact non-secret object (including JSON nulls):

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

Herdr's default session socket is `<config_home>/herdr/herdr.sock`; other sessions
use `<config_home>/herdr/sessions/<session>/herdr.sock`. Production refuses to
take over an existing endpoint and tracks its own managed child. It does not
promise prompt completion, native cancellation, event recovery or terminal fencing.

## Complete CLI reference

These are all command forms accepted by the current product. `ROLE` means
`gateway` or `connector`; `ABS` means a normalized absolute path supplied as a
separate argument. Replace example paths with your own. Commands and option
names are case-sensitive. No `--option=value` syntax, combined short flags or
unspecified extra arguments are supported. Only top-level help has a short flag.

### Help, version and configuration

| Command | Arguments / options | Default / effect | Valid example |
|---|---|---|---|
| `rovloom` | None | Prints top-level help; does not start a role. | `rovloom` |
| `rovloom --help`, `rovloom -h`, `rovloom help` | No additional arguments | Equivalent offline help. | `rovloom -h` |
| `rovloom --version` | No additional arguments | Prints product version. No `-v` alias. | `rovloom --version` |
| `rovloom gateway --help`, `rovloom connector --help` | Exactly one `--help` flag | Prints top-level help; cannot combine with `--config`. | `rovloom connector --help` |
| `rovloom config template ROLE` | Required positional enum `ROLE`; no options | Prints complete non-secret role JSON; writes no file. | `rovloom config template gateway` |
| `rovloom config template runtime ROLE` | Required positional enum `ROLE`; no options | Prints complete non-secret runtime JSON; writes no file. | `rovloom config template runtime connector` |
| `rovloom config check --config ABS` | `--config`: required path string | No default for this command; checks the selected role JSON. | `rovloom config check --config /home/rovloom/.config/rovloom/gateway.json` |
| `rovloom config check-runtime --config ABS` | `--config`: required path string | Checks role JSON and `state_dir/runtime.json`; does not load credentials or verify Agent readiness. | `rovloom config check-runtime --config /home/rovloom/.config/rovloom/connector.json` |

### Run a role

| Command | Arguments / options | Default / effect | Valid example |
|---|---|---|---|
| `rovloom gateway [--config ABS]` | `--config`: optional path string | Defaults to the current user's `~/.config/rovloom/gateway.json`; starts the foreground Gateway. | `rovloom gateway --config /home/rovloom/.config/rovloom/gateway.json` |
| `rovloom connector [--config ABS]` | `--config`: optional path string | Defaults to the current user's `~/.config/rovloom/connector.json`; starts the foreground Connector. | `rovloom connector --config /home/rovloom/.config/rovloom/connector.json` |

Explicit paths take priority; there is no fallback from an invalid explicit path.
The selected file must have the matching role. `--config` selects the role JSON,
not `runtime.json`. Defaults are resolved for the process user. Stop a foreground
role with Ctrl-C; there is no separate top-level `start`, `stop` or `restart`.
Network ports, provider selection and Agent settings are JSON fields, not flags.

### Service command syntax and current availability

`rovloom service --help` is available offline. The five action forms below are
recognized by the service interface, but **the current product has no connected
service backend**: they return `backend_unavailable` and exit **3** without
installing or managing a system service. The examples document syntax; they are
not a working installation procedure for this preview. Administrator privilege
does not remove this limitation.

| Command form | Required arguments | Meaning of the action | Syntax example (currently unavailable) |
|---|---|---|---|
| `rovloom service install` | `--role`, `--executable`, `--workdir`, `--user`; optional `--config` | Add/enable startup at boot; **does not start now**. | `rovloom service install --role gateway --executable /opt/rovloom/rovloom --config /home/rovloom/.config/rovloom/gateway.json --workdir /home/rovloom --user rovloom` |
| `rovloom service start` | `--role` only | Start an installed role now; does not create its installation. | `rovloom service start --role gateway` |
| `rovloom service restart` | `--role` only | Stop the installed instance, then start it. | `rovloom service restart --role connector` |
| `rovloom service stop` | `--role` only | Stop now; retain startup at the next boot. | `rovloom service stop --role connector` |
| `rovloom service uninstall` | `--role` only | Remove startup at future boots; **does not stop** a running instance or delete user data. | `rovloom service uninstall --role gateway` |

Every service action selects exactly one role; repeat separately for the other
role. There is no default role, `all` role, `--now`, `--force`, `--purge` or
`service status` command. Other actions cannot take install-only options.

| Service option | Type / required / default | Purpose |
|---|---|---|
| `--role` | Required enum `gateway` or `connector`; no default | Select the role whose startup/instance is managed. |
| `--executable` | Install-only, required absolute path string, at most 4096 characters; no default | Standalone Rovloom program, not a shell command or interpreter. Windows path must end in `.exe`. |
| `--config` | Install-only, optional absolute path string, at most 4096 characters | Explicit role configuration. If omitted, requires the verified user's `~/.config/rovloom/gateway.json` or `connector.json`; an unavailable verified identity requires an explicit path (`config_path_required`). Do not infer a pre-elevation home from environment variables. |
| `--workdir` | Install-only, required absolute directory string, at most 4096 characters; no default | Working directory of the service; does not set or replace JSON `state_dir`. |
| `--user` | Install-only, required account string; no default | Existing non-root account on Linux/macOS. Windows accepts only LocalService SID `S-1-5-19`, without a password. |

Service path values are fixed at install time; later boot/start/restart uses the
recorded absolute role configuration, rather than resolving a new home. POSIX
installation requires a root-owned protected executable and configuration/work
directories belonging to the chosen non-root account; it does not create accounts
or relax permissions. Windows requires its own protected installation and
LocalService access. Those checks do not make the unconnected product backend usable.

The service action semantics keep installation and running state separate:
install then start would request both boot startup and immediate running;
uninstall then stop would request both no future boot startup and stopping now.
Repeated start must not duplicate a running instance; start/restart requires an
installed registration. Stopping does not itself remove boot startup. Windows
stop/restart may terminate the task directly; do not treat it as native rollback.

### Platform availability and checking state

| Command group | Linux | macOS | Windows |
|---|---|---|---|
| Help/version/template output | Available | Available | Available |
| `config check` | Protected POSIX reader | Protected POSIX reader | Rejected: `config_platform_unsupported` |
| `config check-runtime`, real role startup | Current deployment guide covers Linux x64 | Runtime loader rejects this platform | Runtime loader rejects this platform |
| Service actions | Unavailable in current product CLI | Unavailable; runtime also unsupported | Unavailable; runtime/configuration and installation ACL support also incomplete |
| `update --check` | x64/arm64, proven glibc required | x64/arm64 metadata check | x64/arm64 metadata check |

There is no working Rovloom service-status query in this preview.
Use the foreground process and the management/MCP checks in the Quick Start to
check current runtime readiness. A running process alone does not prove MCP or
Agent readiness; an HTTP client disconnect does not stop Gateway.

### Update commands

| Command | Arguments / options | Effect and current limitation | Valid example |
|---|---|---|---|
| `rovloom update --help` | No extra arguments | Offline update help. | `rovloom update --help` |
| `rovloom update --check` | `--check`: optional boolean switch selecting check-only mode; no value | Reads official stable release metadata over the network; does not replace the program. | `rovloom update --check` |
| `rovloom update` | No arguments | Checks first. No newer release means no replacement and exit 0; if a newer release exists, the missing replacement backend causes `replacement_unavailable` (5). | `rovloom update` |

No public release is currently available, so a network check can return
`release_unavailable`. Exit 0 from `update` does not mean a new binary was
installed. No URL, mirror, version selector, download path, script or confirmation
flag is accepted. The release matrix describes update metadata targets, not full
Gateway/Connector runtime support.

### Output and exit codes

Help, version, check diagnostics, service diagnostics and update status go to
**stderr**. Template JSON goes to **stdout**. Stdout is not an MCP transport.
No command accepts Bearers, TLS secrets, model secrets or arbitrary environment
variables as CLI options. Commands such as `init`, `pair`, `status`, `--token`,
`--port`, `--env` and `--agent-bin-dir` are not part of this CLI.

| Exit code | Role/configuration/service meaning | Update meaning |
|---|---|---|
| `0` | Help/template/check success, normal role shutdown; service help succeeds | Check succeeded or no replacement needed; actual replacement is not currently connected. |
| `1` | Runtime/shutdown failure; service operation failure with a connected backend | Unexpected update failure. |
| `2` | Invalid arguments/configuration; with a connected service backend, invalid options or missing verified default config | Invalid arguments/current version or unsupported platform. |
| `3` | Backend unavailable; every current product service action returns this | Network/release/manifest/download verification failure. |
| `4` | Not a role/configuration/service success code | Permission/staging/lock/installation or incomplete-I/O/cleanup condition; not success. |
| `5` | Not used for these commands | Replacement backend unavailable. |
| `6` | Not used for these commands | Update rolled back (replacement module outcome). |
| `7` | Not used for these commands | Recovery required (replacement module outcome). |

The unconnected service backend is checked before its action arguments are
parsed: even a malformed service action currently reports `backend_unavailable`.
Do not interpret that as proof that its options were valid. Keep error codes
when asking for help; do not upload real configuration or secrets.

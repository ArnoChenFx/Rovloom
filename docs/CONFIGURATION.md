# Rovloom configuration reference

**English** · [简体中文](CONFIGURATION-zh.md) · [Quick Start](QUICK-START.md)

Each role has **one user JSON file**: `~/.config/rovloom/gateway.json` or
`~/.config/rovloom/connector.json`. The default file and user file are the same.
Start the role to create its missing file; you do not have to copy a template or
prepare additional configuration files. Existing documents are read strictly
and are never reset. All fields below
are required unless marked optional. Defaults describe the generated document,
not fallback values for missing fields. Examples contain no credentials.

## Complete minimal configurations

Gateway, normally `~/.config/rovloom/gateway.json`:

```json
{
  "schema_version": 1,
  "role": "gateway",
  "data": {"directory": "/home/your-user/.local/share/rovloom/gateway"},
  "mcp": {"hostname": "127.0.0.1", "port": 9444},
  "devices": {"hostname": "127.0.0.1", "port": 9443},
  "management": {"enabled": true, "port": 9445}
}
```

Connector, normally `~/.config/rovloom/connector.json`:

```json
{
  "schema_version": 1,
  "role": "connector",
  "data": {"directory": "/home/your-user/.local/share/rovloom/connector"},
  "gateway": {"url": ""}
}
```

Replace `/home/your-user` with your actual home when saving an example. The
program substitutes the real home on first creation. Gateway can start locally
with these defaults and no identities; Connector's blank address is a valid
saved configuration; a real local terminal prompts for it, while non-TTY startup returns `configuration_required` (2).
Setting an address does not establish pairing or install a native provider.

## Every user parameter

| Field | Type / required | Generated default / effect |
|---|---|---|
| `schema_version` | Integer, required | Exactly `1`. |
| `role` | String, required | `gateway` or `connector`, matching the command. |
| `data` | Object, required | Contains only `directory`. |
| `data.directory` | Normalized absolute path string, ≤4096 characters, required | `<home>/.local/share/rovloom/<role>`; separate private data for each role. |
| Gateway `mcp` | Object, required | Contains `hostname`, `port`; Streamable HTTP `/mcp`. |
| `mcp.hostname` | String, required | `127.0.0.1`; also accepts `::1`. Loopback only. |
| `mcp.port` | Integer 1–65535, required | `9444`. |
| Gateway `devices` | Object, required | Contains `hostname`, `port`; WS `/connector`. |
| `devices.hostname` | String, required | `127.0.0.1`; also `::1`, `0.0.0.0`, `::`. Defaults do not accept remote devices. |
| `devices.port` | Integer 1–65535, required | `9443`. |
| Gateway `management` | Object, required | Contains `enabled`, `port`; local HTTP management page. |
| `management.enabled` | Boolean, required | `true`; `false` disables this listener. Enabling it grants no administrator identity. |
| `management.port` | Integer 1–65535, required even when disabled | `9445`; listener hostname is fixed to `127.0.0.1`. |
| Connector `gateway` | Object, required | Contains only `url`. |
| `gateway.url` | String, required | `""` while setup is pending; otherwise WS/WSS origin, ≤2048 characters, e.g. `ws://192.0.2.10:9443` or `wss://gateway.example`. No credentials/query/fragment/path except optional trailing `/`. Product selects `/connector`. |
| Connector `native` | Object, optional | Absent by default. Contains only the two installation-directory settings below; applied at first Luvus initialization. |
| `native.runtime_bin_dir` | Normalized absolute directory string, ≤4096 characters, optional | Unset: search `/usr/bin:/bin` for `luvus`. When set, search this directory first, then those fixed system directories. No PATH lists, shell expansion or executable argv. |
| `native.agent_bin_dir` | Normalized absolute directory string, ≤4096 characters, optional | Unset: native/Agent PATH is `/usr/bin:/bin`. When set, prepend this one directory to that fixed PATH. It does not install or authenticate an Agent. |

Enabled Gateway listeners must use different ports. Unknown fields, old flat
fields, runtime/ref selectors, TLS/CA paths, schema hashes, binary pins and
credential values are rejected. There are no user parameters for native roots,
ledgers, bindings or identity digests. After native initialization, changing its
installation settings is rejected; this preview has no guided native reconfiguration.
Changing an initialized Connector's Gateway URL is also rejected before its saved
device credential can be sent to another origin.

Paths are absolute and normalized, not relative to the JSON location. JSON does
not expand `~` or environment variables. The default role path always uses the
process user's home, including on Windows; it does not use AppData or an XDG
override. `--config` takes an absolute file path and overrides only that file's
location. Generated data still defaults to the role user's home. Existing explicit
files do not need home resolution. Missing files need home to generate defaults.

First-file creation and protected role-file checks support Linux/macOS;
Windows returns `config_platform_unsupported`. Gateway startup supports
Linux/macOS, while first-pairing approval and the native Connector still require
Linux. See [platform availability](#platform-availability-and-checking-state).
Templates have platform-appropriate path separators. Keep files private `0600`
and their immediate directory private `0700`, owned by the process user. Newly
created directories/files use those modes; existing permissions and malformed
files are never automatically repaired. User JSON is limited to 16 KiB. JSON has
no comments; malformed encoding and duplicate keys are rejected.

## Program-managed data and authentication

The user edits only the role file. `data.directory` selects where Rovloom keeps
its databases, device credentials and native state. Its default is
`~/.local/share/rovloom/gateway` or `~/.local/share/rovloom/connector`; the loader
internally calls this value `state_dir`. Rovloom prepares its own data during
startup and approved setup. Do not prepare `runtime.json`, a `refs/` directory,
provider JSON or credential files; these are not additional user configuration.
The old `runtime.json`/`refs/` format is not loaded or migrated.

Preserve the data directory as a whole, including companion database files.
Do not edit its internal records or delete them to retry an uncertain setup.
Guided recovery and first Herdr/mixed setup are not yet available. For first
Luvus setup, `data.directory` plus `/n` must fit within 52 UTF-8 bytes; select a
shorter directory before pairing if necessary.

A Gateway with no caller state runs in a **pairing required** state. MCP returns
401 and the management page does not create an administrator session. Existing
MCP access still comes from a caller's already issued Bearer for the exact
`http://<MCP-host>:<port>/mcp` resource. First native approval creates one local
caller for the exact reviewed Target; its Bearer is displayed only to the verified
local terminal and retained privately by Rovloom. Copy it into
the MCP client's secret storage. It expires after 30 days; this preview has no
renewal wizard. Device
credentials, MCP Bearers and independent management proofs are distinct. Existing
management authentication still uses its independent principal/proof; an MCP
Bearer cannot log in as administrator; first setup creates no management cookie
or default administrator.

Connector needs both a reachable Gateway address and completed pairing/native
state. In a genuine local TTY, Gateway approval issues a five-minute one-time code;
Connector asks for the address/code without echoing the code, exchanges the existing
enrollment, saves its device credential privately, then acknowledges
that exact durable delivery. Only a separate owner approval of the measured native
installation permits provider/caller configuration. Non-TTY startup never waits
for input or creates these permissions. Native initialization does not log in to a
model provider, create an Agent or prove a model reply.
Missing provider state is setup-required; corrupt or unsafe state is rejected.
`config check-runtime` checks the existing managed provider registry, not caller
credentials, TLS trust, native binaries or a model connection.

## Network access

Gateway uses ordinary HTTP/WS for local/trusted-network access. Public TLS belongs
to an external standard HTTPS/WSS reverse proxy. Connector WSS always uses system
certificate validation. There is no custom CA or skip-verification option.

## Native installation and pins

Install native programs through their official [latest Luvus](https://github.com/RizRiyz/luvus/releases/latest)
or [latest Herdr](https://github.com/herdrdev/herdr/releases/latest) distribution. Compatibility
uses the installed protocol, complete request/response schema and actual method
capabilities. Version labels are diagnostic; no fixed native release or preset
binary/schema digest is required. Missing or incompatible optional interfaces
only make their dependent operations unavailable.

| Integration basis | Luvus | Herdr |
|---|---|---|
| Schema command | `luvus uhp schema` | `herdr api schema --json` |
| Protocol basis | UHP v1 envelope and actual live method catalog | Actual schema protocol and complete JSON RPC roots |
| Adapter revision | `managed-owned-luvus-0.14.3-1` | `herdr-workflow-4` |
| Classification revision | `managed-owned-rpc-1` | `herdr-0.9.5-workflow-4` |

Revision strings identify Rovloom adapter/classification code; their historical
version text is not a native installation requirement. Protected program-managed
state and each live source must still agree on the actual binary/schema hashes,
complete target and generation. Preserve schema output as original bytes.
A known precompiled digest is a cache key; unknown schema bytes are fully compiled
within the same compiler budget. These are integration checks, not user JSON fields.
Internal discovery does not complete the user-facing provider setup or install
native programs; first-file generation does not prepare native settings or model access.

## Agent installation directory

Install the official Agent, such as OpenCode, in a directory controlled by the
machine owner. Existing native integration runs with `/usr/bin:/bin`, not the
login shell's PATH. An owner-selected `agent_bin_dir` can prepend one normalized
absolute directory; it is a native installation setting, not an executable path,
PATH list, MCP argument or `--agent-bin-dir` flag. Set it before first native
initialization in the single Connector user file:

```json
{
  "native": {
    "runtime_bin_dir": "/home/your-user/.local/bin",
    "agent_bin_dir": "/home/your-user/.local/bin"
  }
}
```

This is an optional fragment of the complete Connector document. Keep the selected
installation directories under the owner's control. Do not edit a managed root
record or its digest to change an initialized installation.

Configure Agent/model access in the runtime's private HOME/XDG locations;
for first Luvus setup its HOME is `<data.directory>/h`. A login in your usual home
is not copied. This preview has no guided model-login procedure for that isolated
environment, so fresh model setup still needs the machine owner's preparation.
Ordinary strict text conversation can keep local `allow_terminal_execution:false`.
Do not use arbitrary argv/env or terminal input to work around missing PATH.
The terminal switch does not sandbox an Agent's own tools. Binary/schema validation
or `ready` alone is not evidence that a model replied.

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
| `rovloom config check [--role ROLE] [--config ABS]` | `--role`: optional `gateway`/`connector`; `--config`: optional absolute path string | No options: read both default user files and report each role. Role selects one; an explicit file overrides its path. Read-only, never creates missing files. | `rovloom config check` |
| `rovloom config check-runtime [--role ROLE] [--config ABS]` | Same optional role and path options as `check` | Same default selection; additionally checks existing program-managed provider state. No creation, credential loading or Agent-readiness claim. | `rovloom config check-runtime --role connector` |

For either check, `--role` and `--config` may appear in either order. An explicit
file without a role uses the role declared in that file; with a role, a mismatch
is an error. Checking both continues after a role error, reports both results,
and returns nonzero if either fails. Neither check creates a missing file.

### Run a role

| Command | Arguments / options | Default / effect | Valid example |
|---|---|---|---|
| `rovloom gateway [--config ABS]` | `--config`: optional path string | Defaults to the current user's `~/.config/rovloom/gateway.json`; starts the foreground Gateway. | `rovloom gateway --config /home/rovloom/.config/rovloom/gateway.json` |
| `rovloom connector [--config ABS]` | `--config`: optional path string | Defaults to the current user's `~/.config/rovloom/connector.json`; starts the foreground Connector. | `rovloom connector --config /home/rovloom/.config/rovloom/connector.json` |

Explicit paths take priority; there is no fallback from an invalid explicit path.
The selected file must have the matching role. A missing file is generated on
Linux/macOS at the selected path; an existing file is never overwritten. Defaults are
resolved for the process user. Stop a foreground
role with Ctrl-C; there is no separate top-level `start`, `stop` or `restart`.
Network ports are JSON fields, not flags. Provider initialization is limited to
the first local-terminal Luvus flow described above; Agent/model login is separate.

### Service command syntax and current availability

`rovloom service --help` is available offline. The product entry connects Gateway to Linux systemd and macOS system LaunchDaemons. Installation requires the current standalone Rovloom
binary, normal system-service authorization, an existing non-root account and an
existing working directory. Existing JSON/role errors are checked; missing config
is left for normal first startup. No UID/mode/ACL or ancestor proof is required,
and existing permissions are not changed. Windows awaits ordinary role-file/startup wiring. Native definition
parsing does not establish actual lifecycle acceptance.
See [service prerequisites and platform limits](SERVICE.md).

| Command form | Required arguments | Meaning of the action | Linux syntax example |
|---|---|---|---|
| `rovloom service install` | `--role`, `--workdir`, `--user`; optional `--executable`, `--config` | Add/enable startup at boot; **does not start now**. | `rovloom service install --role gateway --executable /opt/rovloom/rovloom --config /home/rovloom/.config/rovloom/gateway.json --workdir /home/rovloom --user rovloom` |
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
| `--executable` | Install-only, optional absolute path string, at most 4096 characters; defaults to the current standalone binary | Must equal the current canonical executable. Another installation, shell or interpreter is rejected. Windows path must end in `.exe`. |
| `--config` | Install-only, optional absolute path string, at most 4096 characters | Uses the same current-user role file as foreground startup when omitted. Installation fixes this absolute path; background startup does not select another home. Pass the original user's absolute file explicitly when invoking through sudo. |
| `--workdir` | Install-only, required absolute directory string, at most 4096 characters; no default | Working directory of the service; does not set or replace JSON `data.directory`. |
| `--user` | Install-only, required account string; no default | Existing non-root account on Linux/macOS. Windows accepts only LocalService SID `S-1-5-19`, without a password. |

Service path values are fixed at install time; later boot/start/restart uses the
recorded absolute role configuration, rather than resolving a new home. The installer
checks normal product, account, working-directory and existing JSON/role inputs;
it does not impose ownership/permission or ACL rules. Missing state/config files
are handled by normal role startup. The runtime account does not select a second
configuration directory. Linux working directories cannot end in whitespace or a backslash.

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
| Missing role-file creation | Available | Available | Rejected: `config_platform_unsupported` |
| Gateway startup / `config check-runtime` | Available | Gateway private-file layer available | Runtime loader rejects this platform |
| First-pairing approval | Local terminal required | Not yet available | Not available |
| Native Connector | This guide covers Linux x64 | Not supported | Not supported |
| Service actions | Production systemd backend connected; native Connector on x64 | Gateway system LaunchDaemon; local Connector rejected | Product rejects before system access; ordinary role-file/startup wiring incomplete |
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
| `0` | Help/template/check success, normal role shutdown; successful/idempotent service operation | Check succeeded or no replacement needed; actual replacement is not currently connected. |
| `1` | Runtime/shutdown failure; service operation failure with a connected backend | Unexpected update failure. |
| `2` | Invalid arguments/configuration; with a connected service backend, invalid options or missing verified default config | Invalid arguments/current version or unsupported platform. |
| `3` | Backend/runtime unavailable or unsupported service platform | Network/release/manifest/download verification failure. |
| `4` | Not a role/configuration/service success code | Permission/staging/lock/installation or incomplete-I/O/cleanup condition; not success. |
| `5` | Not used for these commands | Replacement backend unavailable. |
| `6` | Not used for these commands | Update rolled back (replacement module outcome). |
| `7` | Not used for these commands | Recovery required (replacement module outcome). |

The product parses service options before authorization. Invalid options return
`invalid_arguments` (2); insufficient Linux privilege returns `permission_denied`
(1), without invoking sudo. Successful service diagnostics are fixed JSON on
stderr with separate `bootEnabled`, `controlRetained` and `readiness: "not_checked"`.
Keep error codes when asking for help; do not upload real configuration or secrets.

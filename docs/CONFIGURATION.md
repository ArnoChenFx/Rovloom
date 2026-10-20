# Rovloom configuration reference

**English** · [简体中文](CONFIGURATION-zh.md) · [Quick Start](QUICK-START.md)

Each role has one user JSON document at its default path; there is no separate
defaults file and user file. Startup generates it only when missing;
existing documents are parsed strictly and are never reset. All fields below
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
saved configuration but startup returns `configuration_required` (2).
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

Enabled Gateway listeners must use different ports. Unknown fields, old flat
fields, runtime/ref selectors, TLS/CA paths, schema hashes, binary pins and
credential values are rejected. There are no user parameters for native roots,
ledgers, bindings or identity digests. This slice has no native-discovery or
Agent-directory knob whose effect is only promised for later setup.

Paths are absolute and normalized, not relative to the JSON location. JSON does
not expand `~` or environment variables. The default role path always uses the
process user's home, including on Windows; it does not use AppData or an XDG
override. `--config` takes an absolute file path and overrides only that file's
location. Generated data still defaults to the role user's home. Existing explicit
files do not need home resolution. Missing files need home to generate defaults.

First-file creation and runtime currently require Linux. Protected role-file
checks support POSIX and reject Windows with `config_platform_unsupported`.
Templates have platform-appropriate path separators. Keep files private `0600`
and their immediate directory private `0700`, owned by the process user. Newly
created directories/files use those modes; existing permissions and malformed
files are never automatically repaired. User JSON is limited to 16 KiB. JSON has
no comments; malformed encoding and duplicate keys are rejected.

## Program-managed data and authentication

The user edits only the role file. On Gateway startup the program creates missing
private data/control directories and opens its actual databases. A possible
layout is shown for identification, not as a list of files to prepare:

```text
<Gateway data.directory>/
  gateway.db          devices, providers, calls and results
  identity.db         device identity state
  managed/            private program-managed provider/caller/management state
<Connector data.directory>/
  managed/            private paired credential and provider state, when provisioned
```

Databases may have WAL/lock/control companions. Preserve the directory as a whole;
do not edit records, fabricate credentials or reconstruct missing ledgers. Native
runtime-owned state and installation directories are not user configuration.
Automatic preparation of that native state is still missing from the user flow.
Old `runtime.json` and `refs/` are not loaded; there is no legacy-format migration
in this unreleased preview. No self-managed certificate/CA paths remain.

A Gateway with no caller state runs in a **pairing required** state. MCP returns
401 and the management page does not create an administrator session. Existing
MCP access still comes from a caller's already issued Bearer for the exact
`http://<MCP-host>:<port>/mcp` resource; store the original only in the MCP client's
secret storage. Gateway holds its digest/expiry in private managed state. Device
credentials, MCP Bearers and independent management proofs are distinct. Existing
management authentication still uses its independent principal/proof; an MCP
Bearer cannot log in as administrator. No CLI currently issues those credentials.

Connector needs both a reachable Gateway address and completed pairing/native
state. The interactive address/code flow and automatic native setup are not yet
connected, so a fresh user cannot finish deployment from these files alone.
Missing provider state is setup-required; corrupt or unsafe state is rejected.
`config check-runtime` checks the existing managed provider registry, not caller
credentials, TLS trust, native binaries or a model connection.

Gateway uses ordinary HTTP/WS for local/trusted-network access. Public TLS belongs
to an external standard HTTPS/WSS reverse proxy. Connector WSS always uses system
certificate validation. There is no custom CA or skip-verification option.

## Native installation and pins

Install native programs through their official distribution and verify the exact
bytes. A matching version label alone is insufficient; there is no user pin override. Use the official [Luvus](https://github.com/RizRiyz/luvus) or
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

These are current integration checks, not fields to copy into user configuration.
Automatic discovery/installation and version compatibility updates are separate
work; they are not implied by first-file generation.

## Agent installation directory

Install the official Agent, such as OpenCode, in a directory controlled by the
machine owner. Existing native integration runs with `/usr/bin:/bin`, not the
login shell's PATH. An owner-selected `agent_bin_dir` can prepend one normalized
absolute directory; it is a native installation setting, not an executable path,
PATH list, MCP argument or `--agent-bin-dir` flag. The new single-file user setup
does not yet create that native installation setting, so adding it to the role
JSON is rejected. Do not edit a managed root record or its digest to force it in.

Configure Agent/model access in the runtime's private HOME/XDG locations.
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
Linux at the selected path; an existing file is never overwritten. Defaults are
resolved for the process user. Stop a foreground
role with Ctrl-C; there is no separate top-level `start`, `stop` or `restart`.
Network ports are JSON fields, not flags. Provider/Agent initialization is not yet
available as a user setup flow.

### Service command syntax and current availability

`rovloom service --help` is available offline. The product entry connects the
Linux systemd backend. Installation requires the current standalone Rovloom
binary, root authorization, an existing non-root service account and prepared
protected configuration, data and working directories. The backend does not
provision these resources or change permissions. macOS/Windows product service
actions still return `backend_unavailable` (3): their protected role runtime is
not supported. Native definition parsing does not establish lifecycle acceptance.
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
| `--config` | Install-only, optional absolute path string, at most 4096 characters | Explicit role configuration. If omitted, uses the selected `--user` account's verified home and the shared `~/.config/rovloom/gateway.json` or `connector.json` rule; an unavailable verified identity requires an explicit path (`config_path_required`). Do not infer a pre-elevation home from environment variables. |
| `--workdir` | Install-only, required absolute directory string, at most 4096 characters; no default | Working directory of the service; does not set or replace JSON `data.directory`. |
| `--user` | Install-only, required account string; no default | Existing non-root account on Linux/macOS. Windows accepts only LocalService SID `S-1-5-19`, without a password. |

Service path values are fixed at install time; later boot/start/restart uses the
recorded absolute role configuration, rather than resolving a new home. POSIX
installation requires a root-owned protected executable and configuration/work
directories belonging to the chosen non-root account; it does not create accounts
or relax permissions. Windows requires its own protected installation and
LocalService access. The Linux host reads the target account from the system passwd database, then runs the same binary's read-only `config check-runtime --role ROLE --config ABS` under that account via `/usr/sbin/runuser`. It does not start a role during installation. Configured Connector requires a nonempty Gateway URL; registration does not prove native readiness. The chosen data directory must already be private and account-owned. Linux working directories cannot end in whitespace or a backslash.

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
| Service actions | Production systemd backend connected; Gateway on Linux, Connector native owner on x64; lifecycle/boot acceptance still required | Product rejects before system access; runtime unsupported | Product rejects before system access; runtime/configuration and installation ACL support incomplete |
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

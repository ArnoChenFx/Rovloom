// 管理来源测试只生成自有短期身份记录、摘要和目录；不注册账号、不配对设备或调用原生程序。
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configDocument, configTemplate, type GatewayConfig } from '../../src/cli/config.js'

export const managementProof = 'SYNTHETIC_MANAGEMENT_PROOF_'.padEnd(64, 'm')
export const mcpProof = 'SYNTHETIC_MCP_PROOF_'.padEnd(64, 'c')

/** 本机内核分配测试端口；不读取或探测用户listener。 */
async function port(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address !== 'object') {
    throw new Error('fixture_port_unavailable')
  }
  const value = address.port
  server.close()
  await once(server, 'close')
  return value
}

/** 所有JSON均为明确合成的既有记录；上游证明原值只存在于本测试内存。 */
export async function managementSourceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rovloom-management-source-'))
  const state = join(root, 'gateway')
  const refs = join(state, 'managed')
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(refs, { mode: 0o700 })
  const ports = new Set<number>()
  while (ports.size < 3) {
    ports.add(await port())
  }
  const [mcpPort, devicePort, managementPort] = [...ports] as [number, number, number]
  const config = {
    ...configTemplate('gateway'),
    state_dir: state,
    mcp_port: mcpPort,
    device_port: devicePort,
    management_port: managementPort
  } as GatewayConfig
  const configPath = join(root, 'gateway.json')
  const sourcePath = join(refs, 'management.json')
  const callerPath = join(refs, config.authentication_ref + '.json')
  const clock = { now: Date.now() }
  const target = {
    machine_id: 'fixture_machine',
    provider_id: 'fixture_provider',
    profile: 'session',
    session: 'fixture'
  }
  const policy = { revision: 'fixture_policy', grants: [{ target, methods: ['ping'], actions: ['read'] }] }
  const lease = {
    caller: { principal_id: 'fixture_admin' },
    management_session_ref: 'fixture_existing_session',
    issued_at: clock.now - 1000,
    expires_at: clock.now + 600_000
  }
  const admin = {
    principal_id: lease.caller.principal_id,
    session_ref: lease.management_session_ref,
    assurance: 'administrator',
    policy_revision: 'fixture_admin_policy',
    grants: [
      { action: 'gateway_read' },
      { action: 'devices_read', machine_id: target.machine_id },
      { action: 'devices_rename', machine_id: target.machine_id },
      { action: 'devices_revoke', machine_id: target.machine_id },
      { action: 'permissions_read', machine_id: target.machine_id }
    ]
  }
  const source = {
    schema_version: 1,
    kind: 'management-session-source',
    port: managementPort,
    sessions: [
      { credential_sha256: createHash('sha256').update(managementProof).digest('hex'), lease, administrator: admin }
    ],
    pairing_policy_refs: []
  }
  const callers = {
    schema_version: 1,
    kind: 'mcp-caller-source',
    resource: `http://127.0.0.1:${mcpPort}/mcp`,
    local_policy: policy,
    callers: [
      {
        principal: { id: lease.caller.principal_id, policy },
        token_sha256: createHash('sha256').update(mcpProof).digest('hex'),
        issued_at: lease.issued_at,
        expires_at: lease.expires_at
      }
    ]
  }
  const save = /** 只覆写本例自有JSON，权限恢复必须显式操作，不能作为生产自动修复。 */ (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  save(configPath, configDocument(config))
  save(callerPath, callers)
  save(sourcePath, source)
  return {
    root,
    state,
    refs,
    config,
    configPath,
    sourcePath,
    callerPath,
    clock,
    target,
    lease,
    admin,
    source,
    callers,
    origin: `http://127.0.0.1:${managementPort}`,
    assets: new Map([['/', new TextEncoder().encode('<html><head></head><body>explicit asset fixture</body></html>')]]),
    save,
    request: /** 固定实际Origin和Host；Basic值只在测试内存，不能作为URL或CLI参数。 */ (
      authorization = 'Basic ' + Buffer.from(lease.caller.principal_id + ':' + managementProof).toString('base64'),
      init: RequestInit = {}
    ) =>
      new Request(`http://127.0.0.1:${managementPort}/`, {
        ...init,
        headers: { host: `127.0.0.1:${managementPort}`, authorization, ...init.headers }
      }),
    close: /** 清理本例独占目录，不访问其他配置、会话或原生root。 */ () =>
      rmSync(root, { recursive: true, force: true })
  }
}

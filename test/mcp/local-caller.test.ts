// 用真实SDK贯通受保护本机caller、CLI宿主和隔离Store，并验证文件撤销即时拒绝；不声称native/transport闭环。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { configTemplate } from '../../src/cli/config.js'
import { storeFixture } from './store-fixture.js'
import { sdkTestSession } from './sdk-test-session.js'

test(
  '真实SDK经CLI与本机私有caller文件读取实际Store，撤销绑定后拒绝且EOF释放writer',
  /* 子进程实际打开同一隔离数据库，身份来源仍明确为合成政策，未启动native或Connector。 */ async (t) => {
    const f = storeFixture()
    f.store.close()
    const config = join(f.directory, 'gateway.json')
    const binding = join(f.directory, 'callers.json')
    writeFileSync(config, JSON.stringify({ ...configTemplate('gateway'), state_dir: f.directory }), { mode: 0o600 })
    const os = userInfo()
    const row = { ref: 'local-stdio', uid: os.uid, gid: os.gid, principal_id: 'alice' }
    // 仅写入非秘密身份映射，不创建凭据、设备或管理员权限。
    const update = /* 测试拥有该私有文件，可明确更新和撤销绑定；服务必须逐请求重读。 */ (rows: unknown[]) =>
      writeFileSync(binding, JSON.stringify({ schema_version: 1, bindings: rows }), { mode: 0o600 })
    update([row])
    const session = sdkTestSession(t, {
      command: process.execPath,
      args: ['--no-env-file', fileURLToPath(new URL('./local-caller-server.ts', import.meta.url)), config, binding],
      env: { PATH: process.env.PATH ?? '' },
      stderr: 'pipe'
    })
    t.after(/* SDK先停止并排空所有等待，再删除仅属于本例的数据库与私有目录。 */ () => f.close())
    let stderr = ''
    session.transport.stderr?.on(
      'data',
      /* 只断言诊断没有私有路径或合成原文，不读取用户日志。 */ (chunk) => {
        stderr += chunk
      }
    )
    await session.run(
      /* 请求和关闭后断言均处于受管工作流，超时后不会向后续用例抛晚到异常。 */ async (client, _transport, signal) => {
        assert(existsSync(join(f.directory, 'gateway.db.lock')))
        const devices = await client.callTool({ name: 'machines_list', arguments: {} }, CallToolResultSchema, {
          signal,
          timeout: 5000
        })
        assert.equal(devices.isError, undefined)
        const data = devices.structuredContent as { data: { items: { machine_id: string }[] } }
        assert.deepEqual(
          data.data.items.map(/* 比较真实Store按合成授权投影的设备集合。 */ (item) => item.machine_id),
          ['machine_a', 'machine_b']
        )
        update([])
        const rejected = await client.callTool({ name: 'machines_list', arguments: {} }, CallToolResultSchema, {
          signal,
          timeout: 5000
        })
        assert.equal(rejected.isError, true)
        assert.deepEqual(rejected.structuredContent, { gateway_error: { code: 'unauthenticated' } })
        update([row])
        const restored = await client.callTool(
          { name: 'providers_get', arguments: { machine_id: 'machine_a', provider_id: 'luvus_a' } },
          CallToolResultSchema,
          { signal, timeout: 5000 }
        )
        assert.equal(restored.isError, undefined)
        assert.equal((restored.structuredContent as { data: { readiness: string } }).data.readiness, 'unverified')
        await session.close()
        const released = !existsSync(join(f.directory, 'gateway.db.lock'))
        assert(released)
        assert(!stderr.includes(f.directory))
        assert(!stderr.includes('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      }
    )
  }
)

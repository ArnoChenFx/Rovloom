// 写客户端的纯浏览器边界测试；不创建listener、身份库、凭据或视觉布局。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createManagementWriteClient } from '../../src/webui/write-client.js'
import { ManagementClientError, checkDeviceIntent } from '../../src/webui/write-contract.js'
import { createDeviceManagementFlow } from '../../src/webui/write-flow.js'
import { sessionFlowFixture, gate } from '../admin/session-flow-helpers.js'

const csrf = 'SYNTHETIC_CLIENT_CSRF_' + 'e'.repeat(32)
/** 返回固定合法无秘密history，供HTTP客户端独立验证请求保护。 */
function reply() {
  return new Response(
    JSON.stringify({
      history_epoch: 'history_fixture',
      recovery_generation: 'generation_fixture',
      accept_new_until: 10000
    }),
    { headers: { 'content-type': 'application/json' } }
  )
}
/** 只匹配公开固定问题，不依赖底层异常正文。 */
function code(problem: string) {
  return /** 断言只接收客户端自己的固定错误类型。 */ (error: unknown) =>
    error instanceof ManagementClientError && error.problem === problem
}

test(
  '固定同源POST、仅内存CSRF、额外身份字段及getter在fetch前拒绝',
  /** 客户端不接受caller/session/approved等自报授权材料。 */ async () => {
    const calls: { path: string; init: RequestInit }[] = []
    const client = createManagementWriteClient({
      /** 模拟既有受保护bootstrap的内存端口。 */ csrf: async () => csrf,
      /** 检查真正交给fetch的固定请求。 */ fetcher: async (path, init) => {
        calls.push({ path, init })
        return reply()
      }
    })
    try {
      assert.equal(
        (await client.execute('history_open', {}, new AbortController().signal)).history_epoch,
        'history_fixture'
      )
      const call = calls[0]!
      assert.equal(call.path, '/admin/v1/actions/history_open')
      assert.equal(call.init.method, 'POST')
      assert.equal(call.init.credentials, 'same-origin')
      assert.equal(call.init.redirect, 'error')
      assert.equal(call.init.cache, 'no-store')
      assert.equal(new Headers(call.init.headers).get('x-rovloom-csrf'), csrf)
      assert.equal(new Headers(call.init.headers).get('authorization'), null)
      assert.equal(call.init.body, '{}')
      await assert.rejects(
        client.execute('history_open', { caller: 'admin', approved: true } as never, new AbortController().signal),
        code('invalid_request')
      )
      await assert.rejects(
        client.execute('providers_enable' as never, {} as never, new AbortController().signal),
        code('invalid_request')
      )
      let read = false
      const malicious = {
        machine_id: 'machine',
        /** 该getter不应被任何验证或快照执行。 */
        get action() {
          read = true
          return 'device_revoke'
        }
      }
      assert.throws(/** 不执行getter来决定管理动作类型。 */ () => checkDeviceIntent(malicious), /invalid_request/)
      assert.equal(read, false)
      assert.equal(calls.length, 1)
    } finally {
      client.close()
    }
  }
)

test(
  '错误正文、超大/坏UTF8/额外secret回复不进入错误或状态',
  /** 即使响应来源故障也只给固定分类，不向页面保留原文。 */ async () => {
    const responses = [
      new Response('SYNTHETIC_PRIVATE_ERROR', { status: 503 }),
      new Response('x'.repeat(32769), { headers: { 'content-type': 'application/json' } }),
      new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } }),
      new Response(
        JSON.stringify({
          history_epoch: 'history_fixture',
          recovery_generation: 'generation_fixture',
          accept_new_until: 10000,
          credential: 'SYNTHETIC_PRIVATE_ERROR'
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    ]
    for (const response of responses) {
      const client = createManagementWriteClient({
        /** 固定合成CSRF只在本测试内使用。 */ csrf: async () => csrf,
        /** 返回受控损坏响应，不产生任何服务动作。 */ fetcher: async () => response
      })
      try {
        await assert.rejects(
          client.execute('history_open', {}, new AbortController().signal),
          /** 所有失败都已发送但不证明后端状态，不包含私密正文。 */ (error: unknown) =>
            error instanceof ManagementClientError &&
            error.request_started &&
            !String(error).includes('SYNTHETIC_PRIVATE_ERROR')
        )
      } finally {
        client.close()
      }
    }
  }
)

test(
  'CSRF等待取消不发送，忽略abort的八个任务仍占额度；关闭后不再请求',
  /** 不以取消返回为由释放仍未收尾的底层任务，避免无界排队。 */ async () => {
    const release = gate()
    let sends = 0
    const client = createManagementWriteClient({
      timeout_ms: 10,
      /** 故意忽略取消的测试bootstrap，模拟不合作宿主。 */ csrf: async () => {
        await release.promise
        return csrf
      },
      /** 取消后不应进入实际网络发送。 */ fetcher: async () => {
        sends++
        return reply()
      }
    })
    try {
      const tasks = Array.from(
        { length: 8 },
        /** 同时占用八个尚未完成的底层工作。 */ () => client.execute('history_open', {}, new AbortController().signal)
      )
      const results = await Promise.allSettled(tasks)
      assert(
        results.every(
          /** 八个等待都因自己的短期测试deadline结束。 */ (item) =>
            item.status === 'rejected' && item.reason instanceof ManagementClientError && !item.reason.request_started
        )
      )
      await assert.rejects(client.execute('history_open', {}, new AbortController().signal), code('busy'))
      assert.equal(sends, 0)
      client.close()
      await assert.rejects(client.execute('history_open', {}, new AbortController().signal), code('aborted'))
    } finally {
      release.resolve()
      client.close()
    }
  }
)

test(
  'CSRF异步等待期间修改原参数不能换目标，server回执仍匹配最初快照',
  /** 请求在外部回调之前已验证并快照，不使用最近一次可变对象。 */ async () => {
    const release = gate()
    const entered = gate()
    let sent: string | undefined
    const client = createManagementWriteClient({
      /** 等待期间让测试修改外部参数对象。 */ csrf: async () => {
        entered.resolve()
        await release.promise
        return csrf
      },
      /** 只接受最初目标，返回对应真实协议形状。 */ fetcher: async (_path, init) => {
        sent = String(init.body)
        return new Response(
          JSON.stringify({
            target: { machine_id: 'machine_original' },
            resource_revision: 1,
            recovery_generation: 'generation_fixture',
            connection_epoch: null,
            binding_revision: null
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      }
    })
    try {
      const args = { machine_id: 'machine_original' }
      const result = client.execute('write_state_get', args, new AbortController().signal)
      await entered.promise
      args.machine_id = 'machine_other'
      release.resolve()
      assert.equal((await result).target.machine_id, 'machine_original')
      assert.equal(sent, '{"machine_id":"machine_original"}')
    } finally {
      release.resolve()
      client.close()
    }
  }
)

test(
  '用户在确认页取消、会话撤销或备份回执不会变成当前成功',
  /** 验证有限状态的真实交互边界，未使用DOM或视觉变更。 */ async () => {
    const f = sessionFlowFixture()
    const cancelled = createDeviceManagementFlow({ transport: f.client })
    try {
      await cancelled.prepare({ action: 'device_revoke', machine_id: f.device.machine_id })
      cancelled.cancel()
      assert.equal(cancelled.state().phase, 'cancelled')
      await assert.rejects(cancelled.confirm(), code('invalid_request'))
      assert.equal(f.calls.includes('devices_revoke'), false)
    } finally {
      cancelled.dispose()
      f.close()
    }
    const g = sessionFlowFixture()
    const expired = createDeviceManagementFlow({ transport: g.client })
    try {
      await expired.prepare({ action: 'device_rename', machine_id: g.device.machine_id, name: 'must_not_rename' })
      g.f.admin = null
      const state = await expired.confirm()
      assert(state.phase === 'failed')
      assert.equal(state.problem, 'unauthenticated')
      assert.equal(g.calls.includes('devices_rename'), false)
      assert.equal(g.f.store.machine(g.device.machine_id).name, 'owned_browser_flow')
    } finally {
      expired.dispose()
      g.close()
    }
    const h = sessionFlowFixture()
    const history = createDeviceManagementFlow({ transport: h.client })
    try {
      await history.prepare({ action: 'device_rename', machine_id: h.device.machine_id, name: 'owned_backup_evidence' })
      h.hook = /** 先丢失已提交回复，使客户端只能查原回执。 */ async (path, response) => {
        if (path.endsWith('/devices_rename')) {
          throw new Error('SYNTHETIC_LOST_REPLY')
        }
        return response
      }
      assert.equal((await history.confirm()).phase, 'unconfirmed')
      h.hook = /** 模拟同协议的备份历史证据，不冒充真实恢复库或当前持久证明。 */ async (path, response) => {
        if (!path.endsWith('/operations_get')) {
          return response
        }
        const body = (await response.json()) as Record<string, unknown>
        body.evidence = 'backup_history'
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
      }
      assert.equal((await history.checkReceipt()).phase, 'unconfirmed')
      h.hook = undefined
      assert.equal((await history.checkReceipt()).phase, 'committed')
      assert.equal(h.calls.filter(/** 对账期间不再次提交原设备动作。 */ (name) => name === 'devices_rename').length, 1)
    } finally {
      history.dispose()
      h.close()
    }
  }
)

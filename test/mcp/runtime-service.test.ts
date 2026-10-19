// 真实Store/Router/请求作用域验证MCP投影；runtime派发/原Wire结果端口明确为stub，不替代native SDK回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Router } from '../../src/router.js'
import { GatewayError } from '../../src/contracts.js'
import { createTrustedRequestScope } from '../../src/runtime/request-scope.js'
import { RuntimeGatewayService, type RuntimeGateway, type RuntimeGatewayPort } from '../../src/mcp/runtime-service.js'
import { StoreGatewayService } from '../../src/mcp/store-service.js'
import type { ServiceContext, ToolArguments } from '../../src/mcp/types.js'
import type { ManagementPermission } from '../../src/mcp/management.js'
import { storeFixture, target } from './store-fixture.js'

// 此stub只测试参数/回执投影，原生结果权限仍须由runtime-sdk.test.ts中的实际Wire验证。
function projectionFixture() {
  const f = storeFixture()
  const scope = createTrustedRequestScope(f.identities)
  const router = new Router(f.store, f.localPolicies)
  const calls: Parameters<RuntimeGateway['admit']>[0][] = []
  let cancelled = 0
  let override: Partial<ReturnType<RuntimeGateway['get']>> = {}
  let readFailure: Error | undefined
  let openFailure: (() => Error) | undefined
  const runtime: RuntimeGatewayPort = {
    store: f.store,
    router,
    runAuthenticated: scope.runAuthenticated,
    principal: scope.principal,
    get: /* 返回真实授权元数据；override只用于模拟两次快照间的状态推进。 */ (id: string) => ({
      ...router.get(scope.principal(), id),
      ...override
    }),
    admit: /* 明确的准入stub只记录投影并指向人工历史，不执行或假称真实派发。 */ (
      input: Parameters<RuntimeGateway['admit']>[0]
    ) => {
      calls.push(input)
      return { call: router.get(scope.principal(), 'call_fixture'), created: true }
    },
    cancel: /* 调用实际Router取消授权，再返回本例指定的保守监管状态。 */ (id: string) => {
      cancelled++
      return { ...router.cancel(scope.principal(), id), ...override }
    },
    originalAttempt: /* 本投影stub没有原Wire许可，不从人工历史补造attempt。 */ () => undefined,
    results: {
      open: /* 人工历史的Store句柄仅供分页投影，不代表真实原生读取许可。 */ (id: string) => {
        if (openFailure) {
          throw openFailure()
        }
        return router.saveResult(scope.principal(), id)
      },
      read: /* 记录后的页仍由真实Router/Store检查主体、期限与当前双端ACL。 */ (
        id: string,
        offset = 0,
        bytes = 65_536
      ) => {
        if (readFailure) {
          throw readFailure
        }
        return router.readResult(scope.principal(), id, offset, bytes)
      },
      discard: /* 明确使用实际专门discard权限，不把读权限当删除权限。 */ (id: string) =>
        router.discardResponse(scope.principal(), id)
    }
  }
  const service = new RuntimeGatewayService({ runtime, identities: f.identities, localPolicies: f.localPolicies })
  const context: ServiceContext = { caller: { principal_id: 'alice' }, wait_signal: new AbortController().signal }
  const args: ToolArguments['runtime_call'] = {
    target,
    expected_binding_revision: 1,
    contract_ref: 'a'.repeat(64),
    native_request: { method: 'pane.read', params: { value: 'fixture' } },
    deadline: f.store.clock() + 20_000
  }
  return {
    ...f,
    runtime,
    service,
    context,
    args,
    calls,
    cancelled: /* 观察显式取消调用数，取消前端等待不能增加该计数。 */ () => cancelled,
    override: /* 模拟真实宿主后来观察到的新元数据，不修改Store生产状态机。 */ (value: typeof override) => {
      override = value
    },
    readFailure: /* 注入未知宿主错误，确认固定公共映射不会回显原文。 */ (value: Error) => {
      readFailure = value
    },
    openFailure: /* 模拟正文句柄失败而不改动真实Store准入/状态机。 */ (failure: () => Error) => {
      openFailure = failure
    },
    close: /* 回收门面、作用域及本例真实临时库。 */ () => {
      service.close()
      scope.close()
      f.close()
    }
  }
}

test(
  'runtime投影保持原参数/期限，分页绑定主体与大小并逐页重新验权',
  /* 不把stub成功计作原生调用成功。 */ async () => {
    const f = projectionFixture()
    try {
      const call = (await f.service.execute('runtime_call', f.args, f.context)).data
      assert.deepEqual(f.calls[0], {
        target,
        native_request: f.args.native_request,
        options: {
          binding_revision: 1,
          contract_ref: f.args.contract_ref,
          deadline: f.args.deadline,
          validation: 'strict'
        }
      })
      const result = call.result as { result_id: string; expires_at: number }
      const first = (
        await f.service.execute('runtime_result_read', { result_id: result.result_id, max_bytes: 8 }, f.context)
      ).data
      assert(first.next_cursor)
      assert.equal(first.expires_at, result.expires_at)
      assert.deepEqual(
        (await f.service.execute('runtime_result_read', { result_id: result.result_id, max_bytes: 8 }, f.context)).data,
        first
      )
      await assert.rejects(
        /* 游标不能通过更改页大小重新解释。 */ () =>
          f.service.execute(
            'runtime_result_read',
            {
              result_id: result.result_id,
              cursor: first.next_cursor,
              max_bytes: 16
            },
            f.context
          ),
        { code: 'invalid_cursor' }
      )
      await assert.rejects(
        /* history代次错误必须在准入stub之前拒绝。 */ () =>
          f.service.execute(
            'runtime_call',
            {
              ...f.args,
              history: { history_epoch: 'history', client_request_key: 'same', recovery_generation: 'wrong' }
            },
            f.context
          ),
        { code: 'dedup_history_unavailable' }
      )
      assert.equal(f.calls.length, 1)
      f.setCaller(null)
      await assert.rejects(
        /* 原游标不能保留已撤销身份的读取权限。 */ () =>
          f.service.execute(
            'runtime_result_read',
            {
              result_id: result.result_id,
              cursor: first.next_cursor,
              max_bytes: 8
            },
            f.context
          ),
        { code: 'unauthenticated' }
      )
    } finally {
      f.close()
    }
  }
)

test(
  '最后授权快照统一投影，取消保守报告unknown，关闭和未知错误均不泄露或新准入',
  /* 覆盖组合安全边界。 */ async () => {
    const f = projectionFixture()
    try {
      f.override({ state: 'outcome_unknown', content_status: 'unavailable' })
      const view = (await f.service.execute('runtime_call_get', { call_id: 'call_fixture' }, f.context)).data
      assert.equal(view.state, 'outcome_unknown')
      assert.equal(view.delivery, 'possibly_dispatched')
      assert.equal(view.content_status, 'unavailable')
      assert.equal(view.result, undefined)
      const cancel = (await f.service.execute('runtime_call_cancel', { call_id: 'call_fixture' }, f.context)).data
      assert.equal(cancel.cancellation, 'outcome_unknown')
      assert.equal(f.cancelled(), 1)
      f.readFailure(new GatewayError('SYNTHETIC_SECRET_DO_NOT_PRINT'))
      await assert.rejects(
        /* 未知底层code只能变成固定internal_error。 */ () =>
          f.service.execute(
            'runtime_result_read',
            {
              result_id: 'result_fixture'
            },
            f.context
          ),
        { code: 'internal_error', message: 'Gateway service rejected the request' }
      )
      f.service.close()
      await assert.rejects(
        /* 关闭门面后不能再进入既有runtime.admit。 */ () => f.service.execute('runtime_call', f.args, f.context),
        { code: 'unavailable' }
      )
      assert.equal(f.calls.length, 0)
    } finally {
      f.close()
    }
  }
)

test(
  '正文句柄失败保留当前可读的真实调用元数据，撤权后不能借错误返回ID',
  /* 参数投影已取得call_id时不重复准入；正文失败与调用登记结果分开。 */ async () => {
    const f = projectionFixture()
    try {
      f.openFailure(/* 模拟实际结果子额不足；不假造结果或改写TTL。 */ () => new GatewayError('result_quota'))
      const view = (await f.service.execute('runtime_call', f.args, f.context)).data
      assert.equal(view.call_id, 'call_fixture')
      assert.equal(view.state, 'responded')
      assert.equal(view.content_delivery, 'unavailable')
      assert.equal(view.content_reason_code, 'storage_exhausted')
      assert.equal(view.result, undefined)
      assert.equal(f.calls.length, 1)
      f.openFailure(
        /* 失败期间同步撤权时，重新读取元数据也必须拒绝。 */ () => {
          f.setCaller(null)
          return new GatewayError('result_quota')
        }
      )
      await assert.rejects(
        /* 不把错误路径变成已撤权主体的call_id旁路。 */ () =>
          f.service.execute(
            'runtime_call_get',
            {
              call_id: 'call_fixture'
            },
            f.context
          ),
        { code: 'unauthenticated' }
      )
    } finally {
      f.close()
    }
  }
)

test(
  '管理提示对实际后端能力和当前grant求交，降级保持拒绝且不执行写入证明',
  /* 仅观察能力来源，无确认/签发/启用副作用。 */ async () => {
    for (const mode of ['active', 'storage_degraded'] as const) {
      const f = storeFixture(mode)
      let capabilities: readonly ManagementPermission[] = ['devices_revoke', 'devices_rename', 'providers_manage']
      let observed = 0
      const service = new StoreGatewayService({
        ...f,
        managementCapabilities: /* 只读已装配能力stub，不调用任何写端口。 */ () => {
          observed++
          return capabilities
        }
      })
      const context = {
        caller: { principal_id: 'alice' },
        management_session_ref: 'admin_session',
        wait_signal: new AbortController().signal
      }
      try {
        const first = await service.management.execute('permissions_get', { machine_id: 'machine_a' }, context)
        assert.equal(observed, 1)
        assert.deepEqual(
          first.decisions.find(/* 精确检查原管理员已有的撤销grant。 */ (item) => item.action === 'devices_revoke'),
          {
            action: 'devices_revoke',
            allowed: mode === 'active',
            reason_code: mode === 'active' ? 'allowed' : 'storage_degraded'
          }
        )
        assert.equal(
          first.decisions.find(/* 后端存在不能补造管理员缺少的改名权限。 */ (item) => item.action === 'devices_rename')!
            .reason_code,
          'forbidden'
        )
        capabilities = []
        const unavailable = await service.management.execute('permissions_get', { machine_id: 'machine_a' }, context)
        assert.equal(
          unavailable.decisions.find(
            /* 没有实际能力继续拒绝，不能因grant存在显示可执行。 */ (item) => item.action === 'devices_revoke'
          )!.allowed,
          false
        )
        const revoked = new StoreGatewayService({
          ...f,
          managementCapabilities: /* 模拟只读来源中的同步撤权，不能返回旧grant的允许提示。 */ () => {
            f.setAdmin(null)
            return ['devices_revoke']
          }
        })
        await assert.rejects(
          /* 能力回调后再次验证同一管理会话。 */ () =>
            revoked.management.execute(
              'permissions_get',
              {
                machine_id: 'machine_a'
              },
              context
            ),
          { code: 'unauthenticated' }
        )
      } finally {
        f.close()
      }
    }
  }
)

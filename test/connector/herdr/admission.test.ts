/** 合成 Connector 通过真实认证通道验证错误参数不会破坏同 epoch 的合法调用；不运行 Herdr 或模型。 */
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHerdrGatewayResources } from '../../../src/connector/herdr/provider.js'
import { createProviderGatewayRuntime } from '../../../src/runtime/gateway.js'
import { contractRef, object } from '../../../src/wire/index.js'
import type { JsonObject } from '../../../src/wire/types.js'
import { fixture as transportFixture, rawConnect, until } from '../../transport/helpers.js'
import { responseFrame } from '../../storage/helpers.js'
import { raw, source } from './helpers.js'
import { privateHerdrTestRoot } from './private-root.js'

test(
  'invalid Herdr prompt parameters preserve the same authenticated epoch and another pending call',
  /** 实际 Store、资源工厂、Wire 与 loopback socket 保持生产路径；对端只模拟有界 pong。 */ async () => {
    const root = privateHerdrTestRoot('.herdr-admission-')
    const base = transportFixture()
    const paired = base.pair('owned_herdr_admission')
    base.gateway.stop()
    const target = {
      machine_id: paired.machine_id,
      provider_id: 'herdr',
      profile: 'session' as const,
      session: 'owned'
    }
    const schemaPath = join(root, 'schema.json')
    writeFileSync(schemaPath, raw, { mode: 0o600 })
    const resources = await createHerdrGatewayResources({
      config: {
        version: 1,
        target,
        binding_revision: 1,
        config_ref: 'owned-herdr-admission',
        expected_source: source,
        schema_path: schemaPath,
        peer_policy_revision: 'local1'
      }
    })
    base.store.defineProvider(resources.providers[0]!.binding)
    base.principal.policy.grants.push({ target, methods: ['ping', 'agent.prompt'], actions: ['dispatch', 'read'] })
    const provider = resources.providers[0]!
    const preflightRequests: JsonObject[] = []
    const offer = { major: 2, minor: 0, capabilities: ['rpc', 'history_scope'], required: ['rpc'] }
    const runtime = await createProviderGatewayRuntime({
      lifecycle: { store: base.store, identityHost: base.credentials },
      identities: {
        principal: /** 仅本测试已配对宿主的合成 caller 有效。 */ (caller) =>
          caller.principal_id === base.principal.id ? base.principal : null,
        administrator: /** 本测试没有管理员会话。 */ () => null
      },
      localPolicies: /** 固定当前双方权限，故意错误仅来自原生 prompt 参数。 */ () => ({
        revision: 'local1',
        grants: base.principal.policy.grants
      }),
      providers: [
        {
          ...provider,
          preflightRequest: /** 只观察完整根使用的实际 ID，原工厂验证仍原样执行。 */ (request: JsonObject) => {
            preflightRequests.push(structuredClone(request))
            provider.preflightRequest!(request)
          }
        }
      ],
      session: resources.session,
      listener: { hostname: '127.0.0.1', port: 0, developmentLoopback: true, offer },
      release: /** 运行时只释放本轮资源；Store 最后由 fixture 关闭。 */ () => resources.release()
    })
    const client = rawConnect(runtime.transport.url, paired.credential, offer)
    try {
      await until(/** 等待真实 welcome，不能由测试自行给连接指定 epoch。 */ () => Boolean(client.epoch))
      const epoch = client.epoch
      const good = await runtime.runAuthenticated(
        { principal_id: base.principal.id },
        /** 先派发合法 ping 并保留其原请求等待，制造同 epoch 的并发工作。 */ () =>
          runtime.admit({
            target,
            native_request: { method: 'ping', params: {} },
            options: { binding_revision: 1, contract_ref: contractRef(source), deadline: base.now + 10_000 }
          })
      )
      await until(
        /** 合法请求已经实际到达对端，尚未返回任何合成结果。 */ () =>
          client.frames.some(/** 仅识别本测试原请求帧。 */ (frame) => object(frame).type === 'request')
      )
      const original = base.store.attempt(good.call.call_id, good.call.attempt_id!)!
      assert.equal(preflightRequests[0]!.id, original.binding.native_request_id)
      const history = base.store.openHistory(base.principal.id, target, 1)
      const key = { history_epoch: history.history_epoch, client_request_key: 'invalid_prompt_not_registered' }
      let invalidError: unknown
      let invalidAdmitted = false
      try {
        await runtime.runAuthenticated(
          { principal_id: base.principal.id },
          /** 缺少官方必填 text，不能生成第二个派发锚点或影响原合法请求。 */ () => {
            runtime.admit({
              target,
              native_request: { method: 'agent.prompt', params: { target: 'owned-agent' } },
              options: {
                binding_revision: 1,
                contract_ref: contractRef(source),
                deadline: base.now + 10_000,
                history: key
              }
            })
            invalidAdmitted = true
          }
        )
      } catch (error) {
        invalidError = error
      }
      const stateBeforeReply = base.store.call(base.principal.id, good.call.call_id).state
      const open = client.ws.readyState === WebSocket.OPEN
      if (open) {
        client.ws.send(
          JSON.stringify(
            responseFrame(original.binding, {
              result: { type: 'pong', version: '0.9.5', protocol: 22 }
            })
          )
        )
      }
      await until(
        /** 原调用必须能结算；旧缺陷造成的 unknown 也直接记录，不把等待超时掩盖根因。 */ () =>
          ['responded', 'outcome_unknown'].includes(base.store.call(base.principal.id, good.call.call_id).state)
      )
      const observed = {
        invalidAdmitted,
        invalidError:
          invalidError && typeof invalidError === 'object' && 'code' in invalidError ? invalidError.code : null,
        stateBeforeReply,
        legalCallState: base.store.call(base.principal.id, good.call.call_id).state,
        sameEpoch: client.epoch === epoch,
        requestFrames: client.frames.filter(
          /** 错误参数不应额外写出请求或导致合法请求重放。 */ (frame) => object(frame).type === 'request'
        ).length
      }
      assert.deepEqual(observed, {
        invalidAdmitted: false,
        invalidError: 'herdr_native_request_invalid',
        stateBeforeReply: 'dispatching',
        legalCallState: 'responded',
        sameEpoch: true,
        requestFrames: 1
      })
      base.store.assertConnection(original.binding)
      const recovered = await runtime.runAuthenticated(
        { principal_id: base.principal.id },
        /** 错误登记必须完全回滚，原 key 仍可首次用于不同的合法意图。 */ () =>
          runtime.admit({
            target,
            native_request: { method: 'ping', params: {} },
            options: {
              binding_revision: 1,
              contract_ref: contractRef(source),
              deadline: base.now + 10_000,
              history: key
            }
          })
      )
      assert.equal(recovered.created, true)
      assert.equal(recovered.call.epoch, epoch)
      await until(
        /** 第二个合法请求也只发送一次，错误 prompt 没有占用发送或历史槽。 */ () =>
          client.frames.filter(/** 只统计请求，不把 welcome 当作执行。 */ (frame) => object(frame).type === 'request')
            .length === 2
      )
      const retry = base.store.attempt(recovered.call.call_id, recovered.call.attempt_id!)!
      client.ws.send(
        JSON.stringify(responseFrame(retry.binding, { result: { type: 'pong', version: '0.9.5', protocol: 22 } }))
      )
      await until(
        /** 同一未断开的 epoch 能正常完成后续合法工作。 */ () =>
          base.store.call(base.principal.id, recovered.call.call_id).state === 'responded'
      )
    } finally {
      client.ws.close()
      await runtime.close()
      base.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

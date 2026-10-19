// 验证 mock 配对生命周期、受限凭据文件与去重窗口，不配置真实设备或系统权限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, until } from './helpers.js'
import { loadCredential, saveCredential } from '../../src/transport/index.js'
import { CredentialLifecycle } from './memory-identity.js'
import { ReceiveWindow } from '../../src/transport/common.js'

test(
  'enrollment 过期、重放、并发消费仅一次成功，管理员渠道默认拒绝',
  /** 覆盖到期边界、并发及重放消费，并验证管理员拒绝先于配对副作用。 */
  async () => {
    const f = fixture()
    try {
      const machine = f.admin.register('expired')
      const expired = f.admin.issue(machine.machine_id, 5)
      f.now += 5
      assert.throws(
        /** 再次兑换到期或已消费的 enrollment，确认不会签发第二份设备身份。 */
        () => f.admin.redeem(expired),
        /invalid_enrollment/
      )
      const token = f.admin.issue(machine.machine_id)
      const results = await Promise.allSettled([
        Promise.resolve().then(
          /** 在一个并发微任务中消费同一 enrollment，用真实 Store 决定唯一提交者。 */
          () => f.admin.redeem(token)
        ),
        Promise.resolve().then(
          /** 在另一个并发微任务中竞争同一 enrollment，验证不能重复签发设备身份。 */
          () => f.admin.redeem(token)
        )
      ])
      assert.equal(
        results.filter(
          /** 只统计成功提交的并发兑换，核对同一 enrollment 只有一个成功者。 */
          (r) => r.status === 'fulfilled'
        ).length,
        1
      )
      assert.throws(
        /** 再次兑换到期或已消费的 enrollment，确认不会签发第二份设备身份。 */
        () => f.admin.redeem(token),
        /invalid_enrollment/
      )
      f.denyAdmin()
      assert.throws(
        /** 在 mock 管理员拒绝时尝试安全变更，确认没有配对或轮换副作用。 */
        () => f.admin.register('forbidden'),
        /fixture_admin_denied/
      )
      assert.throws(
        /** 在 mock 管理员拒绝时尝试安全变更，确认没有配对或轮换副作用。 */
        () => f.admin.rotate(machine.machine_id, 10),
        /fixture_admin_denied/
      )
    } finally {
      f.stop()
    }
  }
)

test(
  '有界双凭据过渡、过期与显式完成轮换使旧连接失效',
  /** 推进可控时间并完成轮换，断言旧连接、旧凭据和到期凭据依次失效。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      let credential = a.credential
      const client = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => credential
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => client.status().phase === 'ready'
      )
      const oldEpoch = client.status().connection_epoch
      const rotated = f.admin.rotate(a.machine_id, 50, 1000)
      assert.throws(
        /** 在旧双凭据过渡尚未结束时再次轮换，确认有效凭据始终最多两份。 */
        () => f.admin.rotate(a.machine_id, 50),
        /rotation_in_progress/
      )
      assert.equal(f.gateway.status().devices[0]!.authenticated, true)
      f.now += 50
      f.gateway.refresh()
      assert.equal(f.gateway.status().connections, 0)
      credential = rotated
      await until(
        /** 等待同一设备在新的 epoch 完成 ready，验证重连没有复用旧连接。 */
        () => client.status().phase === 'ready' && client.status().connection_epoch !== oldEpoch
      )
      const second = f.admin.rotate(a.machine_id, 50, 1000)
      f.admin.finishRotation(a.machine_id)
      f.gateway.refresh()
      assert.equal(f.gateway.status().connections, 0)
      credential = second
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => client.status().phase === 'ready'
      )
      f.now += 1000
      f.gateway.refresh()
      assert.equal(f.gateway.status().connections, 0)
    } finally {
      f.stop()
    }
  }
)

test(
  '持久撤销拒绝认证、派发和读取；显式 takeover 产生新 epoch',
  /** 验证明确接管更换 epoch，随后持久撤销同时封锁认证与授权读取。 */
  async () => {
    const f = fixture()
    try {
      const a = f.pair('mock')
      const client = f.connector(
        /** 提供预先创建的 mock 设备凭据，只供本次隔离连接使用。 */
        () => a.credential
      )
      await until(
        /** 等待模拟连接完成认证及可信 provider 核对后进入 ready。 */
        () => client.status().phase === 'ready'
      )
      const epoch = client.status().connection_epoch
      f.admin.takeover(
        a.machine_id,
        /** 按 mock 接管授权关闭原 Gateway 连接，为新 epoch 连接腾出位置。 */
        () => f.gateway.disconnect(a.machine_id)
      )
      await until(
        /** 等待同一设备在新的 epoch 完成 ready，验证重连没有复用旧连接。 */
        () => client.status().phase === 'ready' && client.status().connection_epoch !== epoch
      )
      const call = f.call(a.target)
      f.gateway.dispatch(call.call_id)
      await until(
        /** 等待真实 Store 的响应事务完成，避免把 accepted 当成业务结果。 */
        () => f.router.get(f.principal, call.call_id).state === 'responded'
      )
      f.admin.revoke(a.machine_id)
      f.gateway.refresh()
      assert.equal(f.gateway.status().connections, 0)
      assert.throws(
        /** 撤销后尝试读取原调用，确认原授权不能继续访问结果。 */
        () => f.router.get(f.principal, call.call_id),
        /call_not_found/
      )
      assert.throws(
        /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
        () => f.credentials.authenticate(a.machine_id, a.credential.recovery_generation, a.credential.credential),
        /invalid_device_credential/
      )
      assert.throws(
        /** 向非 pending 设备请求 enrollment，确认不能借此自动重配或接管。 */
        () => f.admin.issue(a.machine_id),
        /invalid_machine_state/
      )
    } finally {
      f.stop()
    }
  }
)

test(
  '租期容量、时钟回退、恢复代次和无持久上下文的重启均默认拒绝',
  /** 用小容量与可控代次验证内存 fixture 的限额、到期、回拨及重启拒绝。 */
  () => {
    let now = 100
    let generation = 'generation1'
    const custody = {
      /** 返回可切换的 mock 恢复代次，制造旧身份跨代次的拒绝负例。 */
      generation: () => generation,
      /** 提供固定的无生产效力 epoch，此测试不创建真实网络连接。 */
      connect: () => 'epoch1',
      /** 保留无真实连接的 fixture 检查接口，不作为生产连接来源验证。 */
      assert() {},
      /** 保留不持有真实 socket 的 fixture 断开接口，不影响外部连接。 */
      disconnect() {}
    }
    const c = new CredentialLifecycle(
      custody,
      /** 提供测试控制的可信时间，不推进真实设备或账号期限。 */
      () => now,
      1
    )
    const credential = c.provision('machine1', 10)
    assert.throws(
      /** 超过设备凭据容量申请准入，确认不会淘汰已有身份来腾位。 */
      () => c.provision('machine2'),
      /credential_limit/
    )
    const active = c.authenticate('machine1', generation, credential.credential)
    now = 110
    assert.throws(
      /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
      () => c.assert(active.identity, active.lease),
      /invalid_device_credential/
    )
    now = 105
    assert.throws(
      /** 在可信时间回拨后使用身份，确认过期或旧租期不会复活。 */
      () => c.assert(active.identity, active.lease),
      /clock_untrusted/
    )
    now = 111
    generation = 'generation2'
    assert.throws(
      /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
      () => c.authenticate('machine1', 'generation1', credential.credential),
      /invalid_device_credential/
    )
    const restarted = new CredentialLifecycle(
      custody,
      /** 提供测试控制的可信时间，不推进真实设备或账号期限。 */
      () => now
    )
    assert.throws(
      /** 尝试使用失效、错绑定或旧代次的凭据，确认不能取得认证或租期许可。 */
      () => restarted.authenticate('machine1', generation, credential.credential),
      /invalid_device_credential/
    )
  }
)

test(
  'Connector 安全输入只读专用 Linux 0700/0600 文件，失凭据不按名称接管',
  /** 在新建私有目录中检查凭据创建、替换、权限、符号链接和丢失后的拒绝。 */
  () => {
    const f = fixture()
    const root = mkdtempSync(join(tmpdir(), 'rovloom-mock-custody-'))
    try {
      const a = f.pair('mock')
      const path = join(root, 'device.json')
      saveCredential(path, a.credential)
      assert.equal(statSync(path).mode & 0o777, 0o600)
      assert.deepEqual(loadCredential(path), a.credential)
      assert.throws(
        /** 再次创建已有凭据文件，确认独占写入不会覆盖已保存的身份。 */
        () => saveCredential(path, a.credential)
      )
      const rotated = f.admin.rotate(a.machine_id, 10)
      saveCredential(path, rotated, true)
      assert.deepEqual(loadCredential(path), rotated)
      const link = join(root, 'link')
      symlinkSync(path, link)
      assert.throws(
        /** 读取符号链接或不安全权限的凭据文件，确认启动输入校验拒绝。 */
        () => loadCredential(link),
        /unsafe_storage_file/
      )
      chmodSync(path, 0o644)
      assert.throws(
        /** 读取符号链接或不安全权限的凭据文件，确认启动输入校验拒绝。 */
        () => loadCredential(path),
        /unsafe_storage_file/
      )
      chmodSync(path, 0o600)
      chmodSync(root, 0o755)
      assert.throws(
        /** 从非私有父目录读取凭据，确认不会自动放宽目录安全边界。 */
        () => loadCredential(path),
        /private_storage_directory_required/
      )
      chmodSync(root, 0o700)
      rmSync(path)
      assert.throws(
        /** 删除凭据文件后再次读取，确认不会按名称重建或接管身份。 */
        () => loadCredential(path)
      )
      assert.throws(
        /** 尝试复用已登记名称，确认不会按同名接管原设备。 */
        () => f.admin.register('mock')
      )
      assert.throws(
        /** 向非 pending 设备请求 enrollment，确认不能借此自动重配或接管。 */
        () => f.admin.issue(a.machine_id),
        /invalid_machine_state/
      )
    } finally {
      f.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  '接收窗口抑制重复，冲突和承诺期内满窗不淘汰',
  /** 填满有效去重窗并注入冲突载荷，断言只有正确重复或到期清理可被接纳。 */
  () => {
    const window = new ReceiveWindow()
    const raw = JSON.stringify({ message_id: 'mock', payload: { x: 1 } })
    assert.equal(window.observe(raw, 100), 'new')
    assert.equal(window.observe(raw, 101), 'duplicate')
    assert.throws(
      /** 使用同一消息 ID 改动载荷，确认冲突不能被当作正确重复。 */
      () => window.observe(JSON.stringify({ message_id: 'mock', payload: { x: 2 } }), 102),
      /message_id_conflict/
    )
    for (let i = 0; i < 4095; i++) {
      window.observe(JSON.stringify({ message_id: 'mock_' + i }), 103)
    }
    assert.throws(
      /** 在有效去重窗口已满时准入新消息，确认已有承诺期内记录不被提前淘汰。 */
      () => window.observe(JSON.stringify({ message_id: 'full' }), 104),
      /dedup_window_full/
    )
    assert.equal(window.observe(raw, 60_100), 'new')
  }
)

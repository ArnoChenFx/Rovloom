/** 仅用自有 Unix listener 验证真实 Store 的受管目录边界；本文件不运行或冒充 Herdr 原生验收。 */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHerdrRuntimeChain } from './runtime-chain.js'

/** 自有 socket 即使权限正确，也只能放在原生实例边界，不能混入 Store 管理的普通文件目录。 */
async function listener(address: string) {
  const server = createServer()
  await new Promise<void>(
    /** 只监听本轮临时路径；没有客户端、原生请求或模型调用。 */ (resolve, reject) => {
      server.once('error', reject)
      server.listen(address, resolve)
    }
  )
  chmodSync(address, 0o600)
  return {
    /** 只关闭所属 listener 并等待其资源释放，不接管其它 Unix endpoint。 */
    async close() {
      await new Promise<void>(
        /** 本测试监听关闭后再删除整个自有临时目录。 */ (resolve, reject) =>
          server.close(/** 只传递关闭结果，错误不改为成功。 */ (error) => (error ? reject(error) : resolve()))
      )
    }
  }
}

test(
  'native sockets remain outside the real Store managed parent while its socket guard stays strict',
  /** 重现曾阻断 fixture_authenticate 的根因，正确分区后正向事务通过，污染 Store 子目录仍拒绝。 */
  async () => {
    const root = mkdtempSync('/workspace/rovloom-herdr-chain-test-')
    const chain = createHerdrRuntimeChain(root)
    let native: Awaited<ReturnType<typeof listener>> | undefined
    let contaminated: Awaited<ReturnType<typeof listener>> | undefined
    try {
      native = await listener(join(root, 'native-owned.sock'))
      assert.doesNotThrow(
        /** 原生 socket 不属于独立受管数据库目录，真实 Store 事务应成功。 */ () => chain.f.store.expire()
      )
      contaminated = await listener(join(root, 'gateway-store', 'unexpected.sock'))
      assert.throws(
        /** 即使 0600 socket 也必须被原生产 managedBytes 文件类型检查拒绝。 */ () => chain.f.store.expire(),
        { code: 'unsafe_storage_file' }
      )
    } finally {
      await contaminated?.close()
      await native?.close()
      chain.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
)

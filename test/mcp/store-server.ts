// 仅供真实SDK客户端隔离测试：业务使用实际Store/Router，身份与历史为人工fixture，不连接用户或原生服务。
import { startStdioFacade } from '../../src/mcp/index.js'
import { storeFixture } from './store-fixture.js'

const fixture = storeFixture()
try {
  const running = await startStdioFacade({
    service: fixture.service,
    caller: {
      resolve: /* 固定测试principal仅在本隔离子进程有效，不是产品身份解析器。 */ () => ({ principal_id: 'alice' })
    }
  })
  await running.closed
} finally {
  fixture.close()
}

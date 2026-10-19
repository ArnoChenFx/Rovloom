// 真实stdio SDK测试宿主，仅装配人工Store与合成来源的真实catalog；不提供任何native执行能力。
import { startStdioFacade } from '../../src/mcp/index.js'
import { catalogFixture } from './catalog-fixture.js'

const fixture = catalogFixture()
const stdio = await startStdioFacade({
  service: fixture.service,
  caller: { resolve: /* 合成caller只用于隔离协议测试，不代表生产身份绑定。 */ () => ({ principal_id: 'alice' }) },
  diagnostic: /* 固定诊断码不携带来源、路径或契约内容。 */ (code) => process.stderr.write(code + '\n')
})
try {
  await stdio.closed
} finally {
  fixture.close()
}

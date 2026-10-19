// 按固定 Bun 工具链构建模块化 ESM 产物并清除旧输出；不启动 Gateway 或 Connector 服务。
import { rmSync } from 'node:fs'
import { toolchain } from './toolchain.mjs'

toolchain()
rmSync(new URL('../../dist/', import.meta.url), { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [
    'src/contracts.ts',
    'src/store.ts',
    'src/router.ts',
    'src/protocol.ts',
    'src/native-contract/index.ts',
    'src/wire/index.ts',
    'src/integration/luvus-wire.ts',
    'src/integration/persistence.ts',
    'src/transport/index.ts',
    'src/herdr/readonly.ts',
    'src/connector/luvus/index.ts',
    'src/mcp/index.ts',
    'src/cli/index.ts',
    'src/cli/main.ts'
  ],
  outdir: 'dist/src',
  root: 'src',
  target: 'bun',
  format: 'esm',
  packages: 'external',
  splitting: true,
  sourcemap: 'external'
})
if (!result.success) {
  throw new AggregateError(result.logs, 'Bun build failed')
}
console.log(
  `Built ${result.outputs.length} ESM files/maps for Bun; foundation, native, wire, integration, transport, MCP and CLI entrypoints`
)

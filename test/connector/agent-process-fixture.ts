/** 供进程归属测试编译的纯合成等待程序，不运行原生 provider、Agent 或模型。 */
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.HOME + '/agent-env.json', JSON.stringify({ PATH: process.env.PATH }), { mode: 0o600 })
setInterval(/** 保持自有进程存活，测试通过原 pidfd 结束它。 */ () => {}, 1000)

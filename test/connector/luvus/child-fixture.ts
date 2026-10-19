/** 模拟固定 CLI 的 schema、会话发现及单次 RPC，只读取测试私有设置并输出受控故障。 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 只由本目录测试生成的固定 shebang 入口导入；不调用 shell、不启动任何 native runtime。
const settings = JSON.parse(readFileSync(join(process.cwd(), 'settings.json'), 'utf8'))
const argv = process.argv.slice(2)
writeFileSync(join(process.cwd(), 'observed.json'), JSON.stringify({ argv, env: process.env }))
const command = argv.slice(2).join(' ')
if (command === 'uhp schema') {
  process.stdout.write(readFileSync(settings.schema))
} else if (command === 'session list --json') {
  process.stdout.write(
    JSON.stringify(
      settings.listing ?? {
        sessions: [
          { name: 'synthetic', running: true, endpoint: { transport: 'unix_socket', address: settings.endpoint } }
        ]
      }
    )
  )
  if (settings.mutate_binary) {
    appendFileSync(settings.mutate_binary, '\n// 受控测试：发现之后更改固定文件身份。\n')
  }
} else if (command === 'uhp proxy') {
  let input = ''
  for await (const data of process.stdin) {
    input += data.toString()
  }
  writeFileSync(join(process.cwd(), 'request.jsonl'), input)
  const request = JSON.parse(input)
  if (settings.mode === 'hang') {
    process.on('SIGTERM', /* 故意忽略 SIGTERM，使超时用例检验桥接子进程的强制清理。 */ () => {})
    setInterval(/* 故意保持事件循环存活，让挂起模式持续等待 adapter 清理。 */ () => {}, 1000)
  } else if (settings.mode === 'stderr') {
    process.stderr.write('x'.repeat(131_072))
  } else if (settings.mode === 'overflow') {
    process.stdout.write('x'.repeat(1_048_577))
  } else if (settings.mode === 'raw') {
    process.stdout.write(settings.raw)
    process.exitCode = settings.exit_code ?? 0
  } else {
    process.stdout.write(
      JSON.stringify(
        settings.response ?? {
          id: request.id,
          error: { code: 'synthetic', message: 'preserve', data: { deep: ['汉字', { revision: 7 }] } }
        }
      ) + '\n'
    )
    process.exitCode = settings.exit_code ?? 1
  }
} else {
  process.exitCode = 40
}

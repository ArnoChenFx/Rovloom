/** 测试专用单调耗时观测；固定阶段及分类，不记录 schema、命令、路径或原始异常。 */
export async function phaseTiming<T>(phase: string, run: () => T | Promise<T>): Promise<T> {
  const began = performance.now()
  let outcome = 'failed'
  try {
    const result = await run()
    outcome = 'completed'
    return result
  } finally {
    process.stderr.write(
      JSON.stringify({
        scope: 'rovloom-test-phase',
        phase,
        outcome,
        platform: process.platform,
        arch: process.arch,
        bun: process.versions.bun,
        elapsedMs: Math.round(performance.now() - began)
      }) + '\n'
    )
  }
}

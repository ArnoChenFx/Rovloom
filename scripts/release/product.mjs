/** 固定真实产品入口；Worker 路径须随原生契约工厂接线更新，不自动搜集或复制其它服务。 */
export const product = {
  entrypoint: 'src/cli/main.ts',
  workers: ['src/native-contract/compiler-worker.ts', 'src/connector/herdr/compiler-herdr-worker.ts'],
  assets: [],
  // Gateway切片独立验收；Connector/真实双角色未完成时不能替代下面的完整发行门禁。
  gatewaySmoke: 'scripts/release/gateway-smoke.mjs',
  // 真实 HTTP 产品须提供隔离二进制验收脚本；未接线的预览入口不能进入 tag 发行。
  releaseSmoke: null
}

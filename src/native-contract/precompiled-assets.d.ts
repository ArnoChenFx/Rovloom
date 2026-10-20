// 声明构建生成的固定 JSON 资产；运行时不接受 caller 路径或下载内容。
declare module '*.compiled.json' {
  const value: unknown
  export default value
}

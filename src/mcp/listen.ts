// 监听地址与其规范回环主机：通配绑定时 Host/Origin 校验和本机资源地址仍使用对应回环地址，不随绑定放宽。
export type ListenHostname = '127.0.0.1' | '::1' | '0.0.0.0' | '::'

/** 通配地址监听所有网卡（明文 HTTP），Host 校验只防浏览器重绑定，不提供网络层隔离。 */
export const isWildcardHostname = (hostname: string | undefined): boolean => hostname === '0.0.0.0' || hostname === '::'

/** URL 形式的规范回环主机：IPv6 带方括号；缺省按 127.0.0.1。 */
export function canonicalLoopbackHost(hostname: ListenHostname | undefined): '127.0.0.1' | '[::1]' {
  return hostname === '::1' || hostname === '::' ? '[::1]' : '127.0.0.1'
}

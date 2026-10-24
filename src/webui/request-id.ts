/** getRandomValues 在明文 LAN 页面同样可用；操作关联不依赖仅安全上下文提供的 randomUUID。 */
export function managementRequestId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return 'request_' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

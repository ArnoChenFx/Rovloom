// 以 Bun 以外的运行时（如 node dist/src/cli/main.js）或低于下限的 Bun 启动时，明确提示而不是在深处失败。
export const MINIMUM_BUN = '1.4.3'

/** 逐段比较核心版本号；预发布后缀只看数字前缀，下限本身是正式版本。 */
export function bunSupported(version: string | undefined, minimum = MINIMUM_BUN): boolean {
  if (typeof version !== 'string') {
    return false
  }
  const actual = version.split(/[-+]/u)[0]!.split('.').map(Number)
  const wanted = minimum.split('.').map(Number)
  if (actual.length !== 3 || actual.some((part) => !Number.isSafeInteger(part))) {
    return false
  }
  for (const [index, part] of wanted.entries()) {
    if (actual[index]! !== part) {
      return actual[index]! > part
    }
  }
  return true
}

if (!bunSupported(process.versions.bun)) {
  process.stderr.write(
    `Rovloom requires Bun ${MINIMUM_BUN} or newer (https://bun.sh); this runtime is not supported.\n`
  )
  process.exit(1)
}

/** 独立打包探针 Worker；没有外部执行器、动态源码或生产身份。 */
import { helper } from './probe-helper.mjs'

globalThis.onmessage = /* 返回静态 helper 标记后由宿主回收 Worker。 */ () => globalThis.postMessage(helper)

/** 声明发行构建专用资源模块；源码开发应使用既有显式目录加载器，生产没有 cwd 回退。 */
declare module 'rovloom:management-assets' {
  /** 克隆受管静态资源供现有管理桥注入，所有字节来自编译产物。 */
  export function loadEmbeddedManagementAssets(): ReadonlyMap<string, Uint8Array<ArrayBuffer>>
}

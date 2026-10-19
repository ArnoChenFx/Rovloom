# Rovloom brand assets / 品牌资产

The approved mark uses an orange-red woven **R** as both symbol and first letter,
followed by dark ink-blue **ovloom**. Read the whole word as **Rovloom**.

标志使用橙红编织 **R** 兼作图标与首字母，后接深墨蓝 **ovloom**；完整名称为 **Rovloom**。

| Asset / 资产 | Purpose / 用途 |
| --- | --- |
| [rovloom-logo.png](rovloom-logo.png) | Original transparent PNG; Gateway WebUI header and page icon / 原始透明 PNG；Gateway WebUI 顶栏与页面图标 |
| [rovloom-logo-panel.svg](rovloom-logo-panel.svg) | README display panel with a fixed white background for light and dark themes / README 浅色底板展示包装，兼顾深浅主题 |

Original PNG: **2172 × 724**, **428,629 bytes**.
SHA256: `e0940cf61b4feee2c6db2226a8fe6c998f057427819f04e40a0902b3639d7dbe`.
Git blob: `a6aec714299977b40b6bb98a663559e0c5df2993`.

The display SVG embeds the exact original PNG bytes over a white rectangle.
It contains no remote resources, scripts, font dependencies or redrawn lettering.
Keep the transparent source and its checksum when updating the display wrapper.

展示 SVG 将原 PNG 字节嵌在白色底板上，没有外部资源、脚本、字体依赖或重绘字形。
更新展示包装时保留透明原图及其校验值。

Gateway WebUI builds copy the original PNG into the same static artifact. Keep its
bytes and aspect ratio unchanged; the image is served locally without remote brand resources.

Gateway WebUI 构建将原 PNG 复制到同一静态产物，保持字节和纵横比不变；图片由本机提供，不请求远端品牌资源。

# Rovloom brand assets / 品牌资产

The approved mark uses an orange-red woven **R** as both symbol and first letter,
followed by dark ink-blue **ovloom**. Read the whole word as **Rovloom**.

标志使用橙红编织 **R** 兼作图标与首字母，后接深墨蓝 **ovloom**；完整名称为 **Rovloom**。

| Asset / 资产 | Purpose / 用途 |
| --- | --- |
| [rovloom-logo.png](rovloom-logo.png) | Original transparent wordmark for horizontal layouts / 横版场景的原始透明全名图 |
| [rovloom-logo-panel.svg](rovloom-logo-panel.svg) | README display panel with a fixed white background for light and dark themes / README 浅色底板展示包装，兼顾深浅主题 |
| [rovloom-mark-black.png](rovloom-mark-black.png) | 192 × 192 PNG; black R for light surfaces / 黑色 R，适合浅色界面 |
| [rovloom-mark-navy.png](rovloom-mark-navy.png) | 192 × 192 PNG; navy tile with white R for app icons and compact branding / 深蓝底白色 R，用于应用图标和紧凑品牌展示 |
| [rovloom-mark-transparent.png](rovloom-mark-transparent.png) | 256 × 256 RGBA PNG; orange R with a transparent background; Gateway WebUI header and favicon / 透明背景的橙色 R；Gateway WebUI 顶栏与 favicon |
| [rovloom-icon.ico](rovloom-icon.ico) | Windows program icon: seven transparent RGBA frames, 16–256 px / Windows 程序图标，七个透明 RGBA 帧（16–256 像素） |
| [rovloom-mark-orange.png](rovloom-mark-orange.png) | 192 × 192 PNG; orange R on an opaque light tile / 浅色不透明底的橙色 R |

The transparent mark and the icon are derived from the transparent wordmark with
`scripts/maintenance/make-windows-icon.py`; rerun it if the wordmark changes.
The three opaque square marks retain their original backgrounds. They are opaque RGB
PNGs, not transparent versions.

三款方形图标均保留原图背景，为不透明 RGB PNG，不是透明版本。

Original PNG: **2172 × 724**, **428,629 bytes**.
SHA256: `e0940cf61b4feee2c6db2226a8fe6c998f057427819f04e40a0902b3639d7dbe`.
Git blob: `a6aec714299977b40b6bb98a663559e0c5df2993`.

The display SVG embeds the exact original PNG bytes over a white rectangle.
It contains no remote resources, scripts, font dependencies or redrawn lettering.
Keep the transparent source and its checksum when updating the display wrapper.

展示 SVG 将原 PNG 字节嵌在白色底板上，没有外部资源、脚本、字体依赖或重绘字形。
更新展示包装时保留透明原图及其校验值。

Gateway WebUI builds copy the transparent orange mark and the horizontal wordmark
into the static artifact without changing bytes, backgrounds or aspect ratios.
The header and favicon use the standalone transparent orange R; brand resources are served locally.

Gateway WebUI 顶栏与 favicon 使用独立透明背景橙色 R，构建同时保留横版全名图。两者均保持原始字节、背景与纵横比，使用本机静态资源。

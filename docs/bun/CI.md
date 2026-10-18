# 首次远端 CI 与路径修复

日期：2026-10-18 UTC，PR #17，首次发布 head `7312c26fd39199de1318dc2626bb46df692d80d4`，tree `0e2473675666270c1a4293bfedf4ef07be41a516`。三个原始增量的完整 tree、文件集合与本地一致，75个变更文件已核对。

首次 push/PR 工作流均在 P0 阶段失败。[PR run 39108608474](https://github.com/ArnoChenFx/luvus-mcp/actions/runs/39108608474) 显示官方 Bun 下载/校验、strace准备、version、空缓存frozen install、实装依赖审计、toolchain、typecheck/config/负例及原基础20项均已通过；P0子命令返回1，后续阶段没有运行。不能将这次结果称为CI通过。

复核发现 `scripts/p0/test_endpoint.py` 的两个 setup 写死 `dir=/workspace`；这是原云环境路径，GitHub runner checkout在 `/home/runner/work/...`，验证器的临时项目在 `/tmp`。端点审计又明确拒绝任何 group/world-writable 祖先，因此不能直接把 socket fixture 移入 `/tmp` 或放宽权限断言。

修复：验证器显式设置 `LUVUS_P0_TEST_ROOT=repo.parent`，P0 Python 单测在该可信工作区父目录下创建自己的0700短路径；独立调用默认也取仓库父目录。原七项单测的断言、socket模式/祖先/所有权/替换/清理门禁全部保留。原业务20项和原采集器、原fixtures/历史报告不变。另将失败子命令最后12000字符打印到CI stderr，便于看见真实错误，完整本地日志仍保留。

本地仅定点重跑七项Python边界/失败清理单测，传入全新私有测试根目录，7/7通过、exit0、目录已清理；未无必要重跑整轮。首次远端执行摘要独立保存为 `review/ci-first-failure.json`。修复以普通快进附加提交发布，不改写已经发布的三个提交或强推；下一次CI结论以PR实际run为准。

工作流仅测试。当前main无强制checks，唯一ruleset为disabled，本任务未修改这些设置；该事实不替代实际验证。checkout action 产生的 Node20→24平台弃用提示属于动作宿主，项目执行链仍由Bun和原生TypeScript/Python组成，零Node门禁不包括GitHub自身运行checkout的实现。

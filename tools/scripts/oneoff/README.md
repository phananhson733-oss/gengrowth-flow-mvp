# tools/scripts/oneoff/

一次性脚本归档。这些脚本是为某次具体批次 / 迁移 / 探查写的，**已经跑完**，
保留在此仅供参考与逻辑复用，不属于受维护的工具表面（不进 CI、不保证随主流程演进）。

约定：

- 文件名 `_` 前缀 = 一次性，不在常规工具命名空间内。
- `tools/scripts/` 被 `.git/hooks/pre-commit` 挡在 obsidian vault 自动备份之外，
  所以本目录靠 `git commit --no-verify` 显式提交。
- import 路径相对本目录：共享库在 `../lib/gg-shared.mjs`，仓库根经 `__dirname/../../..` 定位。
- `.sh` 运行器开头 `cd` 到仓库根、用仓库根相对路径调用，与本目录位置无关。

清单：

- `_probe-two-sheets.mjs` — 只读：权限矩阵 + dump 两张 workbook 的 tab 结构。
- `_diff-two-sheets.mjs` — 只读：两表逐列表头对齐 + 关键词 / cluster 集合差异。
- `_merge-new-keywords.mjs` — 研究主表关键词增量并入 flow-mvp 主表（默认 dry-run，`--write` 才写）。
- `_v33-migrate-probe.mjs` — 只读：探查 v3.3 迁移副本 schema。
- `_v33-migrate.mjs` — 关键词主表 v3.1→v3.3 in-place 迁移（生产准入列拆分）。
- `_v33-backfill.mjs` — 回填 page_id / 生产状态 到关键词主表 Z / Y。
- `_run-v44-batch.sh` — v4.4 day1 批量重生成（render → generate → validate）。
- `_run-w22-transits.sh` — W22 transit 批量。
- `_run-w23-empath.sh` — W23 EMPATH 集群批量。
- `_run-w23-mahadasha.sh` — W23 MAHADASHA 集群批量。

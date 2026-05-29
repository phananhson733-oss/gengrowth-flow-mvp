# WEEKLY_SOP.md — 每周操作循环（1-2 人 SEO 内容工厂）

> **这是什么**：把"找词 → 选题 → 写文章 → 发布"压成 1-2 人**每周照做的固定动作**。
> 流程设计见 [FRONT_HALF_FLOW.md](./FRONT_HALF_FLOW.md)（前半段）+ [E2E_FLOW.md](./E2E_FLOW.md)（端到端接缝）+ [PIPELINE.md](./PIPELINE.md)（每步细节）。
> **规范主脑表**：`1CkjOC…`（`GG_SHEETS_FLOW_MVP_WORKBOOK_ID`）。**记于** 2026-05-29。

---

## 0. 每周开跑前（30 秒，必做）

OAuth token 是 7 天测试期、会过期 → bridge / 部分 RAG 读路径会跑不动。每周先：

```bash
node tools/scripts/oauth-init.mjs        # 重新授权（过期才需；queue-build/promote 用 SA 不受影响）
```

原则：**内容生成必用 frontier 模型（Opus 等），不为省 token 降级**；**不用 mock/占位数据**。

---

## 1. 周循环（人 ~60–90 分钟，其余自动）

```
① 库存够就跳过：找词
   node tools/scripts/gg-keyword-mine.mjs --seeds "a,b,c" --entity "x"
   → 人在 keyword_candidates 列 K 标 Y（严格大写）
   node tools/scripts/gg-keyword-promote.mjs --also-draft-pages
   （写关键词主表 + 顺手回填 cluster_id 建议；公式当场分桶）

② 选主题（高杠杆，人只选"主题"不选"词"）
   在 主题集群表 给本周要做的 cluster 设 priority=P0 + week='Week N'
   （要激活 astrocartography / ai_astrology / rising_sign_profiles 等 dormant 新集群，也在这里设）

③ 自动选词入队
   node tools/scripts/gg-queue-build.mjs --week 'Week N' --capacity N          # dry-run 先看
   node tools/scripts/gg-queue-build.mjs --week 'Week N' --capacity N --write  # 确认后入队
   → 看输出：拟入队词 / 未归集群词（提示补 keywords_included）/ park 的工具词（D1）

④ 补 brief + 放行（唯一真正动手处）
   在 选题登记表 给本周「待写」行补：Tier/Template/Entity/Friction/Logic/page_role/content_angle/psych_safety
   （可先 node tools/scripts/gg-brief-suggest.mjs 预填，人 review 采纳）
   确认 cluster_id（Q 列）→ 翻 Status 推进

⑤ 后半段一条龙（基本自动，按 PIPELINE.md 各阶段命令）
   bridge → sheet-pull → RAG(entity/obsidian/friction) → render → llm-orchestrator
   → phase2(6 红线) → publish-to-wiki → oracle-convert → git commit
   （orchestrator 并行多 LLM + frontier-strict + 失败自动 retry）

⑥ 可选：deploy / monitor(GSC+GA4) / retro
```

进度随时看：`node tools/scripts/gg-status.mjs --md`

---

## 2. 人每周只做的 5 个决定（无 RBAC / 无审批列 / 无多级签字）

| # | 决定 | 在哪做 |
|---|---|---|
| 1 | **批准** 哪些候选词 | keyword_candidates 列 K = Y |
| 2 | **定优先级** 做哪个主题 | 主题集群表 priority=P0 + week |
| 3 | **定产能** 本周写几篇 | queue-build `--capacity N` |
| 4 | **写编辑内核** Friction / Logic / page_role | 选题登记表 |
| 5 | **放行** | 翻 Status（"待写"就是队列态） |

「**行的 Status 就是队列**」——没有别的状态机。

---

## 3. 不是每周做、需要创始人拍板的（攒着，想清再做）

- **calculator/工具页类型**：87% 的工具意图搜索量（park 中）要不要做交互排盘引擎？（[E2E_FLOW](./E2E_FLOW.md) / [FRONT_HALF_FLOW §4.2](./FRONT_HALF_FLOW.md)）
- **29 个未归集群词**：补进现有集群 keywords_included / 开新集群 / 放弃。
- **3 个 dormant 新集群**何时排期（设 week+priority）。
- 找词方向（关键词研究反向暴露的新机会）。

---

## 4. 运营 gotcha（知道就不踩）

- **OAuth 7 天过期** → 见 §0，每周先 re-auth。
- queue-build 写的行可能落在 1500+ 行（公式填充所致）：读取已无界、不漏；只是表里不显示该行 vol/KD（cosmetic）。
- park 的工具词不会进文章队列，但**留档在 dry-run 输出**——定期回看，是 calculator 决策的素材。
- 提交 `tools/scripts/` 需 `git commit --no-verify`（pre-commit hook 会静默 unstage）；`docs/` 由 vault-backup 自动提交。

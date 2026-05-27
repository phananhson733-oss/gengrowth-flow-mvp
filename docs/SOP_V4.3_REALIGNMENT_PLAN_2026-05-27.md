<!-- INPUT: oracle 已发布 10 篇 Day-1 文章的 SOP 核查结果 + gengrowth 生成流程诊断。 -->
<!-- OUTPUT: 把生成模板+校验门+转换脚本拉回 SOP v4.3 的可执行修复计划。 -->
<!-- POS: gengrowth-flow-mvp 源头修复工作输入。执行前先解决 mechanism 硬冲突；改完重新生成 10 篇回 oracle 错开部署。 -->

# SOP v4.3 Realignment Plan — 2026-05-27

## 0. 权威决策（已拍板）

**SOP v4.3（`gengrowth-ops/inbox/03-content-briefs/2026-05-25-seo-content-os-v4.3-sop.md`）为唯一权威规范。**

诊断发现：当前 live prompt 模板 + 发布门校验的是内部「v4.0 创作清单 / PRD v0.7 模板 B」7-section schema，**故意偏离了 SOP v4.3**（`tools/scripts/lib/structure-checks.mjs:6-10` 明文："severity 针对 LIVE 模板选，绝不针对被故意丢弃的旧 SOP"）。本次决定把模板与门**一起拉回 SOP v4.3**。模板与门必须同批改，否则两套 spec 更不一致。

## 1. oracle 现状（已发生，不用动）

- 线上 astrologywiki.com 已有这 10 篇的**初版**（更早发布）。
- 本次会话把 green-aura 的「结构修复升级版」部署上线，并对其 3 处占位符做了**热修止血**（commit `3837169`，线上已无乱码）。
- 其余 9 篇升级版**已暂停部署**（保存在 oracle 分支 `content/rebirth`，未推 main）。
- oracle 错开部署脚本：`~/.claude/projects/-Users-wzb-Code-oracle/deploy/deploy-next-rebirth.sh`（待达标内容就绪后启用）。
- **恢复部署的触发条件**：本计划修完 → 重新生成 10 篇 → 过 SOP v4.3 门 → 覆盖 oracle `content/rebirth` → 每篇（EN+ZH 同批）间隔 30-60min 错开 push main。

## 2. 五类问题与根因（来自诊断）

| # | 问题 | 类型 | 根因（文件:行） |
|---|---|---|---|
| 1 | 段落过度碎片化（一句一段+留白） | 真 bug | `definition.prompt.md:159-179` 只设 ≤4 行上限、无下限；`structure-checks.mjs` SC3 只拦 >85 词大段；无句长约束 |
| 2 | 占位符泄漏 `[[<TBD-external-link>]]` / `工具页` | 真 bug | `gg-md-to-oracle-ts.mjs:178-206` 只解析 internal link，无 `TBD-external` 分支；`工具页` 是 CTA 分类标签，CTA Map 查空时漏进 `cta_text`，且 `:183` 未匹配 fallback 包成 `*…*` 掩盖 |
| 3 | banned jargon（mechanism 等） | 规范冲突 | 模板 anti-AI blocklist（`definition.prompt.md:336-358`）不含 SOP 8 词；且 **`mechanism` 被模板强制**（Section 3 `:139-143` + 表头 `:144`）|
| 4 | 缺 FAQ section | 规范分歧 | 模板固定 7 个 H2、H3=0（`:110-157`），结构性排除 FAQ；门 `_phase2-validate.mjs:366` `h3Count!==0` 硬失败 |
| 5 | 表格列头 / CTA 不符 | 规范分歧 | 表头 `Property\|Mechanism\|Energy Center\|Common Misread`（`:144`）；CTA `## Take Action`（`:157`）|

## 3. ⚠️ 执行前必须先定：mechanism 硬冲突

`mechanism` 被 SOP **禁用**，却被模板 **强制**（Section 3 强制 "mechanism + trade-off" 散文 + 表格列头）。**不能既禁又强制。** 执行前需先定替代措辞，建议：
- Section 3 "mechanism + trade-off" → "how it works + trade-off"（或「运作方式 + 取舍」ZH）
- 表格列头里的 `Mechanism` → SOP 版 `Traditional Basis` / `Modern Meaning` 体系

## 4. 逐文件修复点清单

### 4.1 Prompt 模板（4 个文件 + ZH）
`tools/scripts/lib/content-draft-templates/definition.prompt.md` · `definition.prompt.zh.md` · `pillar.prompt.md` · `pillar.prompt.zh.md`
- **段落**（`:159-179`）：加下限——「标题下首段 4-5 行连贯散文；禁止连续一句一段碎片化；句子 ≤ ~25 词」
- **banned jargon**（`:336-358`）：加 SOP 8 词（mechanism/engine/systemic/module/recursive/robust/unlock/delve）；先解决 §3 的 mechanism 强制
- **FAQ**（`:132-157`）：加第 8 个 H2 `## FAQ`，3-4 个 PAA 风格问答（每条 2 句精准事实）
- **表格列头**（`:144` / pillar `:107`）：改 `Concept | Traditional Basis | Modern Meaning | How to Observe/Apply`
- **CTA**（`:157`）：`## Take Action` → `### Where to Go From Here`，Action→Output→Life Insight 公式

### 4.2 校验门（3 个文件）
- `tools/scripts/lib/structure-checks.mjs`：加 SC5（连续单句/<~25 词段落碎片化检测）+ 表头精确匹配检查 + FAQ 存在检查
- `tools/scripts/lib/red-lines.mjs`：加全局（all-author）banned-jargon 红线含 SOP 8 词（现 RL7 只查 per-author token，`:796`）
- `tools/scripts/_phase2-validate.mjs`：`expected_h2`（`:177-185`）+1（FAQ）；放开 `h3Count!==0`（`:366`）允许 FAQ/CTA 的 H3；加占位符泄漏门（CTA 分类标签 `Newsletter/工具页/星盘页/注册` + 未解析 TBD）

### 4.3 转换 / brief 脚本
- `tools/scripts/gg-md-to-oracle-ts.mjs`：加 `TBD-external-link` 解析器（平行于 `:197-206` 的 `transformBody`），未解析则 **hard-fail**，绝不输出字面占位符；`:183` 未匹配 fallback 从静默 `*desc*` 改为记录警告/失败
- `tools/scripts/gg-sheet-to-brief.mjs`（`:326-327`）/ `gg-brief-init.mjs`（`:106-107`）：`cta_text` 等于原始分类标签或为空时 hard-fail，不让其流进 prompt

## 5. 执行后

1. 改完模板+门后，对 1 篇做 TDD/smoke 验证（走 gengrowth 测试栈）确认新门能拦住 5 类问题
2. 重新生成 10 篇（含 EN+ZH），全部过 SOP v4.3 门
3. 渲染成 oracle `.ts`，覆盖 oracle 分支 `content/rebirth` 对应文件
4. 回 oracle：每篇（EN+ZH 同批）间隔 30-60min 错开 push main，Vercel 自动部署，逐篇 curl 验证

## 6. 参考

- 诊断全文见本次 oracle 会话记录（2026-05-27）。
- oracle 部署机制：Vercel GitHub 集成，push main 自动部署；域名 www.astrologywiki.com；文章 URL `/en/wiki/{slug}` `/zh/wiki/{slug}`。

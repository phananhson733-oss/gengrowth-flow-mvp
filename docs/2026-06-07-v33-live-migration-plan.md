---
title: keyword-sheet v3.3 活表迁移执行计划
date: 2026-06-07
type: migration-runbook
status: copy-migrated-verified-awaiting-live-cutover
author: wzb
target_live: 关键词主表 @ 1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc (gengrowth-flow-mvp)
work_copy_mcp: 1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M (gengrowth-flow-mvp — v3.3 迁移副本, owner=xdawayer)
---

# v3.3 活表迁移执行计划

> SSOT 模型：flow-mvp 为 as-built schema 权威；wiki v3.3 为设计参考。本计划**只打 v3.3 的功能 delta，并保留活表既有约定**（见 §2 差异），不照搬 wiki canonical 里与活表冲突的写法。

## 0. 进度

- [x] **复制副本**（迁移说明 §3 step 1）：`1UaTx…`（owner xdawayer，原表未动）。
- [x] **读真实 schema + 数据分布**（§3 的"先 diff 活表"前置）。
- [x] **写权限**：用户把副本共享给 SA 为 Editor（解卡）。
- [x] **在副本上 apply 迁移 + 验收 PASS**（脚本 `tools/scripts/_v33-migrate.mjs --apply`）。
- [x] **副本"类上线"演练 PASS**（用户："原件别动，副本可执行类上线"）：见下。
- [ ] **live cutover**：⏸ 用户喊停"先不要覆盖原件"。已留快照 `15xxJnp1Wf1M…`(v3.1 回滚件)。待**明确**放行后，`_v33-migrate.mjs --workbook 1CkjOC… --apply`（脚本幂等+前置校验+括号自检）。**注：覆盖原表是不可逆生产操作，必须等用户无歧义放行（见 memory feedback-no-overwrite-prod-sheet）。**

### 副本"类上线"端到端演练（2026-06-07，PASS）
用 flow-mvp 真实工具链指向副本跑生产级操作：
- `gg-sheet-audit`：读 v3.3 副本 OK（625 词/21 集群）；21 FK3 错误 + 3 重复警告均为**预存数据问题**（集群 cta_primary 标签对不上 CTA Map id；集群重复），**非迁移引入**（未动主题集群表/CTA Map）。
- `gg-queue-build` dry-run + `--write`：读 v3.3 主表建队列，cluster_id 关联正确；`--write` 把 10 词写入选题登记表 `A1521:A1530`（Status=待写 + cluster_id），**v3.3 完整生产写路径验通**。
- `gg-keyword-promote --dry-run`：v3.3 上干净运行。
结论：迁移后 v3.3 副本 + 已落地脚本改动（竞争建议别名 / cluster_id 按名解析 / A:AB）端到端可用。

### 副本迁移验收结果（2026-06-07，PASS）
- 表头 29 列，N=竞争建议，V–AC = 生产准入_自动/手动生产准入/生产准入/生产状态/page_id/发布URL/备注/cluster_id。
- 公式产出：N {✅可做 459, ⏸暂缓 124, 待填(含空行)}；O {快速胜利 392, 长尾词 174, 战略词 50, ❌无关 9}；V/X {可生产 452, 暂缓 164, 无关 9}。
- 数据零丢失：cluster_id 162→AC、备注 8→AB，旧 Y 已清空。
- 生产候选视图 452 条；矛盾(O=❌无关但X=可生产) 0。
- 副本：https://docs.google.com/spreadsheets/d/1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M/edit
- **踩坑**：首版 fO 末尾多 1 个 `)`（删 DR-skip 子句时漏删配套右括号）→ O #ERROR! → V/X 连带。已修 + 脚本加括号平衡自检。tab 名用无 emoji `生产候选`（用户偏好 + 活表约定）。config tab 真名 `配置`（无 emoji）。

## 1. 活表真实现状（已侦察）

- **关键词主表 = v3.1**：N(13)=`DR过滤`（公式 `IF(J2>30,"❌跳过","✅通过")`），25 列止于 `Y cluster_id`。**626 行关键词**（627 含表头），grid 1500×26。
- V/W/X/Y 区实况：**V 内容状态 = 全空（0 条）**、**W 发布URL = 全空（0 条）**、**X 备注 = 8 条**（"宫位集群补齐"类）、**Y cluster_id = 162 条 / 12 个集群**（vedic_astrology_basics 34、nakshatras_27_stars 33…）。
- 22 个 tab，**无 🧩生产候选**（v3.3 要加）。

## 2. 活表与 wiki canonical 的差异（迁移必须保留活表写法）

| 项 | wiki v3.3 .gs | 活表实况 | 迁移取舍 |
|---|---|---|---|
| 配置 tab 名 | `⚙️配置` | `配置`（公式引用 `'配置'!`） | **保留 `配置`** |
| 分桶名 | `🚀趋势词/⚡快速胜利/🎯战略词/📌长尾词` | 无 emoji：`趋势词/快速胜利/战略词/长尾词` | **保留无 emoji**（views 子串匹配、queue-build 去 emoji，均兼容；改 emoji 会动 626 行 R 值） |
| cluster_id | canonical 主表**无此列** | 在 Y(25) | **迁到 AC(29)**（保留 canonical V–AB 列字母与 wiki 对齐 + 保住 flow-mvp 的 cluster_id；gg-keyword-promote 已改为按表头名解析，落 AC 自动正确） |
| 负向词 token | `❌无关` | `❌跳过` | 随 v3.2 统一改 `❌无关`（O 公式 + R 条件格式 + P 下拉 + 配置 A27/A28 注释一并改，保持一致） |

## 3. 精确操作序列（在副本上执行，dry-run 复核后 apply）

**前置校验**（幂等/安全）：主表表头 must = `…U弱度意图分 | V内容状态 | W发布URL | X备注 | Y cluster_id` 且 N=`DR过滤`；若 N 已是 `竞争建议` → 判定已迁移，中止。

1. **加宽 grid**：columnCount 26 → 29（appendDimension COLUMNS +3，新增 AA/AB/AC）。
2. **搬数据**（先搬后覆盖）：`X2:X1500`(备注 8 条) → `AB2:AB1500`；`Y2:Y1500`(cluster_id 162 条) → `AC2:AC1500`。
3. **清旧列**：清 `X2:X1500`、`Y2:Y1500`（将变公式/下拉，必须先清，否则旧值污染新含义）。V/W 本就空。
4. **改 N（竞争建议）**：N1 表头 `DR过滤`→`竞争建议`；N2=`=IF(J2="待填","待填",IF(ISNUMBER(J2),IF(J2>30,"⏸暂缓","✅可做"),"待填"))`，copyPaste N2→N3:N1500。
5. **改 O（去 DR 删除 + 负向词 ❌无关，保留无 emoji 桶名）**：O2=`=IF(A2="","",IF(SUMPRODUCT(('配置'!$A$28:$A$45<>"")*ISNUMBER(SEARCH('配置'!$A$28:$A$45,A2)))>0,"❌无关",IF(AND(ISNUMBER(F2),F2>1.2,ISNUMBER(D2),D2<35,K2="✅相关",L2="Y"),"趋势词",IF(AND(ISNUMBER(D2),D2<20,ISNUMBER(C2),C2>=100),"快速胜利",IF(AND(ISNUMBER(D2),D2<20,OR(M2="Problem-aware",M2="Informational"),ISNUMBER(C2),C2>=50),"快速胜利",IF(AND(ISNUMBER(D2),D2>=20,D2<=50,OR(M2="Commercial",M2="Transactional")),"战略词","长尾词")))))))`（**删掉了** `IF(N2="❌跳过","❌跳过",` 这层），copyPaste O2→O3:O1500。
6. **新列表头** V1:AC1 = `生产准入_自动 | 手动生产准入 | 生产准入 | 生产状态 | page_id | 发布URL | 备注 | cluster_id`。
7. **V 公式**（适配活表 token）：V2=`=IF(A2="","",IF(O2="❌无关","无关",IF(N2="✅可做","可生产",IF(N2="⏸暂缓","暂缓","暂缓"))))`，copyPaste→V3:V1500。
8. **X 公式**：X2=`=IF(A2="","",IF(W2<>"",W2,V2))`，copyPaste→X3:X1500。
9. **下拉**：移除旧 V(内容状态) 下拉；加 W `可生产/暂缓/集群必需/无关`、Y `未开始/已建卡/已发布/已合并/暂停`。
10. **条件格式**：V2:X1500（可生产→绿/集群必需→紫/暂缓→黄/无关→灰）、Y2:Y1500（状态色）；R 列条件格式 token `❌跳过`→`❌无关`；P 下拉末值 `❌跳过`→`❌无关`；配置 A27/A28 注释 `❌跳过`→`❌无关`。
11. **🧩生产候选 视图**：新 sheet，A1=`=IF(COUNTIF('关键词主表'!X:X,"可生产")+COUNTIF('关键词主表'!X:X,"集群必需")>0,{'关键词主表'!A1:AC1;FILTER('关键词主表'!A2:AC1500,REGEXMATCH('关键词主表'!X2:X1500,"可生产|集群必需"))},{"暂无生产候选"})`（范围到 AC 以带上 cluster_id）。
12. **下游范围加宽**：4 个桶视图（趋势词/快速胜利/战略词/长尾词）FILTER `A1:X/A2:X`→`A1:AC/A2:AC`；选题登记表 C2/D2 VLOOKUP `'关键词主表'!$A:$X`→`$A:$AC`。

## 4. ⛔ 写权限解卡（需用户一次性操作，二选一）

- **A（推荐，非过期）**：把副本 `1UaTx…` 共享给 SA 邮箱 **`gg-writer-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com`** 为 **Editor**（副本 → 共享 → 填邮箱 → 编辑者）。之后用既有 SA 工具链跑迁移；SA token 不过期。
- **B（会再过期）**：`node tools/scripts/oauth-init.mjs` 浏览器重新授权，刷新 user OAuth（7 天 Testing 上限）。

> SA 已可读写**原表**（最终 live cutover 用），只是没副本权限。给副本加 Editor 即可在副本上测试。

## 5. 验收查询（迁移后在副本跑，query 式可测）

- `FILTER X=可生产|集群必需` 返回 N 行，抽查 10 行合理。
- `0 行 O=❌无关 但 X=可生产`。
- cluster_id 162 条全部出现在 AC 列（搬移无丢失）；X备注 8 条在 AB 列。
- 每个 P0 集群（PRD §9.1）≥1 行可进生产候选。
- N=待填 行数统计，确认其中无 P0/Pillar 词被默认暂缓。

## 6. 回滚

- 副本测试阶段：副本本身可丢弃重来；原表 `1UaTx`-MCP 备份 + SA 可随时再复制原表。
- live cutover 前：先对原表做快照副本（=回滚件），apply 后抽查 §5；出现 #REF/错值即从快照恢复。

---
*侦察经 SA 只读原表 + wiki v3.3 .gs 核实。脚本实现待写权限解卡后落地（届时可对副本 dry-run + apply 测试，再 cutover 原表）。*

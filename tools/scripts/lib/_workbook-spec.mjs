// _workbook-spec.mjs — 13 tab schema 规格（1:1 复刻 .gs v3.1）+ 6 个项目运维 tab
//
// SSOT: docs/spec/upstream-canon/keyword-sheet-setup.gs  (Apps Script v3.1)
//   ⚠️ 不允许在本文件做单独偏离。如果 .gs 上游变更：
//      1. 先 `_sync-canon.sh` 拉新 .gs
//      2. 再同步改本文件
//      3. 跑 _bootstrap-flow-mvp-workbook.mjs --rebuild
//
// 颜色编码（PRD v0.7 附录 D 表头颜色规范）：
//   navy   #1a237e = 公式自动列
//   green  #2e7d32 = 必填手动
//   slate  #455a64 = 选填 / 条件字段
//   header #37474f = 视图表 / 配置表 / 运维表表头

export const COLORS = Object.freeze({
  navy:   { red: 0.102, green: 0.137, blue: 0.494 },
  green:  { red: 0.180, green: 0.490, blue: 0.196 },
  slate:  { red: 0.271, green: 0.353, blue: 0.392 },
  header: { red: 0.216, green: 0.278, blue: 0.310 },
  white:  { red: 1.0, green: 1.0, blue: 1.0 },
});

// SOURCE 下拉值（gg-keyword-promote.mjs 同步）
export const SOURCE_LIST = ['竞品映射', '内容缺口', '种子词拓展', '社区挖掘', '趋势词', 'Social信号'];

// 公式（关键词主表 J/K/M/N/O/R/S/U）— 1:1 复刻 .gs v3.1 line 199-260
// 注：`'配置'` 在 Sheets 公式里需单引号
const CFG = "'配置'";

export const MASTER_FORMULAS = Object.freeze({
  J: '=IF(OR(G2="",I2=""),"待填",G2-I2)',
  K: `=IF(A2="","",IF(SUMPRODUCT((${CFG}!$A$6:$A$25<>"")*ISNUMBER(SEARCH(${CFG}!$A$6:$A$25,A2)))>0,"✅相关","⚠️待确认"))`,
  M: '=IF(A2="","",IF(OR(ISNUMBER(SEARCH("best ",A2)),ISNUMBER(SEARCH(" vs ",A2)),ISNUMBER(SEARCH("alternative",A2)),ISNUMBER(SEARCH("comparison",A2)),ISNUMBER(SEARCH("review",A2)),ISNUMBER(SEARCH("pricing",A2)),ISNUMBER(SEARCH("top ",A2))),"Commercial",IF(OR(ISNUMBER(SEARCH("buy ",A2)),ISNUMBER(SEARCH(" cost",A2)),ISNUMBER(SEARCH("cheap",A2)),ISNUMBER(SEARCH("discount",A2)),ISNUMBER(SEARCH("free trial",A2)),ISNUMBER(SEARCH("sign up",A2))),"Transactional",IF(OR(ISNUMBER(SEARCH("fix ",A2)),ISNUMBER(SEARCH("not working",A2)),ISNUMBER(SEARCH("how to fix",A2)),ISNUMBER(SEARCH("how to solve",A2)),ISNUMBER(SEARCH("problem",A2)),ISNUMBER(SEARCH(" error",A2))),"Problem-aware",IF(OR(ISNUMBER(SEARCH("how to ",A2)),ISNUMBER(SEARCH("what is",A2)),ISNUMBER(SEARCH(" guide",A2)),ISNUMBER(SEARCH("tutorial",A2)),ISNUMBER(SEARCH("why ",A2)),ISNUMBER(SEARCH("explained",A2))),"Informational","待确认")))))',
  N: '=IF(J2="待填","待填",IF(ISNUMBER(J2),IF(J2>30,"❌跳过","✅通过"),"待填"))',
  O: `=IF(A2="","",IF(SUMPRODUCT((${CFG}!$A$28:$A$45<>"")*ISNUMBER(SEARCH(${CFG}!$A$28:$A$45,A2)))>0,"❌跳过",IF(N2="❌跳过","❌跳过",IF(AND(ISNUMBER(F2),F2>1.2,ISNUMBER(D2),D2<35,K2="✅相关",L2="Y"),"趋势词",IF(AND(ISNUMBER(D2),D2<20,ISNUMBER(C2),C2>=100),"快速胜利",IF(AND(ISNUMBER(D2),D2<20,OR(M2="Problem-aware",M2="Informational"),ISNUMBER(C2),C2>=50),"快速胜利",IF(AND(ISNUMBER(D2),D2>=20,D2<=50,OR(M2="Commercial",M2="Transactional")),"战略词","长尾词")))))))`,
  R: '=IF(A2="","",IF(P2<>"",P2&"★",O2))',
  S: '=IF(A2="","",IF(AND(ISNUMBER(C2),C2>=500,OR(ISNUMBER(SEARCH("what is",A2)),ISNUMBER(SEARCH("meaning",A2)),ISNUMBER(SEARCH("definition",A2)),ISNUMBER(SEARCH("how does",A2)),ISNUMBER(SEARCH("explained",A2)))),"⚠️疑似高风险",""))',
  U: '=IF(A2="",0,IF(H2="✅弱",3,IF(H2="⚠️中",2,1))+IF(OR(M2="Commercial",M2="Problem-aware"),1,0))',
});

// 视图表的 SORT/FILTER 公式（line 542-577）
export const VIEW_FORMULAS = Object.freeze({
  trend:     `=IF(COUNTIF('关键词主表'!R:R,"*趋势词*")>0,{'关键词主表'!A1:X1;SORT(FILTER('关键词主表'!A2:X1500,REGEXMATCH('关键词主表'!R2:R1500,"趋势词")),6,FALSE)},{"暂无趋势词"})`,
  quickWin:  `=IF(COUNTIF('关键词主表'!R:R,"*快速胜利*")>0,{'关键词主表'!A1:X1;SORT(FILTER('关键词主表'!A2:X1500,REGEXMATCH('关键词主表'!R2:R1500,"快速胜利")),21,FALSE,3,FALSE)},{"暂无快速胜利词"})`,
  strategic: `=IF(COUNTIF('关键词主表'!R:R,"*战略词*")>0,{'关键词主表'!A1:X1;SORT(FILTER('关键词主表'!A2:X1500,REGEXMATCH('关键词主表'!R2:R1500,"战略词")),5,FALSE)},{"暂无战略词"})`,
  longTail:  `=IF(COUNTIF('关键词主表'!R:R,"*长尾词*")>0,{'关键词主表'!A1:X1;FILTER('关键词主表'!A2:X1500,REGEXMATCH('关键词主表'!R2:R1500,"长尾词"))},{"暂无长尾词"})`,
});

// 内容追踪公式（line 660-662）
export const TRACK_FORMULAS = Object.freeze({
  G: '=IF(E2="","",IF(E2<=10,"P3-P10",IF(E2<=20,"P5-P20",IF(E2<=35,"P10-P30",IF(E2<=50,"P20-P50","P50+")))))',
  H: '=IF(OR(F2="",E2=""),"",IF(E2<=10,ROUND(F2*0.11,0),IF(E2<=20,ROUND(F2*0.04,0),IF(E2<=35,ROUND(F2*0.015,0),IF(E2<=50,ROUND(F2*0.005,0),0)))))',
  L: '=IF(OR(H2="",K2=""),"",IF(H2=0,"N/A",TEXT((K2-H2)/H2,"+0%;-0%;0%")))',
});

// ============================================================
// 13 .gs tab + 6 项目运维 tab 规格
// ============================================================

export const TABS = [
  // ────────── .gs v3.1 13 tab ──────────
  {
    name: '配置',
    type: 'config',
    headerColors: { 1: 'header', 2: 'header' }, // A1 B1 深灰
    rows: [
      ['配置项', '值'],
      ['客户产品名', ''],
      ['实验开始日期', ''],
      ['目标国家', ''],
      ['TOPIC_KEYWORDS（趋势词G1相关性检测，每行一个话题词）', ''],
      // A6-A25 默认示例话题词（5 个，留 15 行空让用户填）
      ['seo', ''], ['marketing', ''], ['growth', ''], ['content', ''], ['keyword', ''],
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      // A26 留空
      ['', ''],
      // A27 NEGATIVE 标题
      ['NEGATIVE_KEYWORDS（负向词，关键词含其一即在主表 O 列判 ❌跳过，每行一个）', ''],
      // A28-A45 默认示例负向词 5 个 + 13 空
      ['miami', ''], ['dade', ''], ['trimet', ''], ['hub city', ''], ['bus tracker', ''],
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      ['', ''], ['', ''], ['', ''], ['', ''], ['', ''],
      ['', ''], ['', ''], ['', ''],
    ],
    extras: {
      // 特殊背景：B4 黄色高亮（目标国家必填）、A5/A27 加粗 + 背景色
      cellBackgrounds: [
        { range: 'B4', color: { red: 1.0, green: 0.976, blue: 0.769 } },        // #fff9c4
        { range: 'A5', color: { red: 0.910, green: 0.961, blue: 0.914 } },      // #e8f5e9
        { range: 'A6:A25', color: { red: 0.976, green: 0.984, blue: 0.910 } },  // #f9fbe7
        { range: 'A27', color: { red: 1.0, green: 0.804, blue: 0.824 } },       // #ffcdd2
        { range: 'A28:A45', color: { red: 1.0, green: 0.961, blue: 0.961 } },   // #fff5f5
      ],
      boldRanges: ['A5', 'A27'],
      columnWidths: [320, 180],
      notes: {
        'A4': '目标国家（Day-0 参数，如 US）。约束：\n① Ahrefs Keywords Explorer 导出设为此国家，关键词主表 C 列即取该国月搜索量；\n② SERP 弱度检查用此国家的 Google；\n③ 主题集群表 us_share 标签据此判断。',
        'A6': '替换为客户产品相关的核心话题词（英文），最多20行（A6:A25）。\n例 astrologywiki：astrology, birth chart, horoscope, natal chart, mercury retrograde\n命中TOPIC_KEYWORDS → K列G1话题相关=✅相关（趋势词闸门1通过）',
        'A28': '负向词：与产品无关的词根，关键词命中即在关键词主表 O 列直接判 ❌跳过。\n最多18行（A28:A45），子串匹配，填词根即可（"bus tracker" 命中 "miami dade bus tracker"）。\n默认值是 astrologywiki 的公交类无关词示例，换产品时替换为该产品的无关词；留空=不否决。',
      },
    },
  },

  {
    name: '关键词主表',
    type: 'master',
    header: ['关键词', '来源', '月搜索量', 'KD', 'CPC($)', 'Trends比值', 'Top10最低2站DR均值', 'SERP弱度', '自有站DR', 'DR差值', 'G1话题相关', 'G2可承接', '意图', 'DR过滤', '分桶_自动', '手动分桶', '调整原因', '分桶', 'AIO预判', 'AIO风险', '弱度意图分', '内容状态', '发布URL', '备注', 'cluster_id'],
    headerColorByCol: { // 1-indexed
      // navy (公式自动): J K M N O R S U = 10 11 13 14 15 18 19 21
      1: 'green', 2: 'green', 3: 'green', 4: 'green', 5: 'slate', 6: 'slate',
      7: 'green', 8: 'green', 9: 'green', 10: 'navy', 11: 'navy', 12: 'slate',
      13: 'navy', 14: 'navy', 15: 'navy', 16: 'slate', 17: 'slate', 18: 'navy',
      19: 'navy', 20: 'slate', 21: 'navy', 22: 'slate', 23: 'slate', 24: 'slate',
    },
    extras: {
      frozenRows: 1,
      headerFontColor: 'white',
      headerBold: true,
      headerFontSize: 11,
      columnWidths: [270, 100, 90, 55, 65, 90, 100, 80, 80, 80, 100, 70, 110, 70, 120, 110, 200, 120, 110, 70, 80, 90, 220, 120],
      formulas: { J2: MASTER_FORMULAS.J, K2: MASTER_FORMULAS.K, M2: MASTER_FORMULAS.M, N2: MASTER_FORMULAS.N, O2: MASTER_FORMULAS.O, R2: MASTER_FORMULAS.R, S2: MASTER_FORMULAS.S, U2: MASTER_FORMULAS.U },
      // 向下复制公式到行 500
      formulaFillDown: [
        { src: 'J2:O2', dst: 'J3:O1500' },
        { src: 'R2', dst: 'R3:R1500' },
        { src: 'S2', dst: 'S3:S1500' },
        { src: 'U2', dst: 'U3:U1500' },
      ],
      dataValidations: [
        { range: 'B2:B1500', list: SOURCE_LIST },
        { range: 'H2:H1500', list: ['✅弱', '⚠️中', '❌强', '未查'] },
        { range: 'L2:L1500', list: ['Y', 'N'] },
        { range: 'P2:P1500', list: ['趋势词', '快速胜利', '战略词', '长尾词', '❌跳过'] },
        { range: 'T2:T1500', list: ['高', '低', '未查'] },
        { range: 'V2:V1500', list: ['未开始', '写作中', '已发布', '暂缓'] },
      ],
      conditionalFormats: [
        // R 列分桶（主色）
        { range: 'R2:R1500', textContains: '趋势词',    bg: { red: 0.784, green: 0.902, blue: 0.788 } }, // #c8e6c9
        { range: 'R2:R1500', textContains: '快速胜利★', bg: { red: 1.0,   green: 0.961, blue: 0.616 } }, // #fff59d
        { range: 'R2:R1500', textContains: '快速胜利',  bg: { red: 1.0,   green: 0.976, blue: 0.769 } }, // #fff9c4
        { range: 'R2:R1500', textContains: '战略词',    bg: { red: 0.733, green: 0.871, blue: 0.984 } }, // #bbdefb
        { range: 'R2:R1500', textContains: '长尾词',    bg: { red: 0.988, green: 0.894, blue: 0.925 } }, // #fce4ec
        { range: 'R2:R1500', textContains: '❌跳过',      bg: { red: 0.933, green: 0.933, blue: 0.933 } }, // #eeeeee
        // O 列浅色
        { range: 'O2:O1500', textContains: '🚀', bg: { red: 0.945, green: 0.973, blue: 0.914 } }, // #f1f8e9
        { range: 'O2:O1500', textContains: '⚡', bg: { red: 1.0,   green: 0.992, blue: 0.906 } }, // #fffde7
        { range: 'O2:O1500', textContains: '🎯', bg: { red: 0.910, green: 0.957, blue: 0.992 } }, // #e8f4fd
        { range: 'O2:O1500', textContains: '📌', bg: { red: 0.992, green: 0.949, blue: 0.973 } }, // #fdf2f8
        // P 列非空 → 黄高亮 + 加粗
        { range: 'P2:P1500', notEmpty: true, bg: { red: 1.0, green: 0.945, blue: 0.463 }, bold: true }, // #fff176
        // H 列
        { range: 'H2:H1500', textContains: '✅弱', bg: { red: 0.784, green: 0.902, blue: 0.788 } },
        { range: 'H2:H1500', textContains: '⚠️中', bg: { red: 1.0,   green: 0.976, blue: 0.769 } },
        { range: 'H2:H1500', textContains: '❌强', bg: { red: 1.0,   green: 0.804, blue: 0.824 } },
        // S 列 AIO 橙警
        { range: 'S2:S1500', textContains: '疑似高风险', bg: { red: 1.0, green: 0.878, blue: 0.698 } }, // #ffe0b2
      ],
      // 列注释（line 161-179）
      notes: {
        C1: '月搜索量取「目标国家」(配置!B4) 的数值。Ahrefs Keywords Explorer 把国家设为目标国后导出的 Volume 即此列，不用全球量。',
        E1: 'CPC仅做参考展示，不用于分桶判断。战略词的主条件是意图（M列），不是CPC高低。',
        F1: 'Trends比值（手动，趋势词判断用）：近3个月均值 ÷ 近6个月均值。\n>1.2 = 近期上涨（趋势词候选）\n≈1.0 = 稳定\n<0.8 = 衰退词\n获取：Google Trends 或 Ahrefs "Trend"图表目测估算。留空视为平稳，仅趋势词分桶条件使用。',
        G1: 'Top10最低2站DR均值（查词时手动填写）：取Top10结果中DR最低的2个站，求均值。\n\n为何不用全平均？前期自有站DR=0或接近0，几个高DR站（如WordPress.com DR=94、Reddit DR=91）会把全平均拉到80+，几乎所有词被N列误判为❌跳过；看末两位DR更贴近"你实际能挤进的位置"。\n\n获取：Ahrefs关键词详情页SERP Overview → 按DR升序排 → 取最低2行DR均值；或安装Ahrefs SEO Toolbar直接在Google搜索结果页读DR。\n注：每个词不同，需和H列SERP弱度、I列自有站DR同步填写。',
        H1: 'SERP弱度（快速胜利桶必填，查词时同步判断）\n\n判断方式（三种）：\n① Ahrefs关键词详情页 → SERP Overview：直接看每个排名页DR/UR，最快\n② 安装Ahrefs SEO Toolbar浏览器插件（免费）：Google搜索结果每条旁边直接显示DR/UR\n③ 手工Google搜索：看是否有论坛帖、内容薄弱页、无针对性优化的页面\n\n判断标准：\n✅弱：Top10中≥3个页面DR低/内容薄弱/或有论坛帖（Reddit/Quora等）排名 → 可超越\n⚠️中：Top10中有1-2个可超越位置\n❌强：Top10全部为高质量高DR站点\n\n注：Reddit(DR=91)/Quora(DR=88)虽然站DR高，但单帖内容薄弱且UR低，出现在Top10 = ✅弱信号——说明该词缺乏高质量专业内容，正是内容站机会所在。',
        I1: '自有站DR（查词当时的站DR快照，手动填写）：每次查词时填入你当前的Ahrefs站DR，只填一次，不随时间更新。\n获取：Ahrefs → 输入你的域名 → 查看Domain Rating。\n\n为何不用全局配置？G列是查词时的竞争快照，I列是同时刻你的站DR，两者配对才有意义。使用全局配置会导致新旧DR混用，比较无意义。',
        J1: 'DR差值 = Top10最低2站DR均值（G）- 自有站DR（I），自动计算。\n差值>30 → ❌跳过；差值≤30（含负值）→ ✅通过\n负值（如-5）= 你的站DR已超越该词SERP末位站，更应执行，属于正常情况。\n注：G和I均为查词时快照，执行前如距填写超60天建议重新核查SERP。',
        K1: 'G1话题相关：自动检测关键词是否命中配置!A6:A25的TOPIC_KEYWORDS列表。\n✅相关=话题相关；⚠️待确认=未命中，需人工判断后决定是否填L列=Y。\n初始化后必须先更新配置表话题词，否则默认示例词无意义。',
        L1: 'G2可承接（手动）：站内是否有工具/内容/功能能承接该趋势词的用户需求？\n填Y才能进趋势桶；空值视为N。这是纯人工判断项，脚本无法自动识别。',
        M1: '意图（自动，模式匹配，约80%准确）：\nCommercial: best/vs/alternative/review/pricing\nTransactional: buy/cost/free trial\nProblem-aware: fix/not working/error\nInformational: what is/how to/guide\n未命中→待确认，批量交Claude/GPT用SOP第四节prompt处理。',
        N1: 'DR过滤（公式，唯一真正的过滤关卡）：基于J列DR差值自动判断。\n✅通过：差值≤30，可执行\n❌跳过：差值>30，当前站DR不足以竞争该词\n待填：G或I列未填，无法计算\n❌跳过的词仍留在主表。当站DR提升后重填I列，此列自动重判。',
        O1: '分桶_自动：系统按SOP规则计算的分桶结果（公式列，勿直接修改）。\n如需调整，在P列选目标桶，Q列说明原因。O列始终保留自动判断结果供复盘参考。',
        P1: '手动分桶：非空时覆盖自动分桶（O列），R列显示"桶名★"。\n用途：纠正误分类/强制品牌词进指定桶/试验性调整。\n所有手动调整必须在Q列填写原因，复盘时判断是否调整分类规则。',
        Q1: '调整原因示例：\n"品牌词，强制快速胜利" / "CPC=0且无商业意图，误入战略词" / "试验：观察低KD定义词SERP弱度表现"',
        R1: '分桶（最终结果，只读公式列）：★=人工调整（P列非空），无★=自动分桶结果。\n⚠️ 请勿直接修改R列。如需调整：P列选目标桶→Q列填原因→R列自动更新显示"桶名★"。\n各桶视图Sheet按此列筛选，是决定一个词"去哪里执行"的最终依据。',
        S1: 'AIO预判（自动）：搜索量≥500且含 what is/meaning/definition/how does/explained 时自动标注。\n仅供参考，须在T列用无痕窗口实际确认后填写最终结论。',
        T1: 'AIO风险（手动，S列标记⚠️疑似高风险词须优先确认）：无痕窗口搜索目标词，查看是否出现AI Overview框。\n高：搜索结果顶部有AI Overview摘要框（须用无痕窗口，避免个性化影响）\n低：无AI Overview框\n未查：待确认\n高风险内容策略：避免纯定义型，改为操作型/对比型/案例型，增加原创视角。',
        U1: '弱度意图分（自动）：H列SERP弱度+M列意图的合成分，供快速胜利桶视图排序、并在集群模式下作聚类辅助分流信号；不是执行优先级——执行优先级是集群级的（见主题集群表 priority）。\nH列SERP弱度：✅弱=3/⚠️中=2/❌强=1；M列意图：Commercial或Problem-aware各+1分。\nH列（SERP弱度）填完后排序才有实际意义。',
      },
    },
  },

  {
    name: '主题集群表',
    type: 'standard',
    header: ['cluster_id', 'cluster_name', 'track', 'content_layer', 'business_role', 'primary_entity', 'jtbd', 'content_angle', 'us_share', 'pillar_page', 'series_pattern', 'keywords_included', 'page_assets', 'internal_link_rule', 'cta_primary', 'psych_safety_flag', 'priority', 'week', 'success_metric'],
    headerColorByCol: {
      1: 'green', 2: 'green', 3: 'green', 4: 'green', 5: 'slate', 6: 'green', 7: 'slate', 8: 'slate',
      9: 'green', 10: 'slate', 11: 'slate', 12: 'slate', 13: 'slate', 14: 'slate', 15: 'green',
      16: 'green', 17: 'green', 18: 'green', 19: 'slate',
    },
    extras: {
      frozenRows: 1,
      headerFontColor: 'white',
      headerBold: true,
      headerFontSize: 11,
      columnWidths: [110, 160, 70, 140, 90, 110, 200, 170, 70, 150, 150, 160, 140, 170, 90, 100, 60, 80, 170],
      dataValidations: [
        { range: 'C2:C1500', list: ['量产线', '精修线'] },
        { range: 'D2:D1500', list: ['Core Astrology', 'Product-led Journal', 'Tool-led', 'Wiki Support', 'Quarantine'] },
        { range: 'I2:I1500', list: ['高', '中', '低'] },
        { range: 'O2:O1500', list: ['Newsletter', '工具页', '星盘页', '注册'] },
        { range: 'P2:P1500', list: ['Y', 'N'] },
        { range: 'Q2:Q1500', list: ['P0', 'P1', 'P2'] },
        { range: 'R2:R1500', list: ['Week 1', 'Week 2', 'Week 3', 'Backlog'] },
      ],
      notes: {
        A1: 'cluster_id：手工编号，如 clu_aura_colors。全流程外键，命名稳定不随标题变。',
        B1: 'cluster_name：可读名，如「Aura Colors 核心」。',
        C1: 'track：量产线=aura/Vedic/nakshatra 走量；精修线=自我认知/疗愈走差异化（PRD v0.7 §3.2）。两线都活在种子模板「Track A SEO」之下，与种子模板的「Track B Social Probe」不同维度，不要混。',
        D1: 'content_layer：Core Astrology / Product-led Journal / Tool-led / Wiki Support / Quarantine（脱离主线，不做）。',
        E1: 'business_role：业务角色——流量 / 权威 / 转化 / 工具承接 / newsletter 承接。',
        F1: 'primary_entity：主实体（Birth Chart / Moon Sign / Chiron 等）。决定语义主权，同站其他集群不应再用同实体（防内耗）。',
        G1: 'jtbd：用户带着什么任务来——理解 X 含义 / 查我的 X / 通过 X 反思自己。',
        H1: 'content_angle：本集群的差异化角度。精修线必填（如：用 chiron 反思隐藏的情绪与关系模式）；量产线留空（用模板默认）。',
        I1: 'us_share 三档地区标签（PRD v0.7 §3.3）：\n高=目标国主导（aura/houses 等欧美向），正常进量产线、计入目标国 PV；\n低=非目标国主导（nakshatra/rashi 等印度向），不占 P0 产能；\n中=拿不准，查 2-3 头部词 Ahrefs by-country 饼图。靠主题常识判断即可，不算精确百分比。',
        J1: 'pillar_page：Pillar 页 URL（已发布）或拟定标题（规划中）。每个核心集群最多 1 个 Pillar。',
        K1: 'series_pattern：Series 批量规则，如「Moon in 12 Signs」「Planets in Houses」。',
        L1: 'keywords_included：本集群覆盖的关键词列表（逗号分隔），与关键词主表交叉验证。',
        M1: 'page_assets：本集群已规划/发布的 page_id 列表，与选题登记表交叉验证。',
        N1: 'internal_link_rule：Pillar↔Series↔Support 内链规则；建议每 Series 前 30% 链 Pillar、同簇 Spoke 互链 1-2 条（W21 评审 B-7）。',
        O1: 'cta_primary：本集群默认主 CTA（Newsletter / 工具页 / 星盘页 / 注册）。页面级 CTA 仍由 page_role + track 经 CTA Map 决定，这里标方向。',
        P1: 'psych_safety_flag：Y/N。涉及 healing/trauma/relationship wound/anxiety 时 Y，触发心理安全 QA（附录 B 非临床反思语言规则）。',
        Q1: 'priority：P0 / P1 / P2。P0=本周必启动；P1=排队；P2=暂缓或战略低配（如 us_share=低 的集群）。',
        R1: 'week：计划启动周——Week 1 / Week 2 / Week 3 / Backlog。',
        S1: 'success_metric：Day 30 / Day 60 衡量本集群是否成功的具体指标（如：Day 30 至少 5 词进 Top 50、Day 60 美国 PV 月贡献 ≥ 1000）。',
      },
    },
  },

  {
    name: '选题登记表',
    type: 'standard',
    // bilingual-v9: col 22 target_keyword_zh added for ZH main long-tail (ops
    // hand-fills; LLM derivation is fallback). gg-sheet-pull picks this up
    // automatically via header_map; composeCfg transfers it to fixture; phase2
    // RL4/RL5 prefer it over H1-derive.
    header: ['Target Keyword', 'Associated Keywords', '月搜索量', 'KD', 'Intent', 'Tier', 'Template', 'Entity', 'Friction', 'Logic', 'CTA', 'GSC Keywords', 'Status', 'URL', 'Last Audit', 'page_id', 'cluster_id', 'page_role', 'content_angle', 'psych_safety_flag', 'journal_prompts', 'target_keyword_zh'],
    headerColorByCol: {
      // navy: 3 4 (VLOOKUP)
      // green: 1 5 6 7 8 13 16 17 18 20
      // slate: 2 9 10 11 12 14 15 19 21 22
      1: 'green', 2: 'slate', 3: 'navy', 4: 'navy', 5: 'green', 6: 'green', 7: 'green',
      8: 'green', 9: 'slate', 10: 'slate', 11: 'slate', 12: 'slate', 13: 'green',
      14: 'slate', 15: 'slate', 16: 'green', 17: 'green', 18: 'green', 19: 'slate',
      20: 'green', 21: 'slate', 22: 'slate',
    },
    extras: {
      frozenRows: 1,
      headerFontColor: 'white',
      headerBold: true,
      headerFontSize: 11,
      columnWidths: [180, 220, 80, 55, 80, 55, 110, 110, 150, 150, 90, 140, 70, 200, 90, 130, 150, 80, 180, 100, 200, 180],
      formulas: {
        C2: `=IF($A2="","",IFERROR(VLOOKUP($A2,'关键词主表'!$A:$X,3,FALSE),"未找到"))`,
        D2: `=IF($A2="","",IFERROR(VLOOKUP($A2,'关键词主表'!$A:$X,4,FALSE),"未找到"))`,
      },
      formulaFillDown: [{ src: 'C2:D2', dst: 'C3:D1500' }],
      dataValidations: [
        { range: 'E2:E1500', list: ['Info', 'Compare', 'Tutorial', 'Utility', 'Experience', 'BOFU'] },
        { range: 'F2:F1500', list: ['T1', 'T2', 'T3'] },
        { range: 'G2:G1500', list: ['Definition', 'Comparison', 'Tutorial', 'Programmatic', 'Case Study'] },
        { range: 'M2:M1500', list: ['待写', '写作中', '质检', '已发布', '已刷新'] },
        { range: 'R2:R1500', list: ['Pillar', 'Series', 'Support', 'Tool', 'Wiki', 'Strategic'] },
        { range: 'T2:T1500', list: ['Y', 'N'] },
      ],
      notes: {
        A1: 'Target Keyword：本页核心词。集群可用「主行/留空/次行」排版，但页面角色以 R 列 page_role 为准（不靠行位置）。',
        B1: 'Associated Keywords：1+N 嵌套长尾词（本页 secondary）。同意图变体合并到本页，禁止按数量机械拆 Part。',
        C1: '月搜索量：公式自动从「关键词主表」VLOOKUP，勿手填。"未找到"=该词在主表没匹配上，核对关键词字符串。主表 C 列已切到目标国数值。',
        D1: 'KD：公式自动从「关键词主表」VLOOKUP，勿手填。',
        E1: 'Intent：Info / Compare / Tutorial / Utility / Experience / BOFU。决定 Template 选择。',
        F1: 'Tier：T1 重装（Pillar/战略/心理风险页，审 60-120 分钟）/ T2 标准（Series 主力，30-45 分钟）/ T3 占位（极长尾，10-20 分钟）。每周 T1 ≤ 3 篇（审核产能上限，PRD v0.7 §7.5）。',
        G1: 'Template：Definition / Comparison / Tutorial / Programmatic / Case Study。和 Intent 配对，具体结构见 PRD v0.7 附录 A 5 个页面模板。',
        H1: 'Entity：本页主权实体，如 Midheaven。同集群其他页不能再用同 Entity，防内容内耗。',
        I1: 'Friction：真实痛点证据（Reddit/论坛抓取的具体案例）。T1 必填、T2 AI 辅助、T3 跳过。严禁填形容词。',
        J1: 'Logic：机制 + 权衡（Mechanism + Trade-off）。T1 必填、T2 必填、T3 跳过。',
        K1: 'CTA：页面 CTA 文案/URL。可由 R 列 page_role + track 经 CTA Map 自动决定，不必逐页手填（只在偏离默认时填）。',
        L1: 'GSC Keywords：发布 30 天后从 GSC 抓取该 URL 已获排名但正文中缺失的词，用于内容刷新。维护期填。',
        M1: 'Status：待写 / 写作中 / 质检 / 已发布 / 已刷新。',
        N1: 'URL：发布后填入正式在线网址。',
        O1: 'Last Audit：最后一次内容审计/刷新日期。',
        P1: 'page_id：6-ID 主键，如 page_chiron_7th_house。手工编号，命名稳定。',
        Q1: 'cluster_id：外键 → 主题集群表。每个页面必须归属一个集群，无 cluster_id 的页面属违规（PRD v0.7 §2.3）。',
        R1: 'page_role：Pillar / Series / Support / Tool / Wiki / Strategic。决定页面广深、内链方向、CTA 选择。显式列，不靠行位置。',
        S1: 'content_angle：精修线必填（差异化角度），量产线留空（用模板默认）。PRD v0.7 附录 C。',
        T1: 'psych_safety_flag：Y/N。Y 触发心理安全 QA——必须用反思性、非临床语言（附录 B），不做诊断/治疗承诺。默认 N。',
        U1: 'journal_prompts：仅精修线 product-led / healing 页填（如 chiron 反思 prompts）。量产线 aura/Vedic 长尾页留空。',
        V1: 'target_keyword_zh：中文版主长尾词（bilingual-v9）。运营手填，用于 ZH 文章 phase2 RL4/RL5 keyword anchor。留空则 LLM 自动从英文 target_keyword 派生（demo 模式）。命名规范见 BILINGUAL.md §6：2-8 字、无空格、无 AI 农场尾缀。',
      },
    },
  },

  {
    name: 'CTA Map',
    type: 'standard',
    header: ['cta_id', 'page_role', 'cta_文案', 'target_url', 'ga4_event_name', 'track'],
    headerColorByCol: { 1: 'green', 2: 'green', 3: 'green', 4: 'green', 5: 'slate', 6: 'green' },
    seedRows: [
      ['cta_tool_pillar', 'Pillar', '探索你的星盘 / aura', '（工具页 URL）', 'tool_click', '量产线'],
      ['cta_tool_series', 'Series', '查你的对应落座', '（工具页 URL）', 'tool_click', '量产线'],
      ['cta_tool_support', 'Support', '用工具验证', '（工具页 URL）', 'tool_click', '量产线'],
      ['cta_tool_use', 'Tool', '输入信息生成结果', '（工具页自身）', 'tool_use', '量产线'],
      ['cta_tool_wiki', 'Wiki', '测一测你的 aura', '（aura test URL）', 'tool_click', '量产线'],
      ['cta_news_b', 'Series', '订阅获取每周 journal prompts', '（newsletter URL，待搭建）', 'newsletter_signup', '精修线'],
    ],
    extras: {
      frozenRows: 1,
      headerFontColor: 'white',
      headerBold: true,
      headerFontSize: 11,
      columnWidths: [150, 90, 220, 200, 150, 80],
      dataValidations: [
        { range: 'B2:B1500', list: ['Pillar', 'Series', 'Support', 'Tool', 'Wiki', 'Strategic'] },
        { range: 'F2:F1500', list: ['量产线', '精修线'] },
      ],
      notes: {
        A1: 'cta_id：手工编号，如 cta_tool_pillar。页面生产卡按 page_role + track 引用对应 CTA。预填 6 行是 Week-1 默认（工具页优先，PRD v0.7 §10）。',
        B1: 'page_role：Pillar / Series / Support / Tool / Wiki / Strategic。这条 CTA 适用于哪种页面角色。',
        C1: 'cta_文案：用户在页面看到的 CTA 按钮/链接文字。简短行动指令。',
        D1: 'target_url：点击 CTA 跳转的 URL（工具页 URL / newsletter 注册页 URL 等）。',
        E1: 'ga4_event_name：与 GA4 配置的事件名一一对应（如 tool_click、newsletter_signup）。GA4 上线后填实。',
        F1: 'track：量产线 / 精修线。Week-1 默认：量产线→工具页；精修线→newsletter（待搭建）。阶段策略见 PRD v0.7 §10。',
      },
    },
  },

  {
    name: '结果复盘表',
    type: 'standard',
    header: ['outcome_id', 'page_id', 'cluster_id', 'url', 'day14_收录', 'day14_impressions', 'day30_进Top50词数', 'day30_clicks', 'day60_pv', 'day60_目标国pv', '决策', '备注'],
    headerColorByCol: { 1: 'green', 2: 'green', 3: 'green', 4: 'green', 5: 'green', 6: 'slate', 7: 'slate', 8: 'slate', 9: 'slate', 10: 'slate', 11: 'green', 12: 'slate' },
    extras: {
      frozenRows: 1,
      headerFontColor: 'white',
      headerBold: true,
      headerFontSize: 11,
      columnWidths: [130, 130, 170, 220, 90, 130, 130, 100, 90, 120, 70, 260],
      dataValidations: [
        { range: 'E2:E1500', list: ['Y', 'N'] },
        { range: 'K2:K1500', list: ['继续', '调整', '暂停'] },
      ],
      notes: {
        A1: 'outcome_id：6-ID 主键。每个页面 × 每个时点（Day 14 / 30 / 60）一行，或集群级汇总一行。手工编号如 out_001、out_clu_aura_d30。',
        B1: 'page_id：外键 → 选题登记表。页面级复盘时填。',
        C1: 'cluster_id：外键 → 主题集群表。集群级汇总时填。',
        D1: 'url：发布 URL。便于直接复盘。',
        E1: 'day14_收录：Y/N。GSC → URL Inspection 看页面是否已收录。Day 14 节点。',
        F1: 'day14_impressions：GSC 该 URL 近 14 天 impressions（按 Country 维度筛目标国）。手工粘贴 GSC 导出。',
        G1: 'day30_进Top50词数：该 URL 在 GSC 排名 P1-P50 的 query 数。Day 30 节点。',
        H1: 'day30_clicks：GSC 该 URL 近 30 天 clicks（目标国）。',
        I1: 'day60_pv：GA4 该 URL 近 60 天 page_view 总数（全部地区）。',
        J1: 'day60_目标国pv：GA4 按 Country 维度筛目标国后的 PV。核对「美国为主」目标用这个，不用全部 PV（PRD v0.7 §12 / §13）。',
        K1: '决策：继续 / 调整 / 暂停。按 PRD v0.7 §7.9 Day 14/30/60 规则判：Day 14 未收录→查技术；Day 30 P31-P80→刷新标题；Day 60 无信号→合并/noindex/暂停。',
        L1: '备注：复盘观察、调整原因、下一步动作。',
      },
    },
  },

  // 5 视图表（line 540-577）
  { name: '趋势词', type: 'view', formula: VIEW_FORMULAS.trend, headerColor: { red: 0.910, green: 0.961, blue: 0.914 }, note: '趋势词 — Trends比值降序 | K列G1✅相关+L列G2=Y双门槛 | 发现即执行，不等周计划' },
  { name: '快速胜利', type: 'view', formula: VIEW_FORMULAS.quickWin, headerColor: { red: 1.0, green: 0.976, blue: 0.769 }, note: '快速胜利 — 排序权重（H列SERP弱度+M列意图）→ 月搜索量 降序 | H列SERP弱度填完后排序才有意义 | Week1-4主执行' },
  { name: '战略词', type: 'view', formula: VIEW_FORMULAS.strategic, headerColor: { red: 0.890, green: 0.949, blue: 0.992 }, note: '战略词 — CPC降序（辅助参考，实际优先级以主题集群相关度人工排序为主）| Week3起每周1-2篇' },
  { name: '长尾词', type: 'view', formula: VIEW_FORMULAS.longTail, headerColor: { red: 0.988, green: 0.894, blue: 0.925 }, note: '长尾词 — 社区来源词验证搜索量后归入对应桶 | 50-100搜索量+意图明确→Week1并行 | 其余批量执行' },

  // 分桶规则 — 静态文档表（line 580-638）
  {
    name: '分桶规则',
    type: 'rules',
    // 用 rows 直接填多区段；下方 builder 用 raw values
    rows: [
      ['📋 分桶规则 & 操作参考', '', '', ''],
      ['', '', '', ''],
      ['一、前置关卡（顺序操作，共两种性质：过滤 / 标注）', '', '', ''],
      ['关卡', '操作列', '判断条件', '性质说明'],
      ['第一关：DR过滤', 'N列（公式自动）', 'DR差值≤30 → ✅通过；>30 → ❌跳过\n负值 = 你的站DR超越竞争均值，仍为✅通过', '唯一真正的过滤关卡，❌跳过的词不进入分桶，但保留在主表'],
      ['第二关：SERP弱度', 'H列（手动填写）', '✅弱 / ⚠️中 / ❌强 / 未查', '标注，不过滤；快速胜利桶必填；填写后U列排序权重自动更新'],
      ['第三关：AIO风险', 'T列（手动填写）', '高 / 低 / 未查', '标注，不过滤；搜索量≥500的定义型词优先确认；影响内容结构策略'],
      ['', '', '', ''],
      ['二、四桶分类规则（O列公式按以下优先级依次判断，通过DR过滤后才进入分桶）', '', '', ''],
      ['优先级', '桶名', '分类条件', '桶内排序'],
      ['① 最高', '❌ 跳过', 'DR差值>30（J列超标，N列=❌跳过）', '—'],
      ['②', '🚀 趋势词', 'Trends比值>1.2  且  KD<35  且  K列G1=✅相关  且  L列G2=Y', 'Trends比值降序（F列）'],
      ['③', '⚡ 快速胜利', '主规则：KD<20 且 搜索量≥100\n豁免规则：KD<20 且 M列意图=Problem-aware 或 Informational 且 搜索量≥50', 'H列SERP弱度权重(U列) → 搜索量 降序'],
      ['④', '🎯 战略词', 'KD 20-50  且  M列意图=Commercial 或 Transactional', 'CPC降序（辅助参考，实际以主题集群相关度人工排序为主）'],
      ['⑤ 兜底', '📌 长尾词', '其余所有通过DR过滤的词（含意图=待确认、搜索量低于阈值等未命中上述条件的词）', '—'],
      ['', '', '', ''],
      ['三、意图自动分类规则（M列公式，模式匹配，准确率约80%；未命中→待确认，需人工批量标注）', '', '', ''],
      ['意图类型', '触发词（含任意一个即判定为该类型）', '典型搜索场景', ''],
      ['Commercial', 'best · vs · alternative · comparison · review · pricing · top', '比较选型，有决策意图但未直接购买', ''],
      ['Transactional', 'buy · cost · cheap · discount · free trial · sign up', '直接购买或注册意图', ''],
      ['Problem-aware', 'fix · not working · how to fix · how to solve · problem · error', '遇到问题，寻求解决方案', ''],
      ['Informational', 'how to · what is · guide · tutorial · why · explained', '学习了解，暂无直接商业意图', ''],
      ['待确认', '未命中以上任何模式', '批量粘贴到Claude/GPT，用《关键词研究SOP》第四节prompt批量标注意图', ''],
      ['', '', '', ''],
      ['四、人工调整分桶：P列选目标桶 → Q列填调整原因 → R列自动更新为"桶名★"\nO列（分桶_自动）始终保留原始公式计算结果，供复盘时对比差异，判断是否需要调整分类规则本身。', '', '', ''],
    ],
    extras: {
      frozenRows: 1,
      columnWidths: [120, 120, 370, 230],
      cellStyling: [
        // 标题行（A1）
        { range: 'A1:D1', bg: COLORS.navy, fontColor: 'white', bold: true, fontSize: 13 },
        // 一、前置关卡（A3 标题灰底 + A4 标题深蓝）
        { range: 'A3:D3', bg: { red: 0.910, green: 0.918, blue: 0.945 }, bold: true },
        { range: 'A4:D4', bg: { red: 0.224, green: 0.286, blue: 0.671 }, fontColor: 'white', bold: true },
        // 二、四桶
        { range: 'A9:D9', bg: { red: 0.910, green: 0.961, blue: 0.914 }, bold: true },
        { range: 'A10:D10', bg: COLORS.green, fontColor: 'white', bold: true },
        // 三、意图
        { range: 'A17:C17', bg: { red: 1.0, green: 0.953, blue: 0.878 }, bold: true },
        { range: 'A18:C18', bg: { red: 0.902, green: 0.318, blue: 0.0 }, fontColor: 'white', bold: true },
        // 四、说明（斜体灰底）
        { range: 'A25:D25', bg: { red: 0.961, green: 0.961, blue: 0.961 }, italic: true },
      ],
      rowHeights: { 5: 60, 6: 60, 7: 60, 11: 60, 12: 60, 13: 60, 14: 60, 15: 60, 19: 60, 20: 60, 21: 60, 22: 60, 23: 60 },
      wrapStrategy: ['A5:D7', 'A11:D15', 'A19:C23'],
    },
  },

  // 内容追踪 (line 642-670)
  {
    name: '内容追踪',
    type: 'standard',
    header: ['关键词', '分桶', '发布日期', '内容URL', 'KD', '月搜索量', '预期排名(W8)', '预期流量(W8)', '实际排名(W4)', '实际排名(W8)', '实际流量(W8)', '偏差%', '页面类型匹配', '备注'],
    headerColorByCol: {}, // 用 header 整体深灰
    extras: {
      frozenRows: 1,
      headerBgAll: 'header',
      headerFontColor: 'white',
      headerBold: true,
      columnWidths: [250, 80, 90, 220, 60, 90, 110, 110, 110, 110, 110, 80, 130, 200],
      formulas: { G2: TRACK_FORMULAS.G, H2: TRACK_FORMULAS.H, L2: TRACK_FORMULAS.L },
      formulaFillDown: [{ src: 'G2:H2', dst: 'G3:H1500' }, { src: 'L2', dst: 'L3:L1500' }],
      notes: {
        M1: '发布前填写预计页面格式（如：how-to教程/对比页/工具页）\n发布后对比实际Top3格式，判断是否匹配——格式不匹配是排名不达预期的常见原因',
      },
    },
  },

  // 来源分析 (line 674-690)
  {
    name: '来源分析',
    type: 'standard',
    header: ['来源', '执行词数', '已发布', '命中(P1-P30)', '命中率', '下次是否加大投入？'],
    headerColorByCol: {},
    extras: {
      frozenRows: 1,
      headerBgAll: 'header',
      headerFontColor: 'white',
      headerBold: true,
      columnWidths: [120, 90, 90, 110, 80, 180],
      seedRows: SOURCE_LIST.map((src, i) => [src, 0, 0, 0, `=IF(B${i + 2}=0,"",TEXT(D${i + 2}/B${i + 2},"0.0%"))`, '']),
      tailRow: ['合计', '=SUM(B2:B7)', '=SUM(C2:C7)', '=SUM(D2:D7)', '=IF(B8=0,"",TEXT(D8/B8,"0.0%"))', ''],
      tailRowStyle: { bg: { red: 0.925, green: 0.937, blue: 0.945 }, bold: true },
      notes: { A1: '命中率最高的来源=GenGrowth产品优先自动化的模块' },
    },
  },

  // ────────── 项目运维 6 tab（保留 + 不在 .gs 里）──────────
  {
    name: 'README',
    type: 'standard',
    rows: [
      ['gengrowth-flow-mvp · v8 pipeline workbook (PRD v0.7 附录 D 复刻)'],
      [],
      ['Owner: xdawayer@gmail.com. Writer SA: gg-writer-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com'],
      [`Schema 复刻自: docs/spec/upstream-canon/keyword-sheet-setup.gs (v3.1)`],
      [`Bootstrap on: ${new Date().toISOString()}`],
      [],
      ['Tab', '用途', '读/写方'],
      ['配置', '目标国家 / TOPIC_KEYWORDS / NEGATIVE_KEYWORDS', '人工初始化，全公式 vlookup'],
      ['关键词主表', 'A-X 24 列；J/K/M/N/O/R/S/U 为公式自动', 'mine/promote 写 A-I；公式列勿动'],
      ['主题集群表', 'cluster_id / track / us_share 等', '人工填'],
      ['选题登记表', '21 列 v2.1（v2.0 15 列 + 新 6 列）', 'promote 写 A；人工补 B-U'],
      ['CTA Map', 'page_role → CTA 文案', '人工填，预填 6 行 Week-1 默认'],
      ['结果复盘表', 'Day 14/30/60 GSC+GA4 数据', '维护期手粘'],
      ['趋势词 / 快速胜利 / 战略词 / 长尾词', '主表 R 列分桶视图（公式自动）', '只读视图'],
      ['分桶规则', '文档表，PRD §7.3.2 规则说明', '只读'],
      ['内容追踪', '预期 vs 实际偏差', '人工填'],
      ['来源分析', '6 来源命中率统计', '人工填'],
      ['keyword_candidates', 'mine 副表，wzb_approve 后 promote', 'mine 写 / promote 读'],
      ['pipeline-status / publish-log / quality-metrics / cost-tracking / config', '项目运维（gg-status.mjs）', '自动'],
      ['monitor-auto', 'GSC + GA4 自动回填（区别于人工填的 内容追踪）', '自动 gg-monitor.mjs'],
      ['failure-log', 'phase2 FAIL 时 append；retro 聚类找 prompt template 改进点', '自动 _phase2-validate.mjs'],
      [],
      ['→ 操作手册：docs/PIPELINE.md'],
      ['→ CEO 看板：docs/OPS_OVERVIEW.md'],
      ['→ SSOT spec：docs/spec/upstream-canon/'],
      ['→ Mine audit：docs/KEYWORD_MINE_AUDIT.md'],
    ],
    extras: { columnWidths: [240, 360, 200] },
  },

  {
    name: 'keyword_candidates',
    type: 'standard',
    header: ['run_id', 'entity', 'query', 'source', 'search_volume', 'keyword_difficulty', 'cpc', 'serp_features', 'geo_score', 'ai_recommend', 'wzb_approve'],
    headerColorByCol: {},
    extras: { frozenRows: 1, headerBgAll: 'header', headerFontColor: 'white', headerBold: true },
  },

  {
    name: 'pipeline-status',
    type: 'standard',
    header: ['page_id', 'target_keyword', 'cluster_id', 'tier', 'template', 'candidate_in_sheet', 'approved', 'promoted', 'brief_filled', 'override_path', 'batch_path', 'rag_entity', 'rag_obsidian', 'rag_friction_real', 'prompt_path', 'rendered_llms', 'phase2_status', 'wiki_published_path', 'commit_hash', 'last_updated'],
    headerColorByCol: {},
    extras: { frozenRows: 1, headerBgAll: 'header', headerFontColor: 'white', headerBold: true },
  },

  {
    name: 'publish-log',
    type: 'standard',
    header: ['timestamp', 'page_id', 'llm', 'tier', 'template', 'wiki_path_prod', 'wiki_path_obs', 'commit_hash', 'phase2_overall', 'words', 'wikilinks_total', 'wikilinks_tbd', 'operator'],
    headerColorByCol: {},
    extras: { frozenRows: 1, headerBgAll: 'header', headerFontColor: 'white', headerBold: true },
  },

  {
    name: 'quality-metrics',
    type: 'standard',
    header: ['timestamp', 'page_id', 'llm', 'tag', 'structure_pass', 'rl1_pass', 'rl2_pass', 'rl3_pass', 'rl4_pass', 'rl5_pass', 'rl6_pass', 'overall', 'words', 'rl4_drifted_sections', 'rl5_keyword_count'],
    headerColorByCol: {},
    extras: { frozenRows: 1, headerBgAll: 'header', headerFontColor: 'white', headerBold: true },
  },

  {
    name: 'cost-tracking',
    type: 'standard',
    header: ['timestamp', 'operation', 'tool', 'page_id', 'tokens_in', 'tokens_out', 'tokens_total', 'cost_usd', 'api_calls', 'notes'],
    headerColorByCol: {},
    extras: { frozenRows: 1, headerBgAll: 'header', headerFontColor: 'white', headerBold: true },
  },

  // _phase2-validate.mjs FAIL 时 append；retro 聚类用：80% fail = RL4 → 改 prompt template
  {
    name: 'failure-log',
    type: 'standard',
    header: ['timestamp', 'stage', 'tool', 'page_id', 'llm', 'tag', 'failed_checks', 'fail_reason', 'notes'],
    headerColorByCol: {},
    extras: {
      frozenRows: 1,
      headerBgAll: 'header',
      headerFontColor: 'white',
      headerBold: true,
      columnWidths: [180, 80, 160, 200, 100, 100, 180, 320, 240],
    },
  },

  // gg-monitor.mjs Stage 17 自动写入 tab（ASCII 名，便于索引；区分人工填的 内容追踪）
  {
    name: 'monitor-auto',
    type: 'standard',
    header: ['report_date', 'url', 'clicks', 'impressions', 'ctr', 'position', 'sessions', 'avg_dwell_s', 'engagement_rate', 'cta_signups'],
    headerColorByCol: {},
    extras: {
      frozenRows: 1,
      headerBgAll: 'header',
      headerFontColor: 'white',
      headerBold: true,
      columnWidths: [110, 280, 80, 100, 80, 80, 80, 100, 110, 100],
    },
  },

  {
    name: 'config',
    type: 'standard',
    rows: [
      ['key', 'value', 'unit', 'changed_at', 'changed_by', 'rationale'],
      ['mine.max_kd', '50', 'KD', '', 'bootstrap', 'DataForSEO Labs KD upper bound'],
      ['mine.min_volume', '50', 'searches/mo', '', 'bootstrap', 'minimum monthly search volume'],
      ['mine.max_results', '15', 'rows', '', 'bootstrap', 'top-N candidates per mine run'],
      ['mine.location_code', '2840', 'code', '', 'bootstrap', 'DataForSEO location (2840 = United States)'],
      ['mine.language_code', 'en', 'iso', '', 'bootstrap', 'DataForSEO language'],
      ['mine.read_negatives_from_sheet', 'true', 'bool', '', 'bootstrap', '从 配置!A28:A45 拉负向词（PRD §7.3.2 修法 #1）'],
      ['phase2.RL3_n_gram', '12', 'tokens', '', 'bootstrap', 'SERP plagiarism n-gram overlap threshold'],
      ['phase2.RL4_jaccard_floor', '0.05', 'ratio', '', 'bootstrap', 'per-H2 first-paragraph jaccard floor'],
      ['phase2.RL4_shingle_floor', '0.10', 'ratio', '', 'bootstrap', 'per-H2 first-paragraph 5-gram shingle floor'],
      ['phase2.RL4_drifted_sections_fail', '2', 'count', '', 'bootstrap', 'fail if >=N H2 sections drift'],
      ['phase2.RL5_keyword_max', '12', 'count', '', 'bootstrap', 'max target_keyword repetitions'],
      ['tier1.word_min', '2800', 'words', '', 'bootstrap', 'Pillar Tier 1 minimum'],
      ['tier1.word_max', '3500', 'words', '', 'bootstrap', 'Pillar Tier 1 maximum'],
      ['tier2.word_min', '1500', 'words', '', 'bootstrap', 'Definition/Tutorial Tier 2 minimum'],
      ['tier2.word_max', '1800', 'words', '', 'bootstrap', 'Definition/Tutorial Tier 2 maximum'],
      ['prompt.version', 'v8', 'tag', '', 'bootstrap', 'current prompt template version'],
    ],
    extras: {
      frozenRows: 1,
      headerBgAll: 'header',
      headerFontColor: 'white',
      headerBold: true,
      columnWidths: [220, 100, 90, 110, 100, 320],
    },
  },
];

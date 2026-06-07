/**
 * GenGrowth 关键词研究主表 · 一键生成脚本 v3.3
 * 配合《关键词研究 SOP（六源挖掘 → 四桶分级）》+ GenGrowth MVP PRD v0.8 使用
 *
 * v3.3 变更（2026-06-05）：
 *   - 将「是否进入生产」与「生产进度」拆开：
 *     V 生产准入_自动 / W 手动生产准入 / X 生产准入 / Y 生产状态
 *   - Z 回填 page_id，AA 发布URL，AB 备注
 *
 * v3.2 变更（2026-06-04）：
 *   - N 列从「DR过滤」改为「竞争建议」：DR/KD 不再作为架构删除规则，只提示可做/暂缓
 *   - O/R 分桶保留四桶机会分类；高 DR/KD 词仍归入分桶，供集群架构使用
 *   - V 列改为「生产状态」：可生产 / 暂缓 / 集群必需 / 无关 / 已建卡 / 已发布
 *   - 新增「🧩生产候选」视图：仅汇总 V 列为可生产/集群必需/已建卡/已发布的关键词
 *
 * v3.1 变更（2026-05-20）：
 *   - 4 张新增表（主题集群表 / 选题登记表 / CTA Map / 结果复盘表）表头加颜色区分：
 *       深蓝 #1a237e = 公式自动 / 深绿 #2e7d32 = 必填手动 / 深灰 #455a64 = 选填或条件字段
 *   - 4 张表逐列加字段注释（hover 表头查看），口径对齐 PRD v0.7
 *
 * v3.0 变更（对齐 PRD v0.7 附录 D）：
 *   - ⚙️配置 新增「目标国家」(B4) 与 NEGATIVE_KEYWORDS 负向词区 (A28:A45)
 *   - 关键词主表 O 列分桶公式最前面加 NEGATIVE_KEYWORDS 否决
 *   - K 列 G1话题相关 公式修复空配置格 bug（旧版 SEARCH("",A2)=1 会把所有词误判✅相关）
 *   - 新增 4 张表：主题集群表 / 选题登记表 / CTA Map / 结果复盘表（落地 6-ID 体系）
 *
 * 使用方法：
 * 1. 打开任意 Google Sheet → 扩展程序 → Apps Script
 * 2. 粘贴本文件全部内容，替换默认代码
 * 3. 运行 createGenGrowthKeywordSheet
 * 4. 授权后自动创建新文件，链接打印在日志中
 * ⚠️  运行后请先在 ⚙️配置 表填写：目标国家(B4)、TOPIC_KEYWORDS(A6起)、NEGATIVE_KEYWORDS(A28起)
 *
 * 生成 14 个工作表：
 *   ⚙️配置 / 关键词主表 / 主题集群表 / 选题登记表 / CTA Map / 结果复盘表 /
 *   🧩生产候选 / 🚀趋势词 / ⚡快速胜利 / 🎯战略词 / 📌长尾词 / 📋分桶规则 / 📊内容追踪 / 📈来源分析
 *
 * 列结构（关键词主表，A–AB 共 28 列）：
 *   A  关键词         手动
 *   B  来源           下拉
 *   C  月搜索量       手动（Ahrefs/SEMrush）
 *   D  KD             手动
 *   E  CPC($)         手动（辅助参考，不作分类主条件）
 *   F  Trends比值     手动（近3M均值÷近6M均值，留空=平稳）
 *   G  Top10最低2站DR均值  手动（Top10 中 DR 最低的 2 站均值，规避高DR站把平均拉高，新站友好）
 *   H  SERP弱度       下拉（✅弱/⚠️中/❌强/未查）查词时同步判断，快速胜利桶必填
 *   I  自有站DR       手动（查词当时你的站DR快照，每词独立记录，不会被覆盖）
 *   J  DR差值         公式（G - I；正值=竞争强于你；负值=你已超越，仍✅通过）
 *   K  G1话题相关     公式（匹配配置!TOPIC_KEYWORDS，趋势词闸门1）
 *   L  G2可承接       下拉（Y/N，站内能承接该话题，趋势词闸门2）
 *   M  意图           公式（Commercial/Transactional/Problem-aware/Informational/待确认）
 *   N  竞争建议       公式（J>30→⏸暂缓；≤30→✅可做；仅建议，不删除架构）
 *   O  分桶_自动      公式（四桶分类逻辑，不含人工干预）
 *   P  手动分桶       下拉（非空时覆盖O，R列显示桶名+"★"）
 *   Q  调整原因       手动（记录人工调整依据，供复盘是否调整规则）
 *   R  分桶           公式（最终结果：P非空→P+"★"，否则=O）★=人工调整
 *   S  AIO预判        公式（搜索量≥500+定义型词→⚠️疑似高风险，供人工抽检参考）
 *   T  AIO风险        下拉（高/低/未查）人工无痕窗口确认后填写
 *   U  弱度意图分     公式（H列SERP弱度+M列意图；集群模式下为聚类辅助分流，非执行优先级）
 *   V  生产准入_自动  公式（可生产/暂缓/无关）
 *   W  手动生产准入   下拉（可生产/暂缓/集群必需/无关）
 *   X  生产准入       公式（W非空→W，否则=V）
 *   Y  生产状态       下拉（未开始/已建卡/已发布/已合并/暂停）
 *   Z  page_id        手动（建卡后回填）
 *   AA 发布URL        手动
 *   AB 备注           手动
 */

function createGenGrowthKeywordSheet() {
  var ss = SpreadsheetApp.create('GenGrowth 关键词研究主表');
  var CFG = "'⚙️配置'"; // 配置表引用（含特殊字符需单引号）

  // ────────────────────────────────────────────
  // SHEET 0: ⚙️配置
  // ────────────────────────────────────────────
  var configSh = ss.getActiveSheet();
  configSh.setName('⚙️配置');

  configSh.getRange('A1:B1')
    .setValues([['配置项', '值']])
    .setBackground('#37474f').setFontColor('#ffffff').setFontWeight('bold');

  configSh.getRange('A2:B4').setValues([
    ['客户产品名', ''],
    ['实验开始日期', ''],
    ['目标国家', '']
  ]);
  configSh.getRange('B4').setBackground('#fff9c4');
  configSh.getRange('A4').setNote(
    '目标国家（Day-0 参数，如 US）。约束：\n' +
    '① Ahrefs Keywords Explorer 导出设为此国家，关键词主表 C 列即取该国月搜索量；\n' +
    '② SERP 弱度检查用此国家的 Google；\n' +
    '③ 主题集群表 us_share 标签据此判断。'
  );

  configSh.getRange('A5').setValue('TOPIC_KEYWORDS（趋势词G1相关性检测，每行一个话题词）');
  configSh.getRange('A5').setFontWeight('bold').setBackground('#e8f5e9');

  // 默认示例词（初始化后替换为实际产品话题）
  var defaultTopics = ['seo', 'marketing', 'growth', 'content', 'keyword'];
  for (var i = 0; i < defaultTopics.length; i++) {
    configSh.getRange(6 + i, 1).setValue(defaultTopics[i]);
  }
  configSh.getRange('A6:A25').setBackground('#f9fbe7');
  configSh.getRange('A6').setNote(
    '替换为客户产品相关的核心话题词（英文），最多20行（A6:A25）。\n' +
    '例 astrologywiki：astrology, birth chart, horoscope, natal chart, mercury retrograde\n' +
    '命中TOPIC_KEYWORDS → K列G1话题相关=✅相关（趋势词闸门1通过）'
  );

  // NEGATIVE_KEYWORDS（负向词，v3.0 新增）
  configSh.getRange('A27').setValue('NEGATIVE_KEYWORDS（负向词，关键词含其一即在主表 O 列判 ❌无关，每行一个）');
  configSh.getRange('A27').setFontWeight('bold').setBackground('#ffcdd2');
  var defaultNegatives = ['miami', 'dade', 'trimet', 'hub city', 'bus tracker'];
  for (var ni = 0; ni < defaultNegatives.length; ni++) {
    configSh.getRange(28 + ni, 1).setValue(defaultNegatives[ni]);
  }
  configSh.getRange('A28:A45').setBackground('#fff5f5');
  configSh.getRange('A28').setNote(
    '负向词：与产品无关的词根，关键词命中即在关键词主表 O 列直接判 ❌无关。\n' +
    '最多18行（A28:A45），子串匹配，填词根即可（"bus tracker" 命中 "miami dade bus tracker"）。\n' +
    '默认值是 astrologywiki 的公交类无关词示例，换产品时替换为该产品的无关词；留空=不否决。'
  );

  configSh.setColumnWidth(1, 320);
  configSh.setColumnWidth(2, 180);

  // ────────────────────────────────────────────
  // SHEET 1: 关键词主表
  // ────────────────────────────────────────────
  var master = ss.insertSheet('关键词主表');

  var headers = [
    '关键词',         // A  1
    '来源',           // B  2
    '月搜索量',       // C  3
    'KD',             // D  4
    'CPC($)',         // E  5
    'Trends比值',     // F  6
    'Top10最低2站DR均值', // G  7  ← 查词时手动填（取Top10中DR最低的2站均值）
    'SERP弱度',       // H  8  ← 前移，查词同步判断（必填）
    '自有站DR',       // I  9  ← 新增：查词当时站DR快照
    'DR差值',         // J  10 ← 公式 G-I
    'G1话题相关',     // K  11
    'G2可承接',       // L  12
    '意图',           // M  13
    '竞争建议',       // N  14
    '分桶_自动',      // O  15
    '手动分桶',       // P  16
    '调整原因',       // Q  17
    '分桶',           // R  18
    'AIO预判',        // S  19
    'AIO风险',        // T  20
    '弱度意图分',     // U  21
    '生产准入_自动',  // V  22
    '手动生产准入',   // W  23
    '生产准入',       // X  24
    '生产状态',       // Y  25
    'page_id',        // Z  26
    '发布URL',        // AA 27
    '备注'            // AB 28
  ];

  master.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontColor('#ffffff').setFontWeight('bold').setFontSize(11);

  // 三色表头：深蓝=公式自动 / 深绿=必填手动 / 深灰=选填手动
  var navyCols  = [10, 11, 13, 14, 15, 18, 19, 21, 22, 24]; // J K M N O R S U V X
  var greenCols = [1, 2, 3, 4, 7, 8, 9];             // A B C D G H I
  var slateCols = [5, 6, 12, 16, 17, 20, 23, 25, 26, 27, 28]; // E F L P Q T W Y Z AA AB
  navyCols.forEach(function(c)  { master.getRange(1, c).setBackground('#1a237e'); });
  greenCols.forEach(function(c) { master.getRange(1, c).setBackground('#2e7d32'); });
  slateCols.forEach(function(c) { master.getRange(1, c).setBackground('#455a64'); });

  master.setFrozenRows(1);

  // 列头说明（关键易错列）
  var notes = {
    3:  '月搜索量取「目标国家」(⚙️配置!B4) 的数值。Ahrefs Keywords Explorer 把国家设为目标国后导出的 Volume 即此列，不用全球量。',
    5:  'CPC仅做参考展示，不用于分桶判断。战略词的主条件是意图（M列），不是CPC高低。',
    6:  'Trends比值（手动，趋势词判断用）：近3个月均值 ÷ 近6个月均值。\n>1.2 = 近期上涨（趋势词候选）\n≈1.0 = 稳定\n<0.8 = 衰退词\n获取：Google Trends 或 Ahrefs "Trend"图表目测估算。留空视为平稳，仅趋势词分桶条件使用。',
    7:  'Top10最低2站DR均值（查词时手动填写）：取Top10结果中DR最低的2个站，求均值。\n\n为何不用全平均？前期自有站DR=0或接近0，几个高DR站（如WordPress.com DR=94、Reddit DR=91）会把全平均拉到80+，几乎所有词被N列误判为❌跳过；看末两位DR更贴近"你实际能挤进的位置"。\n\n获取：Ahrefs关键词详情页SERP Overview → 按DR升序排 → 取最低2行DR均值；或安装Ahrefs SEO Toolbar直接在Google搜索结果页读DR。\n注：每个词不同，需和H列SERP弱度、I列自有站DR同步填写。',
    8:  'SERP弱度（⚡快速胜利桶必填，查词时同步判断）\n\n判断方式（三种）：\n① Ahrefs关键词详情页 → SERP Overview：直接看每个排名页DR/UR，最快\n② 安装Ahrefs SEO Toolbar浏览器插件（免费）：Google搜索结果每条旁边直接显示DR/UR\n③ 手工Google搜索：看是否有论坛帖、内容薄弱页、无针对性优化的页面\n\n判断标准：\n✅弱：Top10中≥3个页面DR低/内容薄弱/或有论坛帖（Reddit/Quora等）排名 → 可超越\n⚠️中：Top10中有1-2个可超越位置\n❌强：Top10全部为高质量高DR站点\n\n注：Reddit(DR=91)/Quora(DR=88)虽然站DR高，但单帖内容薄弱且UR低，出现在Top10 = ✅弱信号——说明该词缺乏高质量专业内容，正是内容站机会所在。',
    9:  '自有站DR（查词当时的站DR快照，手动填写）：每次查词时填入你当前的Ahrefs站DR，只填一次，不随时间更新。\n获取：Ahrefs → 输入你的域名 → 查看Domain Rating。\n\n为何不用全局配置？G列是查词时的竞争快照，I列是同时刻你的站DR，两者配对才有意义。使用全局配置会导致新旧DR混用，比较无意义。',
    10: 'DR差值 = Top10最低2站DR均值（G）- 自有站DR（I），自动计算。\n差值>30 → N列提示⏸暂缓；差值≤30（含负值）→ ✅可做。\n负值（如-5）= 你的站DR已超越该词SERP末位站，更应执行，属于正常情况。\n注：G和I均为查词时快照，执行前如距填写超60天建议重新核查SERP。',
    11: 'G1话题相关：自动检测关键词是否命中⚙️配置!A6:A25的TOPIC_KEYWORDS列表。\n✅相关=话题相关；⚠️待确认=未命中，需人工判断后决定是否填L列=Y。\n初始化后必须先更新配置表话题词，否则默认示例词无意义。',
    12: 'G2可承接（手动）：站内是否有工具/内容/功能能承接该趋势词的用户需求？\n填Y才能进趋势桶；空值视为N。这是纯人工判断项，脚本无法自动识别。',
    13: '意图（自动，模式匹配，约80%准确）：\nCommercial: best/vs/alternative/review/pricing\nTransactional: buy/cost/free trial\nProblem-aware: fix/not working/error\nInformational: what is/how to/guide\n未命中→待确认，批量交Claude/GPT用SOP第四节prompt处理。',
    14: '竞争建议（公式）：基于J列DR差值自动判断。\n✅可做：差值≤30，默认可进入生产候选。\n⏸暂缓：差值>30，当前站DR不足以正面竞争，但仍可进入集群架构；若是 Pillar/核心实体，可在V列标「集群必需」。\n待填：G或I列未填，无法计算。\n注意：N列不是过滤关卡，DR/KD 不再决定是否从集群中删除。',
    15: '分桶_自动：系统按SOP规则计算的机会分桶（公式列，勿直接修改）。\n分桶仍存在，用于判断机会类型；生产优先级由主题集群表 priority + X列生产准入共同决定。\n如需调整，在P列选目标桶，Q列说明原因。O列始终保留自动判断结果供复盘参考。',
    16: '手动分桶：非空时覆盖自动分桶（O列），R列显示"桶名★"。\n用途：纠正误分类/强制品牌词进指定桶/试验性调整。\n所有手动调整必须在Q列填写原因，复盘时判断是否调整分类规则。',
    17: '调整原因示例：\n"品牌词，强制快速胜利" / "CPC=0且无商业意图，误入战略词" / "试验：观察低KD定义词SERP弱度表现"',
    18: '分桶（最终结果，只读公式列）：★=人工调整（P列非空），无★=自动分桶结果。\n⚠️ 请勿直接修改R列。如需调整：P列选目标桶→Q列填原因→R列自动更新显示"桶名★"。\n各桶视图Sheet按此列筛选；它表示机会类型，不再等同于生产状态。',
    19: 'AIO预判（自动）：搜索量≥500且含 what is/meaning/definition/how does/explained 时自动标注。\n仅供参考，须在T列用无痕窗口实际确认后填写最终结论。',
    20: 'AIO风险（手动，S列标记⚠️疑似高风险词须优先确认）：无痕窗口搜索目标词，查看是否出现AI Overview框。\n高：搜索结果顶部有AI Overview摘要框（须用无痕窗口，避免个性化影响）\n低：无AI Overview框\n未查：待确认\n高风险内容策略：避免纯定义型，改为操作型/对比型/案例型，增加原创视角。',
    21: '弱度意图分（自动）：H列SERP弱度+M列意图的合成分，供快速胜利桶视图排序、并在集群模式下作聚类辅助分流信号；不是执行优先级——执行优先级是集群级的（见主题集群表 priority）。\nH列SERP弱度：✅弱=3/⚠️中=2/❌强=1；M列意图：Commercial或Problem-aware各+1分。\nH列（SERP弱度）填完后排序才有实际意义。',
    22: '生产准入_自动（公式）：根据 O列分桶 和 N列竞争建议自动给出默认准入。\nO=❌无关 → 无关；N=✅可做 → 可生产；N=⏸暂缓 → 暂缓。\n此列不手改，如需调整用 W列。',
    23: '手动生产准入（人工覆盖）：可生产 / 暂缓 / 集群必需 / 无关。\n用途：把高DR但集群骨架必需的词从“暂缓”改为“集群必需”；或把自动可生产但本轮不做的词改为“暂缓”。',
    24: '生产准入（最终，公式）：W列非空则用W列，否则用V列。\n进入生产候选的准入值：可生产 / 集群必需。暂缓 / 无关 不进入。',
    25: '生产状态（人工进度）：未开始 / 已建卡 / 已发布 / 已合并 / 暂停。\n这列只追踪生产进度，不决定这个词是否应该生产。',
    26: 'page_id：建卡后回填选题登记表 page_id。多个关键词合并为同一页面时，可回填同一个 page_id。',
    27: '发布URL：发布后回填正式 URL。',
    28: '备注：人工说明、迁移备注、特殊判断。'
  };
  Object.keys(notes).forEach(function(col) {
    master.getRange(1, parseInt(col)).setNote(notes[col]);
  });

  // ── 下拉菜单 ──
  var dv = SpreadsheetApp.newDataValidation;
  master.getRange('B2:B500').setDataValidation(
    dv().requireValueInList(['竞品映射','内容缺口','种子词拓展','社区挖掘','趋势词','Social信号'], true).build());
  master.getRange('H2:H500').setDataValidation(  // H: SERP弱度
    dv().requireValueInList(['✅弱','⚠️中','❌强','未查'], true).build());
  master.getRange('L2:L500').setDataValidation(  // L: G2可承接
    dv().requireValueInList(['Y','N'], true).build());
  master.getRange('P2:P500').setDataValidation(  // P: 手动分桶
    dv().requireValueInList(['🚀趋势词','⚡快速胜利','🎯战略词','📌长尾词','❌无关'], true).build());
  master.getRange('T2:T500').setDataValidation(  // T: AIO风险
    dv().requireValueInList(['高','低','未查'], true).build());
  master.getRange('W2:W500').setDataValidation(  // W: 手动生产准入
    dv().requireValueInList(['可生产','暂缓','集群必需','无关'], true).build());
  master.getRange('Y2:Y500').setDataValidation(  // Y: 生产状态
    dv().requireValueInList(['未开始','已建卡','已发布','已合并','暂停'], true).build());

  // ── 公式 ──

  // J: DR差值（G - I，两者均为查词时快照）
  var fJ = '=IF(OR(G2="",I2=""),"待填",G2-I2)';

  // K: G1话题相关（v3.0 修复空配置格 bug：旧版 SEARCH("",A2)=1 会把所有词误判✅相关）
  // 用 <>"" 掩码排除空的 TOPIC_KEYWORDS 格，只在命中真实话题词时才判✅相关
  var fK = '=IF(A2="","",IF(SUMPRODUCT((' + CFG + '!$A$6:$A$25<>"")' +
    '*ISNUMBER(SEARCH(' + CFG + '!$A$6:$A$25,A2)))>0,"✅相关","⚠️待确认"))';

  // M: 意图（模式匹配，按Commercial>Transactional>Problem-aware>Informational>待确认优先级）
  var fM =
    '=IF(A2="","",IF(OR(' +
      'ISNUMBER(SEARCH("best ",A2)),ISNUMBER(SEARCH(" vs ",A2)),' +
      'ISNUMBER(SEARCH("alternative",A2)),ISNUMBER(SEARCH("comparison",A2)),' +
      'ISNUMBER(SEARCH("review",A2)),ISNUMBER(SEARCH("pricing",A2)),' +
      'ISNUMBER(SEARCH("top ",A2))),"Commercial",' +
    'IF(OR(' +
      'ISNUMBER(SEARCH("buy ",A2)),ISNUMBER(SEARCH(" cost",A2)),' +
      'ISNUMBER(SEARCH("cheap",A2)),ISNUMBER(SEARCH("discount",A2)),' +
      'ISNUMBER(SEARCH("free trial",A2)),ISNUMBER(SEARCH("sign up",A2))),"Transactional",' +
    'IF(OR(' +
      'ISNUMBER(SEARCH("fix ",A2)),ISNUMBER(SEARCH("not working",A2)),' +
      'ISNUMBER(SEARCH("how to fix",A2)),ISNUMBER(SEARCH("how to solve",A2)),' +
      'ISNUMBER(SEARCH("problem",A2)),ISNUMBER(SEARCH(" error",A2))),"Problem-aware",' +
    'IF(OR(' +
      'ISNUMBER(SEARCH("how to ",A2)),ISNUMBER(SEARCH("what is",A2)),' +
      'ISNUMBER(SEARCH(" guide",A2)),ISNUMBER(SEARCH("tutorial",A2)),' +
      'ISNUMBER(SEARCH("why ",A2)),ISNUMBER(SEARCH("explained",A2))),"Informational",' +
    '"待确认")))))';

  // N: 竞争建议（仅建议，不再作为架构删除规则）
  var fN = '=IF(J2="待填","待填",IF(ISNUMBER(J2),IF(J2>30,"⏸暂缓","✅可做"),"待填"))';

  // O: 分桶_自动（v3.0：最前面加 NEGATIVE_KEYWORDS 否决）
  // 优先级：负向词❌无关 > 🚀趋势词 > ⚡快速胜利 > 🎯战略词 > 📌长尾词
  // 负向词公式同样用 <>"" 掩码：空负向词格不会误伤（留空=不否决）
  var fO =
    '=IF(A2="","",' +
    'IF(SUMPRODUCT((' + CFG + '!$A$28:$A$45<>"")*ISNUMBER(SEARCH(' + CFG + '!$A$28:$A$45,A2)))>0,"❌无关",' +
    'IF(AND(ISNUMBER(F2),F2>1.2,ISNUMBER(D2),D2<35,K2="✅相关",L2="Y"),"🚀趋势词",' +
    'IF(AND(ISNUMBER(D2),D2<20,ISNUMBER(C2),C2>=100),"⚡快速胜利",' +
    'IF(AND(ISNUMBER(D2),D2<20,OR(M2="Problem-aware",M2="Informational"),ISNUMBER(C2),C2>=50),"⚡快速胜利",' +
    'IF(AND(ISNUMBER(D2),D2>=20,D2<=50,OR(M2="Commercial",M2="Transactional")),"🎯战略词",' +
    '"📌长尾词"))))))';

  // R: 分桶（最终：P非空→人工调整加★；否则=自动结果）
  var fR = '=IF(A2="","",IF(P2<>"",P2&"★",O2))';

  // S: AIO预判（搜索量≥500且含定义型词→疑似高风险）
  var fS =
    '=IF(A2="","",IF(AND(ISNUMBER(C2),C2>=500,OR(' +
      'ISNUMBER(SEARCH("what is",A2)),ISNUMBER(SEARCH("meaning",A2)),' +
      'ISNUMBER(SEARCH("definition",A2)),ISNUMBER(SEARCH("how does",A2)),' +
      'ISNUMBER(SEARCH("explained",A2)))),"⚠️疑似高风险",""))';

  // U: 弱度意图分（H列SERP弱度+M列意图，供快速胜利桶视图排序与聚类辅助分流，非执行优先级）
  var fU =
    '=IF(A2="",0,' +
    'IF(H2="✅弱",3,IF(H2="⚠️中",2,1))' +
    '+IF(OR(M2="Commercial",M2="Problem-aware"),1,0))';

  // V: 生产准入_自动（公式默认值，不手改）
  var fV = '=IF(A2="","",IF(O2="❌无关","无关",IF(N2="✅可做","可生产",IF(N2="⏸暂缓","暂缓","暂缓"))))';

  // X: 生产准入（最终：W非空→人工覆盖，否则=V自动）
  var fX = '=IF(A2="","",IF(W2<>"",W2,V2))';

  // 应用公式
  master.getRange('J2').setFormula(fJ);
  master.getRange('K2').setFormula(fK);
  master.getRange('M2').setFormula(fM);
  master.getRange('N2').setFormula(fN);
  master.getRange('O2').setFormula(fO);
  master.getRange('R2').setFormula(fR);
  master.getRange('S2').setFormula(fS);
  master.getRange('U2').setFormula(fU);
  master.getRange('V2').setFormula(fV);
  master.getRange('X2').setFormula(fX);

  // 向下复制（仅公式列）
  master.getRange('J2:O2').copyTo(master.getRange('J3:O500'));
  master.getRange('R2').copyTo(master.getRange('R3:R500'));
  master.getRange('S2').copyTo(master.getRange('S3:S500'));
  master.getRange('U2').copyTo(master.getRange('U3:U500'));
  master.getRange('V2').copyTo(master.getRange('V3:V500'));
  master.getRange('X2').copyTo(master.getRange('X3:X500'));

  // 列宽（A-AB 共 28 列）
  [270,100,90,55,65,90,100,80,80,80,100,70,110,80,120,110,200,120,110,70,80,110,110,110,90,130,220,160]
    .forEach(function(w, i) { master.setColumnWidth(i + 1, w); });

  // ── 条件格式 ──
  var rules = [];

  // R列（分桶，最终结果）— 主色彩标识
  var rR = master.getRange('R2:R500');
  [
    { t: '🚀趋势词',    bg: '#c8e6c9' },
    { t: '⚡快速胜利★', bg: '#fff59d' },
    { t: '⚡快速胜利',  bg: '#fff9c4' },
    { t: '🎯战略词',    bg: '#bbdefb' },
    { t: '📌长尾词',    bg: '#fce4ec' },
    { t: '❌无关',      bg: '#eeeeee' }
  ].forEach(function(r) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains(r.t).setBackground(r.bg).setRanges([rR]).build());
  });

  // O列（分桶_自动）— 浅色，与R列区分
  var oR = master.getRange('O2:O500');
  [
    { t: '🚀', bg: '#f1f8e9' }, { t: '⚡', bg: '#fffde7' },
    { t: '🎯', bg: '#e8f4fd' }, { t: '📌', bg: '#fdf2f8' }
  ].forEach(function(r) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains(r.t).setBackground(r.bg).setRanges([oR]).build());
  });

  // P列（手动分桶）— 非空时黄色高亮
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenCellNotEmpty().setBackground('#fff176').setBold(true)
    .setRanges([master.getRange('P2:P500')]).build());

  // H列（SERP弱度）
  var hR = master.getRange('H2:H500');
  [
    { t: '✅弱', bg: '#c8e6c9' }, { t: '⚠️中', bg: '#fff9c4' }, { t: '❌强', bg: '#ffcdd2' }
  ].forEach(function(r) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains(r.t).setBackground(r.bg).setRanges([hR]).build());
  });

  // S列（AIO预判）— 橙色警示
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenTextContains('疑似高风险').setBackground('#ffe0b2')
    .setRanges([master.getRange('S2:S500')]).build());

  // V-X列（生产准入）
  var accessR = master.getRange('V2:X500');
  [
    { t: '可生产', bg: '#e8f5e9' },
    { t: '集群必需', bg: '#d1c4e9' },
    { t: '暂缓', bg: '#fff9c4' },
    { t: '无关', bg: '#eeeeee' }
  ].forEach(function(r) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains(r.t).setBackground(r.bg).setRanges([accessR]).build());
  });

  // Y列（生产状态）
  var statusR = master.getRange('Y2:Y500');
  [
    { t: '未开始', bg: '#ffffff' },
    { t: '已建卡', bg: '#bbdefb' },
    { t: '已发布', bg: '#c8e6c9' },
    { t: '已合并', bg: '#e0e0e0' },
    { t: '暂停', bg: '#ffcdd2' }
  ].forEach(function(r) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains(r.t).setBackground(r.bg).setRanges([statusR]).build());
  });

  master.setConditionalFormatRules(rules);

  // ════════════════════════════════════════════
  // v3.0 新增 4 表 — 6-ID 体系（cluster_id / page_id / cta_id / outcome_id）
  // v3.1 加列颜色与字段注释：深蓝=公式自动 / 深绿=必填手动 / 深灰=选填或条件字段
  // ════════════════════════════════════════════

  // SHEET: 主题集群表（cluster_id）— v3.1 加列颜色与字段注释
  var clusterSh = ss.insertSheet('主题集群表');
  var clusterHeaders = [
    'cluster_id', 'cluster_name', 'track', 'content_layer', 'business_role',
    'primary_entity', 'jtbd', 'content_angle', 'us_share', 'pillar_page',
    'series_pattern', 'keywords_included', 'page_assets', 'internal_link_rule',
    'cta_primary', 'psych_safety_flag', 'priority', 'week', 'success_metric'
  ];
  clusterSh.getRange(1, 1, 1, clusterHeaders.length).setValues([clusterHeaders])
    .setFontColor('#ffffff').setFontWeight('bold').setFontSize(11);
  clusterSh.setFrozenRows(1);

  // 表头颜色：深绿=必填手动 / 深灰=选填手动（本表无公式自动列）
  var cluGreen = [1, 2, 3, 4, 6, 9, 15, 16, 17, 18];  // id/name/track/layer/entity/us_share/cta/safety/priority/week
  var cluSlate = [5, 7, 8, 10, 11, 12, 13, 14, 19];   // role/jtbd/angle/pillar/series/keywords/assets/links/metric
  cluGreen.forEach(function(c) { clusterSh.getRange(1, c).setBackground('#2e7d32'); });
  cluSlate.forEach(function(c) { clusterSh.getRange(1, c).setBackground('#455a64'); });

  // 数据验证下拉
  clusterSh.getRange('C2:C200').setDataValidation(dv().requireValueInList(['量产线', '精修线'], true).build());
  clusterSh.getRange('D2:D200').setDataValidation(dv().requireValueInList(['Core Astrology', 'Product-led Journal', 'Tool-led', 'Wiki Support', 'Quarantine'], true).build());
  clusterSh.getRange('I2:I200').setDataValidation(dv().requireValueInList(['高', '中', '低'], true).build());
  clusterSh.getRange('O2:O200').setDataValidation(dv().requireValueInList(['Newsletter', '工具页', '星盘页', '注册'], true).build());
  clusterSh.getRange('P2:P200').setDataValidation(dv().requireValueInList(['Y', 'N'], true).build());
  clusterSh.getRange('Q2:Q200').setDataValidation(dv().requireValueInList(['P0', 'P1', 'P2'], true).build());
  clusterSh.getRange('R2:R200').setDataValidation(dv().requireValueInList(['Week 1', 'Week 2', 'Week 3', 'Backlog'], true).build());

  // 字段注释
  var cluNotes = {
    1:  'cluster_id：手工编号，如 clu_aura_colors。全流程外键，命名稳定不随标题变。',
    2:  'cluster_name：可读名，如「Aura Colors 核心」。',
    3:  'track：量产线=aura/Vedic/nakshatra 走量；精修线=自我认知/疗愈走差异化（PRD v0.7 §3.2）。两线都活在种子模板「Track A SEO」之下，与种子模板的「Track B Social Probe」不同维度，不要混。',
    4:  'content_layer：Core Astrology / Product-led Journal / Tool-led / Wiki Support / Quarantine（脱离主线，不做）。',
    5:  'business_role：业务角色——流量 / 权威 / 转化 / 工具承接 / newsletter 承接。',
    6:  'primary_entity：主实体（Birth Chart / Moon Sign / Chiron 等）。决定语义主权，同站其他集群不应再用同实体（防内耗）。',
    7:  'jtbd：用户带着什么任务来——理解 X 含义 / 查我的 X / 通过 X 反思自己。',
    8:  'content_angle：本集群的差异化角度。精修线必填（如：用 chiron 反思隐藏的情绪与关系模式）；量产线留空（用模板默认）。',
    9:  'us_share 三档地区标签（PRD v0.7 §3.3）：\n高=目标国主导（aura/houses 等欧美向），正常进量产线、计入目标国 PV；\n低=非目标国主导（nakshatra/rashi 等印度向），不占 P0 产能；\n中=拿不准，查 2-3 头部词 Ahrefs by-country 饼图。靠主题常识判断即可，不算精确百分比。',
    10: 'pillar_page：Pillar 页 URL（已发布）或拟定标题（规划中）。每个核心集群最多 1 个 Pillar。',
    11: 'series_pattern：Series 批量规则，如「Moon in 12 Signs」「Planets in Houses」。',
    12: 'keywords_included：本集群覆盖的关键词列表（逗号分隔），与关键词主表交叉验证。',
    13: 'page_assets：本集群已规划/发布的 page_id 列表，与选题登记表交叉验证。',
    14: 'internal_link_rule：Pillar↔Series↔Support 内链规则；建议每 Series 前 30% 链 Pillar、同簇 Spoke 互链 1-2 条（W21 评审 B-7）。',
    15: 'cta_primary：本集群默认主 CTA（Newsletter / 工具页 / 星盘页 / 注册）。页面级 CTA 仍由 page_role + track 经 CTA Map 决定，这里标方向。',
    16: 'psych_safety_flag：Y/N。涉及 healing/trauma/relationship wound/anxiety 时 Y，触发心理安全 QA（附录 B 非临床反思语言规则）。',
    17: 'priority：P0 / P1 / P2。P0=本周必启动；P1=排队；P2=暂缓或战略低配（如 us_share=低 的集群）。',
    18: 'week：计划启动周——Week 1 / Week 2 / Week 3 / Backlog。',
    19: 'success_metric：Day 30 / Day 60 衡量本集群是否成功的具体指标（如：Day 30 至少 5 词进 Top 50、Day 60 美国 PV 月贡献 ≥ 1000）。'
  };
  Object.keys(cluNotes).forEach(function(col) {
    clusterSh.getRange(1, parseInt(col)).setNote(cluNotes[col]);
  });

  [110, 160, 70, 140, 90, 110, 200, 170, 70, 150, 150, 160, 140, 170, 90, 100, 60, 80, 170]
    .forEach(function(w, i) { clusterSh.setColumnWidth(i + 1, w); });

  // SHEET: 选题登记表（page_id）— v2.1 = v2.0 的 15 列 + 6 列；v3.1 加列颜色与字段注释
  var pageSh = ss.insertSheet('选题登记表');
  var pageHeaders = [
    'Target Keyword', 'Associated Keywords', '月搜索量', 'KD', 'Intent', 'Tier',
    'Template', 'Entity', 'Friction', 'Logic', 'CTA', 'GSC Keywords', 'Status', 'URL',
    'Last Audit', 'page_id', 'cluster_id', 'page_role', 'content_angle',
    'psych_safety_flag', 'journal_prompts'
  ];
  pageSh.getRange(1, 1, 1, pageHeaders.length).setValues([pageHeaders])
    .setFontColor('#ffffff').setFontWeight('bold').setFontSize(11);
  pageSh.setFrozenRows(1);

  // 表头颜色：深蓝=公式自动 / 深绿=必填手动 / 深灰=选填或条件字段
  var pgNavy  = [3, 4];                                      // 月搜索量、KD（VLOOKUP）
  var pgGreen = [1, 5, 6, 7, 8, 13, 16, 17, 18, 20];         // keyword/intent/tier/template/entity/status/page_id/cluster_id/page_role/safety
  var pgSlate = [2, 9, 10, 11, 12, 14, 15, 19, 21];          // assoc/friction/logic/cta/gsc/url/audit/angle/prompts
  pgNavy.forEach(function(c)  { pageSh.getRange(1, c).setBackground('#1a237e'); });
  pgGreen.forEach(function(c) { pageSh.getRange(1, c).setBackground('#2e7d32'); });
  pgSlate.forEach(function(c) { pageSh.getRange(1, c).setBackground('#455a64'); });

  // C / D 列从关键词主表 VLOOKUP 自动同步（月搜索量取目标国数值）
  pageSh.getRange('C2').setFormula('=IF($A2="","",IFERROR(VLOOKUP($A2,\'关键词主表\'!$A:$AB,3,FALSE),"未找到"))');
  pageSh.getRange('D2').setFormula('=IF($A2="","",IFERROR(VLOOKUP($A2,\'关键词主表\'!$A:$AB,4,FALSE),"未找到"))');
  pageSh.getRange('C2:D2').copyTo(pageSh.getRange('C3:D300'));

  // 数据验证下拉
  pageSh.getRange('E2:E300').setDataValidation(dv().requireValueInList(['Info', 'Compare', 'Tutorial', 'Utility', 'Experience', 'BOFU'], true).build());
  pageSh.getRange('F2:F300').setDataValidation(dv().requireValueInList(['T1', 'T2', 'T3'], true).build());
  pageSh.getRange('G2:G300').setDataValidation(dv().requireValueInList(['Definition', 'Comparison', 'Tutorial', 'Programmatic', 'Case Study'], true).build());
  pageSh.getRange('M2:M300').setDataValidation(dv().requireValueInList(['待写', '写作中', '质检', '已发布', '已刷新'], true).build());
  pageSh.getRange('R2:R300').setDataValidation(dv().requireValueInList(['Pillar', 'Series', 'Support', 'Tool', 'Wiki', 'Strategic'], true).build());
  pageSh.getRange('T2:T300').setDataValidation(dv().requireValueInList(['Y', 'N'], true).build());

  // 字段注释
  var pgNotes = {
    1:  'Target Keyword：本页核心词。集群可用「主行/留空/次行」排版，但页面角色以 R 列 page_role 为准（不靠行位置）。',
    2:  'Associated Keywords：1+N 嵌套长尾词（本页 secondary）。同意图变体合并到本页，禁止按数量机械拆 Part（W21 评审 A-3 / B-2）。',
    3:  '月搜索量：公式自动从「关键词主表」VLOOKUP，勿手填。"未找到"=该词在主表没匹配上，核对关键词字符串。主表 C 列已切到目标国数值。',
    4:  'KD：公式自动从「关键词主表」VLOOKUP，勿手填。',
    5:  'Intent：Info / Compare / Tutorial / Utility / Experience / BOFU。决定 Template 选择。',
    6:  'Tier：T1 重装（Pillar/战略/心理风险页，45-60 分钟）/ T2 标准（Series 主力，10-15 分钟）/ T3 占位（极长尾，<5 分钟 + 5秒QA）。每周 T1 ≤ 3 篇（审核产能上限，PRD v0.8 §7.5）。',
    7:  'Template：Definition / Comparison / Tutorial / Programmatic / Case Study。和 Intent 配对，具体结构见 PRD v0.7 附录 A 5 个页面模板。',
    8:  'Entity：本页主权实体，如 Midheaven。v0.18 主权机制：同集群其他页不能再用同 Entity，防内容内耗。',
    9:  'Friction：真实痛点证据（Reddit/论坛抓取的具体案例）。T1 必填、T2 AI 辅助、T3 跳过。严禁填形容词。',
    10: 'Logic：机制 + 权衡（Mechanism + Trade-off）。T1 必填、T2 必填、T3 跳过。',
    11: 'CTA：页面 CTA 文案/URL。可由 R 列 page_role + track 经 CTA Map 自动决定，不必逐页手填（只在偏离默认时填）。',
    12: 'GSC Keywords：发布 30 天后从 GSC 抓取该 URL 已获排名但正文中缺失的词，用于内容刷新。维护期填。',
    13: 'Status：待写 / 写作中 / 质检 / 已发布 / 已刷新。选题登记表是页面生产视图，只放已决定生产或已生产的 page；关键词筛选与暂缓原因回到关键词主表 V列。',
    14: 'URL：发布后填入正式在线网址。',
    15: 'Last Audit：最后一次内容审计/刷新日期。',
    16: 'page_id：6-ID 主键，如 page_chiron_7th_house。手工编号，命名稳定。',
    17: 'cluster_id：外键 → 主题集群表。每个页面必须归属一个集群，无 cluster_id 的页面属违规（PRD v0.8 §2.3）。',
    18: 'page_role：Pillar / Series / Support / Tool / Wiki / Strategic。决定页面广深（Pillar 写广、Series 写深）、内链方向、CTA 选择。显式列，不靠行位置。',
    19: 'content_angle：精修线必填（差异化角度），量产线留空（用模板默认）。PRD v0.7 附录 C。',
    20: 'psych_safety_flag：Y/N。Y 触发心理安全 QA——必须用反思性、非临床语言（附录 B），不做诊断/治疗承诺。默认 N。',
    21: 'journal_prompts：仅精修线 product-led / healing 页填（如 chiron 反思 prompts）。量产线 aura/Vedic 长尾页留空。'
  };
  Object.keys(pgNotes).forEach(function(col) {
    pageSh.getRange(1, parseInt(col)).setNote(pgNotes[col]);
  });

  [180, 220, 80, 55, 80, 55, 110, 110, 150, 150, 90, 140, 70, 200, 90, 130, 150, 80, 180, 100, 200]
    .forEach(function(w, i) { pageSh.setColumnWidth(i + 1, w); });

  // SHEET: CTA Map（cta_id）— v3.1 加列颜色与字段注释
  var ctaSh = ss.insertSheet('CTA Map');
  ctaSh.getRange(1, 1, 1, 6)
    .setValues([['cta_id', 'page_role', 'cta_文案', 'target_url', 'ga4_event_name', 'track']])
    .setFontColor('#ffffff').setFontWeight('bold').setFontSize(11);
  ctaSh.setFrozenRows(1);

  // 表头颜色：深绿=必填手动 / 深灰=选填（GA4 上线后填）
  var ctaGreen = [1, 2, 3, 4, 6];
  var ctaSlate = [5];
  ctaGreen.forEach(function(c) { ctaSh.getRange(1, c).setBackground('#2e7d32'); });
  ctaSlate.forEach(function(c) { ctaSh.getRange(1, c).setBackground('#455a64'); });

  // 预填 Week-1 默认（工具页优先，PRD v0.7 §10）
  ctaSh.getRange(2, 1, 6, 6).setValues([
    ['cta_tool_pillar', 'Pillar', '探索你的星盘 / aura', '（工具页 URL）', 'tool_click', '量产线'],
    ['cta_tool_series', 'Series', '查你的对应落座', '（工具页 URL）', 'tool_click', '量产线'],
    ['cta_tool_support', 'Support', '用工具验证', '（工具页 URL）', 'tool_click', '量产线'],
    ['cta_tool_use', 'Tool', '输入信息生成结果', '（工具页自身）', 'tool_use', '量产线'],
    ['cta_tool_wiki', 'Wiki', '测一测你的 aura', '（aura test URL）', 'tool_click', '量产线'],
    ['cta_news_b', 'Series', '订阅获取每周 journal prompts', '（newsletter URL，待搭建）', 'newsletter_signup', '精修线']
  ]);

  ctaSh.getRange('B2:B500').setDataValidation(dv().requireValueInList(['Pillar', 'Series', 'Support', 'Tool', 'Wiki', 'Strategic'], true).build());
  ctaSh.getRange('F2:F500').setDataValidation(dv().requireValueInList(['量产线', '精修线'], true).build());

  // 字段注释
  var ctaNotes = {
    1: 'cta_id：手工编号，如 cta_tool_pillar。页面生产卡按 page_role + track 引用对应 CTA。预填 6 行是 Week-1 默认（工具页优先，PRD v0.7 §10）。',
    2: 'page_role：Pillar / Series / Support / Tool / Wiki / Strategic。这条 CTA 适用于哪种页面角色。',
    3: 'cta_文案：用户在页面看到的 CTA 按钮/链接文字。简短行动指令。',
    4: 'target_url：点击 CTA 跳转的 URL（工具页 URL / newsletter 注册页 URL 等）。',
    5: 'ga4_event_name：与 GA4 配置的事件名一一对应（如 tool_click、newsletter_signup）。GA4 上线后填实。',
    6: 'track：量产线 / 精修线。Week-1 默认：量产线→工具页；精修线→newsletter（待搭建）。阶段策略见 PRD v0.7 §10。'
  };
  Object.keys(ctaNotes).forEach(function(col) {
    ctaSh.getRange(1, parseInt(col)).setNote(ctaNotes[col]);
  });

  [150, 90, 220, 200, 150, 80].forEach(function(w, i) { ctaSh.setColumnWidth(i + 1, w); });

  // SHEET: 结果复盘表（outcome_id）— v3.1 加列颜色与字段注释
  var outcomeSh = ss.insertSheet('结果复盘表');
  var outcomeHeaders = [
    'outcome_id', 'page_id', 'cluster_id', 'url', 'day14_收录', 'day14_impressions',
    'day30_进Top50词数', 'day30_clicks', 'day60_pv', 'day60_目标国pv', '决策', '备注'
  ];
  outcomeSh.getRange(1, 1, 1, outcomeHeaders.length).setValues([outcomeHeaders])
    .setFontColor('#ffffff').setFontWeight('bold').setFontSize(11);
  outcomeSh.setFrozenRows(1);

  // 表头颜色：深绿=必填手动（标识/决策）/ 深灰=GSC/GA4 粘贴的数据
  var outGreen = [1, 2, 3, 4, 5, 11];   // outcome_id/page_id/cluster_id/url/day14_收录/决策
  var outSlate = [6, 7, 8, 9, 10, 12];  // impressions/Top50/clicks/pv/目标国pv/备注
  outGreen.forEach(function(c) { outcomeSh.getRange(1, c).setBackground('#2e7d32'); });
  outSlate.forEach(function(c) { outcomeSh.getRange(1, c).setBackground('#455a64'); });

  outcomeSh.getRange('E2:E300').setDataValidation(dv().requireValueInList(['Y', 'N'], true).build());
  outcomeSh.getRange('K2:K300').setDataValidation(dv().requireValueInList(['继续', '调整', '暂停'], true).build());

  // 字段注释
  var outNotes = {
    1:  'outcome_id：6-ID 主键。每个页面 × 每个时点（Day 14 / 30 / 60）一行，或集群级汇总一行。手工编号如 out_001、out_clu_aura_d30。',
    2:  'page_id：外键 → 选题登记表。页面级复盘时填。',
    3:  'cluster_id：外键 → 主题集群表。集群级汇总时填。',
    4:  'url：发布 URL。便于直接复盘。',
    5:  'day14_收录：Y/N。GSC → URL Inspection 看页面是否已收录。Day 14 节点。',
    6:  'day14_impressions：GSC 该 URL 近 14 天 impressions（按 Country 维度筛目标国）。手工粘贴 GSC 导出。',
    7:  'day30_进Top50词数：该 URL 在 GSC 排名 P1-P50 的 query 数。Day 30 节点。',
    8:  'day30_clicks：GSC 该 URL 近 30 天 clicks（目标国）。',
    9:  'day60_pv：GA4 该 URL 近 60 天 page_view 总数（全部地区）。',
    10: 'day60_目标国pv：GA4 按 Country 维度筛目标国后的 PV。核对「美国为主」目标用这个，不用全部 PV（PRD v0.7 §12 / §13）。',
    11: '决策：继续 / 调整 / 暂停。按 PRD v0.7 §7.9 Day 14/30/60 规则判：Day 14 未收录→查技术；Day 30 P31-P80→刷新标题；Day 60 无信号→合并/noindex/暂停。',
    12: '备注：复盘观察、调整原因、下一步动作。'
  };
  Object.keys(outNotes).forEach(function(col) {
    outcomeSh.getRange(1, parseInt(col)).setNote(outNotes[col]);
  });

  [130, 130, 170, 220, 90, 130, 130, 100, 90, 120, 70, 260]
    .forEach(function(w, i) { outcomeSh.setColumnWidth(i + 1, w); });

  // ════════════════════════════════════════════

  // ────────────────────────────────────────────
  // SHEET 2: 🧩生产候选（按生产准入筛选）
  // ────────────────────────────────────────────
  var prodSh = ss.insertSheet('🧩生产候选');
  prodSh.getRange('A1').setFormula(
    "=IF(COUNTIF('关键词主表'!X:X,\"可生产\")+COUNTIF('关键词主表'!X:X,\"集群必需\")>0,{'关键词主表'!A1:AB1;FILTER('关键词主表'!A2:AB500,REGEXMATCH('关键词主表'!X2:X500,\"可生产|集群必需\"))},{\"暂无生产候选\"})"
  );
  _styleViewSheet(prodSh, '#ede7f6',
    '生产候选 — 从关键词主表进入选题登记表前的过渡视图 | X列=可生产/集群必需 | 分桶表示机会类型，不等于生产状态');

  // ────────────────────────────────────────────
  // SHEET 3: 🚀趋势词（按 Trends比值 降序）
  // ────────────────────────────────────────────
  var trendSh = ss.insertSheet('🚀趋势词');
  trendSh.getRange('A1').setFormula(
    "=IF(COUNTIF('关键词主表'!R:R,\"*趋势词*\")>0,{'关键词主表'!A1:AB1;SORT(FILTER('关键词主表'!A2:AB500,REGEXMATCH('关键词主表'!R2:R500,\"趋势词\")),6,FALSE)},{\"暂无趋势词\"})"
  );
  _styleViewSheet(trendSh, '#e8f5e9',
    '趋势词 — Trends比值降序 | K列G1✅相关+L列G2=Y双门槛 | 发现即执行，不等周计划');

  // ────────────────────────────────────────────
  // SHEET 4: ⚡快速胜利（按排序权重U列→月搜索量C列 降序）
  // ────────────────────────────────────────────
  var qwSh = ss.insertSheet('⚡快速胜利');
  qwSh.getRange('A1').setFormula(
    "=IF(COUNTIF('关键词主表'!R:R,\"*快速胜利*\")>0,{'关键词主表'!A1:AB1;SORT(FILTER('关键词主表'!A2:AB500,REGEXMATCH('关键词主表'!R2:R500,\"快速胜利\")),21,FALSE,3,FALSE)},{\"暂无快速胜利词\"})"
  );
  _styleViewSheet(qwSh, '#fff9c4',
    '快速胜利 — 排序权重（H列SERP弱度+M列意图）→ 月搜索量 降序 | H列SERP弱度填完后排序才有意义 | Week1-4主执行');

  // ────────────────────────────────────────────
  // SHEET 5: 🎯战略词（按 CPC 降序，辅助参考）
  // ────────────────────────────────────────────
  var stratSh = ss.insertSheet('🎯战略词');
  stratSh.getRange('A1').setFormula(
    "=IF(COUNTIF('关键词主表'!R:R,\"*战略词*\")>0,{'关键词主表'!A1:AB1;SORT(FILTER('关键词主表'!A2:AB500,REGEXMATCH('关键词主表'!R2:R500,\"战略词\")),5,FALSE)},{\"暂无战略词\"})"
  );
  _styleViewSheet(stratSh, '#e3f2fd',
    '战略词 — CPC降序（辅助参考，实际优先级以主题集群相关度人工排序为主）| Week3起每周1-2篇');

  // ────────────────────────────────────────────
  // SHEET 6: 📌长尾词
  // ────────────────────────────────────────────
  var ltSh = ss.insertSheet('📌长尾词');
  ltSh.getRange('A1').setFormula(
    "=IF(COUNTIF('关键词主表'!R:R,\"*长尾词*\")>0,{'关键词主表'!A1:AB1;FILTER('关键词主表'!A2:AB500,REGEXMATCH('关键词主表'!R2:R500,\"长尾词\"))},{\"暂无长尾词\"})"
  );
  _styleViewSheet(ltSh, '#fce4ec',
    '长尾词 — 社区来源词验证搜索量后归入对应桶 | 50-100搜索量+意图明确→Week1并行 | 其余批量执行');

  // ────────────────────────────────────────────
  // SHEET 7: 📋分桶规则
  // ────────────────────────────────────────────
  var ruleSh = ss.insertSheet('📋分桶规则');

  // ── 标题行 ──
  ruleSh.getRange(1, 1, 1, 4).setBackground('#1a237e').setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(13);
  ruleSh.getRange('A1').setValue('📋 分桶规则 & 操作参考');

  // ── 一、前置关卡 ──
  ruleSh.getRange(3, 1, 1, 4).setBackground('#e8eaf6');
  ruleSh.getRange('A3').setValue('一、前置判断（顺序操作，共两种性质：过滤 / 建议 / 标注）').setFontWeight('bold');
  ruleSh.getRange(4, 1, 1, 4).setValues([['关卡', '操作列', '判断条件', '性质说明']])
    .setBackground('#3949ab').setFontColor('#ffffff').setFontWeight('bold');
  ruleSh.getRange(5, 1, 3, 4).setValues([
    ['第一关：竞争建议', 'N列（公式自动）', 'DR差值≤30 → ✅可做；>30 → ⏸暂缓\n负值 = 你的站DR超越竞争均值，仍为✅可做', '建议，不过滤；高DR/KD词仍进入分桶与集群架构。若是 Pillar/核心实体，在W列手动标「集群必需」'],
    ['第二关：SERP弱度', 'H列（手动填写）', '✅弱 / ⚠️中 / ❌强 / 未查', '标注，不过滤；⚡快速胜利桶必填；填写后U列排序权重自动更新'],
    ['第三关：AIO风险', 'T列（手动填写）', '高 / 低 / 未查', '标注，不过滤；搜索量≥500的定义型词优先确认；影响内容结构策略']
  ]).setVerticalAlignment('top').setWrap(true);

  // ── 二、四桶分类规则 ──
  ruleSh.getRange(9, 1, 1, 4).setBackground('#e8f5e9');
  ruleSh.getRange('A9').setValue('二、四桶分类规则（O列公式按以下优先级依次判断；分桶=机会类型，不等于生产状态）').setFontWeight('bold');
  ruleSh.getRange(10, 1, 1, 4).setValues([['优先级', '桶名', '分类条件', '桶内排序']])
    .setBackground('#2e7d32').setFontColor('#ffffff').setFontWeight('bold');
  ruleSh.getRange(11, 1, 5, 4).setValues([
    ['① 最高', '❌ 无关', '命中 NEGATIVE_KEYWORDS 或人工判定与产品无关', '—'],
    ['②', '🚀 趋势词', 'Trends比值>1.2  且  KD<35  且  K列G1=✅相关  且  L列G2=Y', 'Trends比值降序（F列）'],
    ['③', '⚡ 快速胜利', '主规则：KD<20 且 搜索量≥100\n豁免规则：KD<20 且 M列意图=Problem-aware 或 Informational 且 搜索量≥50', 'H列SERP弱度权重(U列) → 搜索量 降序'],
    ['④', '🎯 战略词', 'KD 20-50  且  M列意图=Commercial 或 Transactional', 'CPC降序（辅助参考，实际以主题集群相关度人工排序为主）'],
    ['⑤ 兜底', '📌 长尾词', '其余所有相关词（含高DR暂缓词、意图=待确认、搜索量低于阈值等未命中上述条件的词）', '—']
  ]).setVerticalAlignment('top').setWrap(true);

  // ── 三、意图自动分类规则 ──
  ruleSh.getRange(17, 1, 1, 3).setBackground('#fff3e0');
  ruleSh.getRange('A17').setValue('三、意图自动分类规则（M列公式，模式匹配，准确率约80%；未命中→待确认，需人工批量标注）').setFontWeight('bold');
  ruleSh.getRange(18, 1, 1, 3).setValues([['意图类型', '触发词（含任意一个即判定为该类型）', '典型搜索场景']])
    .setBackground('#e65100').setFontColor('#ffffff').setFontWeight('bold');
  ruleSh.getRange(19, 1, 5, 3).setValues([
    ['Commercial', 'best · vs · alternative · comparison · review · pricing · top', '比较选型，有决策意图但未直接购买'],
    ['Transactional', 'buy · cost · cheap · discount · free trial · sign up', '直接购买或注册意图'],
    ['Problem-aware', 'fix · not working · how to fix · how to solve · problem · error', '遇到问题，寻求解决方案'],
    ['Informational', 'how to · what is · guide · tutorial · why · explained', '学习了解，暂无直接商业意图'],
    ['待确认', '未命中以上任何模式', '批量粘贴到Claude/GPT，用《关键词研究SOP》第四节prompt批量标注意图']
  ]).setVerticalAlignment('top').setWrap(true);

  // ── 四、人工调整说明 ──
  ruleSh.getRange(25, 1, 1, 4).setBackground('#f5f5f5').setFontStyle('italic');
  ruleSh.getRange('A25').setValue(
    '四、人工调整分桶：P列选目标桶 → Q列填调整原因 → R列自动更新为"桶名★"\n' +
    'O列（分桶_自动）始终保留原始公式计算结果，供复盘时对比差异，判断是否需要调整分类规则本身。\n' +
    'V列（生产准入_自动）给默认值，W列（手动生产准入）可覆盖，X列（生产准入）决定是否进入「🧩生产候选」和选题登记表：可生产 / 集群必需 进入候选；暂缓 / 无关不进入。\n' +
    'Y列（生产状态）只记录进度：未开始 / 已建卡 / 已发布 / 已合并 / 暂停。'
  ).setWrap(true);

  // ── 列宽 & 行高 ──
  [120, 120, 370, 230].forEach(function(w, i) { ruleSh.setColumnWidth(i + 1, w); });
  [5, 6, 7, 11, 12, 13, 14, 15, 19, 20, 21, 22, 23].forEach(function(r) {
    ruleSh.setRowHeight(r, 60);
  });
  ruleSh.setFrozenRows(1);

  // ────────────────────────────────────────────
  // SHEET 7: 📊内容追踪
  // ────────────────────────────────────────────
  var trackSh = ss.insertSheet('📊内容追踪');
  var tHeaders = [
    '关键词','分桶','发布日期','内容URL',
    'KD','月搜索量',
    '预期排名(W8)','预期流量(W8)',
    '实际排名(W4)','实际排名(W8)','实际流量(W8)',
    '偏差%','页面类型匹配','备注'
  ];
  trackSh.getRange(1, 1, 1, tHeaders.length)
    .setValues([tHeaders])
    .setBackground('#37474f').setFontColor('#ffffff').setFontWeight('bold');
  trackSh.setFrozenRows(1);
  trackSh.getRange('M1').setNote(
    '发布前填写预计页面格式（如：how-to教程/对比页/工具页）\n' +
    '发布后对比实际Top3格式，判断是否匹配——格式不匹配是排名不达预期的常见原因'
  );

  var fExpRank = '=IF(E2="","",IF(E2<=10,"P3-P10",IF(E2<=20,"P5-P20",IF(E2<=35,"P10-P30",IF(E2<=50,"P20-P50","P50+")))))';
  var fExpTraffic = '=IF(OR(F2="",E2=""),"",IF(E2<=10,ROUND(F2*0.11,0),IF(E2<=20,ROUND(F2*0.04,0),IF(E2<=35,ROUND(F2*0.015,0),IF(E2<=50,ROUND(F2*0.005,0),0)))))';
  var fDev = '=IF(OR(H2="",K2=""),"",IF(H2=0,"N/A",TEXT((K2-H2)/H2,"+0%;-0%;0%")))';

  trackSh.getRange('G2').setFormula(fExpRank);
  trackSh.getRange('H2').setFormula(fExpTraffic);
  trackSh.getRange('L2').setFormula(fDev);
  trackSh.getRange('G2:H2').copyTo(trackSh.getRange('G3:H200'));
  trackSh.getRange('L2').copyTo(trackSh.getRange('L3:L200'));
  trackSh.setColumnWidth(1, 250);
  trackSh.setColumnWidth(4, 220);

  // ────────────────────────────────────────────
  // SHEET 8: 📈来源分析
  // ────────────────────────────────────────────
  var srcSh = ss.insertSheet('📈来源分析');
  srcSh.getRange(1, 1, 1, 6)
    .setValues([['来源','执行词数','已发布','命中(P1-P30)','命中率','下次是否加大投入？']])
    .setBackground('#37474f').setFontColor('#ffffff').setFontWeight('bold');

  ['竞品映射','内容缺口','种子词拓展','社区挖掘','趋势词','Social信号'].forEach(function(src, i) {
    var r = i + 2;
    srcSh.getRange(r, 1).setValue(src);
    srcSh.getRange(r, 5).setFormula('=IF(B'+r+'=0,"",TEXT(D'+r+'/B'+r+',"0.0%"))');
  });
  srcSh.getRange(8, 1, 1, 5).setValues([
    ['合计','=SUM(B2:B7)','=SUM(C2:C7)','=SUM(D2:D7)','=IF(B8=0,"",TEXT(D8/B8,"0.0%"))']
  ]).setFontWeight('bold').setBackground('#eceff1');
  srcSh.setColumnWidth(1, 120);
  srcSh.setColumnWidth(6, 180);
  srcSh.getRange('A1').setNote('命中率最高的来源=GenGrowth产品优先自动化的模块');

  // ────────────────────────────────────────────
  Logger.log('✅ 创建成功（v3.3 · 14 表）：' + ss.getUrl());
  Logger.log('⚠️  请先在 ⚙️配置 表填写：目标国家(B4)、TOPIC_KEYWORDS(A6:A25)、NEGATIVE_KEYWORDS(A28:A45)');
}

// ── 辅助：为桶视图添加说明行 + 表头行 ──
function _styleViewSheet(sheet, color, note) {
  sheet.insertRowBefore(1);
  sheet.getRange('A1').setValue('⬆ 数据从第3行起自动填充 | ' + note);
  sheet.getRange(1, 1, 1, 28)
    .setBackground(color).setFontStyle('italic').setFontColor('#555555');
  // 第2行是公式输出的表头行（来自关键词主表!A1:AB1），统一加深色样式
  sheet.getRange(2, 1, 1, 28)
    .setBackground('#37474f').setFontColor('#ffffff').setFontWeight('bold');
  sheet.setFrozenRows(2);
}

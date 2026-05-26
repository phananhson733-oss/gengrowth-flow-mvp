// author-routing.mjs — cluster-domain → author 混合路由 (Lane B / T3).
//
// 契约（与 content-draft / Lane A 对齐）：brief 上的三个字段
//   - author          作家 id 字符串（kebab，如 "marcus-orion"）或 '' (未命中)
//   - author_source   'auto' | 'override'  (留空时无该字段)
//   - cluster_domain  cluster 的领域 join key（= 主题集群表 primary_entity 列）
//
// 路由规则（混合：自动建议 + 人工覆盖）：
//   1. sheet 选题登记表若有 author 列且非空 → override（合法 id 校验 + 规整大小写），
//      不被自动值覆盖。
//   2. 否则按 cluster_domain 查 config snapshot 的 `author.map.<domain>` 映射 → auto。
//   3. 都没有 → author 留空（不回退默认作家；硬拦在 Lane A content-draft 做）。
//
// 非法 author_id → 不写 author + 记 warning（fail-loud 由调用方决定退出码）。

// 4 位已知作家（kebab id）。override / map 值都对照这张表校验，挡 typo / 串味。
export const KNOWN_AUTHOR_IDS = Object.freeze([
  'elena-vane', // Aura / Chakra / 能量
  'julian-thorne', // Houses / Nodes / Chiron
  'aditi-sharma', // Vedic / Nakshatra
  'marcus-orion', // Basics / Transits / Aspects
]);

// config snapshot 里 author.map 的 key 前缀（动态域名）。
export const AUTHOR_MAP_PREFIX = 'author.map.';

// 规整 author id：trim + lowercase（"Marcus-Orion" / " marcus-orion " → "marcus-orion"）。
export function normalizeAuthorId(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase();
}

// 是否合法 author id（对照 4 个已知 id，大小写不敏感）。
export function isValidAuthorId(raw) {
  return KNOWN_AUTHOR_IDS.includes(normalizeAuthorId(raw));
}

// 规整 cluster domain join key：trim + lowercase（映射查找用，挡大小写/空白漂移）。
export function normalizeDomain(raw) {
  if (raw == null) return '';
  return String(raw).trim().toLowerCase();
}

// 从 config snapshot values（dotted-key 扁平 map）抽出 author.map.* 整组，
// 规整成 Map<normalized-domain, author_id>。非法 author_id 值跳过 + 记 warning。
// snapshotValues: Record<string, string>（gg-config-sync 落的 .values）。
// 返回 { map: Map, warnings: string[] }。
export function buildAuthorMap(snapshotValues) {
  const map = new Map();
  const warnings = [];
  if (!snapshotValues || typeof snapshotValues !== 'object') return { map, warnings };
  for (const [key, val] of Object.entries(snapshotValues)) {
    if (!key.startsWith(AUTHOR_MAP_PREFIX)) continue;
    const domain = normalizeDomain(key.slice(AUTHOR_MAP_PREFIX.length));
    if (!domain) {
      warnings.push(`author.map key "${key}" has empty domain — skipped`);
      continue;
    }
    const authorId = normalizeAuthorId(val);
    if (!isValidAuthorId(authorId)) {
      warnings.push(`author.map "${key}" = "${val}" is not a known author_id — skipped`);
      continue;
    }
    map.set(domain, authorId);
  }
  return { map, warnings };
}

// 混合路由核心（纯函数，给两个 brief 脚本 + 预检报告 + 测试共用）。
//   - clusterDomain: cluster 的 primary_entity（join key）
//   - overrideRaw:   选题登记表 author 列原始值（可空）
//   - authorMap:     buildAuthorMap(...).map
// 返回 { author, author_source, cluster_domain, warnings[] }。
//   author '' = 未命中（留空，不回退默认）；author_source 仅在命中时有值。
export function resolveAuthor({ clusterDomain, overrideRaw, authorMap }) {
  const domain = normalizeDomain(clusterDomain);
  const warnings = [];
  const overrideTrimmed = overrideRaw == null ? '' : String(overrideRaw).trim();

  // 1. 人工 override 优先，且永不被自动值覆盖。
  if (overrideTrimmed) {
    if (isValidAuthorId(overrideTrimmed)) {
      return {
        author: normalizeAuthorId(overrideTrimmed),
        author_source: 'override',
        cluster_domain: domain,
        warnings,
      };
    }
    // 非法 override → 拒绝（不写 author），记 warning。不静默回退自动值，
    // 因为人工显式填了一个值，回退会掩盖 typo。
    warnings.push(
      `author override "${overrideTrimmed}" is not a known author_id (${KNOWN_AUTHOR_IDS.join('/')}) — rejected, author left blank`,
    );
    return { author: '', author_source: undefined, cluster_domain: domain, warnings };
  }

  // 2. 自动：按 cluster_domain 查映射。
  const mapped = authorMap instanceof Map ? authorMap.get(domain) : undefined;
  if (mapped) {
    return { author: mapped, author_source: 'auto', cluster_domain: domain, warnings };
  }

  // 3. 未命中 → 留空（硬拦在 content-draft）。
  return { author: '', author_source: undefined, cluster_domain: domain, warnings };
}

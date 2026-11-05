/**
 * Locale selection and the CLI's own strings (summary, stat, Markdown). Hunk titles come from
 * `@kgdiff/core`'s `formatHunk`; errors and notices on stderr stay in English so they can be
 * searched for.
 */
import type { Locale, ReplayPhase } from '@kgdiff/core';
import { type ChangeFamily, isDefinitionKey, type PossibleMatchSide } from './model.js';
import type { Env } from './style.js';

export const LOCALES: readonly Locale[] = ['en', 'zh-CN'];

/**
 * Map a locale tag or POSIX locale (`zh_CN.UTF-8`, `zh-Hant`, `en_US`, `C`) to a supported
 * locale: any Chinese tag → `zh-CN`, any English or POSIX tag → `en`, anything else `undefined`.
 */
export function matchLocale(tag: string): Locale | undefined {
  const t = tag
    .trim()
    .toLowerCase()
    .replace(/[.@].*$/, '')
    .replace(/_/g, '-');
  if (t === 'zh' || t.startsWith('zh-') || t === 'cn') return 'zh-CN';
  if (t === 'en' || t.startsWith('en-') || t === 'c' || t === 'posix') return 'en';
  return undefined;
}

/**
 * The locale to use: `--locale` when given, else the first non-empty of `LC_ALL`, `LC_MESSAGES`,
 * `LANG` (POSIX precedence), mapped with `matchLocale`; `en` when nothing matches.
 */
export function resolveLocale(flag: Locale | undefined, env: Env): Locale {
  if (flag) return flag;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const value = env[name];
    if (value) return matchLocale(value) ?? 'en';
  }
  return 'en';
}

/** Thousands separators without `Intl`, so output never depends on the runtime's ICU data. */
export function formatInt(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface Messages {
  /** Group headings, by replay phase. */
  readonly phase: Readonly<Record<ReplayPhase, string>>;
  /** Counter labels (`+3 added`), by replay phase. */
  readonly counter: Readonly<Record<ReplayPhase, string>>;
  readonly family: Readonly<Record<ChangeFamily, string>>;
  /** `179 → 184 nodes · 351 → 353 edges`; one number when a count did not change. */
  readonly totals: (nodes: Count, edges: Count) => string;
  readonly changes: (changes: number, hunks: number) => string;
  readonly more: (n: number) => string;
  readonly moreHint: string;
  readonly identical: string;
  readonly identicalDetail: (nodes: number, edges: number) => string;
  readonly table: {
    readonly nodes: string;
    readonly edges: string;
    readonly added: string;
    readonly removed: string;
    readonly modified: string;
    readonly unchanged: string;
    readonly total: string;
  };
  readonly byType: string;
  readonly untyped: string;
  readonly moreTypes: (n: number) => string;
  /** Watched attributes (`--watch-attr`): changes flagged ⚑ for review first. */
  readonly watch: {
    /** How the default definition keys (`def`, `IAO:0000115`, …) are named. */
    readonly definition: string;
    /** After ⚑ under the diffstat bar: `Review first: definition changed in 10 hunks`. */
    readonly line: (labels: readonly string[], hunks: number) => string;
    /** After ⚑ in a hunk's summary: `definition`. */
    readonly marker: (labels: readonly string[]) => string;
  };
  /** Pairings kgdiff considered but did not apply, listed after the hunks. */
  readonly possible: {
    readonly heading: string;
    /** `“Saudi Aramco” → “Aramco”`; each side's id is added when both have the same name. */
    readonly title: (before: PossibleMatchSide, after: PossibleMatchSide) => string;
    readonly belowThreshold: (threshold: string) => string;
    readonly ambiguous: string;
    readonly evidence: (label: string, neighbors: string) => string;
    /** Terminal: what "not applied" means and how to pair one. */
    readonly hint: string;
    readonly more: (n: number) => string;
  };
  readonly markdown: {
    readonly legend: string;
    readonly more: (n: number) => string;
    /** Heading of the block of hunks that change a watched attribute (after ⚑). */
    readonly reviewFirst: string;
    readonly reviewFirstHint: (labels: readonly string[]) => string;
    readonly reviewFirstMore: (n: number) => string;
    /** Like `possible.hint`, as Markdown. */
    readonly possibleHint: string;
    readonly possibleMore: (n: number) => string;
    readonly generatedBy: (generator: string) => string;
  };
}

/**
 * Display names of watched attribute keys, in order: the default definition keys are all
 * “definition” (once), other keys are shown as they are.
 */
export function watchLabels(keys: readonly string[], m: Messages): string[] {
  const labels: string[] = [];
  for (const key of keys) {
    const label = isDefinitionKey(key) ? m.watch.definition : key;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/**
 * Both sides of a possible match, quoted and joined by `arrow`. When they share a name (two
 * “Apple”s), `withId` adds each side's id, as hunk titles do for equally named nodes.
 */
function possibleTitle(
  before: PossibleMatchSide,
  after: PossibleMatchSide,
  quote: (name: string) => string,
  withId: (quoted: string, id: string) => string,
  arrow: string,
): string {
  const same = before.name === after.name;
  const side = (s: PossibleMatchSide): string =>
    same ? withId(quote(s.name), s.id) : quote(s.name);
  return `${side(before)}${arrow}${side(after)}`;
}

/** A count before and after the change. */
export type Count = readonly [before: number, after: number];

const plural = (n: number, one: string, many: string): string =>
  `${formatInt(n)} ${n === 1 ? one : many}`;

/** `179 → 184`, or `74` when unchanged. */
export function formatCount([before, after]: Count): string {
  return before === after ? formatInt(after) : `${formatInt(before)} → ${formatInt(after)}`;
}

const en: Messages = {
  phase: {
    restructure: 'Restructured',
    modify: 'Modified',
    add: 'Added',
    remove: 'Removed',
  },
  counter: { add: 'added', remove: 'removed', modify: 'modified', restructure: 'restructured' },
  family: {
    added: 'added',
    removed: 'removed',
    content: 'content',
    structure: 'structure',
    identity: 'identity',
  },
  // The noun agrees with the number next to it (the after count): `1 node`, `2 → 1 node`.
  totals: (nodes, edges) =>
    `${formatCount(nodes)} ${nodes[1] === 1 ? 'node' : 'nodes'} · ` +
    `${formatCount(edges)} ${edges[1] === 1 ? 'edge' : 'edges'}`,
  changes: (changes, hunks) =>
    `${plural(changes, 'change', 'changes')} in ${plural(hunks, 'hunk', 'hunks')}`,
  more: (n) => `… and ${formatInt(n)} more`,
  moreHint: '--limit 0 lists all',
  identical: 'No differences',
  identicalDetail: (nodes, edges) =>
    `Both versions have ${plural(nodes, 'node', 'nodes')} and ${plural(edges, 'edge', 'edges')}.`,
  table: {
    nodes: 'nodes',
    edges: 'edges',
    added: 'added',
    removed: 'removed',
    modified: 'modified',
    unchanged: 'unchanged',
    total: 'before → after',
  },
  byType: 'By type',
  untyped: '(untyped)',
  moreTypes: (n) => `… and ${plural(n, 'more type', 'more types')}`,
  watch: {
    definition: 'definition',
    line: (labels, hunks) =>
      `Review first: ${labels.join(', ')} changed in ${plural(hunks, 'hunk', 'hunks')}`,
    marker: (labels) => labels.join(', '),
  },
  possible: {
    heading: 'Possible matches',
    title: (before, after) =>
      possibleTitle(
        before,
        after,
        (name) => `“${name}”`,
        (quoted, id) => `${quoted} (${id})`,
        ' → ',
      ),
    belowThreshold: (threshold) => `below the ${threshold} threshold`,
    ambiguous: 'too close to another candidate',
    evidence: (label, neighbors) => `name ${label} · neighbours ${neighbors}`,
    hint:
      'Not paired, so listed as removed or added. To pair one, add a synonym or a ' +
      'replacement link, or lower --threshold.',
    more: (n) => `… and ${formatInt(n)} more · --json lists all`,
  },
  markdown: {
    legend:
      '🟩 added · 🟥 removed · 🟨 content (renames, attributes, types, synonyms) · ' +
      '🟦 structure (moves, relations) · 🟪 identity (merges, splits)',
    more: (n) =>
      `…and ${plural(n, 'more hunk', 'more hunks')}. Open the HTML report for the full list.`,
    reviewFirst: 'Review first',
    reviewFirstHint: (labels) =>
      `These hunks change a watched attribute (${labels.join(', ')}). Such an edit can change ` +
      'what existing data means even when the diff looks small.',
    reviewFirstMore: (n) => `…and ${formatInt(n)} more.`,
    possibleHint:
      'kgdiff did not pair these nodes, so they are listed above as removed or added. If a ' +
      'pair is the same thing, add a synonym or a replacement link, or lower `--threshold`.',
    possibleMore: (n) =>
      `…and ${plural(n, 'more possible match', 'more possible matches')}. The HTML report ` +
      "shows them in each node's details.",
    generatedBy: (generator) => `Generated by ${generator}`,
  },
};

const zh: Messages = {
  phase: { restructure: '结构调整', modify: '修改', add: '新增', remove: '删除' },
  counter: { add: '新增', remove: '删除', modify: '修改', restructure: '结构调整' },
  family: {
    added: '新增',
    removed: '删除',
    content: '内容',
    structure: '结构',
    identity: '身份',
  },
  totals: (nodes, edges) => `节点 ${formatCount(nodes)} · 关系 ${formatCount(edges)}`,
  changes: (changes, hunks) => `${formatInt(hunks)} 组共 ${formatInt(changes)} 处变化`,
  more: (n) => `… 另有 ${formatInt(n)} 组`,
  moreHint: '--limit 0 显示全部',
  identical: '没有差异',
  identicalDetail: (nodes, edges) =>
    `两个版本均有 ${formatInt(nodes)} 个节点、${formatInt(edges)} 条关系。`,
  table: {
    nodes: '节点',
    edges: '关系',
    added: '新增',
    removed: '删除',
    modified: '修改',
    unchanged: '未变',
    total: '变更前 → 变更后',
  },
  byType: '按类型',
  untyped: '（无类型）',
  moreTypes: (n) => `… 另有 ${formatInt(n)} 个类型`,
  watch: {
    definition: '定义',
    line: (labels, hunks) => `优先审查：${formatInt(hunks)} 组变更修改了${labels.join('、')}`,
    marker: (labels) => labels.join('、'),
  },
  possible: {
    heading: '可能的匹配',
    title: (before, after) =>
      possibleTitle(
        before,
        after,
        (name) => `「${name}」`,
        (quoted, id) => `${quoted}（${id}）`,
        '→',
      ),
    belowThreshold: (threshold) => `低于阈值 ${threshold}`,
    ambiguous: '与其他候选过于接近',
    evidence: (label, neighbors) => `名称 ${label} · 邻居 ${neighbors}`,
    hint: '这些节点未配对，因此按删除或新增列出。如是同一节点，可补充别名或替换链接，或调低 --threshold。',
    more: (n) => `… 另有 ${formatInt(n)} 对 · --json 列出全部`,
  },
  markdown: {
    legend:
      '🟩 新增 · 🟥 删除 · 🟨 内容（改名、属性、类型、别名） · 🟦 结构（移动、关系） · 🟪 身份（合并、拆分、换 ID）',
    more: (n) => `……另有 ${formatInt(n)} 组变更未列出，完整列表请查看 HTML 报告。`,
    reviewFirst: '优先审查',
    reviewFirstHint: (labels) =>
      `这些变更修改了受关注的属性（${labels.join('、')}）。这类修改在差异里看起来很小，却可能改变已有数据的含义。`,
    reviewFirstMore: (n) => `……另有 ${formatInt(n)} 组。`,
    possibleHint:
      'kgdiff 没有配对这些节点，因此它们在上方按删除或新增列出。如果某一对其实是同一节点，可补充别名或替换链接，或调低 `--threshold`。',
    possibleMore: (n) =>
      `……另有 ${formatInt(n)} 对可能的匹配未列出，HTML 报告的节点详情中可以看到全部。`,
    generatedBy: (generator) => `由 ${generator} 生成`,
  },
};

const MESSAGES: Readonly<Record<Locale, Messages>> = { en, 'zh-CN': zh };

export function messages(locale: Locale): Messages {
  return MESSAGES[locale];
}

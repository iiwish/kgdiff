/**
 * UI strings (`en`, `zh-CN`). Hunk titles and facet names come from core (`formatHunk`,
 * `facetLabel`); everything the viewer itself says lives here.
 *
 * Placeholders are `{name}`. Keys ending in `.one` / `.other` are plural pairs used through
 * `plural()`. Chinese UI quotes names with 「」, English with “ ”.
 */
import type { Locale } from '@kgdiff/core';

/**
 * Every message once, as `[en, zh-CN]`: the translations sit side by side and each key is
 * spelled once, so bundles carry no second copy of the keys.
 */
const TABLE = {
  'brand.tagline': ['git diff for knowledge graphs', '知识图谱的 git diff'],
  'header.compare': ['Compared versions', '对比的版本'],
  'header.actions': ['Viewer actions', '查看器操作'],
  'dock.label': ['View', '视图'],
  'mode.label': ['Compare by', '对比方式'],
  'mode.overlay': ['Overlay', '叠加'],
  'mode.swipe': ['Swipe', '滑动对比'],
  'mode.replay': ['Replay', '回放'],
  'mode.changes': ['Changes only', '仅看变更'],
  'scope.hint': ['Show only the changes, with nearby context', '只显示变更，以及附近的上下文'],
  'scope.on': ['Showing only the changes', '只显示变更'],
  'scope.off': ['Showing the whole graph', '显示全图'],
  'scope.locked': [
    'This graph was laid out around its changes only: the whole graph cannot be shown.',
    '这张图只对变更部分做了布局，无法显示全图。',
  ],
  'family.added': ['Added', '新增'],
  'family.removed': ['Removed', '删除'],
  'family.content': ['Content', '内容'],
  'family.structure': ['Structure', '结构'],
  'family.identity': ['Identity', '身份'],
  'family.neutral': ['Unchanged', '未变'],
  'familyHint.added': ['Only in the new version', '只在新版本中'],
  'familyHint.removed': ['Only in the old version', '只在旧版本中'],
  'familyHint.content': ['Renamed, attributes, types, synonyms', '改名、属性、类型、别名'],
  'familyHint.structure': ['Moved or relinked', '移动或关系改指向'],
  'familyHint.identity': ['Merged, split or re-keyed', '合并、拆分或更换 id'],
  'familyHint.neutral': ['Unchanged context', '未变化的上下文'],
  'phase.remove': ['Removed', '删除'],
  'phase.restructure': ['Restructured', '结构调整'],
  'phase.modify': ['Modified', '修改'],
  'phase.add': ['Added', '新增'],
  'kind.add': ['Addition', '新增'],
  'kind.remove': ['Removal', '删除'],
  'kind.merge': ['Merge', '合并'],
  'kind.split': ['Split', '拆分'],
  'kind.modify': ['Edit', '修改'],
  'kind.relations': ['Relations', '关系'],
  'status.unchanged': ['Unchanged', '未变'],
  'status.added': ['Added', '新增'],
  'status.removed': ['Removed', '删除'],
  'status.modified': ['Modified', '修改'],
  'action.fit': ['Fit to view', '适应视图'],
  'action.help': ['Keyboard shortcuts', '键盘快捷键'],
  'action.sidebar': ['Toggle sidebar', '显示或隐藏侧栏'],
  'action.zoomIn': ['Zoom in', '放大'],
  'action.zoomOut': ['Zoom out', '缩小'],
  'action.settings': ['Display settings', '显示设置'],
  'menu.theme': ['Theme', '主题'],
  'menu.palette': ['Colors', '配色'],
  'menu.language': ['Language', '语言'],
  'theme.auto': ['Auto', '跟随系统'],
  'theme.light': ['Light', '浅色'],
  'theme.dark': ['Dark', '深色'],
  'palette.default': ['Default', '默认'],
  'palette.colorblind': ['Color-blind safe', '色觉友好'],
  'sidebar.label': ['Change list', '变更列表'],
  'sidebar.changes': ['Changes', '变更'],
  'sidebar.search': ['Search nodes', '搜索节点'],
  'sidebar.searchPlaceholder': ['Search nodes…', '搜索节点…'],
  'sidebar.searchClear': ['Clear search', '清除搜索'],
  'sidebar.noResults': ['No nodes match “{q}”', '没有与「{q}」匹配的节点'],
  'sidebar.results.one': ['{n} node', '{n} 个节点'],
  'sidebar.results.other': ['{n} nodes', '{n} 个节点'],
  'sidebar.filters': ['Filter by kind of change', '按变更类别筛选'],
  'sidebar.clearFilters': ['Show all', '显示全部'],
  'sidebar.filteredEmpty': ['No changes match the filters.', '没有符合筛选条件的变更。'],
  'sidebar.noChanges': ['No changes to review.', '没有需要审阅的变更。'],
  'sidebar.sheet': ['Resize panel', '调整面板高度'],
  'sidebar.sheetValue': ['{p} of the height', '占高度的 {p}'],
  'review.progress': ['{done} of {total} reviewed', '已审阅 {done} / {total}'],
  'review.toggle': ['Reviewed', '已审阅'],
  'review.mark': ['Mark as reviewed', '标记为已审阅'],
  'review.unmark': ['Mark as not reviewed', '标记为未审阅'],
  'review.complete': ['All changes reviewed', '全部变更已审阅'],
  'detail.label': ['Change details', '变更详情'],
  'detail.empty': ['Select a change to see what happened.', '选择一项变更，查看具体发生了什么。'],
  'detail.emptyHint': ['Use j / k to step through changes.', '按 j / k 逐项浏览变更。'],
  'detail.prev': ['Previous change', '上一项变更'],
  'detail.next': ['Next change', '下一项变更'],
  'detail.changes': ['Changes', '变更内容'],
  'detail.changedTo': ['changed to', '改为'],
  'detail.identity': ['Overview', '基本信息'],
  'detail.id': ['Id', 'ID'],
  'detail.types': ['Types', '类型'],
  'detail.status': ['Status', '状态'],
  'detail.name': ['Name', '名称'],
  'detail.before': ['Before', '变更前'],
  'detail.after': ['After', '变更后'],
  'detail.attributes': ['Attributes', '属性'],
  'detail.aliases': ['Synonyms', '别名'],
  'detail.hierarchy': ['Hierarchy', '层级'],
  'detail.relations': ['Relations', '关系'],
  'detail.composition': ['Composition', '组成'],
  'detail.evidence': ['Match evidence', '匹配依据'],
  'detail.nodes': ['Nodes', '节点'],
  'detail.showMore': ['Show more', '展开'],
  'detail.showLess': ['Show less', '收起'],
  'detail.unchangedAttrs.one': ['{n} unchanged attribute', '{n} 个未变属性'],
  'detail.unchangedAttrs.other': ['{n} unchanged attributes', '{n} 个未变属性'],
  'detail.moreRelations.one': ['{n} more relation', '另外 {n} 条关系'],
  'detail.moreRelations.other': ['{n} more relations', '另外 {n} 条关系'],
  'detail.was': ['was {x}', '原为{x}'],
  'detail.viaHint': ['via replacement hint', '依据替代声明'],
  'detail.viaHeuristic': ['heuristic', '启发式推断'],
  'detail.confidence': ['{p} confidence', '置信度 {p}'],
  'detail.matchScore': ['{p} match', '匹配度 {p}'],
  'detail.matchHint': ['Matched through a replacement hint', '依据替代声明匹配'],
  'detail.evidence.label': ['Label', '名称'],
  'detail.evidence.neighbors': ['Neighbours', '邻居'],
  'detail.evidence.types': ['Types', '类型'],
  'detail.evidence.attrs': ['Attributes', '属性'],
  'detail.suggestion': ['Possible match', '可能是同一节点'],
  'detail.suggestion.ambiguous': ['ambiguous', '存在歧义'],
  'detail.suggestion.below': ['below threshold', '低于阈值'],
  'detail.deprecated': ['Deprecated', '已弃用'],
  'detail.undeprecated': ['No longer deprecated', '取消弃用'],
  'detail.replacedBy': ['Replaced by', '替代为'],
  'detail.replaces': ['Replaces', '替代了'],
  'detail.unchangedNode': ['Unchanged node', '未变节点'],
  'detail.implicit': ['Created for a dangling relation', '因悬空关系自动创建'],
  'detail.collapsed': ['duplicate, collapsed', '重复关系，已合并'],
  'detail.mergedFrom': ['Merged from', '合并自'],
  'detail.splitInto': ['Split into', '拆分为'],
  'detail.edgeAttrs': ['attributes changed', '属性有变化'],
  'detail.showOnCanvas': ['Show on canvas', '在画布中显示'],
  'replay.label': ['Replay controls', '回放控制'],
  'replay.play': ['Play', '播放'],
  'replay.pause': ['Pause', '暂停'],
  'replay.speed': ['Playback speed {s}', '播放速度 {s}'],
  'replay.position': ['{i} / {n}', '{i} / {n}'],
  'replay.finished': ['Replay finished', '回放结束'],
  'replay.restart': ['Restart', '重新播放'],
  'replay.scrubber': ['Replay position', '回放进度'],
  'swipe.divider': ['Comparison divider', '对比分隔线'],
  'focus.context': ['Context', '上下文'],
  'focus.hops': ['Context hops', '上下文跳数'],
  'focus.expand': ['Click to expand', '点击展开'],
  'focus.expandUnavailable': [
    'Expanding needs the kgdiff compute add-on',
    '展开需要 kgdiff 计算模块（kgdiff-viewer-compute.js）',
  ],
  'focus.expandNearest': ['Show hidden context near the selection', '展开选中项附近的隐藏节点'],
  'announce.expanded': ['Expanded {label}', '已展开{label}'],
  'announce.nothingHidden': ['No hidden context', '没有隐藏的节点'],
  'help.expand': ['Show hidden context (changes only)', '展开隐藏节点（仅看变更）'],
  'legend.title': ['Legend', '图例'],
  'legend.toggle': ['Toggle legend', '显示或隐藏图例'],
  'minimap.label': ['Overview', '全局缩略图'],
  'tooltip.relations.one': ['{n} relation', '{n} 条关系'],
  'tooltip.relations.other': ['{n} relations', '{n} 条关系'],
  'tooltip.select': ['Click to select', '点击选中'],
  'help.title': ['Keyboard shortcuts', '键盘快捷键'],
  'help.close': ['Close', '关闭'],
  'help.enter': ['Fly to the selected change', '定位到选中的变更'],
  'help.esc': ['Clear selection, close popovers', '取消选择，关闭弹出层'],
  'help.space': ['Play / pause (replay)', '播放 / 暂停（回放）'],
  'help.arrows': ['Step (replay) · move divider (swipe)', '单步（回放）· 移动分隔线（滑动对比）'],
  'help.theme': ['Cycle theme', '切换主题'],
  'help.homeEnd': ['First / last change', '第一项 / 最后一项变更'],
  'state.loading': ['Preparing the diff', '正在准备对比'],
  'step.parse': ['Parsing', '解析文件'],
  'step.match': ['Matching nodes', '匹配节点'],
  'step.layout': ['Laying out', '计算布局'],
  'step.scene': ['Drawing', '绘制'],
  'state.identical.title': ['No differences', '没有差异'],
  'state.identical.body': [
    'Both versions have {nodes} and {edges}.',
    '两个版本均有 {nodes}、{edges}。',
  ],
  'count.nodes.one': ['{n} node', '{n} 个节点'],
  'count.nodes.other': ['{n} nodes', '{n} 个节点'],
  'count.edges.one': ['{n} edge', '{n} 条关系'],
  'count.edges.other': ['{n} edges', '{n} 条关系'],
  'state.error.title': ['This diff could not be shown', '无法显示这份对比'],
  'state.error.details': ['Details', '详细信息'],
  'state.empty.title': ['Nothing to compare yet', '还没有可对比的内容'],
  'state.empty.body': [
    'Load two versions of a graph to see what changed.',
    '载入一个图谱的两个版本，查看发生了哪些变化。',
  ],
  'aria.canvas': [
    'Graph diff. Before: {nb} nodes, {eb} edges. After: {na} nodes, {ea} edges. {changes}.',
    '图谱对比。变更前：{nb} 个节点、{eb} 条关系；变更后：{na} 个节点、{ea} 条关系；{changes}。',
  ],
  'aria.changes.one': ['{n} change', '共 {n} 项变更'],
  'aria.changes.other': ['{n} changes', '共 {n} 项变更'],
  'announce.change': ['Change {i} of {n}: {title}', '第 {i} 项变更，共 {n} 项：{title}'],
  'announce.node': ['Node {label}, {status}', '节点「{label}」，{status}'],
  'announce.mode': ['{mode} view', '{mode}视图'],
  'announce.cleared': ['Selection cleared', '已取消选择'],
  'announce.reviewed': ['Marked as reviewed. {progress}', '已标记为已审阅。{progress}'],
  'announce.unreviewed': ['Marked as not reviewed. {progress}', '已标记为未审阅。{progress}'],
  'announce.finished': ['Replay finished', '回放结束'],
  'announce.chapter': ['{phase}: {n} changes', '{phase}：{n} 项变更'],
  'error.formats': [
    'Parsing text needs @kgdiff/formats (import it, or pass parsed graphs).',
    '解析文本需要 @kgdiff/formats（请引入它，或传入已解析的图）。',
  ],
  'error.notLoaded': ['Nothing is loaded yet.', '尚未载入任何内容。'],
} as const satisfies Readonly<Record<string, readonly [en: string, zh: string]>>;

export type MessageKey = keyof typeof TABLE;
export type Messages = Readonly<Record<MessageKey, string>>;

function column(index: 0 | 1): Messages {
  return Object.fromEntries(
    Object.entries(TABLE).map(([key, texts]) => [key, texts[index]]),
  ) as Messages;
}

const en = column(0);

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, 'zh-CN': column(1) };

export const LOCALES: readonly Locale[] = ['en', 'zh-CN'];

/** `zh*` → `zh-CN`, anything else → `en`. */
export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'en' || v.startsWith('en-')) return 'en';
  if (v === 'zh' || v.startsWith('zh')) return 'zh-CN';
  return null;
}

/** The browser's preferred locale among the supported ones (default `en`). */
export function detectLocale(): Locale {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  for (const lang of nav?.languages ?? [nav?.language ?? '']) {
    const l = normalizeLocale(lang);
    if (l) return l;
  }
  return 'en';
}

const numberFormats = new Map<Locale, Intl.NumberFormat>();

export function formatNumber(n: number, locale: Locale): string {
  let nf = numberFormats.get(locale);
  if (nf === undefined) {
    nf = new Intl.NumberFormat(locale);
    numberFormats.set(locale, nf);
  }
  return nf.format(n);
}

export function formatPercent(x: number): string {
  return `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
}

export type Params = Readonly<Record<string, string | number>>;

/** Localized message with `{name}` placeholders; numbers are formatted for the locale. */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const template = (MESSAGES[locale] ?? MESSAGES.en)[key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = params[name];
    if (v === undefined) return match;
    return typeof v === 'number' ? formatNumber(v, locale) : v;
  });
}

type PluralBase<K> = K extends `${infer B}.one` ? B : never;
export type PluralKey = PluralBase<MessageKey>;

/** Plural pair `<key>.one` / `<key>.other` with `{n}`. */
export function plural(locale: Locale, key: PluralKey, n: number, params?: Params): string {
  const form = new Intl.PluralRules(locale).select(n) === 'one' ? 'one' : 'other';
  return translate(locale, `${key}.${form}` as MessageKey, { ...params, n });
}

/** Quote a node name the way the locale does: “name” / 「name」. */
export function quote(text: string, locale: Locale): string {
  return locale === 'zh-CN' ? `「${text}」` : `“${text}”`;
}

/** A translator bound to one locale. */
export interface Translator {
  readonly locale: Locale;
  t(key: MessageKey, params?: Params): string;
  plural(key: PluralKey, n: number, params?: Params): string;
  num(n: number): string;
  quote(text: string): string;
}

export function translator(locale: Locale): Translator {
  return {
    locale,
    t: (key, params) => translate(locale, key, params),
    plural: (key, n, params) => plural(locale, key, n, params),
    num: (n) => formatNumber(n, locale),
    quote: (text) => quote(text, locale),
  };
}

/**
 * UI strings (`en`, `zh-CN`). Hunk titles and facet names come from core (`formatHunk`,
 * `facetLabel`); everything the viewer itself says lives here.
 *
 * Placeholders are `{name}`. Keys ending in `.one` / `.other` are plural pairs used through
 * `plural()`. Chinese UI quotes names with 「」, English with “ ”.
 */
import type { Locale } from '@kgdiff/core';

const en = {
  'brand.tagline': 'git diff for knowledge graphs',
  'header.compare': 'Compared versions',
  'header.actions': 'Viewer actions',
  'dock.label': 'View',
  'mode.label': 'Compare by',
  'mode.overlay': 'Overlay',
  'mode.swipe': 'Swipe',
  'mode.replay': 'Replay',
  'mode.changes': 'Changes only',
  'scope.hint': 'Show only the changes, with nearby context',
  'scope.on': 'Showing only the changes',
  'scope.off': 'Showing the whole graph',
  'scope.locked':
    'This graph was laid out around its changes only: the whole graph cannot be shown.',
  'family.added': 'Added',
  'family.removed': 'Removed',
  'family.content': 'Content',
  'family.structure': 'Structure',
  'family.identity': 'Identity',
  'family.neutral': 'Unchanged',
  'familyHint.added': 'Only in the new version',
  'familyHint.removed': 'Only in the old version',
  'familyHint.content': 'Renamed, attributes, types, synonyms',
  'familyHint.structure': 'Moved or relinked',
  'familyHint.identity': 'Merged, split or re-keyed',
  'familyHint.neutral': 'Unchanged context',
  'phase.remove': 'Removed',
  'phase.restructure': 'Restructured',
  'phase.modify': 'Modified',
  'phase.add': 'Added',
  'kind.add': 'Addition',
  'kind.remove': 'Removal',
  'kind.merge': 'Merge',
  'kind.split': 'Split',
  'kind.modify': 'Edit',
  'kind.relations': 'Relations',
  'status.unchanged': 'Unchanged',
  'status.added': 'Added',
  'status.removed': 'Removed',
  'status.modified': 'Modified',
  'action.fit': 'Fit to view',
  'action.help': 'Keyboard shortcuts',
  'action.sidebar': 'Toggle sidebar',
  'action.zoomIn': 'Zoom in',
  'action.zoomOut': 'Zoom out',
  'action.settings': 'Display settings',
  'menu.theme': 'Theme',
  'menu.palette': 'Colors',
  'menu.language': 'Language',
  'theme.auto': 'Auto',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'palette.default': 'Default',
  'palette.colorblind': 'Color-blind safe',
  'sidebar.label': 'Change list',
  'sidebar.changes': 'Changes',
  'sidebar.search': 'Search nodes',
  'sidebar.searchPlaceholder': 'Search nodes…',
  'sidebar.searchClear': 'Clear search',
  'sidebar.searchResults': 'Matching nodes',
  'sidebar.noResults': 'No nodes match “{q}”',
  'sidebar.results.one': '{n} node',
  'sidebar.results.other': '{n} nodes',
  'sidebar.filters': 'Filter by kind of change',
  'sidebar.clearFilters': 'Show all',
  'sidebar.filteredEmpty': 'No changes match the filters.',
  'sidebar.noChanges': 'No changes to review.',
  'sidebar.sheet': 'Resize panel',
  'sidebar.sheetValue': '{p} of the height',
  'sidebar.resize': 'Resize the sidebar',
  'sidebar.split': 'Resize the change list and the details',
  'sidebar.splitValue': 'Change list {p} of the height',
  'sidebar.hideList': 'Collapse the change list',
  'sidebar.showList': 'Expand the change list',
  'review.progress': '{done} of {total} reviewed',
  'review.toggle': 'Reviewed',
  'review.mark': 'Mark as reviewed',
  'review.unmark': 'Mark as not reviewed',
  'review.complete': 'All changes reviewed',
  'detail.label': 'Change details',
  'detail.hide': 'Collapse the details',
  'detail.show': 'Expand the details',
  'detail.empty': 'Select a change to see what happened.',
  'detail.emptyHint': 'Use j / k to step through changes.',
  'detail.prev': 'Previous change',
  'detail.next': 'Next change',
  'detail.changes': 'Changes',
  'detail.changedTo': 'changed to',
  'detail.identity': 'Overview',
  'detail.id': 'Id',
  'detail.types': 'Types',
  'detail.status': 'Status',
  'detail.name': 'Name',
  'detail.before': 'Before',
  'detail.after': 'After',
  'detail.attributes': 'Attributes',
  'detail.aliases': 'Synonyms',
  'detail.hierarchy': 'Hierarchy',
  'detail.relations': 'Relations',
  'detail.composition': 'Composition',
  'detail.evidence': 'Match evidence',
  'detail.nodes': 'Nodes',
  'detail.showMore': 'Show more',
  'detail.showLess': 'Show less',
  'detail.unchangedAttrs.one': '{n} unchanged attribute',
  'detail.unchangedAttrs.other': '{n} unchanged attributes',
  'detail.moreRelations.one': '{n} more relation',
  'detail.moreRelations.other': '{n} more relations',
  'detail.was': 'was {x}',
  'detail.viaHint': 'via replacement hint',
  'detail.viaHeuristic': 'heuristic',
  'detail.confidence': '{p} confidence',
  'detail.matchScore': '{p} match',
  'detail.matchHint': 'Matched through a replacement hint',
  'detail.evidence.label': 'Label',
  'detail.evidence.neighbors': 'Neighbours',
  'detail.evidence.types': 'Types',
  'detail.evidence.attrs': 'Attributes',
  'detail.suggestion': 'Possible match',
  'detail.suggestion.ambiguous': 'ambiguous',
  'detail.suggestion.below': 'below threshold',
  'detail.deprecated': 'Deprecated',
  'detail.undeprecated': 'No longer deprecated',
  'detail.replacedBy': 'Replaced by',
  'detail.replaces': 'Replaces',
  'detail.unchangedNode': 'Unchanged node',
  'detail.implicit': 'Created for a dangling relation',
  'detail.collapsed': 'duplicate, collapsed',
  'detail.mergedFrom': 'Merged from',
  'detail.splitInto': 'Split into',
  'detail.edgeAttrs': 'attributes changed',
  'detail.showOnCanvas': 'Show on canvas',
  'replay.label': 'Replay controls',
  'replay.play': 'Play',
  'replay.pause': 'Pause',
  'replay.speed': 'Playback speed {s}',
  'replay.position': '{i} / {n}',
  'replay.finished': 'Replay finished',
  'replay.restart': 'Restart',
  'replay.scrubber': 'Replay position',
  'swipe.divider': 'Comparison divider',
  'focus.context': 'Context',
  'focus.hops': 'Context hops',
  'focus.expand': 'Click to expand',
  'focus.expandUnavailable': 'Expanding needs the kgdiff compute add-on',
  'focus.expandNearest': 'Show hidden context near the selection',
  'announce.expanded': 'Expanded {label}',
  'announce.nothingHidden': 'No hidden context',
  'help.expand': 'Show hidden context (changes only)',
  'legend.title': 'Legend',
  'legend.toggle': 'Toggle legend',
  'minimap.label': 'Overview',
  'zoom.label': 'Zoom',
  'stage.label': 'Graph diff',
  'tooltip.relations.one': '{n} relation',
  'tooltip.relations.other': '{n} relations',
  'tooltip.select': 'Click to select',
  'help.title': 'Keyboard shortcuts',
  'help.close': 'Close',
  'help.enter': 'Fly to the selected change',
  'help.esc': 'Clear selection, close popovers',
  'help.space': 'Play / pause (replay)',
  'help.arrows': 'Step (replay) · move divider (swipe)',
  'help.theme': 'Cycle theme',
  'help.homeEnd': 'First / last change',
  'state.loading': 'Preparing the diff',
  'step.parse': 'Parsing',
  'step.match': 'Matching nodes',
  'step.layout': 'Laying out',
  'step.scene': 'Drawing',
  'state.identical.title': 'No differences',
  'state.identical.body': 'Both versions have {nodes} and {edges}.',
  'count.nodes.one': '{n} node',
  'count.nodes.other': '{n} nodes',
  'count.edges.one': '{n} edge',
  'count.edges.other': '{n} edges',
  'state.error.title': 'This diff could not be shown',
  'state.error.details': 'Details',
  'state.empty.title': 'Nothing to compare yet',
  'state.empty.body': 'Load two versions of a graph to see what changed.',
  'aria.canvas':
    'Graph diff. Before: {nb} nodes, {eb} edges. After: {na} nodes, {ea} edges. {changes}.',
  'aria.changes.one': '{n} change',
  'aria.changes.other': '{n} changes',
  'announce.change': 'Change {i} of {n}: {title}',
  'announce.node': 'Node {label}, {status}',
  'announce.mode': '{mode} view',
  'announce.cleared': 'Selection cleared',
  'announce.reviewed': 'Marked as reviewed. {progress}',
  'announce.unreviewed': 'Marked as not reviewed. {progress}',
  'announce.finished': 'Replay finished',
  'announce.chapter': '{phase}: {n} changes',
  'error.formats': 'Parsing text needs @kgdiff/formats (import it, or pass parsed graphs).',
  'error.notLoaded': 'Nothing is loaded yet.',
  'error.noLayout':
    'This report has no layout, and laying it out in the browser needs the compute module: add kgdiff-viewer-compute.js (@kgdiff/viewer/standalone/compute) after the viewer, or import @kgdiff/viewer as a module.',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Readonly<Record<MessageKey, string>>;

const zhCN: Messages = {
  'brand.tagline': '知识图谱的 git diff',
  'header.compare': '对比的版本',
  'header.actions': '查看器操作',
  'dock.label': '视图',
  'mode.label': '对比方式',
  'mode.overlay': '叠加',
  'mode.swipe': '滑动对比',
  'mode.replay': '回放',
  'mode.changes': '仅看变更',
  'scope.hint': '只显示变更，以及附近的上下文',
  'scope.on': '只显示变更',
  'scope.off': '显示全图',
  'scope.locked': '这张图只对变更部分做了布局，无法显示全图。',
  'family.added': '新增',
  'family.removed': '删除',
  'family.content': '内容',
  'family.structure': '结构',
  'family.identity': '身份',
  'family.neutral': '未变',
  'familyHint.added': '只在新版本中',
  'familyHint.removed': '只在旧版本中',
  'familyHint.content': '改名、属性、类型、别名',
  'familyHint.structure': '移动或关系改指向',
  'familyHint.identity': '合并、拆分或更换 id',
  'familyHint.neutral': '未变化的上下文',
  'phase.remove': '删除',
  'phase.restructure': '结构调整',
  'phase.modify': '修改',
  'phase.add': '新增',
  'kind.add': '新增',
  'kind.remove': '删除',
  'kind.merge': '合并',
  'kind.split': '拆分',
  'kind.modify': '修改',
  'kind.relations': '关系',
  'status.unchanged': '未变',
  'status.added': '新增',
  'status.removed': '删除',
  'status.modified': '修改',
  'action.fit': '适应视图',
  'action.help': '键盘快捷键',
  'action.sidebar': '显示或隐藏侧栏',
  'action.zoomIn': '放大',
  'action.zoomOut': '缩小',
  'action.settings': '显示设置',
  'menu.theme': '主题',
  'menu.palette': '配色',
  'menu.language': '语言',
  'theme.auto': '跟随系统',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'palette.default': '默认',
  'palette.colorblind': '色觉友好',
  'sidebar.label': '变更列表',
  'sidebar.changes': '变更',
  'sidebar.search': '搜索节点',
  'sidebar.searchPlaceholder': '搜索节点…',
  'sidebar.searchClear': '清除搜索',
  'sidebar.searchResults': '匹配的节点',
  'sidebar.noResults': '没有与「{q}」匹配的节点',
  'sidebar.results.one': '{n} 个节点',
  'sidebar.results.other': '{n} 个节点',
  'sidebar.filters': '按变更类别筛选',
  'sidebar.clearFilters': '显示全部',
  'sidebar.filteredEmpty': '没有符合筛选条件的变更。',
  'sidebar.noChanges': '没有需要审阅的变更。',
  'sidebar.sheet': '调整面板高度',
  'sidebar.sheetValue': '占高度的 {p}',
  'sidebar.resize': '调整侧栏宽度',
  'sidebar.split': '调整变更列表与详情的高度',
  'sidebar.splitValue': '变更列表占高度的 {p}',
  'sidebar.hideList': '收起变更列表',
  'sidebar.showList': '展开变更列表',
  'review.progress': '已审阅 {done} / {total}',
  'review.toggle': '已审阅',
  'review.mark': '标记为已审阅',
  'review.unmark': '标记为未审阅',
  'review.complete': '全部变更已审阅',
  'detail.label': '变更详情',
  'detail.hide': '收起详情',
  'detail.show': '展开详情',
  'detail.empty': '选择一项变更，查看具体发生了什么。',
  'detail.emptyHint': '按 j / k 逐项浏览变更。',
  'detail.prev': '上一项变更',
  'detail.next': '下一项变更',
  'detail.changes': '变更内容',
  'detail.changedTo': '改为',
  'detail.identity': '基本信息',
  'detail.id': 'ID',
  'detail.types': '类型',
  'detail.status': '状态',
  'detail.name': '名称',
  'detail.before': '变更前',
  'detail.after': '变更后',
  'detail.attributes': '属性',
  'detail.aliases': '别名',
  'detail.hierarchy': '层级',
  'detail.relations': '关系',
  'detail.composition': '组成',
  'detail.evidence': '匹配依据',
  'detail.nodes': '节点',
  'detail.showMore': '展开',
  'detail.showLess': '收起',
  'detail.unchangedAttrs.one': '{n} 个未变属性',
  'detail.unchangedAttrs.other': '{n} 个未变属性',
  'detail.moreRelations.one': '另外 {n} 条关系',
  'detail.moreRelations.other': '另外 {n} 条关系',
  'detail.was': '原为{x}',
  'detail.viaHint': '依据替代声明',
  'detail.viaHeuristic': '启发式推断',
  'detail.confidence': '置信度 {p}',
  'detail.matchScore': '匹配度 {p}',
  'detail.matchHint': '依据替代声明匹配',
  'detail.evidence.label': '名称',
  'detail.evidence.neighbors': '邻居',
  'detail.evidence.types': '类型',
  'detail.evidence.attrs': '属性',
  'detail.suggestion': '可能是同一节点',
  'detail.suggestion.ambiguous': '存在歧义',
  'detail.suggestion.below': '低于阈值',
  'detail.deprecated': '已弃用',
  'detail.undeprecated': '取消弃用',
  'detail.replacedBy': '替代为',
  'detail.replaces': '替代了',
  'detail.unchangedNode': '未变节点',
  'detail.implicit': '因悬空关系自动创建',
  'detail.collapsed': '重复关系，已合并',
  'detail.mergedFrom': '合并自',
  'detail.splitInto': '拆分为',
  'detail.edgeAttrs': '属性有变化',
  'detail.showOnCanvas': '在画布中显示',
  'replay.label': '回放控制',
  'replay.play': '播放',
  'replay.pause': '暂停',
  'replay.speed': '播放速度 {s}',
  'replay.position': '{i} / {n}',
  'replay.finished': '回放结束',
  'replay.restart': '重新播放',
  'replay.scrubber': '回放进度',
  'swipe.divider': '对比分隔线',
  'focus.context': '上下文',
  'focus.hops': '上下文跳数',
  'focus.expand': '点击展开',
  'focus.expandUnavailable': '展开需要 kgdiff 计算模块（kgdiff-viewer-compute.js）',
  'focus.expandNearest': '展开选中项附近的隐藏节点',
  'announce.expanded': '已展开{label}',
  'announce.nothingHidden': '没有隐藏的节点',
  'help.expand': '展开隐藏节点（仅看变更）',
  'legend.title': '图例',
  'legend.toggle': '显示或隐藏图例',
  'minimap.label': '全局缩略图',
  'zoom.label': '缩放',
  'stage.label': '图谱差异',
  'tooltip.relations.one': '{n} 条关系',
  'tooltip.relations.other': '{n} 条关系',
  'tooltip.select': '点击选中',
  'help.title': '键盘快捷键',
  'help.close': '关闭',
  'help.enter': '定位到选中的变更',
  'help.esc': '取消选择，关闭弹出层',
  'help.space': '播放 / 暂停（回放）',
  'help.arrows': '单步（回放）· 移动分隔线（滑动对比）',
  'help.theme': '切换主题',
  'help.homeEnd': '第一项 / 最后一项变更',
  'state.loading': '正在准备对比',
  'step.parse': '解析文件',
  'step.match': '匹配节点',
  'step.layout': '计算布局',
  'step.scene': '绘制',
  'state.identical.title': '没有差异',
  'state.identical.body': '两个版本均有 {nodes}、{edges}。',
  'count.nodes.one': '{n} 个节点',
  'count.nodes.other': '{n} 个节点',
  'count.edges.one': '{n} 条关系',
  'count.edges.other': '{n} 条关系',
  'state.error.title': '无法显示这份对比',
  'state.error.details': '详细信息',
  'state.empty.title': '还没有可对比的内容',
  'state.empty.body': '载入一个图谱的两个版本，查看发生了哪些变化。',
  'aria.canvas':
    '图谱对比。变更前：{nb} 个节点、{eb} 条关系；变更后：{na} 个节点、{ea} 条关系；{changes}。',
  'aria.changes.one': '共 {n} 项变更',
  'aria.changes.other': '共 {n} 项变更',
  'announce.change': '第 {i} 项变更，共 {n} 项：{title}',
  'announce.node': '节点「{label}」，{status}',
  'announce.mode': '{mode}视图',
  'announce.cleared': '已取消选择',
  'announce.reviewed': '已标记为已审阅。{progress}',
  'announce.unreviewed': '已标记为未审阅。{progress}',
  'announce.finished': '回放结束',
  'announce.chapter': '{phase}：{n} 项变更',
  'error.formats': '解析文本需要 @kgdiff/formats（请引入它，或传入已解析的图）。',
  'error.notLoaded': '尚未载入任何内容。',
  'error.noLayout':
    '这份报告没有布局，在浏览器中布局需要计算模块：请在查看器之后加入 kgdiff-viewer-compute.js（@kgdiff/viewer/standalone/compute），或以模块方式引入 @kgdiff/viewer。',
};

export const MESSAGES: Readonly<Record<Locale, Messages>> = { en, 'zh-CN': zhCN };

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

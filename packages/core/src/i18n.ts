/**
 * Localized hunk titles and facet labels (`en`, `zh-CN`).
 *
 * Titles say what happened in one line, naming the nodes involved; subtitles summarize the
 * rest (counts, confidence, context). English quotes names “like this”, Chinese 「像这样」.
 */
import { KgdiffError } from './errors.js';
import type {
  AttrChange,
  DiffResult,
  EdgeFacet,
  FacetKind,
  Hunk,
  Locale,
  NodeFacet,
  UnionEdge,
  UnionId,
  UnionNode,
} from './types.js';
import { getOrCreate } from './util.js';

type Noun = 'node' | 'relation' | 'attribute' | 'type' | 'synonym' | 'duplicate';

interface Phrasebook {
  readonly quote: (text: string) => string;
  /** Names for titles: up to two shown, the rest counted (`total` ≥ names.length). */
  readonly names: (names: readonly string[], total: number) => string;
  /** `+2 −1 ~1 attributes` style change counts. */
  readonly delta: (noun: Noun, added: number, removed: number, modified: number) => string;
  readonly title: {
    readonly merged: (sources: string, target: string) => string;
    readonly split: (source: string, targets: string) => string;
    readonly added: (nodes: readonly string[], total: number, relations: number) => string;
    readonly removed: (nodes: readonly string[], total: number, relations: number) => string;
    readonly renamed: (from: string, to: string) => string;
    readonly moved: (node: string, under: string) => string;
    readonly detached: (node: string, from: string) => string;
    readonly deprecated: (node: string) => string;
    readonly restored: (node: string) => string;
    readonly rekeyed: (node: string) => string;
    readonly attrs: (node: string) => string;
    readonly types: (node: string) => string;
    readonly aliases: (node: string) => string;
    readonly replacement: (node: string) => string;
    readonly edited: (node: string) => string;
    readonly pointsTo: (source: string, relation: string, to: string, from: string) => string;
    readonly comesFrom: (target: string, relation: string, to: string, from: string) => string;
    readonly predicate: (source: string, target: string, from: string, to: string) => string;
    readonly edgeAdded: (source: string, relation: string, target: string) => string;
    readonly edgeRemoved: (source: string, relation: string, target: string) => string;
    readonly edgeEdited: (source: string, relation: string, target: string) => string;
    readonly relationsAdded: (n: number, source: string) => string;
    readonly relationsRemoved: (n: number, source: string) => string;
    readonly relationsUpdated: (n: number, source: string) => string;
  };
  readonly note: {
    readonly viaHint: string;
    readonly inferred: (percent: string) => string;
    readonly confidence: (percent: string) => string;
    readonly carried: (n: number) => string;
    readonly collapsed: (n: number) => string;
    readonly keptDeprecated: string;
    readonly sourceKept: string;
    readonly sourceKeptDeprecated: string;
    readonly typed: (types: string) => string;
    readonly linkedTo: (nodes: string) => string;
    readonly wasLinkedTo: (nodes: string) => string;
    readonly standalone: string;
    readonly movedUnder: (nodes: string) => string;
    readonly movedFrom: (nodes: string) => string;
    readonly detachedFrom: (nodes: string) => string;
    readonly deprecated: string;
    readonly restored: string;
    readonly replacedBy: (nodes: string) => string;
    readonly noLongerReplaced: string;
    readonly replaces: (nodes: string) => string;
    readonly noLongerReplaces: (nodes: string) => string;
    readonly idChanged: (from: string, to: string) => string;
    readonly match: (percent: string) => string;
    readonly retargeted: (n: number) => string;
    readonly relationRetargeted: string;
    readonly relationResourced: string;
    readonly relationTypeChanged: string;
    readonly newRelation: string;
    readonly relationRemoved: string;
    readonly relabeled: (from: string, to: string) => string;
    readonly hierarchy: string;
  };
  readonly separator: string;
}

/** Thousands separators without `Intl`, so output never depends on the runtime's ICU data. */
function int(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

const EN_NOUNS: Readonly<Record<Noun, readonly [string, string]>> = {
  node: ['node', 'nodes'],
  relation: ['relation', 'relations'],
  attribute: ['attribute', 'attributes'],
  type: ['type', 'types'],
  synonym: ['synonym', 'synonyms'],
  duplicate: ['duplicate', 'duplicates'],
};

const ZH_NOUNS: Readonly<Record<Noun, readonly [string, string]>> = {
  node: ['个', '节点'],
  relation: ['条', '关系'],
  attribute: ['个', '属性'],
  type: ['个', '类型'],
  synonym: ['个', '别名'],
  duplicate: ['条', '重复关系'],
};

function deltaParts(added: number, removed: number, modified: number): string {
  const parts: string[] = [];
  if (added) parts.push(`+${int(added)}`);
  if (removed) parts.push(`−${int(removed)}`);
  if (modified) parts.push(`~${int(modified)}`);
  return parts.join(' ');
}

const en: Phrasebook = (() => {
  const q = (text: string): string => {
    const [name, id] = text.split(ID_MARK);
    return id === undefined ? `“${text}”` : `“${name}” (${id})`;
  };
  const count = (n: number, noun: Noun): string => `${int(n)} ${EN_NOUNS[noun][n === 1 ? 0 : 1]}`;
  const names = (list: readonly string[], total: number): string => {
    const shown = list.slice(0, 2).map(q);
    if (total <= 1) return shown[0] ?? '';
    if (total === 2) return `${shown[0]} and ${shown[1]}`;
    return `${shown[0]}, ${shown[1]} and ${int(total - 2)} more`;
  };
  const grew = (verb: string) => (nodes: readonly string[], total: number, relations: number) => {
    const first = q(nodes[0] ?? '');
    const rel = relations ? count(relations, 'relation') : '';
    if (total <= 1) return rel ? `${verb} ${first} and ${rel}` : `${verb} ${first}`;
    if (total === 2) {
      const second = q(nodes[1] ?? '');
      return rel ? `${verb} ${first}, ${second} and ${rel}` : `${verb} ${first} and ${second}`;
    }
    const more = `${int(total - 1)} more nodes`;
    return rel ? `${verb} ${first}, ${more} and ${rel}` : `${verb} ${first} and ${more}`;
  };
  const arrow = (s: string, relation: string, t: string): string => `${q(s)} —${relation}→ ${q(t)}`;
  return {
    quote: q,
    names,
    delta: (noun, a, r, m) => {
      const total = a + r + m;
      return total ? `${deltaParts(a, r, m)} ${EN_NOUNS[noun][total === 1 ? 0 : 1]}` : '';
    },
    title: {
      merged: (sources, target) => `Merged ${sources} into ${target}`,
      split: (source, targets) => `Split ${source} into ${targets}`,
      added: grew('Added'),
      removed: grew('Removed'),
      renamed: (from, to) => `Renamed ${q(from)} → ${q(to)}`,
      moved: (node, under) => `Moved ${q(node)} under ${under}`,
      detached: (node, from) => `Detached ${q(node)} from ${from}`,
      deprecated: (node) => `Deprecated ${q(node)}`,
      restored: (node) => `Restored ${q(node)}`,
      rekeyed: (node) => `Changed the id of ${q(node)}`,
      attrs: (node) => `Updated attributes of ${q(node)}`,
      types: (node) => `Changed the type of ${q(node)}`,
      aliases: (node) => `Updated synonyms of ${q(node)}`,
      replacement: (node) => `Updated replacement links of ${q(node)}`,
      edited: (node) => `Edited ${q(node)}`,
      pointsTo: (s, relation, to, from) =>
        `${q(s)}: ${relation} now points to ${q(to)} (was ${q(from)})`,
      comesFrom: (t, relation, to, from) =>
        `${q(t)}: ${relation} now comes from ${q(to)} (was ${q(from)})`,
      predicate: (s, t, from, to) => `${q(s)} → ${q(t)}: ${from} is now ${to}`,
      edgeAdded: (s, relation, t) => `Added ${arrow(s, relation, t)}`,
      edgeRemoved: (s, relation, t) => `Removed ${arrow(s, relation, t)}`,
      edgeEdited: (s, relation, t) => `Edited ${arrow(s, relation, t)}`,
      relationsAdded: (n, s) => `Added ${count(n, 'relation')} to ${q(s)}`,
      relationsRemoved: (n, s) => `Removed ${count(n, 'relation')} from ${q(s)}`,
      relationsUpdated: (n, s) => `Updated ${count(n, 'relation')} of ${q(s)}`,
    },
    note: {
      viaHint: 'via replacement hint',
      inferred: (p) => `inferred · ${p} confidence`,
      confidence: (p) => `${p} confidence`,
      carried: (n) => `${count(n, 'relation')} carried over`,
      collapsed: (n) => `${count(n, 'duplicate')} collapsed`,
      keptDeprecated: 'kept as deprecated',
      sourceKept: 'source kept',
      sourceKeptDeprecated: 'source kept as deprecated',
      typed: (types) => `type ${types}`,
      linkedTo: (nodes) => `linked to ${nodes}`,
      wasLinkedTo: (nodes) => `was linked to ${nodes}`,
      standalone: 'standalone',
      movedUnder: (nodes) => `moved under ${nodes}`,
      movedFrom: (nodes) => `from ${nodes}`,
      detachedFrom: (nodes) => `detached from ${nodes}`,
      deprecated: 'deprecated',
      restored: 'restored',
      replacedBy: (nodes) => `replaced by ${nodes}`,
      noLongerReplaced: 'no longer replaced',
      replaces: (nodes) => `replaces ${nodes}`,
      noLongerReplaces: (nodes) => `no longer replaces ${nodes}`,
      idChanged: (from, to) => `${from} → ${to}`,
      match: (p) => `${p} match`,
      retargeted: (n) => `${int(n)} retargeted`,
      relationRetargeted: 'relation retargeted',
      relationResourced: 'relation moved to another subject',
      relationTypeChanged: 'relation type changed',
      newRelation: 'new relation',
      relationRemoved: 'relation removed',
      relabeled: (from, to) => `label ${q(from)} → ${q(to)}`,
      hierarchy: 'hierarchy',
    },
    separator: ' · ',
  };
})();

const zh: Phrasebook = (() => {
  const q = (text: string): string => {
    const [name, id] = text.split(ID_MARK);
    return id === undefined ? `「${text}」` : `「${name}」（${id}）`;
  };
  const count = (n: number, noun: Noun): string =>
    `${int(n)} ${ZH_NOUNS[noun][0]}${ZH_NOUNS[noun][1]}`;
  const names = (list: readonly string[], total: number): string => {
    const shown = list.slice(0, 2).map(q);
    if (total <= 1) return shown[0] ?? '';
    if (total === 2) return `${shown[0]}和${shown[1]}`;
    return `${shown[0]}、${shown[1]}等 ${int(total)} 个节点`;
  };
  const grew = (verb: string) => (nodes: readonly string[], total: number, relations: number) => {
    const first = q(nodes[0] ?? '');
    const subject =
      total <= 1
        ? first
        : total === 2
          ? `${first}和${q(nodes[1] ?? '')}`
          : `${first}等 ${int(total)} 个节点`;
    return relations ? `${verb}${subject}及 ${count(relations, 'relation')}` : `${verb}${subject}`;
  };
  const arrow = (s: string, relation: string, t: string): string => `${q(s)}—${relation}→${q(t)}`;
  return {
    quote: q,
    names,
    delta: (noun, a, r, m) => (a + r + m ? `${ZH_NOUNS[noun][1]} ${deltaParts(a, r, m)}` : ''),
    title: {
      merged: (sources, target) => `${sources}合并入${target}`,
      split: (source, targets) => `${source}拆分为${targets}`,
      added: grew('新增'),
      removed: grew('删除'),
      renamed: (from, to) => `${q(from)}改名为${q(to)}`,
      moved: (node, under) => `${q(node)}移至${under}下`,
      detached: (node, from) => `${q(node)}脱离${from}`,
      deprecated: (node) => `弃用${q(node)}`,
      restored: (node) => `恢复${q(node)}`,
      rekeyed: (node) => `${q(node)}的 ID 已变更`,
      attrs: (node) => `修改${q(node)}的属性`,
      types: (node) => `修改${q(node)}的类型`,
      aliases: (node) => `修改${q(node)}的别名`,
      replacement: (node) => `修改${q(node)}的替代关系`,
      edited: (node) => `修改${q(node)}`,
      pointsTo: (s, relation, to, from) =>
        `${q(s)}的${q(relation)}改为指向${q(to)}（原为${q(from)}）`,
      comesFrom: (t, relation, to, from) =>
        `${q(t)}的${q(relation)}改为来自${q(to)}（原为${q(from)}）`,
      predicate: (s, t, from, to) => `${q(s)}→${q(t)}的关系由${q(from)}改为${q(to)}`,
      edgeAdded: (s, relation, t) => `新增关系${arrow(s, relation, t)}`,
      edgeRemoved: (s, relation, t) => `删除关系${arrow(s, relation, t)}`,
      edgeEdited: (s, relation, t) => `修改关系${arrow(s, relation, t)}`,
      relationsAdded: (n, s) => `为${q(s)}新增 ${count(n, 'relation')}`,
      relationsRemoved: (n, s) => `删除${q(s)}的 ${count(n, 'relation')}`,
      relationsUpdated: (n, s) => `修改${q(s)}的 ${count(n, 'relation')}`,
    },
    note: {
      viaHint: '依据替代声明',
      inferred: (p) => `推断 · 置信度 ${p}`,
      confidence: (p) => `置信度 ${p}`,
      carried: (n) => `迁移 ${count(n, 'relation')}`,
      collapsed: (n) => `合并 ${count(n, 'duplicate')}`,
      keptDeprecated: '源节点保留为已弃用',
      sourceKept: '源节点保留',
      sourceKeptDeprecated: '源节点保留为已弃用',
      typed: (types) => `类型 ${types}`,
      linkedTo: (nodes) => `关联${nodes}`,
      wasLinkedTo: (nodes) => `原关联${nodes}`,
      standalone: '无外部关联',
      movedUnder: (nodes) => `移至${nodes}下`,
      movedFrom: (nodes) => `原属${nodes}`,
      detachedFrom: (nodes) => `脱离${nodes}`,
      deprecated: '已弃用',
      restored: '已恢复',
      replacedBy: (nodes) => `由${nodes}替代`,
      noLongerReplaced: '不再有替代项',
      replaces: (nodes) => `替代${nodes}`,
      noLongerReplaces: (nodes) => `不再替代${nodes}`,
      idChanged: (from, to) => `ID ${from} → ${to}`,
      match: (p) => `匹配度 ${p}`,
      retargeted: (n) => `${int(n)} 条关系改为指向新节点`,
      relationRetargeted: '关系改为指向新节点',
      relationResourced: '关系改为来自新节点',
      relationTypeChanged: '关系类型变更',
      newRelation: '新关系',
      relationRemoved: '关系已删除',
      relabeled: (from, to) => `标签${q(from)}→${q(to)}`,
      hierarchy: '层级关系',
    },
    separator: ' · ',
  };
})();

const PHRASEBOOKS: Readonly<Record<Locale, Phrasebook>> = { en, 'zh-CN': zh };

function phrasebook(locale: Locale | undefined): Phrasebook {
  return PHRASEBOOKS[locale ?? 'en'] ?? en;
}

type FacetLabels = Readonly<Record<FacetKind, string>>;

/**
 * Facet names for `facetLabel`. Kept apart from the phrasebooks, which only `formatHunk` reads,
 * so bundles that format hunks without naming facets (the standalone viewer) leave them out.
 */
const EN_FACETS: FacetLabels = {
  rekey: 'Re-keyed',
  rename: 'Renamed',
  mergedInto: 'Merged into',
  mergeTarget: 'Merge target',
  splitFrom: 'Split from',
  splitInto: 'Split into',
  move: 'Moved',
  deprecate: 'Deprecated',
  replacement: 'Replacement links',
  types: 'Types changed',
  aliases: 'Synonyms changed',
  attrs: 'Attributes changed',
  retarget: 'Retargeted',
  predicate: 'Relation type changed',
  label: 'Relabeled',
  collapsed: 'Collapsed duplicate',
};

const FACET_LABELS: Readonly<Record<Locale, FacetLabels>> = {
  en: EN_FACETS,
  'zh-CN': {
    rekey: 'ID 变更',
    rename: '改名',
    mergedInto: '合并入',
    mergeTarget: '合并目标',
    splitFrom: '拆分自',
    splitInto: '拆分为',
    move: '移动',
    deprecate: '弃用',
    replacement: '替代关系',
    types: '类型变更',
    aliases: '别名变更',
    attrs: '属性变更',
    retarget: '改为指向',
    predicate: '关系类型变更',
    label: '标签变更',
    collapsed: '重复合并',
  },
};

const MAX_NAME = 40;

/**
 * Separates a display name from the id appended to tell equally named nodes apart; the
 * phrasebooks render it as `“Heart” (T)` / `「Heart」（T）`.
 */
const ID_MARK = '\u0000';

/** Display names of several nodes; a name shared by different nodes gets each one's id appended. */
function distinct(entries: readonly { readonly id: UnionId; readonly name: string }[]): string[] {
  const ids = new Map<string, Set<UnionId>>();
  for (const e of entries) getOrCreate(ids, e.name, () => new Set<UnionId>()).add(e.id);
  return entries.map((e) =>
    (ids.get(e.name)?.size ?? 0) > 1 ? `${e.name}${ID_MARK}${e.id}` : e.name,
  );
}

function shorten(label: string): string {
  const chars = Array.from(label);
  return chars.length > MAX_NAME ? `${chars.slice(0, MAX_NAME - 1).join('')}…` : label;
}

/** Display name of a union node: its label, shortened to 40 characters. */
function nameOf(diff: DiffResult, id: UnionId): string {
  return shorten(diff.index.node(id)?.label ?? id);
}

/** Name a node was known by before the change (merge sources keep their old name). */
function formerName(node: UnionNode): string {
  return shorten(node.before?.label ?? node.label);
}

/**
 * Display name of a node referenced from a replacement link: `replacedBy` names nodes as they
 * are now (after ids), `replaces` names nodes as they were (before ids).
 */
function nameOfLinked(diff: DiffResult, id: string, side: 'after' | 'before'): string {
  const node =
    side === 'after'
      ? (diff.index.nodeByAfter(id) ?? diff.index.nodeByBefore(id))
      : (diff.index.nodeByBefore(id) ?? diff.index.nodeByAfter(id));
  if (!node) return id;
  return side === 'after' ? nameOf(diff, node.id) : formerName(node);
}

function listNames(p: Phrasebook, names: readonly string[]): string {
  return p.names(names, names.length);
}

function facetOf<K extends NodeFacet['kind']>(
  node: UnionNode,
  kind: K,
): Extract<NodeFacet, { kind: K }> | undefined {
  return node.facets.find((f) => f.kind === kind) as Extract<NodeFacet, { kind: K }> | undefined;
}

function edgeFacet<K extends EdgeFacet['kind']>(
  edge: UnionEdge,
  kind: K,
): Extract<EdgeFacet, { kind: K }> | undefined {
  return edge.facets.find((f) => f.kind === kind) as Extract<EdgeFacet, { kind: K }> | undefined;
}

function attrCounts(changes: readonly AttrChange[]): [number, number, number] {
  let added = 0;
  let removed = 0;
  let modified = 0;
  for (const c of changes) {
    if (c.before === undefined) added++;
    else if (c.after === undefined) removed++;
    else modified++;
  }
  return [added, removed, modified];
}

function edgeCounts(edges: readonly UnionEdge[]): [number, number, number] {
  return [
    edges.filter((e) => e.status === 'added').length,
    edges.filter((e) => e.status === 'removed').length,
    edges.filter((e) => e.status === 'modified').length,
  ];
}

function join(p: Phrasebook, parts: readonly (string | undefined)[]): string {
  return parts.filter((x): x is string => Boolean(x)).join(p.separator);
}

/** Content facets of a node as subtitle phrases (attrs, types, synonyms). */
function contentNotes(p: Phrasebook, node: UnionNode): string[] {
  const notes: string[] = [];
  const attrs = facetOf(node, 'attrs');
  if (attrs) notes.push(p.delta('attribute', ...attrCounts(attrs.changes)));
  const types = facetOf(node, 'types');
  if (types) notes.push(p.delta('type', types.added.length, types.removed.length, 0));
  const aliases = facetOf(node, 'aliases');
  if (aliases) notes.push(p.delta('synonym', aliases.added.length, aliases.removed.length, 0));
  return notes;
}

/** Notes for a `replacement` facet: who replaces the node, whom it replaces. */
function linkNotes(p: Phrasebook, diff: DiffResult, node: UnionNode): string[] {
  const facet = facetOf(node, 'replacement');
  if (!facet) return [];
  const names = (ids: readonly string[], side: 'after' | 'before'): string =>
    listNames(
      p,
      ids.map((id) => nameOfLinked(diff, id, side)),
    );
  const notes: string[] = [];
  const replacedBy = node.after?.replacedBy ?? [];
  if (facet.replacedBy.added.length || facet.replacedBy.removed.length) {
    notes.push(
      replacedBy.length ? p.note.replacedBy(names(replacedBy, 'after')) : p.note.noLongerReplaced,
    );
  }
  if (facet.replaces.added.length)
    notes.push(p.note.replaces(names(facet.replaces.added, 'before')));
  else if (facet.replaces.removed.length)
    notes.push(p.note.noLongerReplaces(names(facet.replaces.removed, 'before')));
  return notes;
}

function confidenceNote(
  p: Phrasebook,
  contributions: readonly { confidence: number; via: string }[],
): string {
  if (contributions.every((c) => c.via === 'hint')) return p.note.viaHint;
  const lowest = contributions.reduce(
    (min, c) => Math.min(min, c.confidence),
    Number.POSITIVE_INFINITY,
  );
  return contributions.every((c) => c.via === 'heuristic')
    ? p.note.inferred(percent(lowest))
    : p.note.confidence(percent(lowest));
}

function restructureNotes(
  p: Phrasebook,
  edges: readonly UnionEdge[],
  cause: 'merge' | 'split',
): string[] {
  const carried = edges.filter((e) =>
    e.facets.some((f) => f.kind === 'retarget' && f.cause === cause),
  );
  const collapsed = edges.filter((e) => edgeFacet(e, 'collapsed'));
  const other = edges.filter((e) => !carried.includes(e) && !collapsed.includes(e));
  return [
    carried.length ? p.note.carried(carried.length) : '',
    collapsed.length ? p.note.collapsed(collapsed.length) : '',
    p.delta('relation', ...edgeCounts(other)),
  ];
}

// ─── Per-kind formatters ─────────────────────────────────────────────────────

interface Parts {
  readonly p: Phrasebook;
  readonly diff: DiffResult;
  readonly hunk: Hunk;
  readonly nodes: readonly UnionNode[];
  readonly edges: readonly UnionEdge[];
  readonly anchor: UnionNode | undefined;
}

type Formatted = { readonly title: string; readonly subtitle: string };

function formatMerge({ p, diff, hunk, edges, anchor }: Parts): Formatted {
  const targetFacet = anchor ? facetOf(anchor, 'mergeTarget') : undefined;
  const sources = (targetFacet?.sources ?? [])
    .map((id) => diff.index.node(id))
    .filter((n) => n !== undefined);
  const contributions = sources.map((s) => facetOf(s, 'mergedInto')).filter((f) => f !== undefined);
  const named = distinct([
    { id: hunk.anchor, name: nameOf(diff, hunk.anchor) },
    ...sources.map((s) => ({ id: s.beforeId ?? s.id, name: formerName(s) })),
  ]);
  const title = p.title.merged(
    p.names(named.slice(1), sources.length),
    p.quote(named[0] as string),
  );
  const subtitle = join(p, [
    contributions.length ? confidenceNote(p, contributions) : '',
    ...restructureNotes(p, edges, 'merge'),
    sources.some((s) => s.status !== 'removed') ? p.note.keptDeprecated : '',
    ...(anchor ? contentNotes(p, anchor) : []),
  ]);
  return { title, subtitle };
}

function formatSplit({ p, diff, hunk, edges, anchor }: Parts): Formatted {
  // The title lists only the nodes the source split into; what became of the source itself
  // (kept, kept as deprecated, gone) is said in the subtitle.
  const targetIds = anchor ? (facetOf(anchor, 'splitInto')?.targets ?? []) : [];
  const targets = targetIds.map((id) => diff.index.node(id)).filter((n) => n !== undefined);
  const contributions = targets.map((t) => facetOf(t, 'splitFrom')).filter((f) => f !== undefined);
  const named = distinct([
    { id: hunk.anchor, name: formerName(anchor ?? (diff.index.node(hunk.anchor) as UnionNode)) },
    ...targetIds.map((id) => ({ id, name: nameOf(diff, id) })),
  ]);
  const title = p.title.split(
    p.quote(named[0] as string),
    p.names(named.slice(1), targetIds.length),
  );
  const kept = anchor?.after;
  const subtitle = join(p, [
    contributions.length ? confidenceNote(p, contributions) : '',
    ...restructureNotes(p, edges, 'split'),
    kept ? (kept.deprecated ? p.note.sourceKeptDeprecated : p.note.sourceKept) : '',
  ]);
  return { title, subtitle };
}

function formatGroup({ p, diff, hunk, nodes, anchor }: Parts, added: boolean): Formatted {
  const ordered = [hunk.anchor, ...hunk.nodes.filter((id) => id !== hunk.anchor)].map((id) =>
    nameOf(diff, id),
  );
  const title = (added ? p.title.added : p.title.removed)(ordered, nodes.length, hunk.edges.length);
  const context = hunk.context.map((id) => nameOf(diff, id));
  const types = anchor?.types ?? [];
  const subtitle = join(p, [
    types.length ? p.note.typed(types.join(', ')) : '',
    context.length
      ? (added ? p.note.linkedTo : p.note.wasLinkedTo)(listNames(p, context))
      : p.note.standalone,
  ]);
  return { title, subtitle };
}

function formatModify({ p, diff, edges, anchor }: Parts): Formatted {
  const node = anchor as UnionNode;
  const name = nameOf(diff, node.id);
  const rename = facetOf(node, 'rename');
  const moves = node.facets.filter((f) => f.kind === 'move');
  const movedTo = [...new Set(moves.flatMap((m) => m.to))].map((id) => nameOf(diff, id));
  const movedFrom = [...new Set(moves.flatMap((m) => m.from))].map((id) => nameOf(diff, id));
  const deprecate = facetOf(node, 'deprecate');
  const rekey = facetOf(node, 'rekey');
  // Hierarchy edges of a move are the move itself, not separate relation changes.
  const movedPredicates = new Set(moves.map((m) => m.predicate));
  const ownEdges = edges.filter((e) => !(e.hierarchical && movedPredicates.has(e.predicate)));
  const content = node.facets.filter(
    (f) =>
      f.kind === 'attrs' || f.kind === 'types' || f.kind === 'aliases' || f.kind === 'replacement',
  );

  let title: string;
  let lead: 'rename' | 'move' | 'deprecate' | 'rekey' | 'content';
  if (rename) {
    title = p.title.renamed(shorten(rename.from), shorten(rename.to));
    lead = 'rename';
  } else if (moves.length) {
    title = movedTo.length
      ? p.title.moved(name, listNames(p, movedTo))
      : p.title.detached(name, listNames(p, movedFrom));
    lead = 'move';
  } else if (deprecate) {
    title = (deprecate.deprecated ? p.title.deprecated : p.title.restored)(name);
    lead = 'deprecate';
  } else if (rekey) {
    title = p.title.rekeyed(name);
    lead = 'rekey';
  } else {
    const only = content.length === 1 && ownEdges.length === 0 ? content[0]?.kind : undefined;
    title =
      only === 'attrs'
        ? p.title.attrs(name)
        : only === 'types'
          ? p.title.types(name)
          : only === 'aliases'
            ? p.title.aliases(name)
            : only === 'replacement'
              ? p.title.replacement(name)
              : p.title.edited(name);
    lead = 'content';
  }

  const notes: string[] = [];
  if (rekey) {
    notes.push(p.note.idChanged(rekey.from, rekey.to));
    if (rekey.score < 1) notes.push(p.note.match(percent(rekey.score)));
  }
  notes.push(...contentNotes(p, node));
  if (moves.length) {
    if (lead !== 'move') {
      notes.push(
        movedTo.length
          ? p.note.movedUnder(listNames(p, movedTo))
          : p.note.detachedFrom(listNames(p, movedFrom)),
      );
    } else if (movedTo.length && movedFrom.length) {
      notes.push(p.note.movedFrom(listNames(p, movedFrom)));
    }
  }
  if (deprecate && lead !== 'deprecate')
    notes.push(deprecate.deprecated ? p.note.deprecated : p.note.restored);
  notes.push(...linkNotes(p, diff, node));
  notes.push(p.delta('relation', ...edgeCounts(ownEdges)));
  return { title, subtitle: join(p, notes) };
}

function formatRelations({ p, diff, hunk, edges }: Parts): Formatted {
  const source = nameOf(diff, hunk.anchor);
  const edge = edges.length === 1 ? edges[0] : undefined;
  if (!edge) {
    const [added, removed, modified] = edgeCounts(edges);
    const n = edges.length;
    const title =
      added === n
        ? p.title.relationsAdded(n, source)
        : removed === n
          ? p.title.relationsRemoved(n, source)
          : p.title.relationsUpdated(n, source);
    const retargeted = edges.filter((e) => edgeFacet(e, 'retarget')).length;
    return {
      title,
      subtitle: join(p, [
        p.delta('relation', added, removed, modified),
        retargeted ? p.note.retargeted(retargeted) : '',
      ]),
    };
  }
  const relation = shorten(edge.label);
  const retargets = edge.facets.filter((f) => f.kind === 'retarget');
  const single = retargets.length === 1 ? retargets[0] : undefined;
  const ends = [edge.source, edge.target, ...(single ? [single.from, single.to] : [])];
  const [s = '', t = '', from = '', to = ''] = distinct(
    ends.map((id) => ({ id, name: nameOf(diff, id) })),
  );
  const predicate = edgeFacet(edge, 'predicate');
  const label = edgeFacet(edge, 'label');
  const attrs = edgeFacet(edge, 'attrs');
  const extras = [
    label ? p.note.relabeled(shorten(label.from), shorten(label.to)) : '',
    attrs ? p.delta('attribute', ...attrCounts(attrs.changes)) : '',
    edge.hierarchical ? p.note.hierarchy : '',
  ];
  if (single && !predicate) {
    return single.end === 'target'
      ? {
          title: p.title.pointsTo(s, relation, to, from),
          subtitle: join(p, [p.note.relationRetargeted, ...extras]),
        }
      : {
          title: p.title.comesFrom(t, relation, to, from),
          subtitle: join(p, [p.note.relationResourced, ...extras]),
        };
  }
  if (predicate && retargets.length === 0) {
    const before = shorten(edge.before?.label ?? predicate.from);
    return {
      title: p.title.predicate(s, t, before, relation),
      subtitle: join(p, [p.note.relationTypeChanged, ...extras]),
    };
  }
  if (edge.status === 'added') {
    return {
      title: p.title.edgeAdded(s, relation, t),
      subtitle: join(p, [p.note.newRelation, ...extras]),
    };
  }
  if (edge.status === 'removed') {
    return {
      title: p.title.edgeRemoved(s, relation, t),
      subtitle: join(p, [p.note.relationRemoved, ...extras]),
    };
  }
  return { title: p.title.edgeEdited(s, relation, t), subtitle: join(p, extras) };
}

/**
 * Localized one-line title and subtitle for a hunk, e.g. “Merged “A” into “B”” /
 * “3 relations carried over”. Default locale `en`.
 *
 * @throws KgdiffError `invalid-input` when the hunk does not belong to `diff`.
 */
export function formatHunk(
  hunk: Hunk,
  diff: DiffResult,
  locale?: Locale,
): { readonly title: string; readonly subtitle: string } {
  const p = phrasebook(locale);
  const nodes = hunk.nodes.map((id) => diff.index.node(id));
  const edges = hunk.edges.map((id) => diff.index.edge(id));
  if (nodes.some((n) => n === undefined) || edges.some((e) => e === undefined)) {
    throw new KgdiffError('invalid-input', `Hunk "${hunk.id}" does not belong to this diff`, {
      hunk: hunk.id,
    });
  }
  const parts: Parts = {
    p,
    diff,
    hunk,
    nodes: nodes as UnionNode[],
    edges: edges as UnionEdge[],
    anchor: diff.index.node(hunk.anchor),
  };
  switch (hunk.kind) {
    case 'merge':
      return formatMerge(parts);
    case 'split':
      return formatSplit(parts);
    case 'add':
      return formatGroup(parts, true);
    case 'remove':
      return formatGroup(parts, false);
    case 'modify':
      return parts.anchor ? formatModify(parts) : formatRelations(parts);
    case 'relations':
      return formatRelations(parts);
    default: {
      const exhaustive: never = hunk.kind;
      throw new KgdiffError('invalid-input', `Unknown hunk kind "${String(exhaustive)}"`);
    }
  }
}

/** Localized short name of a facet kind, e.g. `rename` → “Renamed” / “改名”. Default locale `en`. */
export function facetLabel(kind: FacetKind, locale?: Locale): string {
  const label = (FACET_LABELS[locale ?? 'en'] ?? EN_FACETS)[kind];
  if (label === undefined)
    throw new KgdiffError('invalid-input', `Unknown facet kind "${String(kind)}"`);
  return label;
}

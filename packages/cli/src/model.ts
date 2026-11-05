/**
 * Presentation model shared by every text output: hunk families, glyphs, name-status letters,
 * phase grouping, the per-phase counts behind the counters and the diffstat bar, and the
 * possible matches listed after the hunks.
 */
import type { DiffResult, Hunk, HunkKind, MatchSuggestion, ReplayPhase } from '@kgdiff/core';

/** The five meaning families of docs/visual-language.md (mirrors `@kgdiff/scene`). */
export type ChangeFamily = 'added' | 'removed' | 'content' | 'structure' | 'identity';

/**
 * Family of each hunk kind. Identical to `hunkFamily` in `@kgdiff/scene` (a test enforces it);
 * duplicated so text outputs do not load the scene and layout modules.
 */
export const KIND_FAMILY: Readonly<Record<HunkKind, ChangeFamily>> = {
  add: 'added',
  remove: 'removed',
  merge: 'identity',
  split: 'identity',
  relations: 'structure',
  modify: 'content',
};

/**
 * Family a hunk is shown with: its kind's family, except that a `modify` hunk made only of
 * hierarchy moves (phase `restructure`) is `structure`, as its node is drawn
 * (docs/visual-language.md: move → structure).
 */
export function hunkFamily(hunk: Hunk): ChangeFamily {
  if (hunk.kind === 'modify' && hunk.phase === 'restructure') return 'structure';
  return KIND_FAMILY[hunk.kind];
}

/** One-character glyph of a hunk: `+ − ~ ⇄ ⊕ ⑂`. */
export function hunkGlyph(hunk: Hunk): string {
  switch (hunk.kind) {
    case 'add':
      return '+';
    case 'remove':
      return '−';
    case 'merge':
      return '⊕';
    case 'split':
      return '⑂';
    case 'relations':
      return '⇄';
    case 'modify':
      return hunk.phase === 'restructure' ? '⇄' : '~';
    default:
      return assertNever(hunk.kind);
  }
}

export type NameStatus = 'A' | 'D' | 'M' | 'R' | 'V' | 'G' | 'S' | 'E';

/**
 * `--name-status` letter: `A` added, `D` removed, `M` modified, `R` renamed, `V` moved,
 * `G` merged, `S` split, `E` relations. A modify hunk is `R` when its node was renamed, else `V`
 * when it moved in the hierarchy, else `M`.
 */
export function nameStatus(hunk: Hunk, diff: DiffResult): NameStatus {
  switch (hunk.kind) {
    case 'add':
      return 'A';
    case 'remove':
      return 'D';
    case 'merge':
      return 'G';
    case 'split':
      return 'S';
    case 'relations':
      return 'E';
    case 'modify': {
      const facets = diff.index.node(hunk.anchor)?.facets ?? [];
      if (facets.some((f) => f.kind === 'rename')) return 'R';
      if (facets.some((f) => f.kind === 'move')) return 'V';
      return 'M';
    }
    default:
      return assertNever(hunk.kind);
  }
}

/**
 * Order of the phase groups in hunk lists: the replay order ("clean up, restructure, refine,
 * grow"), shared with the viewer's change list and the Markdown summary.
 */
export const LIST_PHASES: readonly ReplayPhase[] = ['remove', 'restructure', 'modify', 'add'];

/** Order of the counters and the diffstat bar segments. */
export const COUNTER_PHASES: readonly ReplayPhase[] = ['add', 'remove', 'modify', 'restructure'];

/** Counter glyph and family of each phase. */
export const PHASE_GLYPH: Readonly<Record<ReplayPhase, string>> = {
  add: '+',
  remove: '−',
  modify: '~',
  restructure: '⇄',
};

export const PHASE_FAMILY: Readonly<Record<ReplayPhase, ChangeFamily>> = {
  add: 'added',
  remove: 'removed',
  modify: 'content',
  restructure: 'structure',
};

export interface PhaseCount {
  /** Hunks in the phase. */
  readonly hunks: number;
  /** Changed elements (nodes + edges) owned by those hunks. */
  readonly changes: number;
}

export interface Overview {
  readonly phases: Readonly<Record<ReplayPhase, PhaseCount>>;
  /** Changed elements (every changed node and edge belongs to exactly one hunk). */
  readonly changes: number;
  readonly hunks: number;
}

/** Per-phase hunk and change counts. O(hunks). */
export function overview(diff: DiffResult): Overview {
  const phases: Record<ReplayPhase, { hunks: number; changes: number }> = {
    add: { hunks: 0, changes: 0 },
    remove: { hunks: 0, changes: 0 },
    modify: { hunks: 0, changes: 0 },
    restructure: { hunks: 0, changes: 0 },
  };
  let changes = 0;
  for (const h of diff.hunks) {
    const n = h.nodes.length + h.edges.length;
    phases[h.phase].hunks++;
    phases[h.phase].changes += n;
    changes += n;
  }
  return { phases, changes, hunks: diff.hunks.length };
}

/** Hunks in list order: grouped by `LIST_PHASES`, each group in review order. */
export function groupByPhase(hunks: readonly Hunk[]): { phase: ReplayPhase; hunks: Hunk[] }[] {
  return LIST_PHASES.map((phase) => ({
    phase,
    hunks: hunks.filter((h) => h.phase === phase).sort((a, b) => a.order - b.order),
  })).filter((g) => g.hunks.length > 0);
}

/**
 * Split `total` cells among `weights` proportionally (largest remainder); every positive weight
 * gets at least one cell when `total` allows. Deterministic; ties go to the earlier entry.
 */
export function apportion(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / sum) * total);
  const cells = exact.map((x, i) => ((weights[i] as number) > 0 ? Math.max(1, Math.floor(x)) : 0));
  let used = cells.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; used < total && k < byRemainder.length * 2; k++) {
    const { i } = byRemainder[k % byRemainder.length] as { i: number };
    if ((weights[i] as number) > 0) {
      cells[i] = (cells[i] as number) + 1;
      used++;
    }
  }
  // Minimum cells may overshoot a tiny total: take back from the largest segments.
  while (used > total) {
    let largest = 0;
    for (let i = 1; i < cells.length; i++) {
      if ((cells[i] as number) > (cells[largest] as number)) largest = i;
    }
    cells[largest] = (cells[largest] as number) - 1;
    used--;
  }
  return cells;
}

/** One side of a possible match: the node's id in its version and the name shown for it. */
export interface PossibleMatchSide {
  readonly id: string;
  readonly name: string;
}

/** A pairing kgdiff considered but did not apply (a `MatchSuggestion`), ready to list. */
export interface PossibleMatch {
  readonly before: PossibleMatchSide;
  readonly after: PossibleMatchSide;
  readonly score: number;
  readonly reason: MatchSuggestion['reason'];
  /** Label and neighbourhood evidence, 0..1. */
  readonly label: number;
  readonly neighbors: number;
}

/** Longest name shown for either side (as hunk titles shorten names, @kgdiff/core i18n). */
const MAX_POSSIBLE_NAME = 40;

function shortName(label: string): string {
  const chars = Array.from(label);
  return chars.length > MAX_POSSIBLE_NAME
    ? `${chars.slice(0, MAX_POSSIBLE_NAME - 1).join('')}…`
    : label;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The suggestions a reviewer of the text outputs needs to see: pairings kgdiff did not apply
 * where the before node is reported removed or the after node added, so that "removed X, added
 * Y" can be read as "maybe X became Y". The viewer's detail panel lists the same ones. Names
 * are the label each node had in its own version. Highest score first, then by ids.
 */
export function possibleMatches(diff: DiffResult): PossibleMatch[] {
  const list: PossibleMatch[] = [];
  for (const s of diff.suggestions) {
    const before = diff.index.nodeByBefore(s.before);
    const after = diff.index.nodeByAfter(s.after);
    if (before?.status !== 'removed' && after?.status !== 'added') continue;
    list.push({
      before: { id: s.before, name: shortName(before?.before?.label ?? before?.label ?? s.before) },
      after: { id: s.after, name: shortName(after?.after?.label ?? after?.label ?? s.after) },
      score: s.score,
      reason: s.reason,
      label: s.evidence.label,
      neighbors: s.evidence.neighbors,
    });
  }
  return list.sort(
    (x, y) =>
      y.score - x.score ||
      byCodePoint(x.before.id, y.before.id) ||
      byCodePoint(x.after.id, y.after.id),
  );
}

/** A score or evidence value as a whole percentage: `0.796` → `80%`. */
export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

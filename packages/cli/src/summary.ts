/**
 * Terminal outputs: the default summary (header, counters, diffstat bar, hunk list, possible
 * matches), `--stat` and `--name-status` (docs/cli.md §Terminal summary).
 *
 * Every line is laid out on plain text first (measured with `stringWidth`, truncated with an
 * ellipsis) and painted last, so alignment holds with and without color and with CJK labels.
 */
import { type DiffResult, formatHunk, type Hunk, type Locale } from '@kgdiff/core';
import { formatInt, type Messages, messages, watchLabels } from './locale.js';
import {
  apportion,
  type ChangeFamily,
  COUNTER_PHASES,
  DEFAULT_WATCH_ATTRS,
  groupByPhase,
  hunkFamily,
  hunkGlyph,
  nameStatus,
  type Overview,
  overview,
  PHASE_FAMILY,
  PHASE_GLYPH,
  type PossibleMatch,
  percent,
  possibleMatches,
  watchedChanges,
} from './model.js';
import type { Painter } from './style.js';
import { padEnd, padStart, sanitize, stringWidth, truncate, wrap } from './width.js';

export interface TextContext {
  readonly paint: Painter;
  readonly locale: Locale;
  /** Maximum line width in columns. */
  readonly width: number;
  /** Maximum hunks listed in the summary; 0 lists all. */
  readonly limit: number;
  /**
   * Attribute keys whose changes are flagged ⚑ for review first (`--watch-attr`). Default
   * `DEFAULT_WATCH_ATTRS` (definitions); `[]` flags nothing.
   */
  readonly watch?: readonly string[];
}

/** Flag glyph of hunks that change a watched attribute. */
const FLAG = '⚑';

/** The watched attributes each hunk changes, for `ctx.watch` or the default definitions. */
function watchedOf(diff: DiffResult, ctx: TextContext): ReadonlyMap<string, readonly string[]> {
  return watchedChanges(diff, ctx.watch ?? DEFAULT_WATCH_ATTRS);
}

/** `⚑ Review first: definition changed in 10 hunks`, under the diffstat bar; none if no flags. */
function reviewFirstLines(
  watched: ReadonlyMap<string, readonly string[]>,
  ctx: TextContext,
  width: number,
): string[] {
  if (watched.size === 0) return [];
  const m = messages(ctx.locale);
  const keys = new Set<string>();
  for (const list of watched.values()) for (const key of list) keys.add(key);
  const watchOrder = (ctx.watch ?? DEFAULT_WATCH_ATTRS).filter((k) => keys.has(k));
  const text = m.watch.line(watchLabels(watchOrder, m), watched.size);
  const room = width - INDENT.length - stringWidth(FLAG) - 1;
  return [`${INDENT}${ctx.paint.tone('accent', FLAG)} ${truncate(sanitize(text), room)}`];
}

const INDENT = '  ';
const BRAND = 'kgdiff';
/** The layout never stretches beyond what it needs, nor below this width. */
const COMFORT_WIDTH = 72;
const MAX_BAR = 50;
const COLUMN_GAP = 3;
/** Narrowest title column worth keeping a family column for. */
const MIN_TITLE = 16;
/**
 * Room kept for the summary after the family label before titles are truncated (at most a
 * quarter of the line).
 */
const MIN_SUMMARY = 22;

/** `179 → 184 nodes · 351 → 353 edges` (single numbers when a count did not change). */
export function totalsText(diff: DiffResult, m: Messages): string {
  const { before, after } = diff.stats;
  return m.totals([before.nodes, after.nodes], [before.edges, after.edges]);
}

/** Left and right text on one line, right-aligned to `width`; wraps the right part if needed. */
function spread(
  left: { plain: string; painted: string },
  right: { plain: string; painted: string },
  width: number,
): string[] {
  const gap = width - stringWidth(left.plain) - stringWidth(right.plain);
  if (!right.plain) return [left.painted];
  if (gap >= COLUMN_GAP) return [left.painted + ' '.repeat(gap) + right.painted];
  const room = width - INDENT.length;
  return [
    left.painted,
    INDENT + (stringWidth(right.plain) <= room ? right.painted : truncate(right.plain, room)),
  ];
}

function headerLines(diff: DiffResult, title: string, ctx: TextContext, width: number): string[] {
  const m = messages(ctx.locale);
  const { paint } = ctx;
  const right = totalsText(diff, m);
  const fixed = BRAND.length + 2;
  const fitsBeside = width - fixed - COLUMN_GAP - stringWidth(right) >= 12;
  const titleRoom = fitsBeside ? width - fixed - COLUMN_GAP - stringWidth(right) : width - fixed;
  const shown = truncate(sanitize(title), titleRoom);
  const left = {
    plain: `${BRAND}  ${shown}`,
    painted: `${paint.bold(paint.tone('accent', BRAND))}  ${paint.bold(shown)}`,
  };
  return spread(left, { plain: right, painted: paint.dim(right) }, width);
}

interface Painted {
  readonly plain: string;
  readonly painted: string;
}

function counterItems(ov: Overview, m: Messages, paint: Painter): Painted[] {
  const items: Painted[] = [];
  for (const phase of COUNTER_PHASES) {
    const n = ov.phases[phase].hunks;
    if (n === 0) continue;
    const count = `${PHASE_GLYPH[phase]}${formatInt(n)}`;
    items.push({
      plain: `${count} ${m.counter[phase]}`,
      painted: `${paint.bold(paint.tone(PHASE_FAMILY[phase], count))} ${m.counter[phase]}`,
    });
  }
  return items;
}

const COUNTER_GAP = '   ';

/** Counter items joined on one line, or wrapped over several lines to fit `room`. */
function counterLines(items: readonly Painted[], room: number): Painted[] {
  const lines: { plain: string[]; painted: string[] }[] = [];
  for (const item of items) {
    const line = lines[lines.length - 1];
    const width = line ? stringWidth(line.plain.join(COUNTER_GAP)) + COUNTER_GAP.length : 0;
    if (line && width + stringWidth(item.plain) <= room) {
      line.plain.push(item.plain);
      line.painted.push(item.painted);
    } else lines.push({ plain: [item.plain], painted: [item.painted] });
  }
  return lines.map((l) => ({
    plain: l.plain.join(COUNTER_GAP),
    painted: l.painted.join(COUNTER_GAP),
  }));
}

/** Proportional diffstat bar: one segment per phase, sized by changed elements. */
export function diffstatBar(ov: Overview, width: number, paint: Painter): string {
  const cells = apportion(
    COUNTER_PHASES.map((p) => ov.phases[p].changes),
    Math.min(ov.changes, Math.max(10, Math.min(MAX_BAR, width - INDENT.length * 2))),
  );
  return COUNTER_PHASES.map((phase, i) => {
    const n = cells[i] as number;
    if (n === 0) return '';
    return paint.level === 0
      ? PHASE_GLYPH[phase].repeat(n)
      : paint.tone(PHASE_FAMILY[phase], '█'.repeat(n));
  }).join('');
}

/** Counters, the diffstat bar, and the review-first line when a watched attribute changed. */
function statLines(
  ov: Overview,
  ctx: TextContext,
  width: number,
  watched: ReadonlyMap<string, readonly string[]>,
): string[] {
  const m = messages(ctx.locale);
  const right = m.changes(ov.changes, ov.hunks);
  const rows = counterLines(counterItems(ov, m, ctx.paint), width - INDENT.length);
  const lines = rows.slice(0, -1).map((r) => INDENT + r.painted);
  const last = rows[rows.length - 1] ?? { plain: '', painted: '' };
  lines.push(
    ...spread(
      { plain: INDENT + last.plain, painted: INDENT + last.painted },
      { plain: right, painted: ctx.paint.dim(right) },
      width,
    ),
  );
  lines.push(INDENT + diffstatBar(ov, width, ctx.paint));
  lines.push(...reviewFirstLines(watched, ctx, width));
  return lines;
}

function identicalLines(diff: DiffResult, ctx: TextContext, width: number): string[] {
  const m = messages(ctx.locale);
  const { paint } = ctx;
  const detail = m.identicalDetail(diff.stats.after.nodes, diff.stats.after.edges);
  const head = `✓ ${m.identical}`;
  const room = width - INDENT.length;
  if (stringWidth(head) + 2 + stringWidth(detail) <= room) {
    return [
      `${INDENT}${paint.tone('added', '✓')} ${paint.bold(m.identical)}  ${paint.dim(detail)}`,
    ];
  }
  return [
    `${INDENT}${paint.tone('added', '✓')} ${paint.bold(m.identical)}`,
    ...wrap(detail, room).map((line) => INDENT + paint.dim(line)),
  ];
}

/** A line of the hunk list (or of the possible matches): glyph, title, family and summary. */
interface Row {
  /** Colour of the glyph and the family label. */
  readonly tone: ChangeFamily;
  readonly glyph: string;
  readonly title: string;
  readonly family: string;
  /** Watched attributes the hunk changes (`definition`), shown as `⚑ definition`. */
  readonly flag?: string;
  readonly subtitle: string;
}

function rowsOf(
  diff: DiffResult,
  hunks: readonly Hunk[],
  ctx: TextContext,
  watched: ReadonlyMap<string, readonly string[]>,
): Row[] {
  const m = messages(ctx.locale);
  return hunks.map((hunk) => {
    const { title, subtitle } = formatHunk(hunk, diff, ctx.locale);
    const keys = watched.get(hunk.id);
    return {
      tone: hunkFamily(hunk),
      glyph: hunkGlyph(hunk),
      title: sanitize(title),
      family: m.family[hunkFamily(hunk)],
      ...(keys ? { flag: sanitize(m.watch.marker(watchLabels(keys, m))) } : {}),
      subtitle: sanitize(subtitle),
    };
  });
}

/** What follows the family label: ` · ⚑ definition · <subtitle>`, as plain text. */
const restText = (row: Row): string =>
  (row.flag ? ` · ${FLAG} ${row.flag}` : '') + (row.subtitle ? ` · ${row.subtitle}` : '');

/** Glyph of a possible match: “maybe the same”. */
const POSSIBLE_GLYPH = '≈';
/** Possible matches listed before "… and N more" (all with `--limit 0`). */
export const POSSIBLE_LIMIT = 10;

/** Possible match rows: both names, then the score, why it was not applied and the evidence. */
function possibleRows(diff: DiffResult, list: readonly PossibleMatch[], ctx: TextContext): Row[] {
  const m = messages(ctx.locale);
  const threshold = percent(diff.options.match.threshold);
  return list.map((p) => ({
    tone: 'identity',
    glyph: POSSIBLE_GLYPH,
    title: sanitize(m.possible.title(p.before, p.after)),
    family: percent(p.score),
    subtitle: sanitize(
      [
        p.reason === 'ambiguous' ? m.possible.ambiguous : m.possible.belowThreshold(threshold),
        m.possible.evidence(percent(p.label), percent(p.neighbors)),
      ].join(' · '),
    ),
  }));
}

const rightText = (row: Row): string => row.family + restText(row);

/** Natural width of the hunk list (before any truncation). */
function listWidth(rows: readonly Row[]): number {
  let title = 0;
  let right = 0;
  for (const row of rows) {
    title = Math.max(title, stringWidth(row.title));
    right = Math.max(right, stringWidth(rightText(row)));
  }
  return INDENT.length + 2 + title + COLUMN_GAP + right;
}

/**
 * Column widths for the hunk list. Titles come first: they get all the room they need as long
 * as the family column keeps its family label plus a short summary; the summaries take the rest.
 * Below ~40 columns the family column is dropped.
 */
function listColumns(rows: readonly Row[], width: number): { title: number; right: number } {
  const room = width - INDENT.length - 2 - COLUMN_GAP;
  let maxTitle = 0;
  let maxRight = 0;
  let maxFamily = 0;
  for (const row of rows) {
    maxTitle = Math.max(maxTitle, stringWidth(row.title));
    maxRight = Math.max(maxRight, stringWidth(rightText(row)));
    maxFamily = Math.max(maxFamily, stringWidth(row.family));
  }
  if (maxTitle + maxRight <= room) return { title: maxTitle, right: maxRight };
  if (room - maxFamily < MIN_TITLE) return { title: width - INDENT.length - 2, right: 0 };
  const minRight = Math.min(maxRight, maxFamily + Math.min(MIN_SUMMARY, Math.floor(room / 4)));
  const title = Math.max(MIN_TITLE, Math.min(maxTitle, room - minRight));
  return { title, right: Math.max(maxFamily, Math.min(maxRight, room - title)) };
}

function renderRow(row: Row, cols: { title: number; right: number }, ctx: TextContext): string {
  const { paint } = ctx;
  const tone = row.tone;
  const glyph = paint.tone(tone, row.glyph);
  if (cols.right === 0) return `${INDENT}${glyph} ${truncate(row.title, cols.title)}`;
  const title = padEnd(truncate(row.title, cols.title), cols.title);
  const familyWidth = stringWidth(row.family);
  const restRoom = cols.right - familyWidth;
  const full = restText(row);
  const rest = full && restRoom >= 6 ? truncate(full, restRoom) : '';
  // The flag comes first, so it survives truncation, and keeps the accent colour; the summary
  // after it is dimmed.
  const flag = row.flag ? ` · ${FLAG} ${row.flag}` : '';
  const flagShown = flag ? rest.slice(0, Math.min(rest.length, flag.length)) : '';
  const painted = flagShown
    ? paint.dim(flagShown.slice(0, 3)) + paint.tone('accent', flagShown.slice(3))
    : '';
  return (
    `${INDENT}${glyph} ${title}${' '.repeat(COLUMN_GAP)}` +
    `${paint.tone(tone, row.family)}${painted}${paint.dim(rest.slice(flagShown.length))}`
  );
}

/** Line width for a layout whose content naturally needs `natural` columns. */
function layoutWidth(natural: number, available: number): number {
  return Math.min(available, Math.max(natural, COMFORT_WIDTH));
}

function headerNatural(diff: DiffResult, title: string, ctx: TextContext, ov: Overview): number {
  const m = messages(ctx.locale);
  const header = BRAND.length + 2 + stringWidth(sanitize(title)) + COLUMN_GAP;
  const counters =
    INDENT.length +
    stringWidth(
      counterItems(ov, m, ctx.paint)
        .map((i) => i.plain)
        .join(COUNTER_GAP),
    ) +
    COLUMN_GAP;
  return Math.max(
    header + stringWidth(totalsText(diff, m)),
    counters + stringWidth(m.changes(ov.changes, ov.hunks)),
  );
}

/**
 * The default terminal output: header (title, node and edge totals), per-phase counters, a
 * proportional diffstat bar, then the hunks grouped by phase with glyph, title and a family /
 * summary column. At most `ctx.limit` hunks are listed (0 = all), then "… and N more".
 * Hunks that change a watched attribute (`ctx.watch`, definitions by default) are marked
 * `⚑ definition` before their summary, and a line under the bar counts them.
 *
 * Last come the possible matches: pairings kgdiff considered but did not apply, between a node
 * listed as removed and one listed as added (`possibleMatches`), with their score, why they were
 * not applied, the evidence, and how to pair one. At most `POSSIBLE_LIMIT` (all with
 * `--limit 0`).
 */
export function renderSummary(diff: DiffResult, title: string, ctx: TextContext): string {
  const ov = overview(diff);
  const watched = watchedOf(diff, ctx);
  if (ov.hunks === 0) {
    const width = layoutWidth(headerNatural(diff, title, ctx, ov), ctx.width);
    return `${[...headerLines(diff, title, ctx, width), '', ...identicalLines(diff, ctx, width)].join('\n')}\n`;
  }
  const m = messages(ctx.locale);
  const { paint } = ctx;
  const groups = groupByPhase(diff.hunks);
  let shown = 0;
  const budget = ctx.limit > 0 ? ctx.limit : Number.POSITIVE_INFINITY;
  const listed = groups.map((g) => {
    const take = g.hunks.slice(0, Math.max(0, budget - shown));
    shown += take.length;
    return { phase: g.phase, total: g.hunks.length, rows: rowsOf(diff, take, ctx, watched) };
  });
  const possible = possibleMatches(diff);
  const possibleShown = possible.slice(
    0,
    ctx.limit > 0 ? Math.min(ctx.limit, POSSIBLE_LIMIT) : possible.length,
  );
  const possibleList = possibleRows(diff, possibleShown, ctx);
  const allRows = listed.flatMap((g) => g.rows);
  const width = layoutWidth(
    Math.max(headerNatural(diff, title, ctx, ov), listWidth(allRows), listWidth(possibleList)),
    ctx.width,
  );
  const cols = listColumns(allRows, width);
  // Columns of their own: hunk titles are often long, and the reason and evidence matter more
  // here than lining up with the hunks above (the section has its own heading).
  const possibleCols = listColumns(possibleList, width);
  const lines = [
    ...headerLines(diff, title, ctx, width),
    '',
    ...statLines(ov, ctx, width, watched),
    '',
  ];
  for (const group of listed) {
    if (group.rows.length === 0) continue;
    lines.push(`${INDENT}${paint.bold(m.phase[group.phase])} ${paint.dim(formatInt(group.total))}`);
    for (const row of group.rows) lines.push(renderRow(row, cols, ctx));
  }
  const hidden = ov.hunks - shown;
  if (hidden > 0) {
    const more = `${m.more(hidden)} · ${m.moreHint}`;
    lines.push(INDENT + paint.dim(truncate(more, width - INDENT.length)));
  }
  if (possible.length > 0) {
    lines.push(
      '',
      `${INDENT}${paint.bold(m.possible.heading)} ${paint.dim(formatInt(possible.length))}`,
    );
    for (const row of possibleList) lines.push(renderRow(row, possibleCols, ctx));
    const notListed = possible.length - possibleShown.length;
    if (notListed > 0) {
      lines.push(INDENT + paint.dim(truncate(m.possible.more(notListed), width - INDENT.length)));
    }
    for (const line of wrap(m.possible.hint, width - INDENT.length)) {
      lines.push(INDENT + paint.dim(line));
    }
  }
  return `${lines.join('\n')}\n`;
}

const MAX_TYPE_ROWS = 12;
const MAX_TYPE_NAME = 28;

/**
 * `--stat`: header, counters and bar (with the review-first line, as in the summary), a nodes /
 * edges × added / removed / modified / unchanged
 * table, and a git-style per-type breakdown (`+` added, `−` removed, `~` modified nodes).
 */
export function renderStat(diff: DiffResult, title: string, ctx: TextContext): string {
  const ov = overview(diff);
  const width = layoutWidth(headerNatural(diff, title, ctx, ov), ctx.width);
  const lines = [...headerLines(diff, title, ctx, width), ''];
  if (ov.hunks === 0) return `${[...lines, ...identicalLines(diff, ctx, width)].join('\n')}\n`;
  lines.push(...statLines(ov, ctx, width, watchedOf(diff, ctx)), '');
  lines.push(...countsTable(diff, ctx, width), '');
  lines.push(...typeLines(diff, ctx, width));
  return `${lines.join('\n')}\n`;
}

/** Node / edge counts; columns are dropped from the right when the line is too narrow. */
function countsTable(diff: DiffResult, ctx: TextContext, width: number): string[] {
  const m = messages(ctx.locale);
  const { paint } = ctx;
  const { nodes, edges } = diff.stats;
  const all = [
    { label: m.table.added, key: 'added', tone: 'added' },
    { label: m.table.removed, key: 'removed', tone: 'removed' },
    { label: m.table.modified, key: 'modified', tone: 'content' },
    { label: m.table.unchanged, key: 'unchanged', tone: undefined },
  ] as const;
  const rows = [
    { label: m.table.nodes, counts: nodes },
    { label: m.table.edges, counts: edges },
  ];
  const labelWidth = Math.max(...rows.map((r) => stringWidth(r.label)));
  const widthOf = (c: (typeof all)[number]): number =>
    Math.max(stringWidth(c.label), ...rows.map((r) => formatInt(r.counts[c.key]).length));
  const columns: (typeof all)[number][] = [...all];
  while (
    columns.length > 1 &&
    INDENT.length + labelWidth + columns.reduce((sum, c) => sum + 2 + widthOf(c), 0) > width
  ) {
    columns.pop();
  }
  const widths = columns.map(widthOf);
  const head =
    INDENT +
    ' '.repeat(labelWidth) +
    columns.map((c, i) => `  ${padStart(c.label, widths[i] as number)}`).join('');
  const body = rows.map(
    (r) =>
      INDENT +
      padEnd(r.label, labelWidth) +
      columns
        .map((c, i) => {
          const n = r.counts[c.key];
          const cell = padStart(formatInt(n), widths[i] as number);
          return `  ${c.tone && n > 0 ? paint.tone(c.tone, cell) : cell}`;
        })
        .join(''),
  );
  return [paint.dim(head), ...body];
}

function typeLines(diff: DiffResult, ctx: TextContext, width: number): string[] {
  const m = messages(ctx.locale);
  const { paint } = ctx;
  const changed = diff.stats.byType.filter((t) => t.added + t.removed + t.modified > 0);
  if (changed.length === 0) return [];
  const shown = changed.slice(0, MAX_TYPE_ROWS);
  const totals = shown.map((t) => t.added + t.removed + t.modified);
  const countRoom = Math.max(...totals.map((n) => formatInt(n).length));
  // Names give way first on narrow lines: indent, two spaces, count, space, ≥ 4 bar cells.
  const nameRoom = Math.max(
    4,
    Math.min(MAX_TYPE_NAME, width - INDENT.length - 2 - countRoom - 1 - 4),
  );
  const names = shown.map((t) => truncate(sanitize(t.type) || m.untyped, nameRoom));
  const nameWidth = Math.max(...names.map(stringWidth));
  const countWidth = Math.max(...totals.map((n) => formatInt(n).length));
  const maxTotal = Math.max(...totals);
  const barRoom = Math.max(1, Math.min(30, width - INDENT.length - nameWidth - countWidth - 3));
  const lines = [INDENT + paint.bold(m.byType)];
  shown.forEach((t, i) => {
    const total = totals[i] as number;
    const size =
      maxTotal <= barRoom ? total : Math.max(1, Math.round((total / maxTotal) * barRoom));
    const [a, r, mod] = apportion([t.added, t.removed, t.modified], size);
    const bar =
      paint.tone('added', '+'.repeat(a ?? 0)) +
      paint.tone('removed', '−'.repeat(r ?? 0)) +
      paint.tone('content', '~'.repeat(mod ?? 0));
    lines.push(
      `${INDENT}${padEnd(names[i] as string, nameWidth)}  ${padStart(formatInt(total), countWidth)} ${bar}`,
    );
  });
  if (changed.length > shown.length) {
    lines.push(
      INDENT +
        paint.dim(truncate(m.moreTypes(changed.length - shown.length), width - INDENT.length)),
    );
  }
  return lines;
}

/**
 * `--name-status`: one line per hunk in review order: status letter, anchor id, title.
 * Tab-separated (scriptable) unless `aligned`, which pads the columns for a terminal.
 */
export function renderNameStatus(diff: DiffResult, ctx: TextContext, aligned: boolean): string {
  if (diff.hunks.length === 0) return '';
  const rows = diff.hunks.map((hunk) => ({
    hunk,
    letter: nameStatus(hunk, diff),
    id: sanitize(hunk.anchor),
    title: sanitize(formatHunk(hunk, diff, ctx.locale).title),
  }));
  const { paint } = ctx;
  if (!aligned) {
    return `${rows.map((r) => `${paint.tone(hunkFamily(r.hunk), r.letter)}\t${r.id}\t${r.title}`).join('\n')}\n`;
  }
  const idWidth = Math.min(
    rows.reduce((max, r) => Math.max(max, stringWidth(r.id)), 0),
    Math.max(8, Math.floor(ctx.width / 3)),
  );
  const titleRoom = Math.max(1, ctx.width - 1 - 2 - idWidth - 2);
  return `${rows
    .map((r) => {
      const id = padEnd(truncate(r.id, idWidth), idWidth);
      return `${paint.bold(paint.tone(hunkFamily(r.hunk), r.letter))}  ${paint.dim(id)}  ${truncate(r.title, titleRoom)}`;
    })
    .join('\n')}\n`;
}

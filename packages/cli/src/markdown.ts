/**
 * GitHub-flavoured Markdown summary for PR comments and `$GITHUB_STEP_SUMMARY`
 * (docs/cli.md §Markdown summary): title, diffstat table, family legend, the hunk list grouped
 * by phase and the possible matches, in `<details>` blocks. No HTML beyond `<details>` /
 * `<summary>`.
 */
import { type DiffResult, formatHunk, type Locale } from '@kgdiff/core';
import { formatInt, messages } from './locale.js';
import {
  type ChangeFamily,
  groupByPhase,
  hunkFamily,
  hunkGlyph,
  overview,
  percent,
  possibleMatches,
} from './model.js';
import { totalsText } from './summary.js';
import { revealInvisible } from './width.js';

/** Hunks listed before "…and N more". */
export const MARKDOWN_HUNK_LIMIT = 100;
/** Groups start expanded when the whole list is at most this long. */
const OPEN_THRESHOLD = 30;
/** Possible matches listed before "…and N more". */
export const MARKDOWN_POSSIBLE_LIMIT = 20;
/** The possible matches start expanded when there are at most this many. */
const POSSIBLE_OPEN_THRESHOLD = 10;

const FAMILY_SQUARE: Readonly<Record<ChangeFamily, string>> = {
  added: '🟩',
  removed: '🟥',
  content: '🟨',
  structure: '🟦',
  identity: '🟪',
};

/** Zero-width space: invisible, but enough to stop GitHub's autolinkers and filters. */
const ZWSP = '\u200B';

/**
 * Escape untrusted text for inline GFM.
 *
 * 1. Invisible and bidirectional controls become a visible `⟨U+202E⟩`; C0 controls and line
 *    breaks become spaces; C1 controls are dropped.
 * 2. GitHub's post-Markdown filters are defused first (they act on the rendered text, so
 *    escaping alone does not stop them): a zero-width space breaks `:shortcode:` emoji,
 *    `@mentions`, `#123` / `org/repo#123` / `GH-123` references, bare `scheme://` URLs and
 *    `www.` autolinks.
 * 3. Markdown punctuation (backslash, backtick, `*`, `_`, brackets, `|`, `~`, `#`, `$` for math)
 *    is backslash-escaped; `<`, `>` and `&` become entities, so no raw HTML gets through.
 */
export function escapeMarkdown(text: string): string {
  return (
    revealInvisible(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are replaced on purpose.
      .replace(/[\u0000-\u001f\u2028\u2029]+/g, ' ')
      .replace(/[\u007f-\u009f]/g, '')
      .replace(/:([a-z0-9_+-]+):/gi, `:${ZWSP}$1:`)
      .replace(/\b(GH)-(?=\d)/gi, `$1${ZWSP}-`)
      .replace(/([@#])(?=[\p{L}\p{N}_])/gu, `$1${ZWSP}`)
      .replace(/:\/\//g, `://${ZWSP}`)
      .replace(/\b(www)\./gi, `$1${ZWSP}.`)
      .replace(/[\\`*_[\]|~#$]/g, '\\$&')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .trim()
  );
}

export interface MarkdownOptions {
  readonly locale: Locale;
  readonly title: string;
  /** e.g. `kgdiff 0.1.0`. */
  readonly generator: string;
}

/** Render the Markdown summary. Deterministic: no timestamps. */
export function renderMarkdown(diff: DiffResult, options: MarkdownOptions): string {
  const m = messages(options.locale);
  const ov = overview(diff);
  const out: string[] = [`## kgdiff · ${escapeMarkdown(options.title)}`, ''];
  const totals = escapeMarkdown(totalsText(diff, m));

  if (ov.hunks === 0) {
    const detail = m.identicalDetail(diff.stats.after.nodes, diff.stats.after.edges);
    out.push(`✅ **${m.identical}.** ${escapeMarkdown(detail)}`, '');
  } else {
    out.push(`**${escapeMarkdown(m.changes(ov.changes, ov.hunks))}** · ${totals}`, '');
    // Table cells are sentence-cased (a no-op for Chinese).
    const t = Object.fromEntries(
      Object.entries(m.table).map(([k, v]) => [k, v.charAt(0).toUpperCase() + v.slice(1)]),
    ) as typeof m.table;
    const { nodes, edges, before, after } = diff.stats;
    const pair = (b: number, a: number): string => `${formatInt(b)} → ${formatInt(a)}`;
    out.push(
      `| | ${t.added} | ${t.removed} | ${t.modified} | ${t.unchanged} | ${t.total} |`,
      '| :-- | --: | --: | --: | --: | --: |',
      `| **${t.nodes}** | ${formatInt(nodes.added)} | ${formatInt(nodes.removed)} | ${formatInt(nodes.modified)} | ${formatInt(nodes.unchanged)} | ${pair(before.nodes, after.nodes)} |`,
      `| **${t.edges}** | ${formatInt(edges.added)} | ${formatInt(edges.removed)} | ${formatInt(edges.modified)} | ${formatInt(edges.unchanged)} | ${pair(before.edges, after.edges)} |`,
      '',
      m.markdown.legend,
      '',
    );
    let budget = MARKDOWN_HUNK_LIMIT;
    const open = ov.hunks <= OPEN_THRESHOLD ? ' open' : '';
    for (const group of groupByPhase(diff.hunks)) {
      if (budget <= 0) break;
      const listed = group.hunks.slice(0, budget);
      budget -= listed.length;
      out.push(
        `<details${open}>`,
        `<summary>${m.phase[group.phase]} (${formatInt(group.hunks.length)})</summary>`,
        '',
      );
      for (const hunk of listed) {
        const { title, subtitle } = formatHunk(hunk, diff, options.locale);
        const family = hunkFamily(hunk);
        const glyph = hunkGlyph(hunk) === '~' ? '\\~' : hunkGlyph(hunk);
        const note = subtitle ? ` — *${escapeMarkdown(subtitle)}*` : '';
        out.push(`- ${FAMILY_SQUARE[family]} ${glyph} ${escapeMarkdown(title)}${note}`);
      }
      out.push('', '</details>', '');
    }
    if (ov.hunks > MARKDOWN_HUNK_LIMIT) {
      out.push(`*${escapeMarkdown(m.markdown.more(ov.hunks - MARKDOWN_HUNK_LIMIT))}*`, '');
    }
    out.push(...possibleSection(diff, options.locale));
  }
  out.push(`*${escapeMarkdown(m.markdown.generatedBy(options.generator))}*`);
  return `${out.join('\n')}\n`;
}

/**
 * The possible matches (`possibleMatches`): pairings kgdiff did not apply between a node listed
 * as removed and one listed as added. In a pull request comment they are what tells a reviewer
 * that "removed X" and "added Y" may be one entity. Empty when there are none.
 */
function possibleSection(diff: DiffResult, locale: Locale): string[] {
  const possible = possibleMatches(diff);
  if (possible.length === 0) return [];
  const m = messages(locale);
  const threshold = percent(diff.options.match.threshold);
  const open = possible.length <= POSSIBLE_OPEN_THRESHOLD ? ' open' : '';
  const out = [
    `<details${open}>`,
    `<summary>${m.possible.heading} (${formatInt(possible.length)})</summary>`,
    '',
    `*${m.markdown.possibleHint}*`,
    '',
  ];
  for (const p of possible.slice(0, MARKDOWN_POSSIBLE_LIMIT)) {
    const reason =
      p.reason === 'ambiguous' ? m.possible.ambiguous : m.possible.belowThreshold(threshold);
    const note = [
      percent(p.score),
      reason,
      m.possible.evidence(percent(p.label), percent(p.neighbors)),
    ].join(' · ');
    out.push(`- ≈ ${escapeMarkdown(m.possible.title(p.before, p.after))} — *${note}*`);
  }
  if (possible.length > MARKDOWN_POSSIBLE_LIMIT) {
    out.push(
      '',
      `*${escapeMarkdown(m.markdown.possibleMore(possible.length - MARKDOWN_POSSIBLE_LIMIT))}*`,
    );
  }
  out.push('', '</details>', '');
  return out;
}

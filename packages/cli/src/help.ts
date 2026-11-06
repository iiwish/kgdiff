/**
 * `kgdiff --help` and `kgdiff apply --help`: grouped options, defaults, examples and exit
 * codes, aligned and wrapped to the terminal width.
 */
import type { Painter } from './style.js';
import { padEnd, stringWidth, wrap } from './width.js';

interface Entry {
  readonly flags: string;
  readonly text: string;
  readonly default?: string;
}

interface Section {
  readonly title: string;
  readonly note?: string;
  readonly entries?: readonly Entry[];
  /** Pre-formatted lines (usage, examples). */
  readonly lines?: readonly (readonly [command: string, comment?: string])[];
}

const MAIN: readonly Section[] = [
  {
    title: 'Usage',
    lines: [
      ['kgdiff <before> <after> [options]'],
      ['kgdiff apply <graph> <delta> [-o <file>] [--no-strict]'],
    ],
    note:
      'Graphs: JSON (.json), JSON-LD (.jsonld), Turtle (.ttl), N-Triples (.nt), N-Quads (.nq), ' +
      'TriG (.trig), RDF/XML (.rdf, .owl), OBO (.obo); gzip-compressed files work too. ' +
      'Use - to read one side from stdin.',
  },
  {
    title: 'Output',
    note: 'Default: a summary on stdout. Outputs combine, e.g. -o report.html --markdown summary.md',
    entries: [
      {
        flags: '--stat',
        text: 'Diffstat only: counters, bar, node and edge counts, changes by type',
      },
      {
        flags: '--name-status',
        text: 'One line per hunk: A added, D removed, M modified, R renamed, V moved, G merged, S split, E relations',
      },
      { flags: '--json [file]', text: 'Full machine-readable diff (DiffJSON)' },
      { flags: '--delta [file]', text: 'Invertible delta only, for kgdiff apply' },
      {
        flags: '--markdown [file]',
        text: 'GitHub-flavoured Markdown for PR comments and job summaries',
      },
      {
        flags: '-o, --html <file>',
        text: 'Self-contained interactive HTML report (works offline)',
      },
      {
        flags: '--open',
        text: 'Open the HTML report in the browser (a temporary file without -o)',
      },
      { flags: '--pretty', text: 'Indent JSON output' },
    ],
  },
  {
    title: 'Diff',
    entries: [
      {
        flags: '-f, --format <fmt>',
        text: 'Input format: auto, json, jsonld, turtle, ntriples, nquads, trig, rdfxml, obo',
        default: 'auto',
      },
      { flags: '--before-format <fmt>', text: 'Format of <before> only' },
      { flags: '--after-format <fmt>', text: 'Format of <after> only' },
      { flags: '--match <strategy>', text: 'Node matching: id, auto, similarity', default: 'auto' },
      { flags: '--threshold <n>', text: 'Similarity acceptance threshold, 0–1', default: '0.82' },
      {
        flags: '--edge-identity <mode>',
        text: 'Edge identity: structure, id',
        default: 'structure',
      },
      {
        flags: '--hierarchy <predicate>',
        text: 'Hierarchy predicate (repeatable); replaces the defaults when given',
      },
      { flags: '--ignore-attr <key>', text: 'Ignore an attribute when comparing (repeatable)' },
      { flags: '--no-merges', text: 'Do not detect merges' },
      { flags: '--no-splits', text: 'Do not detect splits' },
      {
        flags: '--lang <tags>',
        text: 'RDF label language preference, comma-separated, e.g. zh,en',
      },
    ],
  },
  {
    title: 'Report',
    entries: [
      {
        flags: '--title <text>',
        text: 'Title of the summary and report',
        default: '<before> → <after>',
      },
      { flags: '--theme <theme>', text: 'Initial theme: auto, light, dark', default: 'auto' },
      {
        flags: '--locale <locale>',
        text: 'Language of hunk titles and the report: en, zh-CN',
        default: 'from LANG, else en',
      },
      { flags: '--mode <mode>', text: 'Initial viewer mode: overlay, swipe, replay' },
      {
        flags: '--scope <scope>',
        text: 'Show the whole graph or only the changes (in any mode): all, changes',
        default: 'changes for large graphs, else all',
      },
      {
        flags: '--panels <spec>',
        text: 'Initial panel states, e.g. "detail:collapsed minimap:hidden" (repeatable)',
      },
      {
        flags: '--reproducible',
        text: 'Omit the timestamp: byte-identical reports for identical input',
      },
      {
        flags: '--no-compute',
        text: 'Leave out the viewer compute add-on (by default inlined for large graphs laid out around their changes, so collapsed groups can be expanded)',
      },
    ],
  },
  {
    title: 'Behaviour',
    entries: [
      {
        flags: '--exit-code',
        text: 'Exit with 1 when the graphs differ, like git diff --exit-code',
      },
      {
        flags: '--allow-empty',
        text: 'Treat an empty input as an empty graph (otherwise an empty file or stdin is an error)',
      },
      { flags: '-q, --quiet', text: 'Print nothing on stdout (files are still written)' },
      {
        flags: '--color <when>',
        text: 'auto, always, never (auto honours NO_COLOR and FORCE_COLOR)',
        default: 'auto',
      },
      { flags: '--limit <n>', text: 'Hunks listed in the summary; 0 lists all', default: '50' },
      {
        flags: '--watch-attr <key>',
        text: 'Flag changes to this attribute ⚑ for review first (repeatable); replaces the defaults',
        default: 'definitions',
      },
      { flags: '-h, --help', text: 'Show this help' },
      { flags: '-v, --version', text: 'Show the version' },
    ],
  },
  {
    title: 'Examples',
    lines: [
      ['kgdiff v12.json v13.json', 'colored summary'],
      ['kgdiff old.obo new.obo -o report.html --open', 'interactive report'],
      ['kgdiff a.ttl b.ttl --markdown >> "$GITHUB_STEP_SUMMARY"', 'CI job summary'],
      ['kgdiff a.json b.json --exit-code -q', 'fail when the graphs differ'],
      ['kgdiff a.json b.json --delta patch.json', 'export a delta …'],
      ['kgdiff apply a.json patch.json -o b.json', '… and apply it'],
      ['curl -s https://example.org/latest.ttl | kgdiff pinned.ttl -', 'compare with stdin'],
    ],
  },
  {
    title: 'Environment',
    note:
      'NO_COLOR, FORCE_COLOR (0–3) and COLORTERM control colors · LANG / LC_ALL the locale · ' +
      'COLUMNS the width when piped · KGDIFF_MAX_INPUT the input size limit (default 1G, e.g. 4G) · ' +
      'DEBUG=kgdiff prints stack traces',
  },
  {
    title: 'Exit status',
    note: '0 success (and no differences with --exit-code) · 1 differences with --exit-code · 2 usage or input error',
  },
];

const APPLY: readonly Section[] = [
  {
    title: 'Usage',
    lines: [['kgdiff apply <graph> <delta> [-o <file>] [--no-strict]']],
    note:
      'Applies a kgdiff delta (from --delta, or the delta inside --json output) to a graph and ' +
      'writes the result as kgdiff JSON. Use - to read the graph or the delta from stdin.',
  },
  {
    title: 'Options',
    entries: [
      {
        flags: '-o, --output <file>',
        text: 'Write the patched graph to a file',
        default: 'stdout',
      },
      {
        flags: '--no-strict',
        text: "Apply the operations that fit even if the graph is not the delta's base; reports how many were skipped",
      },
      { flags: '--verbose', text: 'With --no-strict, list the skipped operations' },
      { flags: '--allow-empty', text: 'Treat an empty <graph> as an empty graph' },
      { flags: '-f, --format <fmt>', text: 'Format of <graph>', default: 'auto' },
      { flags: '--lang <tags>', text: 'RDF label language preference, e.g. zh,en' },
      { flags: '--pretty', text: 'Indent the JSON output' },
      { flags: '-q, --quiet', text: 'Print nothing on stdout' },
      { flags: '--color <when>', text: 'auto, always, never', default: 'auto' },
      { flags: '-h, --help', text: 'Show this help' },
    ],
  },
  {
    title: 'Examples',
    lines: [
      ['kgdiff v1.ttl v2.ttl --delta patch.json', 'make a delta'],
      ['kgdiff apply v1.ttl patch.json -o v2.json', 'apply it'],
    ],
  },
  {
    title: 'Exit status',
    note: '0 applied · 2 the delta does not fit the graph, or another error',
  },
];

const INDENT = '  ';
const MAX_FLAGS = 26;

function paintFlags(flags: string, paint: Painter): string {
  return flags
    .split(/(<[^>]+>|\[[^\]]+\])/)
    .map((part) =>
      part.startsWith('<') || part.startsWith('[') ? paint.dim(part) : paint.tone('accent', part),
    )
    .join('');
}

/**
 * Render help text. `width` is the terminal width (descriptions wrap to it; below 60 columns
 * they go under their flags).
 */
export function renderHelp(
  topic: 'main' | 'apply',
  version: string,
  paint: Painter,
  width: number,
): string {
  const sections = topic === 'apply' ? APPLY : MAIN;
  const w = Math.max(40, Math.min(width, 100));
  const flagWidth = Math.min(
    MAX_FLAGS,
    Math.max(...sections.flatMap((s) => (s.entries ?? []).map((e) => stringWidth(e.flags)))) + 2,
  );
  const stacked = w < 60;
  const out: string[] = [
    `${paint.bold(paint.tone('accent', 'kgdiff'))} ${version}  ${paint.dim(
      topic === 'apply' ? 'apply a delta to a graph' : 'git diff for knowledge graphs',
    )}`,
  ];
  for (const section of sections) {
    out.push('', paint.bold(section.title));
    for (const [command, comment] of section.lines ?? []) {
      const gap = Math.max(2, 58 - stringWidth(command));
      if (comment && stringWidth(command) + gap + stringWidth(comment) + 4 <= w) {
        out.push(`${INDENT}${command}${' '.repeat(gap)}${paint.dim(`# ${comment}`)}`);
        continue;
      }
      if (comment) out.push(INDENT + paint.dim(`# ${comment}`));
      // Long commands wrap with a hanging indent (narrow terminals).
      wrap(command, w - INDENT.length - 4).forEach((line, i) => {
        out.push(`${INDENT}${i > 0 ? '    ' : ''}${line}`);
      });
    }
    if (section.note && section.lines) out.push('');
    if (section.note) {
      for (const line of wrap(section.note, w - INDENT.length)) out.push(INDENT + paint.dim(line));
    }
    for (const entry of section.entries ?? []) {
      const room = stacked ? w - INDENT.length * 3 : w - INDENT.length - flagWidth;
      const defaultText = entry.default ? `[default: ${entry.default}]` : '';
      const wrapped = wrap(defaultText ? `${entry.text} ${defaultText}` : entry.text, room).map(
        (line) =>
          defaultText && line.endsWith(defaultText)
            ? line.slice(0, -defaultText.length) + paint.dim(defaultText)
            : line,
      );
      const flagsPlain = entry.flags;
      if (stacked || stringWidth(flagsPlain) >= flagWidth) {
        out.push(INDENT + paintFlags(flagsPlain, paint));
        for (const line of wrapped)
          out.push(INDENT.repeat(stacked ? 3 : 1) + ' '.repeat(stacked ? 0 : flagWidth) + line);
        continue;
      }
      wrapped.forEach((line, i) => {
        const lead =
          i === 0
            ? paintFlags(flagsPlain, paint) + ' '.repeat(flagWidth - stringWidth(flagsPlain))
            : padEnd('', flagWidth);
        out.push(INDENT + lead + line);
      });
    }
  }
  return `${out.join('\n')}\n`;
}

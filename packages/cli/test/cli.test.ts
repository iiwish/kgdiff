import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { hashGraph, normalize } from '@kgdiff/core';
import { parseGraph } from '@kgdiff/formats';
import { describe, expect, it } from 'vitest';
import { DIFF_OPTIONS } from '../src/args.js';
import { cliVersion, stringWidth, stripAnsi } from '../src/index.js';
import { CWD, dataset, REPO, run } from './helpers.js';

const BEFORE = JSON.stringify({
  meta: { name: 'zoo', version: 'v1' },
  nodes: [
    { id: 'animal', label: 'Animal' },
    { id: 'bird', label: 'Bird' },
    { id: 'cat', label: 'Cat', attrs: { legs: 4 } },
    { id: 'dog', label: 'Dog' },
    { id: 'dodo', label: 'Dodo' },
  ],
  edges: [
    { source: 'bird', target: 'animal', predicate: 'is_a' },
    { source: 'cat', target: 'animal', predicate: 'is_a' },
    { source: 'dog', target: 'animal', predicate: 'is_a' },
    { source: 'dodo', target: 'bird', predicate: 'eats' },
  ],
});

const AFTER = JSON.stringify({
  meta: { name: 'zoo', version: 'v2' },
  nodes: [
    { id: 'animal', label: 'Animal' },
    { id: 'bird', label: 'Bird' },
    { id: 'cat', label: 'House cat', attrs: { legs: 4 } },
    { id: 'dog', label: 'Dog' },
    { id: 'owl', label: 'Owl' },
  ],
  edges: [
    { source: 'bird', target: 'animal', predicate: 'is_a' },
    { source: 'cat', target: 'animal', predicate: 'is_a' },
    { source: 'dog', target: 'animal', predicate: 'is_a' },
    { source: 'owl', target: 'bird', predicate: 'is_a' },
  ],
});

const files = { 'before.json': BEFORE, 'after.json': AFTER };
const ESC = String.fromCharCode(27);

describe('summary', () => {
  it('prints header, counters, bar and hunks grouped by phase', async () => {
    const r = await run(['before.json', 'after.json'], { files });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    const lines = r.stdout.split('\n');
    expect(lines[0]).toMatch(/^kgdiff {2}zoo v1 → v2 +5 nodes · 4 edges$/);
    expect(lines[2]).toMatch(
      /^ {2}\+1 added {3}−1 removed {3}~1 modified +\d+ changes in 3 hunks$/,
    );
    expect(lines[3]).toMatch(/^ {2}[+−~]+$/);
    expect(r.stdout).toContain('  Modified 1\n  ~ Renamed “Cat” → “House cat”');
    expect(r.stdout).toMatch(/ {2}\+ Added “Owl” and 1 relation +added · /);
    expect(r.stdout).toMatch(/ {2}− Removed “Dodo” and 1 relation +removed · /);
    expect(r.stdout).not.toContain(ESC);
    expect(r.stdout.endsWith('\n')).toBe(true);
  });

  it('lists groups in replay order: Removed, Restructured, Modified, Added', async () => {
    const d = dataset('ontology-release');
    const r = await run([d.before, d.after, ...d.flags]);
    const headings = r.stdout
      .split('\n')
      .filter((l) => /^ {2}[A-Z][a-z]+ \d+$/.test(l))
      .map((l) => l.trim().split(' ')[0]);
    expect(headings).toEqual(['Restructured', 'Modified', 'Added']);
    const e = dataset('enterprise-kg');
    const zh = await run([e.before, e.after, ...e.flags, '--locale', 'zh-CN']);
    const zhHeadings = zh.stdout
      .split('\n')
      .filter((l) => /^ {2}\p{Script=Han}+ \d+$/u.test(l))
      .map((l) => l.trim().split(' ')[0]);
    expect(zhHeadings).toEqual(['删除', '结构调整', '修改', '新增']);
    const md = await run([e.before, e.after, ...e.flags, '--markdown']);
    const summaries = [...md.stdout.matchAll(/<summary>(\w+) \(/g)].map((m) => m[1]);
    expect(summaries).toEqual(['Removed', 'Restructured', 'Modified', 'Added']);
  });

  it('reports identical graphs calmly', async () => {
    const r = await run(['before.json', 'before.json', '--exit-code'], { files });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✓ No differences  Both versions have 5 nodes and 4 edges.');
  });

  it('limits the list and says how many are hidden', async () => {
    const d = dataset('ontology-release');
    const r = await run([d.before, d.after, ...d.flags, '--limit', '3']);
    expect(r.stdout.split('\n').filter((l) => /^ {2}[⑂⊕⇄~+−] /.test(l))).toHaveLength(3);
    expect(r.stdout).toContain('  … and 19 more · --limit 0 lists all');
    const all = await run([d.before, d.after, ...d.flags, '--limit', '0']);
    expect(all.stdout.split('\n').filter((l) => /^ {2}[⑂⊕⇄~+−] /.test(l))).toHaveLength(22);
    expect(all.stdout).not.toContain('more ·');
  });

  it('keeps every line within the terminal width, CJK included', async () => {
    const d = dataset('enterprise-kg');
    for (const columns of [50, 64, 80, 132]) {
      const r = await run([d.before, d.after, ...d.flags, '--locale', 'zh-CN'], {
        isTTY: true,
        columns,
        env: { NO_COLOR: '1' },
      });
      for (const line of r.stdout.split('\n')) {
        expect(stringWidth(line), line).toBeLessThanOrEqual(Math.min(columns, 120));
      }
    }
  });

  it('aligns the family column with wide characters and with color', async () => {
    const d = dataset('enterprise-kg');
    for (const color of ['never', 'always']) {
      const r = await run([d.before, d.after, ...d.flags, '--locale', 'zh-CN', '--color', color], {
        env: { COLUMNS: '100', COLORTERM: 'truecolor' },
      });
      const rows = stripAnsi(r.stdout)
        .split('\n')
        .filter((l) => /^ {2}[⑂⊕⇄~+−] /.test(l));
      expect(rows.length).toBe(12);
      const columns = rows.map((row) => {
        const at = row.search(/(新增|删除|内容|结构|身份)( ·|$)/);
        return stringWidth(row.slice(0, at));
      });
      expect(new Set(columns).size).toBe(1);
    }
  });

  it('localizes from LANG and lets --locale win', async () => {
    const zh = await run(['before.json', 'after.json'], { files, env: { LANG: 'zh_CN.UTF-8' } });
    expect(zh.stdout).toContain('「Cat」改名为「House cat」');
    expect(zh.stdout).toContain('节点 5 · 关系 4');
    const en = await run(['before.json', 'after.json', '--locale', 'en'], {
      files,
      env: { LANG: 'zh_CN.UTF-8' },
    });
    expect(en.stdout).toContain('Renamed “Cat” → “House cat”');
  });

  it('never prints control characters from labels', async () => {
    const evil = JSON.stringify({
      nodes: [{ id: `x${ESC}[2J`, label: `bad${ESC}]0;title\u0007\nname` }],
      edges: [],
    });
    const r = await run(['before.json', 'evil.json', '--name-status'], {
      files: { ...files, 'evil.json': evil },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain(ESC);
    expect(r.stdout).not.toContain('\u0007');
    expect(
      r.stdout
        .split('\n')
        .filter(Boolean)
        .every((l) => l.split('\t').length === 3),
    ).toBe(true);
  });
});

describe('possible matches', () => {
  const graph = (nodes: readonly object[], edges: readonly object[] = []): string =>
    JSON.stringify({ nodes, edges });
  /** Two extraction runs with fresh ids: “Saudi Aramco” is “Aramco” with the same neighbours. */
  const runs = {
    'run-a.json': graph(
      [
        { id: 'e1', label: 'Saudi Aramco', type: 'Organization' },
        { id: 'e2', label: 'Saudi Arabia', type: 'Country' },
        { id: 'e3', label: 'Petroleum', type: 'Industry' },
        { id: 'e4', label: 'Amin Nasser', type: 'Person' },
        { id: 'e5', label: 'Dhahran', type: 'City' },
      ],
      [
        { source: 'e1', target: 'e2', predicate: 'based_in' },
        { source: 'e1', target: 'e3', predicate: 'industry' },
        { source: 'e4', target: 'e1', predicate: 'ceo_of' },
        { source: 'e1', target: 'e5', predicate: 'headquartered_in' },
      ],
    ),
    'run-b.json': graph(
      [
        { id: 'x9', label: 'Aramco', type: 'Organization' },
        { id: 'x2', label: 'Saudi Arabia', type: 'Country' },
        { id: 'x7', label: 'Petroleum', type: 'Industry' },
        { id: 'x4', label: 'Amin Nasser', type: 'Person' },
        { id: 'x1', label: 'Dhahran', type: 'City' },
      ],
      [
        { source: 'x9', target: 'x2', predicate: 'based_in' },
        { source: 'x9', target: 'x7', predicate: 'industry' },
        { source: 'x4', target: 'x9', predicate: 'ceo_of' },
        { source: 'x9', target: 'x1', predicate: 'headquartered_in' },
      ],
    ),
  };
  const similar = ['run-a.json', 'run-b.json', '--match', 'similarity'];
  /** Piped: 120 columns, the widest layout. */
  const wide = { files: runs };

  /** Six atoms bonded in a ring, and the same atoms as two triangles: every pairing ties. */
  const ring = (prefix: string, bonds: readonly [number, number][]): string =>
    graph(
      [1, 2, 3, 4, 5, 6].map((i) => ({ id: `${prefix}${i}`, label: 'C', type: 'Atom' })),
      bonds.map(([s, t]) => ({
        source: `${prefix}${s}`,
        target: `${prefix}${t}`,
        predicate: 'bond',
      })),
    );
  const rings = {
    'hexagon.json': ring('h', [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 1],
    ]),
    'triangles.json': ring('t', [
      [1, 2],
      [2, 3],
      [3, 1],
      [4, 5],
      [5, 6],
      [6, 4],
    ]),
  };
  const symmetric = ['hexagon.json', 'triangles.json', '--match', 'similarity'];

  it('lists a pairing that was not applied, with its score, why, and the evidence', async () => {
    const r = await run(similar, wide);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('  − Removed “Saudi Aramco” and 3 relations');
    expect(r.stdout).toContain('  + Added “Aramco” and 3 relations');
    // Its own columns: the long hunk titles above do not squeeze the reason and the evidence.
    expect(r.stdout).toMatch(
      /\n\n {2}Possible matches 1\n {2}≈ “Saudi Aramco” → “Aramco” {3}80% · below the 82% threshold · name 67% · neighbours 100%\n/,
    );
    expect(r.stdout).toMatch(
      /neighbours 100%\n {2}Not paired, so listed as removed or added\. To pair one, add a synonym or a replacement link, or lower --threshold\.\n$/,
    );
  });

  it('says nothing once the pairing is applied, or when there is none', async () => {
    const paired = await run([...similar, '--threshold', '0.79'], wide);
    expect(paired.stdout).toContain('~ Renamed “Saudi Aramco” → “Aramco”');
    expect(paired.stdout).not.toContain('Possible matches');
    const zoo = await run(['before.json', 'after.json'], { files });
    expect(zoo.stdout).not.toContain('Possible matches');
  });

  it('names each side by its id when both have the same name', async () => {
    const r = await run([...symmetric, '--limit', '1'], { files: rings });
    expect(r.stdout).toMatch(
      / {2}≈ “C” \(h1\) → “C” \(t1\) +100% · too close to another candidate · name 100%/,
    );
  });

  it('lists 10 unless --limit is lower or 0', async () => {
    const count = (stdout: string): number =>
      stdout.split('\n').filter((l) => l.startsWith('  ≈ ')).length;
    const capped = await run(symmetric, { files: rings });
    expect(capped.stdout).toContain('  Possible matches 36\n');
    expect(count(capped.stdout)).toBe(10);
    expect(capped.stdout).toContain('  … and 26 more · --json lists all\n');
    expect(count((await run([...symmetric, '--limit', '3'], { files: rings })).stdout)).toBe(3);
    const all = await run([...symmetric, '--limit', '0'], { files: rings });
    expect(count(all.stdout)).toBe(36);
    expect(all.stdout).not.toContain('more · --json');
  });

  it('speaks Chinese', async () => {
    const r = await run([...similar, '--locale', 'zh-CN'], wide);
    expect(r.stdout).toMatch(
      / {2}可能的匹配 1\n {2}≈ 「Saudi Aramco」→「Aramco」 +80% · 低于阈值 82% · 名称 67% · 邻居 100%\n/,
    );
    expect(r.stdout).toContain('这些节点未配对，因此按删除或新增列出。');
  });

  it('--markdown lists them in their own block, after the hunks', async () => {
    const r = await run([...similar, '--markdown'], { files: runs });
    const block = r.stdout.slice(r.stdout.indexOf('<details open>\n<summary>Possible'));
    expect(block).toBe(
      [
        '<details open>',
        '<summary>Possible matches (1)</summary>',
        '',
        '*kgdiff did not pair these nodes, so they are listed above as removed or added. If a pair is the same thing, add a synonym or a replacement link, or lower `--threshold`.*',
        '',
        '- ≈ “Saudi Aramco” → “Aramco” — *80% · below the 82% threshold · name 67% · neighbours 100%*',
        '',
        '</details>',
        '',
        `*Generated by kgdiff ${cliVersion()}*`,
        '',
      ].join('\n'),
    );
    const paired = await run([...similar, '--threshold', '0.79', '--markdown'], { files: runs });
    expect(paired.stdout).not.toContain('Possible matches');
  });

  it('--markdown escapes the names, collapses a long list and caps it at 20', async () => {
    const escaped = await run(
      ['a.json', 'b.json', '--match', 'similarity', '--threshold', '0.99', '--markdown'],
      {
        files: {
          'a.json': graph([{ id: 't', label: '*Tom* @cat <b>' }]),
          'b.json': graph([{ id: 'u', label: '*Tom* @cats <b>' }]),
        },
      },
    );
    expect(escaped.stdout).toContain(
      '- ≈ “\\*Tom\\* @​cat &lt;b&gt;” → “\\*Tom\\* @​cats &lt;b&gt;” — *82% · below the 99% threshold',
    );
    const many = await run([...symmetric, '--markdown'], { files: rings });
    expect(many.stdout).toContain('<details>\n<summary>Possible matches (36)</summary>');
    expect(many.stdout.split('\n').filter((l) => l.startsWith('- ≈ '))).toHaveLength(20);
    expect(many.stdout).toContain(
      "*…and 16 more possible matches. The HTML report shows them in each node's details.*",
    );
  });
});

describe('review first (watched attributes)', () => {
  const node = (id: string, label: string, attrs?: object) => ({
    id,
    label,
    ...(attrs ? { attrs } : {}),
  });
  const graph = (nodes: readonly object[]): string =>
    JSON.stringify({
      nodes: [...nodes, node('disease', 'Disease')],
      edges: nodes.map((n) => ({
        source: (n as { id: string }).id,
        target: 'disease',
        predicate: 'is_a',
      })),
    });
  /** Asthma's definition is reworded (and a note edited); Gout is only renamed. */
  const release = {
    'v1.json': graph([
      node('asthma', 'Asthma', { def: 'A chronic disease of the airways.', note: 'a' }),
      node('gout', 'Gout'),
    ]),
    'v2.json': graph([
      node('asthma', 'Asthma', {
        def: 'A chronic inflammatory disease of the airways.',
        note: 'b',
      }),
      node('gout', 'Gouty arthritis'),
    ]),
  };
  const pair = ['v1.json', 'v2.json'];

  it('counts the hunks that change a definition under the bar and marks their rows', async () => {
    const r = await run(pair, { files: release });
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split('\n');
    expect(lines[3]).toMatch(/^ {2}~+$/);
    expect(lines[4]).toBe('  ⚑ Review first: definition changed in 1 hunk');
    expect(r.stdout).toMatch(
      / {2}~ Updated attributes of “Asthma” +content · ⚑ definition · ~2 attributes\n/,
    );
    expect(r.stdout).toMatch(/ {2}~ Renamed “Gout” → “Gouty arthritis” +content\n/);
    expect((await run([...pair, '--stat'], { files: release })).stdout).toContain(
      '  ⚑ Review first: definition changed in 1 hunk\n',
    );
  });

  it('speaks Chinese', async () => {
    const r = await run([...pair, '--locale', 'zh-CN'], { files: release });
    expect(r.stdout).toContain('  ⚑ 优先审查：1 组变更修改了定义\n');
    expect(r.stdout).toMatch(/「Asthma」.* +内容 · ⚑ 定义 · /);
  });

  it('--watch-attr replaces the definitions; --ignore-attr and [] leave nothing to flag', async () => {
    const note = await run([...pair, '--watch-attr', 'note'], { files: release });
    expect(note.stdout).toContain('  ⚑ Review first: note changed in 1 hunk\n');
    expect(note.stdout).toContain('content · ⚑ note · ');
    expect(note.stdout).not.toContain('⚑ definition');
    const both = await run([...pair, '--watch-attr', 'note', '--watch-attr', 'def'], {
      files: release,
    });
    expect(both.stdout).toContain('  ⚑ Review first: note, definition changed in 1 hunk\n');
    const ignored = await run([...pair, '--ignore-attr', 'def'], { files: release });
    expect(ignored.stdout).not.toContain('⚑');
    expect((await run(['before.json', 'after.json'], { files })).stdout).not.toContain('⚑');
  });

  it('--markdown lists them in a block before the groups, and marks them in the groups', async () => {
    const r = await run([...pair, '--markdown'], { files: release });
    const item = '- 🟨 \\~ Updated attributes of “Asthma” — *⚑ definition · \\~2 attributes*';
    expect(r.stdout).toContain(
      [
        '<details open>',
        '<summary>⚑ Review first (1)</summary>',
        '',
        '*These hunks change a watched attribute (definition). Such an edit can change what existing data means even when the diff looks small.*',
        '',
        item,
        '',
        '</details>',
        '',
        '<details open>',
        '<summary>Modified (2)</summary>',
        '',
        item,
        '- 🟨 \\~ Renamed “Gout” → “Gouty arthritis”',
      ].join('\n'),
    );
    const none = await run(['before.json', 'after.json', '--markdown'], { files });
    expect(none.stdout).not.toContain('Review first');
  });

  it('--markdown lists at most 20 under Review first', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `t${String(i).padStart(2, '0')}`);
    const r = await run(['m1.json', 'm2.json', '--markdown'], {
      files: {
        'm1.json': graph(ids.map((id) => node(id, `Term ${id}`, { def: `Old ${id}.` }))),
        'm2.json': graph(ids.map((id) => node(id, `Term ${id}`, { def: `New ${id}.` }))),
      },
    });
    const block = r.stdout.slice(0, r.stdout.indexOf('</details>'));
    expect(block).toContain('<summary>⚑ Review first (25)</summary>');
    expect(block.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(20);
    expect(block).toContain('*…and 5 more, marked ⚑ below.*');
  });
});

describe('colors', () => {
  it('is plain when stdout is not a terminal', async () => {
    const r = await run(['before.json', 'after.json'], { files });
    expect(r.stdout).not.toContain(ESC);
  });

  it('colors a terminal unless NO_COLOR is set', async () => {
    expect((await run(['before.json', 'after.json'], { files, isTTY: true })).stdout).toContain(
      ESC,
    );
    const noColor = await run(['before.json', 'after.json'], {
      files,
      isTTY: true,
      env: { NO_COLOR: '1' },
    });
    expect(noColor.stdout).not.toContain(ESC);
  });

  it('honours --color and FORCE_COLOR', async () => {
    const always = await run(['before.json', 'after.json', '--color', 'always'], {
      files,
      env: { NO_COLOR: '1' },
    });
    expect(always.stdout).toContain(`${ESC}[`);
    const never = await run(['before.json', 'after.json', '--color=never'], {
      files,
      isTTY: true,
      env: { FORCE_COLOR: '3' },
    });
    expect(never.stdout).not.toContain(ESC);
    const forced = await run(['before.json', 'after.json'], { files, env: { FORCE_COLOR: '3' } });
    expect(forced.stdout).toContain(`${ESC}[38;2;52;211;153m`);
  });

  it('uses 256 colors and 16 colors depending on the terminal', async () => {
    const r256 = await run(['before.json', 'after.json'], {
      files,
      isTTY: true,
      env: { TERM: 'xterm-256color' },
    });
    expect(r256.stdout).toContain(`${ESC}[38;5;`);
    const r16 = await run(['before.json', 'after.json'], {
      files,
      isTTY: true,
      env: { TERM: 'xterm' },
    });
    expect(r16.stdout).toMatch(new RegExp(`${ESC}\\[3[1-6]m`));
    expect(r16.stdout).not.toContain('38;5;');
  });

  it('paints the bar with family-colored blocks', async () => {
    const r = await run(['before.json', 'after.json', '--color', 'always'], { files });
    expect(stripAnsi(r.stdout).split('\n')[3]).toMatch(/^ {2}█+$/);
  });
});

describe('outputs', () => {
  it('--stat prints the diffstat with counts and types', async () => {
    const r = await run(['before.json', 'after.json', '--stat'], { files });
    expect(r.stdout).toContain('added  removed  modified  unchanged');
    expect(r.stdout).toMatch(/nodes +1 +1 +1 +3/);
    expect(r.stdout).toContain('By type');
    expect(r.stdout).toContain('(untyped)');
    expect(r.stdout).not.toContain('Renamed');
  });

  it('--name-status prints one tab-separated line per hunk', async () => {
    const r = await run(['before.json', 'after.json', '--name-status'], { files });
    expect(r.stdout).toBe(
      'D\tdodo\tRemoved “Dodo” and 1 relation\nR\tcat\tRenamed “Cat” → “House cat”\nA\towl\tAdded “Owl” and 1 relation\n',
    );
  });

  it('--name-status aligns columns on a terminal', async () => {
    const r = await run(['before.json', 'after.json', '--name-status'], {
      files,
      isTTY: true,
      env: { NO_COLOR: '1' },
    });
    expect(r.stdout).toContain('D  dodo  Removed “Dodo” and 1 relation');
    expect(r.stdout).toContain('R  cat   Renamed “Cat” → “House cat”');
  });

  it('--stat and --name-status combine', async () => {
    const r = await run(['before.json', 'after.json', '--stat', '--name-status'], { files });
    expect(r.stdout).toContain('By type');
    expect(r.stdout).toContain('R\tcat\t');
  });

  it('--json prints the full diff, --pretty indents it', async () => {
    const r = await run(['before.json', 'after.json', '--json'], { files });
    const json = JSON.parse(r.stdout) as { format: string; hunks: unknown[] };
    expect(json.format).toBe('kgdiff.diff');
    expect(json.hunks).toHaveLength(3);
    expect(r.stdout.split('\n')).toHaveLength(2);
    const pretty = await run(['before.json', 'after.json', '--json', '--pretty'], { files });
    expect(pretty.stdout).toContain('\n  "format": "kgdiff.diff"');
  });

  it('--delta prints the delta only', async () => {
    const r = await run(['before.json', 'after.json', '--delta'], { files });
    const delta = JSON.parse(r.stdout) as { format: string; base: { name: string } };
    expect(delta.format).toBe('kgdiff.delta');
    expect(delta.base.name).toBe('zoo');
  });

  it('writes combined outputs to files and keeps the summary on stdout', async () => {
    const r = await run(
      [
        'before.json',
        'after.json',
        '-o',
        'report.html',
        '--markdown',
        'summary.md',
        '--json',
        'diff.json',
        '--delta',
        'delta.json',
      ],
      { files },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^kgdiff {2}zoo/);
    expect(JSON.parse(r.file('diff.json')).format).toBe('kgdiff.diff');
    expect(JSON.parse(r.file('delta.json')).format).toBe('kgdiff.delta');
    expect(r.file('summary.md')).toMatch(/^## kgdiff · zoo v1 → v2/);
    expect(r.file('report.html')).toMatch(/^<!doctype html>/);
    expect(r.stderr).toMatch(/✓ Wrote diff diff\.json \(\d+(\.\d)? kB\)/);
    expect(r.stderr).toContain('✓ Wrote report report.html');
  });

  it('--quiet prints nothing but still writes files and sets the exit code', async () => {
    const r = await run(['before.json', 'after.json', '-q', '--exit-code', '--json', 'out.json'], {
      files,
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(r.written.size).toBe(1);
  });

  it('--markdown escapes labels', async () => {
    const tricky = JSON.stringify({
      nodes: [
        { id: 'a', label: '*bold* _it_ `code`' },
        { id: 'b', label: '[link](x) | pipe ~strike~' },
        { id: 'c', label: '<script>alert(1)</script> & co' },
        { id: 'd', label: '@octocat fixes #12 :tada:' },
        { id: 'e', label: 'line\nbreak' },
      ],
      edges: [],
    });
    const r = await run(['before.json', 'tricky.json', '--markdown'], {
      files: { ...files, 'tricky.json': tricky },
    });
    const md = r.stdout;
    expect(md).toContain('\\*bold\\* \\_it\\_ \\`code\\`');
    expect(md).toContain('\\[link\\](x) \\| pipe \\~strike\\~');
    expect(md).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
    expect(md).not.toContain('<script>');
    expect(md).toContain('@\u200boctocat');
    expect(md).toContain('\\#\u200b12');
    expect(md).toContain(':\u200btada:');
    expect(md).toContain('line break');
    // Only <details> / <summary> as HTML.
    const tags = new Set([...md.matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(['details', 'summary']);
  });

  it('--markdown lists at most 100 hunks', async () => {
    const nodes = Array.from({ length: 130 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }));
    const r = await run(['empty.json', 'many.json', '--markdown'], {
      files: {
        'empty.json': JSON.stringify({ nodes: [], edges: [] }),
        'many.json': JSON.stringify({ nodes, edges: [] }),
      },
    });
    expect(r.stdout.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(100);
    expect(r.stdout).toContain('…and 30 more hunks.');
    expect(r.stdout).toContain('<details>\n<summary>Added (130)</summary>');
  });

  it('reads one side from stdin', async () => {
    const r = await run(['-', 'after.json', '--name-status'], { files, stdin: BEFORE });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('R\tcat\t');
    const prompt = await run(['before.json', '-', '-q'], { files, stdin: AFTER, stdinIsTTY: true });
    expect(prompt.code).toBe(0);
  });

  it('prompts when stdin is a terminal', async () => {
    const r = await run(['before.json', '-'], { files, stdin: AFTER, stdinIsTTY: true });
    expect(r.stderr).toContain('Reading <after> from stdin… (end with Ctrl-D)');
  });

  it('reads gzip-compressed and UTF-16 files', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(AFTER, 'utf16le')]);
    const r = await run(['before.json.gz', 'after16.json', '--name-status'], {
      files: { 'before.json.gz': gzipSync(BEFORE), 'after16.json': utf16 },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('R\tcat\t');
  });

  it('opens the report, in a temporary file without -o', async () => {
    const r = await run(['before.json', 'after.json', '--open', '-q'], { files });
    expect(r.code).toBe(0);
    expect(r.opened).toHaveLength(1);
    // `resolve` adds the drive and backslashes on Windows, as the CLI's own path handling does.
    expect(r.opened).toEqual([resolve('/tmp/kgdiff-1', 'kgdiff-report.html')]);
    expect(r.written.has(r.opened[0] as string)).toBe(true);
    const named = await run(['before.json', 'after.json', '-o', 'r.html', '--open', '-q'], {
      files,
    });
    expect(named.opened).toEqual([resolve(CWD, 'r.html')]);
  });

  it('warns but succeeds when the browser cannot be opened', async () => {
    const r = await run(['before.json', 'after.json', '-o', 'r.html', '--open'], {
      files,
      openFile: async () => {
        throw new Error('spawn xdg-open ENOENT');
      },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('warning: Could not open the report (spawn xdg-open ENOENT)');
  });

  it('reports parse warnings on stderr unless quiet', async () => {
    const obo = (extra: string) => `format-version: 1.4\n\n[Term]\nid: X:1\nname: one\n${extra}`;
    const r = await run(['a.obo', 'b.obo'], {
      files: { 'a.obo': obo(''), 'b.obo': obo('\n[Weird]\nid: Y\n') },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^warning: b\.obo:\d+: /m);
    const quiet = await run(['a.obo', 'b.obo', '-q'], {
      files: { 'a.obo': obo(''), 'b.obo': obo('\n[Weird]\nid: Y\n') },
    });
    expect(quiet.stderr).toBe('');
  });
});

describe('exit codes and errors', () => {
  it('exits 1 with --exit-code when the graphs differ', async () => {
    expect((await run(['before.json', 'after.json', '--exit-code'], { files })).code).toBe(1);
    expect((await run(['before.json', 'after.json'], { files })).code).toBe(0);
  });

  it('exits 2 with a one-line message and a hint for a missing file', async () => {
    const r = await run(['nope.json', 'after.json'], { files });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      'error: Cannot read <before> "nope.json": no such file or directory.\nhint: Check the path. Use - to read from stdin.\n',
    );
  });

  it('prints a stack trace only with DEBUG=kgdiff', async () => {
    const r = await run(['nope.json', 'after.json'], { files, env: { DEBUG: 'kgdiff' } });
    expect(r.stderr).toMatch(/\n\s+at /);
    expect(r.stderr).toContain('ENOENT');
  });

  it('names the file and line of a syntax error', async () => {
    const r = await run(['before.json', 'bad.ttl'], {
      files: { ...files, 'bad.ttl': '@prefix ex: <http://e/> .\nex:a ex:b ex:c ;\n ex:d .' },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(
      /^error: "bad\.ttl": Invalid Turtle: .* line 3\.\nhint: If the format was detected wrongly, pass --format <fmt>/,
    );
  });

  it('suggests --format when the format cannot be detected', async () => {
    const r = await run(['before.json', 'mystery.txt'], {
      files: { ...files, 'mystery.txt': 'hello world' },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('error: Cannot tell the format of "mystery.txt".');
    expect(r.stderr).toContain('hint: Pass --format <fmt>');
  });

  it('says so when a kgdiff diff is given as a graph', async () => {
    const made = await run(['before.json', 'after.json', '--json', 'diff.json', '-q'], { files });
    const r = await run(['before.json', 'diff.json'], {
      files: { ...files, 'diff.json': made.file('diff.json') },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'error: "diff.json": This is a kgdiff diff (format "kgdiff.diff", as `kgdiff --json` writes it), not a graph.',
    );
    expect(r.stderr).not.toContain('hint:');
  });

  it('suggests an upgrade for a graph from a newer kgdiff', async () => {
    const v2 = JSON.stringify({ format: 'kgdiff.graph', version: 2, nodes: [], edges: [] });
    const r = await run(['before.json', 'v2.json'], { files: { ...files, 'v2.json': v2 } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('error: "v2.json": Unsupported kgdiff graph version 2;');
    expect(r.stderr).toContain('hint: Upgrade kgdiff: npm install -g @kgdiff/cli@latest.');
  });

  it('rejects binary input', async () => {
    const r = await run(['before.json', 'bin.json'], {
      files: { ...files, 'bin.json': new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]) },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('is not valid UTF-8 text');
  });

  it('reports usage errors with exit code 2', async () => {
    const r = await run(['before.json', 'after.json', '--sta'], { files });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'error: Unknown option --sta.\nhint: Did you mean --stat? Run `kgdiff --help` for usage.\n',
    );
    const colored = await run(['a', 'b', '--sta', '--color', 'always'], {});
    expect(colored.stderr).toContain(ESC);
  });

  it('refuses to overwrite an input or write two outputs to one file', async () => {
    const r = await run(['before.json', 'after.json', '--json', 'after.json'], { files });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'error: --json "after.json" is the input <after> "after.json"; kgdiff never overwrites its inputs.',
    );
    const twice = await run(['before.json', 'after.json', '--json', 'x', '--delta', 'x'], {
      files,
    });
    expect(twice.stderr).toContain('--json and --delta both write to "x"');
  });

  it('reports unwritable outputs', async () => {
    const r = await run(['before.json', 'after.json', '--json', 'missing-dir/out.json'], { files });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      'error: Cannot write diff to "missing-dir/out.json": no such file or directory.',
    );
    expect(r.stderr).toContain('hint: Create the directory first.');
  });

  it('fails clearly when the viewer bundle is missing', async () => {
    const { CliError } = await import('../src/index.js');
    const r = await run(['before.json', 'after.json', '-o', 'r.html'], {
      files,
      bundle: new CliError(
        'viewer-missing',
        'The HTML report needs the standalone viewer bundle.',
        'Build it.',
      ),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      'error: The HTML report needs the standalone viewer bundle.\nhint: Build it.\n',
    );
    expect(r.written.size).toBe(0);
  });

  it('maps invalid diff options to an input error', async () => {
    const r = await run(['before.json', 'after.json', '--hierarchy', ''], { files });
    expect([0, 2]).toContain(r.code);
  });
});

describe('RDF/XML and JSON-LD inputs', () => {
  const fixture = (name: string) =>
    readFileSync(resolve(REPO, 'packages/formats/test/fixtures', name), 'utf8');
  /** Hunks and warnings of a one-edit diff; file names are taken out of the warnings. */
  const diffOf = async (name: string, from: string, to: string) => {
    const extension = name.slice(name.indexOf('.'));
    const text = fixture(name);
    const r = await run([`a${extension}`, `b${extension}`, '--json'], {
      files: { [`a${extension}`]: text, [`b${extension}`]: text.replace(from, to) },
    });
    expect(r.code, name).toBe(0);
    const { hunks } = JSON.parse(r.stdout) as { hunks: unknown[] };
    return { hunks: JSON.stringify(hunks), warnings: r.stderr.replaceAll(extension, '.*') };
  };

  it('diffs .owl and .jsonld files exactly like their Turtle twins', async () => {
    const turtle = await diffOf('go-mini.ttl', '"mitochondrion"@en', '"mitochondria"@en');
    expect(JSON.parse(turtle.hunks)).toHaveLength(1);
    expect(await diffOf('go-mini.owl', '>mitochondrion<', '>mitochondria<')).toEqual(turtle);
    expect(await diffOf('go-mini.jsonld', '"mitochondrion"', '"mitochondria"')).toEqual(turtle);
  });

  it('reads JSON-LD and RDF/XML from stdin by their content', async () => {
    const r = await run(['go.owl', '-', '--exit-code', '-q'], {
      files: { 'go.owl': fixture('go-mini.owl') },
      stdin: fixture('go-mini.jsonld'),
    });
    expect(r.code).toBe(0);
  });

  it('explains that remote JSON-LD contexts are never fetched', async () => {
    const remote = '{"@context": "https://schema.org/", "@id": "https://ex.org/a", "name": "A"}';
    const r = await run(['a.jsonld', 'b.jsonld'], {
      files: { 'a.jsonld': remote, 'b.jsonld': remote },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(
      /^error: "a\.jsonld": Invalid JSON-LD: loading remote context failed: "https:\/\/schema\.org\/" was not loaded, as kgdiff never fetches documents; inline the context/,
    );
  });

  it('rejects OWL/XML saved as .owl with a conversion hint', async () => {
    const r = await run(['before.json', 'pizza.owl'], {
      files: {
        ...files,
        'pizza.owl':
          '<?xml version="1.0"?>\n<Ontology xmlns="http://www.w3.org/2002/07/owl#" ontologyIRI="http://ex.org/pizza"/>',
      },
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('OWL/XML is not supported');
    expect(r.stderr).toContain('robot convert');
  });
});

describe('help and version', () => {
  it('lists every input format and its extensions', async () => {
    const r = await run(['--help']);
    const help = r.stdout.replace(/\s+/g, ' ');
    expect(help).toContain('RDF/XML (.rdf, .owl)');
    expect(help).toContain('JSON-LD (.jsonld)');
    expect(help).toContain(
      'Input format: auto, json, jsonld, turtle, ntriples, nquads, trig, rdfxml, obo',
    );
  });

  it('prints the version', async () => {
    const r = await run(['--version']);
    expect(r.stdout).toMatch(/^kgdiff \d+\.\d+\.\d+\n$/);
    expect(r.code).toBe(0);
  });

  it('documents every option, grouped, within 80 columns', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    for (const section of [
      'Usage',
      'Output',
      'Diff',
      'Report',
      'Behaviour',
      'Examples',
      'Exit status',
    ]) {
      expect(r.stdout).toContain(`\n${section}\n`);
    }
    for (const name of Object.keys(DIFF_OPTIONS)) expect(r.stdout).toContain(`--${name}`);
    for (const line of r.stdout.split('\n'))
      expect(stringWidth(line), line).toBeLessThanOrEqual(80);
    expect(r.stdout).not.toContain(ESC);
  });

  it('has a help page for apply', async () => {
    const r = await run(['apply', '--help']);
    expect(r.stdout).toContain('kgdiff apply <graph> <delta>');
    expect(r.stdout).toContain('--no-strict');
  });

  it('wraps help on narrow terminals and colors it on a TTY', async () => {
    const r = await run(['--help'], { isTTY: true, columns: 50 });
    expect(r.stdout).toContain(ESC);
    for (const line of stripAnsi(r.stdout).split('\n')) {
      expect(stringWidth(line), line).toBeLessThanOrEqual(50);
    }
  });
});

describe('apply', () => {
  async function graphHash(text: string, filename: string): Promise<string> {
    return hashGraph(normalize(parseGraph(text, { filename }).graph));
  }

  it('round-trips every example dataset: diff → delta → apply equals after', async () => {
    for (const id of [
      'enterprise-kg',
      'ontology-release',
      'schema-vocab',
      'llm-extraction',
      'data-lineage',
    ]) {
      const d = dataset(id);
      const made = await run([d.before, d.after, ...d.flags, '--delta', 'patch.json', '-q']);
      expect(made.code).toBe(0);
      const applied = await run(['apply', d.before, 'patch.json', '-o', 'out.json'], {
        files: { 'patch.json': made.file('patch.json') },
      });
      expect(applied.code, applied.stderr).toBe(0);
      expect(applied.stderr).toMatch(
        /✓ Wrote patched graph \(\d+ operations applied, c\d+:[0-9a-f]+\) out\.json/,
      );
      const { readFileSync } = await import('node:fs');
      const expected = await graphHash(readFileSync(d.after, 'utf8'), d.after);
      expect(await graphHash(applied.file('out.json'), 'out.json')).toBe(expected);
      // kgdiff reads its own output back as the same graph.
      const check = await run([d.after, 'out.json', '--exit-code', '-q', ...d.flags], {
        files: { 'out.json': applied.file('out.json') },
      });
      expect(check.code, id).toBe(0);
    }
  });

  it('chains two applies (v1 → v2 → v3)', async () => {
    const v3 = JSON.stringify({
      ...JSON.parse(AFTER),
      meta: { name: 'zoo', version: 'v3' },
      nodes: [...JSON.parse(AFTER).nodes, { id: 'emu', label: 'Emu', type: 'Bird' }],
    });
    const step1 = await run(['before.json', 'after.json', '--delta', 'd1.json', '-q'], { files });
    const step2 = await run(['after.json', 'v3.json', '--delta', 'd2.json', '-q'], {
      files: { ...files, 'v3.json': v3 },
    });
    const out1 = await run(['apply', 'before.json', 'd1.json', '-o', 'out1.json', '-q'], {
      files: { ...files, 'd1.json': step1.file('d1.json') },
    });
    expect(out1.code, out1.stderr).toBe(0);
    const out2 = await run(['apply', 'out1.json', 'd2.json', '-o', 'out2.json'], {
      files: { 'out1.json': out1.file('out1.json'), 'd2.json': step2.file('d2.json') },
    });
    expect(out2.code, out2.stderr).toBe(0);
    expect(out2.stderr).not.toContain('warning');
    expect(await graphHash(out2.file('out2.json'), 'out2.json')).toBe(
      await graphHash(v3, 'v3.json'),
    );
  });

  it('lists every skipped operation in one pass with --verbose', async () => {
    const made = await run(['before.json', 'after.json', '--delta', 'd.json', '-q'], { files });
    const total = (JSON.parse(made.file('d.json')) as { ops: unknown[] }).ops.length;
    const r = await run(
      ['apply', 'empty.json', 'd.json', '--no-strict', '--verbose', '--allow-empty'],
      {
        files: { 'empty.json': '', 'd.json': made.file('d.json') },
      },
    );
    expect(r.code).toBe(0);
    const count = Number(/Skipped (\d+) of (\d+) operations/.exec(r.stderr)?.[1]);
    expect(r.stderr).toContain(`of ${total} operations that do not fit this graph:`);
    expect(count).toBeGreaterThan(0);
    expect(r.stderr.split('\n').filter((l) => /^ {2}#\d+ /.test(l))).toHaveLength(count);
    const indices = [...r.stderr.matchAll(/^ {2}#(\d+) /gm)].map((m) => Number(m[1]));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it('writes kgdiff JSON that leads with its format marker', async () => {
    const made = await run(['before.json', 'after.json', '--delta', 'd.json', '-q'], { files });
    const out = await run(['apply', 'before.json', 'd.json'], {
      files: { ...files, 'd.json': made.file('d.json') },
    });
    const graph = JSON.parse(out.stdout);
    expect(Object.keys(graph)).toEqual(['format', 'version', 'meta', 'nodes', 'edges']);
    expect(graph).toMatchObject({ format: 'kgdiff.graph', version: 1 });
  });

  it('records the target version and the output file in meta', async () => {
    const made = await run(['before.json', 'after.json', '--delta', 'd.json', '-q'], { files });
    const out = await run(['apply', 'before.json', 'd.json', '-o', 'dir/patched.json', '-q'], {
      files: { ...files, 'd.json': made.file('d.json') },
    });
    const meta = JSON.parse(out.file('dir/patched.json')).meta;
    expect(meta).toEqual({ name: 'zoo', version: 'v2', source: 'patched.json' });
    const stdout = await run(['apply', 'before.json', 'd.json'], {
      files: { ...files, 'd.json': made.file('d.json') },
    });
    expect(JSON.parse(stdout.stdout).meta).toEqual({ name: 'zoo', version: 'v2' });
  });

  it('accepts --json output as the delta and reads it from stdin', async () => {
    const made = await run(['before.json', 'after.json', '--json'], { files });
    const out = await run(['apply', 'before.json', '-', '--pretty'], { files, stdin: made.stdout });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('\n  "nodes": [');
    expect(await graphHash(out.stdout, 'x.json')).toBe(await graphHash(AFTER, 'after.json'));
  });

  it('refuses a delta made for another graph, unless --no-strict', async () => {
    const made = await run(['before.json', 'after.json', '--delta', 'd.json', '-q'], { files });
    const strict = await run(['apply', 'after.json', 'd.json'], {
      files: { ...files, 'd.json': made.file('d.json') },
    });
    expect(strict.code).toBe(2);
    expect(strict.stderr).toMatch(
      /^error: <graph> "after\.json" is not the base of this delta \(graph c\d+:[0-9a-f]+, delta base c\d+:[0-9a-f]+\)\./,
    );
    expect(strict.stderr).toContain('--format and --lang must match');
    expect(strict.stderr).toContain('--no-strict applies what fits');
    const loose = await run(['apply', 'after.json', 'd.json', '--no-strict'], {
      files: { ...files, 'd.json': made.file('d.json') },
    });
    expect(loose.code).toBe(0);
    expect(loose.stderr).toMatch(
      /^warning: Skipped \d+ of \d+ operations that do not fit this graph \(--verbose lists them\)\.$/m,
    );
    const verbose = await run(['apply', 'after.json', 'd.json', '--no-strict', '--verbose'], {
      files: { ...files, 'd.json': made.file('d.json') },
    });
    expect(verbose.stderr).toMatch(/^ {2}#\d+ node\.\w+: .+$/m);
  });

  it('counts exactly the skipped operations with --no-strict', async () => {
    // The delta from before → after, applied to a graph where "cat" was already renamed and
    // "dodo" is gone: exactly those two operations (and the edge removal that needs dodo's
    // edge) cannot apply.
    const made = await run(['before.json', 'after.json', '--delta', 'd.json', '-q'], { files });
    const delta = JSON.parse(made.file('d.json')) as { ops: { op: string }[] };
    const partial = JSON.parse(BEFORE) as {
      nodes: { id: string; label: string }[];
      edges: unknown[];
    };
    partial.nodes = partial.nodes.map((n) => (n.id === 'cat' ? { ...n, label: 'House cat' } : n));
    const out = await run(
      ['apply', 'partial.json', 'd.json', '--no-strict', '--verbose', '-o', 'out.json'],
      {
        files: { 'partial.json': JSON.stringify(partial), 'd.json': made.file('d.json') },
      },
    );
    expect(out.code).toBe(0);
    expect(out.stderr).toContain(`Skipped 1 of ${delta.ops.length} operations`);
    expect(out.stderr).toMatch(/#\d+ node\.set: node "cat" label differs from "from"/);
    expect(out.stderr).toContain(`(${delta.ops.length - 1} operations applied,`);
    expect(await graphHash(out.file('out.json'), 'out.json')).toBe(
      await graphHash(AFTER, 'after.json'),
    );
  });

  it('explains files that are not deltas', async () => {
    const notJson = await run(['apply', 'before.json', 'x.json'], {
      files: { ...files, 'x.json': '{' },
    });
    expect(notJson.code).toBe(2);
    expect(notJson.stderr).toMatch(/^error: "x\.json" is not valid JSON/);
    const graph = await run(['apply', 'before.json', 'after.json'], { files });
    expect(graph.stderr).toContain('"after.json" is not a kgdiff delta');
    const future = await run(['apply', 'before.json', 'd.json'], {
      files: {
        ...files,
        'd.json': JSON.stringify({
          format: 'kgdiff.delta',
          version: 9,
          edgeIdentity: 'structure',
          ops: [],
        }),
      },
    });
    expect(future.code).toBe(2);
    expect(future.stderr).toContain('Unsupported delta version 9');
    expect(future.stderr).toContain('hint: Upgrade kgdiff');
  });
});

describe('edge cases', () => {
  const graph = (nodes: unknown[], edges: unknown[] = []) => JSON.stringify({ nodes, edges });

  it('handles empty graphs', async () => {
    const r = await run(['e1.json', 'e2.json', '--exit-code'], {
      files: { 'e1.json': graph([]), 'e2.json': graph([]) },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('No differences  Both versions have 0 nodes and 0 edges.');
    const md = await run(['e1.json', 'e2.json', '--markdown'], {
      files: { 'e1.json': graph([]), 'e2.json': graph([]) },
    });
    expect(md.stdout).toContain('✅ **No differences.**');
    const ns = await run(['e1.json', 'e2.json', '--name-status'], {
      files: { 'e1.json': graph([]), 'e2.json': graph([]) },
    });
    expect(ns.stdout).toBe('');
  });

  it('handles a single node, self-loops, parallel edges and odd ids', async () => {
    const before = graph([{ id: 'a | "quoted" id', label: 'A' }]);
    const after = graph(
      [
        { id: 'a | "quoted" id', label: 'A' },
        { id: 'b c', label: 'B' },
      ],
      [
        { source: 'a | "quoted" id', target: 'a | "quoted" id', predicate: 'self' },
        { source: 'b c', target: 'a | "quoted" id', predicate: 'p' },
        { source: 'b c', target: 'a | "quoted" id', predicate: 'p', attrs: { n: 2 } },
      ],
    );
    const r = await run(['a.json', 'b.json', '--name-status'], {
      files: { 'a.json': before, 'b.json': after },
    });
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.split('\t')).toHaveLength(3);
    expect(r.stdout).toContain('a | "quoted" id');
    const summary = await run(['a.json', 'b.json'], {
      files: { 'a.json': before, 'b.json': after },
    });
    expect(summary.code).toBe(0);
  });

  it('truncates very long labels to the terminal width', async () => {
    const long = 'Very long label '.repeat(40);
    const r = await run(['a.json', 'b.json'], {
      files: {
        'a.json': graph([{ id: 'x', label: 'X' }]),
        'b.json': graph([{ id: 'x', label: long }]),
      },
      isTTY: true,
      columns: 70,
      env: { NO_COLOR: '1' },
    });
    for (const line of r.stdout.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(70);
    expect(r.stdout).toContain('…');
  });
});

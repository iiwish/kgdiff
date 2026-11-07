import { describe, expect, it } from 'vitest';
import { editDistance, suggest } from '../src/args.js';
import { CliError, type Command, type DiffCommandOptions, parseCommandLine } from '../src/index.js';

function diffOptions(argv: string[]): DiffCommandOptions {
  const command = parseCommandLine(argv);
  if (command.kind !== 'diff') throw new Error(`expected diff, got ${command.kind}`);
  return command.options;
}

function usageError(argv: string[]): CliError {
  try {
    parseCommandLine(argv);
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error(`expected a usage error for ${argv.join(' ')}`);
}

describe('diff command line', () => {
  it('takes two graphs and documented defaults', () => {
    const o = diffOptions(['a.ttl', 'b.ttl']);
    expect(o).toMatchObject({
      before: 'a.ttl',
      after: 'b.ttl',
      beforeFormat: 'auto',
      afterFormat: 'auto',
      diff: {},
      stat: false,
      nameStatus: false,
      open: false,
      pretty: false,
      reproducible: false,
      compute: true,
      exitCode: false,
      quiet: false,
      color: 'auto',
      limit: 50,
    });
    expect(o.json).toBeUndefined();
    expect(o.locale).toBeUndefined();
  });

  it('maps diff options to DiffOptions', () => {
    const o = diffOptions([
      'a.json',
      'b.json',
      '--match',
      'similarity',
      '--threshold',
      '0.9',
      '--edge-identity',
      'id',
      '--hierarchy',
      'is_a',
      '--hierarchy',
      'part_of',
      '--ignore-attr',
      'updated',
      '--no-merges',
      '--no-splits',
    ]);
    expect(o.diff).toEqual({
      match: { strategy: 'similarity', threshold: 0.9 },
      edgeIdentity: 'id',
      hierarchyPredicates: ['is_a', 'part_of'],
      ignoreAttrs: ['updated'],
      detectMerges: false,
      detectSplits: false,
    });
  });

  it('maps format and language options to parse options', () => {
    const o = diffOptions([
      'a',
      'b',
      '-f',
      'turtle',
      '--after-format',
      'ntriples',
      '--lang',
      'zh,en',
    ]);
    expect(o.beforeFormat).toBe('turtle');
    expect(o.afterFormat).toBe('ntriples');
    expect(o.languages).toEqual(['zh', 'en']);
  });

  it('reads report and behaviour options', () => {
    const o = diffOptions([
      'a',
      'b',
      '-o',
      'r.html',
      '--open',
      '--title',
      'Release 13',
      '--theme',
      'dark',
      '--locale',
      'zh',
      '--mode',
      'replay',
      '--reproducible',
      '--no-compute',
      '--exit-code',
      '-q',
      '--color=never',
      '--limit',
      '0',
    ]);
    expect(o).toMatchObject({
      html: 'r.html',
      open: true,
      title: 'Release 13',
      theme: 'dark',
      locale: 'zh-CN',
      mode: 'replay',
      reproducible: true,
      compute: false,
      exitCode: true,
      quiet: true,
      color: 'never',
      limit: 0,
    });
  });

  it('--panels reads region:state pairs, as the viewer’s panels attribute does', () => {
    expect(diffOptions(['a', 'b']).panels).toBeUndefined();
    expect(
      diffOptions(['a', 'b', '--panels', 'detail:collapsed  minimap:hidden,legend:open']).panels,
    ).toEqual({ detail: 'collapsed', minimap: 'hidden', legend: 'open' });
    // Repeatable; a region named again takes the last state.
    expect(
      diffOptions(['a', 'b', '--panels=list:hidden detail:open', '--panels', 'detail:hidden'])
        .panels,
    ).toEqual({ list: 'hidden', detail: 'hidden' });
    expect(diffOptions(['a', 'b', '--panels', ' ']).panels).toBeUndefined();
  });

  it('--panels explains what is wrong, with a suggestion', () => {
    const pair = usageError(['a', 'b', '--panels', 'detail']);
    expect(pair.message).toBe('Invalid value "detail" for --panels.');
    expect(pair.hint).toMatch(/^Expected region:state pairs, e\.g\. --panels "detail:collapsed/);
    expect(pair.hint).toContain('Regions: list, detail, search, filters, dock, transport');
    const region = usageError(['a', 'b', '--panels', 'detials:hidden']);
    expect(region.message).toBe('Unknown panel region "detials" in --panels.');
    expect(region.hint).toMatch(/^Did you mean "detail"\? Regions: /);
    const state = usageError(['a', 'b', '--panels', 'minimap:collapse']);
    expect(state.message).toBe('Invalid state "collapse" for the minimap panel in --panels.');
    expect(state.hint).toBe('Did you mean "collapsed"? Expected one of: open, collapsed, hidden.');
    expect(usageError(['a', 'b', '--panels', 'zoom:open:x']).message).toMatch(/--panels/);
    expect(usageError(['a', 'b', '--panels', 'sidebar:hidden']).message).toBe(
      'Unknown panel region "sidebar" in --panels.',
    );
  });

  it('--watch-attr collects attribute keys, and is absent when not given', () => {
    expect(diffOptions(['a.obo', 'b.obo']).watchAttrs).toBeUndefined();
    expect(
      diffOptions(['a.ttl', 'b.ttl', '--watch-attr', 'rdfs:comment', '--watch-attr=def'])
        .watchAttrs,
    ).toEqual(['rdfs:comment', 'def']);
    const error = usageError(['a.ttl', 'b.ttl', '--watch-attr', ' ']);
    expect(error.message).toBe('--watch-attr needs an attribute key.');
    expect(error.hint).toContain('--watch-attr rdfs:comment');
  });

  it('accepts - for stdin on one side', () => {
    expect(diffOptions(['-', 'b.ttl']).before).toBe('-');
    expect(diffOptions(['a.ttl', '-']).after).toBe('-');
    expect(usageError(['-', '-']).message).toMatch(/only one input/i);
  });

  it('treats arguments after -- as files', () => {
    const o = diffOptions(['--stat', '--', '--weird.json', 'b.json']);
    expect(o.before).toBe('--weird.json');
  });
});

describe('optional output values', () => {
  it('writes to stdout when no value is given', () => {
    expect(diffOptions(['a', 'b', '--json']).json).toBe('-');
    expect(diffOptions(['a', 'b', '--delta']).delta).toBe('-');
    expect(diffOptions(['a', 'b', '--markdown']).markdown).toBe('-');
  });

  it('takes the next argument as the file', () => {
    const o = diffOptions(['a', 'b', '-o', 'report.html', '--markdown', 'summary.md']);
    expect(o.markdown).toBe('summary.md');
    expect(o.html).toBe('report.html');
    expect(diffOptions(['a', 'b', '--json', 'out.json']).json).toBe('out.json');
  });

  it('binds with = always', () => {
    expect(diffOptions(['a', 'b', '--json=out.json']).json).toBe('out.json');
  });

  it('leaves the graphs alone when they are needed as positionals', () => {
    const o = diffOptions(['--json', 'a.json', 'b.json']);
    expect(o.json).toBe('-');
    expect([o.before, o.after]).toEqual(['a.json', 'b.json']);
    const p = diffOptions(['--json', 'a.json', 'b.json', '--markdown', 'm.md']);
    expect([p.before, p.after, p.json, p.markdown]).toEqual(['a.json', 'b.json', '-', 'm.md']);
  });

  it('does not take an option as a value', () => {
    const o = diffOptions(['a', 'b', '--json', '--pretty']);
    expect(o.json).toBe('-');
    expect(o.pretty).toBe(true);
  });
});

describe('validation', () => {
  it('reports missing and extra graphs', () => {
    expect(usageError([]).message).toBe('Missing <before> and <after> arguments.');
    expect(usageError(['a.ttl']).message).toBe('Missing <after> argument.');
    expect(usageError(['a', 'b', 'c']).message).toBe('Unexpected argument "c".');
  });

  it('suggests the closest option for typos', () => {
    const error = usageError(['a', 'b', '--sta']);
    expect(error.message).toBe('Unknown option --sta.');
    expect(error.hint).toMatch(/Did you mean --stat\?/);
    expect(usageError(['a', 'b', '--exitcode']).hint).toMatch(/--exit-code/);
    expect(usageError(['a', 'b', '--name-stauts']).hint).toMatch(/--name-status/);
    expect(usageError(['a', 'b', '-x']).message).toBe('Unknown option -x.');
  });

  it('rejects invalid enumerated values with a suggestion', () => {
    const error = usageError(['a', 'b', '--match', 'simlarity']);
    expect(error.message).toBe('Invalid value "simlarity" for --match.');
    expect(error.hint).toMatch(/Did you mean "similarity"\?/);
    expect(usageError(['a', 'b', '-f', 'ttl']).hint).toBe(
      'Expected one of: auto, json, jsonld, turtle, ntriples, nquads, trig, rdfxml, obo.',
    );
    expect(usageError(['a', 'b', '-f', 'owl']).message).toBe('Invalid value "owl" for --format.');
    expect(usageError(['a', 'b', '--color', 'yes']).hint).toMatch(/auto, always, never/);
    expect(usageError(['a', 'b', '--theme', 'blue']).message).toMatch(/--theme/);
    expect(usageError(['a', 'b', '--mode', 'side']).message).toMatch(/--mode/);
    expect(usageError(['a', 'b', '--scope', 'some']).hint).toMatch(/all, changes/);
    expect(usageError(['a', 'b', '--edge-identity', 'key']).message).toMatch(/--edge-identity/);
  });

  it('validates numbers', () => {
    expect(usageError(['a', 'b', '--threshold', '1.5']).hint).toBe(
      'Expected a number between 0 and 1.',
    );
    expect(usageError(['a', 'b', '--threshold', 'high']).message).toMatch(/--threshold/);
    expect(usageError(['a', 'b', '--limit', '2.5']).hint).toBe('Expected an integer ≥ 0.');
    expect(usageError(['a', 'b', '--limit=-1']).message).toMatch(/--limit/);
  });

  it('requires values and refuses values for flags', () => {
    expect(usageError(['a', 'b', '--title']).message).toBe('Option --title needs a value.');
    expect(usageError(['a', 'b', '--title', '--stat']).message).toMatch(/needs a value/);
    expect(usageError(['a', 'b', '--stat=yes']).message).toBe(
      'Option --stat does not take a value.',
    );
    expect(diffOptions(['a', 'b', '--title=-draft-']).title).toBe('-draft-');
  });

  it('rejects unsupported locales', () => {
    expect(usageError(['a', 'b', '--locale', 'fr']).message).toBe('Unsupported locale "fr".');
  });

  it('allows only one output on stdout', () => {
    expect(usageError(['a', 'b', '--json', '--markdown']).message).toBe(
      '--json and --markdown would all write to stdout.',
    );
    expect(usageError(['a', 'b', '--stat', '--delta']).message).toMatch(/--delta and --stat/);
    expect(diffOptions(['a', 'b', '--stat', '--name-status']).nameStatus).toBe(true);
    expect(diffOptions(['a', 'b', '--json', 'x.json', '--markdown']).markdown).toBe('-');
  });

  it('refuses an HTML report on stdout', () => {
    expect(usageError(['a', 'b', '-o', '-']).message).toMatch(/must be written to a file/);
  });
});

describe('help, version and apply', () => {
  const kind = (argv: string[]): Command['kind'] => parseCommandLine(argv).kind;

  it('recognises help and version anywhere', () => {
    expect(kind(['--help'])).toBe('help');
    expect(kind(['a', 'b', '-h'])).toBe('help');
    expect(kind(['--version'])).toBe('version');
    expect(kind(['-v'])).toBe('version');
    expect(parseCommandLine(['help', 'apply'])).toEqual({
      kind: 'help',
      topic: 'apply',
      color: 'auto',
    });
    expect(parseCommandLine(['apply', '--help'])).toMatchObject({ kind: 'help', topic: 'apply' });
    expect(usageError(['help', 'nope']).message).toMatch(/Unknown help topic/);
  });

  it('parses apply', () => {
    expect(parseCommandLine(['apply', 'g.ttl', 'd.json', '-o', 'out.json', '--no-strict'])).toEqual(
      {
        kind: 'apply',
        options: {
          color: 'auto',
          quiet: false,
          graph: 'g.ttl',
          delta: 'd.json',
          output: 'out.json',
          strict: false,
          format: 'auto',
          pretty: false,
          allowEmpty: false,
          verbose: false,
        },
      },
    );
    const o = parseCommandLine(['apply', 'g', 'd']);
    expect(o.kind === 'apply' && o.options.output).toBe('-');
    expect(usageError(['apply', 'g']).message).toBe('Missing <delta> argument.');
    expect(usageError(['apply', 'g', 'd', '--stat']).message).toBe('Unknown option --stat.');
  });
});

describe('suggestions', () => {
  it('measures edit distance with transpositions', () => {
    expect(editDistance('stat', 'stat')).toBe(0);
    expect(editDistance('sta', 'stat')).toBe(1);
    expect(editDistance('tsat', 'stat')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('suggests only close candidates', () => {
    expect(suggest('jsno', ['json', 'delta'])).toBe('json');
    expect(suggest('zzzzzz', ['json', 'delta'])).toBeUndefined();
    expect(suggest('mark', ['markdown', 'match'])).toBe('markdown');
  });
});

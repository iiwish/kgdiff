/**
 * The API reports of the published npm packages: one `*.api.md` per public entry point, committed
 * under `packages/<name>/api/`, written by API Extractor from the built declarations (`dist/*.d.ts`).
 * It does for the TypeScript API what cargo-semver-checks does for the Rust one
 * (docs/versioning.md): a change to an exported name or signature changes a report, so it shows
 * up in review, and from 1.0 on a removal or change in a report is a breaking change.
 *
 *   pnpm build && pnpm api:check    # fails when a report differs from the built declarations
 *   pnpm build && pnpm api:update   # writes the reports again
 *
 * Every `exports` entry with a `types` condition has a report; the standalone bundles of
 * @kgdiff/viewer (script tags, no `types`) have one for the module each is built from. Not
 * covered: @kgdiff/formats (deprecated, not published from 1.0 on) and @kgdiff/cli (a command).
 *
 * Items whose doc comment has `@experimental` (or `@deprecated`) carry that tag in the report,
 * so the reports change when 1.0 drops the tag.
 *
 * On a difference, the report as built is left in node_modules/.cache/api-extractor/ and the
 * script prints a diff.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import {
  Extractor,
  ExtractorConfig,
  ExtractorLogLevel,
  type ExtractorMessage,
  ExtractorMessageCategory,
  type IConfigFile,
} from '@microsoft/api-extractor';
import ts from 'typescript5';

const ROOT = resolve(import.meta.dirname, '..');
const TEMP = join(ROOT, 'node_modules', '.cache', 'api-extractor');
const PACKAGES = ['core', 'compute', 'layout', 'scene', 'renderer', 'viewer', 'g6'];
/** The modules the bundles without a `types` condition are built from (packages/viewer/vite.config.ts). */
const UNTYPED_SOURCES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '@kgdiff/viewer': {
    './standalone': './dist/standalone.d.ts',
    './standalone/compute': './dist/standalone-compute.d.ts',
  },
};
/** The doc-comment tags a report shows on each item that has them. */
const SHOWN_TAGS = ['experimental', 'deprecated'];

interface Entry {
  readonly packageDir: string;
  readonly packageName: string;
  /** `.`, `./computed`, `./elements/root`… */
  readonly subpath: string;
  /** Absolute path of the built declaration file. */
  readonly dts: string;
  /** `index.api.md`, `computed.api.md`, `elements-root.api.md`… */
  readonly reportName: string;
}

interface PackageJson {
  readonly name: string;
  readonly exports: Readonly<Record<string, string | { readonly types?: string }>>;
}

function entries(): Entry[] {
  const list: Entry[] = [];
  for (const name of PACKAGES) {
    const packageDir = join(ROOT, 'packages', name);
    const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageJson;
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const types =
        typeof target === 'object' ? target.types : UNTYPED_SOURCES[pkg.name]?.[subpath];
      if (types === undefined) continue;
      const reportName = `${subpath === '.' ? 'index' : subpath.slice(2).replaceAll('/', '-')}.api.md`;
      list.push({
        packageDir,
        packageName: pkg.name,
        subpath,
        dts: join(packageDir, types),
        reportName,
      });
    }
  }
  return list;
}

const COMPILER_OPTIONS = {
  target: 'ES2022',
  lib: ['ES2023', 'DOM', 'DOM.Iterable'],
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  skipLibCheck: true,
  jsx: 'react-jsx',
};

function config(entry: Entry): IConfigFile {
  return {
    projectFolder: entry.packageDir,
    mainEntryPointFilePath: entry.dts,
    compiler: {
      overrideTsconfig: { compilerOptions: COMPILER_OPTIONS, include: ['dist'] },
    },
    apiReport: {
      enabled: true,
      reportFileName: entry.reportName,
      reportFolder: join(entry.packageDir, 'api'),
      reportTempFolder: join(TEMP, posix.basename(entry.packageDir)),
    },
    docModel: { enabled: false },
    dtsRollup: { enabled: false },
    tsdocMetadata: { enabled: false },
    messages: {
      compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.Warning } },
      extractorMessageReporting: {
        default: { logLevel: ExtractorLogLevel.Warning, addToApiReportFile: true },
        // The packages do not use release tags (@public, @beta…); stability is `@experimental`.
        'ae-missing-release-tag': { logLevel: ExtractorLogLevel.None },
        // Re-exports of another @kgdiff package's types are fine.
        'ae-wrong-input-file-type': { logLevel: ExtractorLogLevel.None },
        // Documentation is not API: a doc fix must not change a report.
        'ae-undocumented': { logLevel: ExtractorLogLevel.None, addToApiReportFile: false },
      },
      tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
    },
  };
}

/**
 * The `@experimental` / `@deprecated` tags of the entry's exported declarations and of their
 * members, at any depth (`ViewerConfig.view.shapes`), keyed by path: `Renderer.addLayer`.
 * API Extractor keeps only release tags (@public, @beta…) in a report, so they are added here.
 */
function taggedDeclarations(entry: Entry): Map<string, Set<string>> {
  const program = ts.createProgram([entry.dts], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry.dts);
  const tagged = new Map<string, Set<string>>();
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) return tagged;

  const record = (node: ts.Node, path: readonly string[]) => {
    for (const tag of ts.getJSDocTags(node)) {
      const name = tag.tagName.text;
      if (!SHOWN_TAGS.includes(name)) continue;
      const key = path.join('.');
      const set = tagged.get(key) ?? new Set<string>();
      set.add(name);
      tagged.set(key, set);
    }
  };
  const walk = (node: ts.Node, path: readonly string[]) => {
    let next = path;
    if (
      (ts.isPropertySignature(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isEnumMember(node)) &&
      node.name !== undefined
    ) {
      next = [...path, node.name.getText().replace(/^['"]|['"]$/g, '')];
      record(node, next);
    }
    ts.forEachChild(node, (child) => walk(child, next));
  };
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    for (const declaration of symbol.declarations ?? []) {
      // `export declare const x: …` documents the statement, not the variable declaration.
      const documented = ts.isVariableDeclaration(declaration)
        ? declaration.parent.parent
        : declaration;
      record(documented, [exported.name]);
      ts.forEachChild(declaration, (child) => walk(child, [exported.name]));
    }
  }
  return tagged;
}

const DECLARATION =
  /^export (?:declare )?(?:abstract )?(?:class|interface|type|function|const|let|var|enum|namespace) (\w+)/;
const MEMBER =
  /^((?: {4})+)(?:readonly |static |protected |abstract |get |set )*['"]?([\w$-]+)['"]?\??\s*[(:<=,]/;
/** What API Extractor writes about documentation, not about the API. */
const DOC_NOISE = /@public|\(undocumented\)|\(No @packageDocumentation comment for this package\)/g;

/**
 * Drops the doc comments, what only says whether an item is documented (a doc fix must not
 * change a report) and the `@public` every item has, and adds a `// @experimental` / `// @deprecated` line above each
 * item that has the tag.
 */
function annotate(report: string, tagged: Map<string, Set<string>>): string {
  const out: string[] = [];
  /** The path of the declaration, then of the inline object types, the line is in. */
  const stack: string[] = [];
  let inDocComment = false;
  for (const raw of report.split('\n')) {
    let line = raw;
    // Doc comments the declarations keep inside types (union members).
    if (inDocComment || /^\s*(?:\| )?\/\*\*/.test(line)) {
      const continued = inDocComment;
      inDocComment = !line.includes('*/');
      line = continued ? line.replace(/^.*?\*\/\s*/, '') : line.replace(/\/\*\*.*?\*\/\s*/, '');
      if (inDocComment || line.trim() === '') continue;
    }
    if (/^\s*\/\/ /.test(line) && DOC_NOISE.test(line)) {
      line = line
        .replace(DOC_NOISE, '')
        .replace(/\s+$/, '')
        .replace(/\/\/\s+/, '// ');
      if (/^\s*\/\/$/.test(line)) continue;
    }
    if (line === '' && out.at(-1) === '') continue;
    let key: string | undefined;
    const declaration = DECLARATION.exec(line);
    if (declaration?.[1] !== undefined) {
      stack.length = 0;
      stack.push(declaration[1]);
      key = declaration[1];
    } else {
      const member = MEMBER.exec(line);
      const depth = member?.[1] === undefined ? 0 : member[1].length / 4;
      if (member?.[2] !== undefined && depth <= stack.length) {
        stack.length = depth;
        key = [...stack, member[2]].join('.');
        if (/\{$/.test(line)) stack.push(member[2]);
      }
    }
    const tags = key === undefined ? undefined : tagged.get(key);
    if (tags !== undefined) {
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      for (const tag of [...tags].sort()) {
        // API Extractor writes `// @deprecated` itself.
        if (!out.at(-1)?.trimStart().startsWith(`// @${tag}`)) out.push(`${indent}// @${tag}`);
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

function run(update: boolean): number {
  const all = entries();
  const missing = all.filter((entry) => !existsSync(entry.dts));
  if (missing.length > 0) {
    for (const entry of missing) console.error(`missing ${relative(ROOT, entry.dts)}`);
    console.error('Run `pnpm build` first.');
    return 1;
  }
  const changed: string[] = [];
  const problems: string[] = [];
  for (const entry of all) {
    const label = `${entry.packageName}${entry.subpath === '.' ? '' : entry.subpath.slice(1)}`;
    const extractorConfig = ExtractorConfig.prepare({
      configObject: config(entry),
      configObjectFullPath: undefined,
      packageJsonFullPath: join(entry.packageDir, 'package.json'),
    });
    const messages: string[] = [];
    // Not a local build: API Extractor only writes the report to its temporary folder, and the
    // tags are added before it is compared with the committed one.
    Extractor.invoke(extractorConfig, {
      localBuild: false,
      messageCallback: (message: ExtractorMessage) => {
        message.handled = true;
        // The report's own messages are in the report; the console ones are about comparing it.
        if (message.category === ExtractorMessageCategory.Extractor) return;
        if (message.category === ExtractorMessageCategory.Console) return;
        if (
          message.logLevel !== ExtractorLogLevel.Error &&
          message.logLevel !== ExtractorLogLevel.Warning
        )
          return;
        messages.push(message.formatMessageWithLocation(`${ROOT}/`));
      },
    });
    const temp = extractorConfig.reportTempFilePath;
    if (messages.length > 0 || !existsSync(temp)) {
      problems.push(`${label}:\n  ${messages.join('\n  ') || 'API Extractor wrote no report'}`);
      continue;
    }
    const generated = annotate(
      readFileSync(temp, 'utf8').replaceAll('\r\n', '\n'),
      taggedDeclarations(entry),
    );
    writeFileSync(temp, generated);
    const committedPath = extractorConfig.reportFilePath;
    const committed = existsSync(committedPath)
      ? readFileSync(committedPath, 'utf8').replaceAll('\r\n', '\n')
      : undefined;
    if (committed === generated) continue;
    changed.push(relative(ROOT, committedPath));
    if (update) {
      mkdirSync(join(entry.packageDir, 'api'), { recursive: true });
      writeFileSync(committedPath, generated);
    } else if (committed === undefined) {
      console.error(`${relative(ROOT, committedPath)} is missing (${label})`);
    } else {
      spawnSync(
        'git',
        [
          'diff',
          '--no-index',
          '--no-color',
          '--',
          relative(ROOT, committedPath),
          relative(ROOT, temp),
        ],
        {
          cwd: ROOT,
          stdio: 'inherit',
        },
      );
    }
  }
  for (const problem of problems) console.error(problem);
  if (update) {
    console.log(
      changed.length > 0
        ? `Updated:\n  ${changed.join('\n  ')}`
        : `${all.length} API reports, none changed.`,
    );
    return problems.length > 0 ? 1 : 0;
  }
  if (changed.length > 0) {
    console.error(
      `\nThe API reports differ from the built declarations:\n  ${changed.join('\n  ')}\n` +
        'If the change is intended, run `pnpm api:update` and commit the reports ' +
        '(from 1.0 on, a removal or change in a report is a breaking change: docs/versioning.md).',
    );
  } else if (problems.length === 0) {
    console.log(`${all.length} API reports match the built declarations.`);
  }
  return changed.length > 0 || problems.length > 0 ? 1 : 0;
}

const mode = process.argv[2];
if (mode !== '--check' && mode !== '--update') {
  console.error('usage: tsx scripts/api-report.ts --check | --update');
  process.exit(2);
}
process.exit(run(mode === '--update'));

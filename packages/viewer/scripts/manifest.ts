/**
 * The Custom Elements Manifest of the viewer's elements (RFC 0001 §8), generated from the
 * sources, and the files generated from it.
 *
 *   pnpm --filter @kgdiff/viewer manifest            writes them
 *   pnpm --filter @kgdiff/viewer manifest --check    fails when a committed one differs
 *
 * `@custom-elements-manifest/analyzer` reads the element classes: their members, inheritance
 * and observed attributes. The sources say the rest, so nothing is patched by hand:
 *
 * - `@tagname` names an element class; `@experimental` marks it (and an interface member);
 * - the public interfaces in `src/index.ts` (`KgdiffViewerElement`, `KgdiffRootElement`, …) are
 *   the public surface: an element's members are those of the interface it implements, with
 *   the interface's descriptions;
 * - `KgdiffEventMap` lists the roots' events (`@defaultLayout`: `<kgdiff-viewer>`'s only);
 * - `@attr`, `@slot` and `@cssstate` on a class document attributes without a property, slots
 *   and custom states;
 * - the CSS custom properties of the roots are the theme's public tokens (`TOKENS`).
 *
 * The experimental status is carried as `experimental` (`true`, or the note) on a declaration
 * or a member, as the schema's `deprecated` is.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as analyzer from '@custom-elements-manifest/analyzer';
// The analyzer's own TypeScript (5.4), whose syntax tree it reads; `typescript` here is 7.
import ts from 'typescript5';
import { TOKENS, VERBATIM } from '../src/theme.js';

/** The analyzer's entry point (its types declare the plugin API only). */
const { create } = analyzer as unknown as {
  create(options: { modules: readonly ts.SourceFile[] }): unknown;
};

// ─── Manifest types (the subset of the schema written here) ─────────────────────────────

export interface Type {
  readonly text: string;
}

export interface Parameter {
  readonly name: string;
  readonly type?: Type;
  readonly optional?: boolean;
  readonly description?: string;
}

export interface Member {
  readonly kind: 'field' | 'method';
  readonly name: string;
  readonly type?: Type;
  readonly description?: string;
  readonly readonly?: boolean;
  readonly parameters?: readonly Parameter[];
  readonly return?: { readonly type?: Type };
  readonly attribute?: string;
  readonly experimental?: boolean | string;
}

export interface Attribute {
  readonly name: string;
  readonly fieldName?: string;
  readonly type?: Type;
  readonly description?: string;
  readonly experimental?: boolean | string;
}

export interface EventDoc {
  readonly name: string;
  readonly type: Type;
  readonly description?: string;
}

export interface Named {
  readonly name: string;
  readonly description?: string;
}

export interface CssProperty extends Named {
  readonly syntax?: string;
}

export interface Element {
  readonly kind: 'class';
  readonly customElement: true;
  readonly name: string;
  readonly tagName: string;
  readonly description: string;
  readonly experimental?: boolean | string;
  readonly attributes: readonly Attribute[];
  readonly members: readonly Member[];
  readonly events: readonly EventDoc[];
  readonly slots: readonly Named[];
  readonly cssProperties: readonly CssProperty[];
  readonly cssStates: readonly Named[];
}

export interface Module {
  readonly kind: 'javascript-module';
  readonly path: string;
  readonly declarations: readonly Element[];
  readonly exports: readonly {
    readonly kind: 'js' | 'custom-element-definition';
    readonly name: string;
    readonly declaration: { readonly name: string; readonly module: string };
  }[];
}

export interface Manifest {
  readonly schemaVersion: string;
  readonly readme: string;
  readonly modules: readonly Module[];
}

// ─── Reading the sources ────────────────────────────────────────────────────────────────

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(pkg, '..', '..');

/** The elements in the order the docs present them. */
export const ORDER = [
  'kgdiff-viewer',
  'kgdiff-root',
  'kgdiff-stage',
  'kgdiff-change-list',
  'kgdiff-change-detail',
  'kgdiff-search',
  'kgdiff-filters',
  'kgdiff-view-dock',
  'kgdiff-transport',
  'kgdiff-legend',
  'kgdiff-zoom',
  'kgdiff-minimap',
  'kgdiff-title',
  'kgdiff-actions',
] as const;

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(pkg, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

/** Paragraphs kept, lines within one joined. */
function tidy(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

interface Doc {
  readonly text: string;
  readonly tags: ReadonlyMap<string, readonly string[]>;
}

function docOf(node: ts.Node): Doc {
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  const doc = docs[docs.length - 1];
  const tags = new Map<string, string[]>();
  for (const tag of doc?.tags ?? []) {
    const list = tags.get(tag.tagName.text) ?? [];
    list.push(tidy(ts.getTextOfJSDocComment(tag.comment) ?? ''));
    tags.set(tag.tagName.text, list);
  }
  return { text: tidy(ts.getTextOfJSDocComment(doc?.comment) ?? ''), tags };
}

/** `true`, or the note after `@experimental`. */
function experimental(doc: Doc): boolean | string | undefined {
  const tag = doc.tags.get('experimental');
  if (!tag) return undefined;
  return tag[0] ? tag[0] : true;
}

/** `{type} name - description`, the form of `@attr`, `@slot` and `@cssstate`. */
function tagged(text: string): { name: string; type?: string; description?: string } {
  const m = /^(?:\{(.+?)\}\s+)?(\S+)(?:\s+-\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) throw new Error(`[manifest] cannot read the tag "${text}"`);
  const [, type, name = '', description] = m;
  return { name, ...(type ? { type } : {}), ...(description ? { description } : {}) };
}

const nameOf = (node: ts.PropertyName | ts.BindingName | undefined): string =>
  node ? node.getText().replace(/^['"]|['"]$/g, '') : '';

interface InterfaceDoc {
  readonly doc: Doc;
  readonly extends: readonly string[];
  readonly members: Map<string, Doc>;
}

interface ClassDoc {
  readonly name: string;
  readonly path: string;
  readonly doc: Doc;
  readonly tagName?: string;
  readonly superclass?: string;
  readonly implements?: string;
  /** What `observedAttributes` returns: names, or a constant's name. */
  readonly observed?: readonly string[] | string;
}

interface Sources {
  readonly interfaces: Map<string, InterfaceDoc>;
  readonly aliases: Map<string, readonly string[]>;
  readonly events: readonly (EventDoc & { readonly defaultLayout: boolean })[];
  readonly classes: Map<string, ClassDoc>;
  /** Constant arrays of strings (`ROOT_ATTRIBUTES`), spreads kept as `...NAME`. */
  readonly constants: Map<string, readonly string[]>;
}

const ELEMENT_FILES = (): string[] => [
  'src/element.ts',
  'src/root-element.ts',
  ...readdirSync(join(pkg, 'src/elements'))
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => `src/elements/${f}`),
];

function readSources(files: readonly ts.SourceFile[]): Sources {
  const interfaces = new Map<string, InterfaceDoc>();
  const aliases = new Map<string, readonly string[]>();
  const events: (EventDoc & { defaultLayout: boolean })[] = [];
  const classes = new Map<string, ClassDoc>();
  const constants = new Map<string, readonly string[]>();

  for (const file of [sourceFile('src/index.ts'), ...files]) {
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        const members = new Map<string, Doc>();
        for (const m of node.members) {
          const name = nameOf(m.name);
          const doc = docOf(m);
          const seen = members.get(name);
          if (!seen || (!seen.text && doc.text)) members.set(name, doc);
          if (node.name.text === 'KgdiffEventMap' && ts.isPropertySignature(m) && m.type) {
            events.push({
              name,
              type: { text: m.type.getText().replace(/\s+/g, ' ') },
              ...(doc.text ? { description: doc.text } : {}),
              defaultLayout: doc.tags.has('defaultLayout'),
            });
          }
        }
        interfaces.set(node.name.text, {
          doc: docOf(node),
          extends: (node.heritageClauses ?? []).flatMap((h) =>
            h.types.map((t) => t.expression.getText()),
          ),
          members,
        });
      } else if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)) {
        const values = node.type.types.map((t) =>
          ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null,
        );
        if (values.every((v) => v !== null)) aliases.set(node.name.text, values as string[]);
      } else if (ts.isVariableDeclaration(node) && node.initializer) {
        let init: ts.Expression = node.initializer;
        if (ts.isAsExpression(init)) init = init.expression;
        if (ts.isArrayLiteralExpression(init)) {
          const items = init.elements.map((e) =>
            ts.isStringLiteral(e)
              ? e.text
              : ts.isSpreadElement(e) && ts.isIdentifier(e.expression)
                ? `...${e.expression.text}`
                : null,
          );
          if (items.every((i) => i !== null)) constants.set(nameOf(node.name), items as string[]);
        }
      } else if (ts.isClassDeclaration(node) && node.name) {
        const doc = docOf(node);
        let superclass: string | undefined;
        let implemented: string | undefined;
        for (const h of node.heritageClauses ?? []) {
          const first = h.types[0]?.expression.getText();
          if (h.token === ts.SyntaxKind.ExtendsKeyword) superclass = first;
          else implemented = first;
        }
        let observed: readonly string[] | string | undefined;
        for (const m of node.members) {
          if (!ts.isGetAccessorDeclaration(m) || nameOf(m.name) !== 'observedAttributes') continue;
          const ret = m.body?.statements.find(ts.isReturnStatement)?.expression;
          if (ret && ts.isIdentifier(ret)) observed = ret.text;
          else if (ret && ts.isArrayLiteralExpression(ret)) {
            observed = ret.elements.filter(ts.isStringLiteral).map((e) => e.text);
          }
        }
        const tagName = doc.tags.get('tagname')?.[0];
        classes.set(node.name.text, {
          name: node.name.text,
          path: file.fileName,
          doc,
          ...(tagName ? { tagName } : {}),
          ...(superclass ? { superclass } : {}),
          ...(implemented ? { implements: implemented } : {}),
          ...(observed ? { observed } : {}),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { interfaces, aliases, events, classes, constants };
}

// ─── Building the manifest ──────────────────────────────────────────────────────────────

interface AnalyzedMember {
  kind: string;
  name: string;
  privacy?: string;
  static?: boolean;
  type?: Type;
  description?: string;
  readonly?: boolean;
  parameters?: { name: string; type?: Type; optional?: boolean; description?: string }[];
  return?: { type?: Type };
}

interface AnalyzedDeclaration {
  name: string;
  members?: AnalyzedMember[];
}

const camel = (name: string): string =>
  name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** The `dist` module an element's source compiles to. */
const distPath = (path: string): string => path.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');

export function buildManifest(): Manifest {
  const files = ELEMENT_FILES().map(sourceFile);
  const sources = readSources(files);
  const analyzed = create({ modules: files }) as {
    modules: { declarations?: AnalyzedDeclaration[] }[];
  };
  const declarations = new Map<string, AnalyzedDeclaration>();
  for (const m of analyzed.modules) {
    for (const d of m.declarations ?? []) declarations.set(d.name, d);
  }

  const chain = (start: string | undefined): ClassDoc[] => {
    const out: ClassDoc[] = [];
    for (let c = start ? sources.classes.get(start) : undefined; c; ) {
      out.push(c);
      c = c.superclass ? sources.classes.get(c.superclass.replace(/<.*$/, '')) : undefined;
    }
    return out;
  };
  const interfaceChain = (start: string | undefined): InterfaceDoc[] => {
    const out: InterfaceDoc[] = [];
    const walk = (name: string): void => {
      const i = sources.interfaces.get(name);
      if (!i || out.includes(i)) return;
      out.push(i);
      for (const e of i.extends) walk(e);
    };
    if (start) walk(start);
    return out;
  };
  const resolve = (items: readonly string[] | string): string[] => {
    const list = typeof items === 'string' ? (sources.constants.get(items) ?? []) : items;
    return list.flatMap((i) => (i.startsWith('...') ? resolve(i.slice(3)) : [i]));
  };

  const elements = [...sources.classes.values()].filter((c) => c.tagName);
  const modules: Module[] = [];
  for (const tagName of ORDER) {
    const cls = elements.find((c) => c.tagName === tagName);
    if (!cls) throw new Error(`[manifest] no class has @tagname ${tagName}`);
    const classes = chain(cls.name);
    const interfaces = interfaceChain(cls.implements);
    const publicDoc = (name: string): Doc | undefined => {
      for (const i of interfaces) {
        const d = i.members.get(name);
        if (d) return d;
      }
      return undefined;
    };
    const isRoot = interfaces.some((i) => i === sources.interfaces.get('KgdiffRootElement'));
    const isViewer = interfaces.some((i) => i === sources.interfaces.get('KgdiffViewerElement'));

    // Members: the interface's, as the class implements them.
    const members: Member[] = [];
    for (const m of declarations.get(cls.name)?.members ?? []) {
      if (m.static || m.privacy === 'private' || m.privacy === 'protected') continue;
      const doc = publicDoc(m.name);
      if (!doc) continue;
      const exp = experimental(doc);
      const description = doc.text || m.description;
      if (m.kind === 'method') {
        members.push({
          kind: 'method',
          name: m.name,
          ...(description ? { description: tidy(description) } : {}),
          ...(m.parameters
            ? {
                parameters: m.parameters.map((p) => ({
                  name: p.name,
                  ...(p.type ? { type: p.type } : {}),
                  ...(p.optional ? { optional: true } : {}),
                })),
              }
            : {}),
          ...(m.return?.type ? { return: { type: m.return.type } } : {}),
          ...(exp ? { experimental: exp } : {}),
        });
      } else {
        members.push({
          kind: 'field',
          name: m.name,
          ...(m.type ? { type: m.type } : {}),
          ...(description ? { description: tidy(description) } : {}),
          ...(m.readonly ? { readonly: true } : {}),
          ...(exp ? { experimental: exp } : {}),
        });
      }
    }

    // Attributes: what the element observes, then those documented with `@attr`.
    const observed = classes.find((c) => c.observed)?.observed;
    const attrTags = classes.flatMap((c) => (c.doc.tags.get('attr') ?? []).map(tagged));
    const names = [...(observed ? resolve(observed) : []), ...attrTags.map((t) => t.name)];
    const attributes: Attribute[] = [];
    for (const name of new Set(names)) {
      const tag = attrTags.find((t) => t.name === name);
      const fieldName = name === 'for' ? 'htmlFor' : camel(name);
      const field = members.find((m) => m.kind === 'field' && m.name === fieldName);
      const description = tag?.description ?? field?.description;
      const type = tag?.type ?? field?.type?.text;
      if (!description) throw new Error(`[manifest] ${tagName}: no description for ${name}`);
      attributes.push({
        name,
        ...(field ? { fieldName } : {}),
        ...(type ? { type: { text: type } } : {}),
        description,
        ...(field?.experimental ? { experimental: field.experimental } : {}),
      });
    }
    const withAttributes = members.map((m) => {
      const a = attributes.find((x) => x.fieldName === m.name);
      return a ? { ...m, attribute: a.name } : m;
    });

    const slots = cls.doc.tags.get('slot')?.map(tagged) ?? [];
    const cssStates = cls.doc.tags.get('cssstate')?.map(tagged) ?? [];
    const events: EventDoc[] = isRoot
      ? sources.events
          .filter((e) => isViewer || !e.defaultLayout)
          .map(({ defaultLayout: _, ...e }) => e)
      : [];
    const cssProperties: CssProperty[] = isRoot
      ? TOKENS.map(([token, path]) => ({
          name: `--kgdiff-${token}`,
          ...(VERBATIM.has(token) ? {} : { syntax: '<color>' }),
          description: `The theme's \`${path}\`.`,
        }))
      : [];

    const description = cls.doc.text || interfaces[0]?.doc.text;
    if (!description) throw new Error(`[manifest] ${tagName} has no description`);
    const exp = experimental(cls.doc);
    const element: Element = {
      kind: 'class',
      customElement: true,
      name: cls.name,
      tagName,
      description,
      ...(exp ? { experimental: exp } : {}),
      attributes,
      members: withAttributes,
      events,
      slots: slots.map(({ name, description: d }) => ({ name, ...(d ? { description: d } : {}) })),
      cssProperties,
      cssStates: cssStates.map(({ name, description: d }) => ({
        name,
        ...(d ? { description: d } : {}),
      })),
    };
    const path = distPath(cls.path);
    // `<kgdiff-viewer>` is defined by the package's main module; every other element by its own.
    const definedIn = tagName === 'kgdiff-viewer' ? 'dist/index.js' : path;
    modules.push({
      kind: 'javascript-module',
      path,
      declarations: [element],
      exports: [
        { kind: 'js', name: cls.name, declaration: { name: cls.name, module: path } },
        ...(definedIn === path
          ? [
              {
                kind: 'custom-element-definition' as const,
                name: tagName,
                declaration: { name: cls.name, module: path },
              },
            ]
          : []),
      ],
    });
    if (definedIn !== path) {
      modules.push({
        kind: 'javascript-module',
        path: definedIn,
        declarations: [],
        exports: [
          {
            kind: 'custom-element-definition',
            name: tagName,
            declaration: { name: cls.name, module: path },
          },
        ],
      });
    }
  }
  return {
    schemaVersion: '2.1.0',
    readme: 'README.md',
    modules,
  };
}

/** Every element of the manifest, in its order. */
export function elementsOf(manifest: Manifest): Element[] {
  return manifest.modules.flatMap((m) => m.declarations);
}

// ─── The generated files ────────────────────────────────────────────────────────────────

export interface Generated {
  /** From the repository's root. */
  readonly path: string;
  readonly content: string;
}

export function generate(): Generated[] {
  const manifest = buildManifest();
  return [
    {
      path: 'packages/viewer/custom-elements.json',
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
  ];
}

/** The generated files that differ from the committed ones. */
export function stale(): string[] {
  return generate()
    .filter((g) => {
      try {
        return readFileSync(join(repo, g.path), 'utf8') !== g.content;
      } catch {
        return true;
      }
    })
    .map((g) => g.path);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--check')) {
    const paths = stale();
    if (paths.length > 0) {
      console.error(
        `[manifest] out of date: ${paths.join(', ')}.\nRun: pnpm --filter @kgdiff/viewer manifest`,
      );
      process.exit(1);
    }
  } else {
    for (const g of generate()) writeFileSync(join(repo, g.path), g.content);
  }
}

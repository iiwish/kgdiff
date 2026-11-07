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

  const typeFiles = ['src/index.ts', '../core/src/types.ts', '../scene/src/types.ts'];
  for (const file of [...typeFiles.map(sourceFile), ...files]) {
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

/**
 * What an attribute's text can be: a property's string unions spelled out (`ViewerMode` →
 * `'overlay' | 'swipe' | 'replay'`), `boolean` or `number` as they are, anything else (an
 * object a property takes too, such as `panels`) `string`. `null` is the attribute's absence.
 */
function attributeType(
  text: string | undefined,
  aliases: ReadonlyMap<string, readonly string[]>,
): string | undefined {
  if (!text) return undefined;
  const parts = text
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p && p !== 'null' && p !== 'undefined')
    .flatMap((p) => aliases.get(p)?.map((v) => `'${v}'`) ?? [p]);
  if (parts.every((p) => /^'[^']*'$/.test(p))) return parts.join(' | ');
  if (parts.length === 1 && (parts[0] === 'boolean' || parts[0] === 'number')) return parts[0];
  return 'string';
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
      const type = attributeType(tag?.type ?? field?.type?.text, sources.aliases);
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

interface Words {
  readonly title: string;
  readonly intro: string;
  readonly experimental: (note: string) => string;
  readonly import: (tag: string, subpath: string | null) => string;
  readonly attributes: string;
  readonly properties: string;
  readonly methods: string;
  readonly events: string;
  readonly slots: string;
  readonly states: string;
  readonly tokens: string;
  readonly tokensIntro: string;
  readonly head: {
    readonly attribute: string;
    readonly property: string;
    readonly values: string;
    readonly type: string;
    readonly description: string;
    readonly method: string;
    readonly event: string;
    readonly detail: string;
    readonly slot: string;
    readonly state: string;
    readonly token: string;
    readonly syntax: string;
  };
  readonly readonly: string;
  readonly exp: string;
}

const EN: Words = {
  title: 'Viewer elements: reference',
  intro:
    'Every element of `@kgdiff/viewer`: its attributes and the properties they reflect, its ' +
    'other properties, methods, events, slots, CSS custom properties and custom states. ' +
    '[Viewer: interaction and API](interaction.md) explains how they work together, and ' +
    '[Embed the viewer](guide/viewer.md) has recipes.\n\n' +
    'The elements other than `<kgdiff-viewer>` are experimental in 0.6 and become stable in ' +
    '0.7: names, attributes and markup may change in a minor release until then. Editors can ' +
    "complete the tags and attributes from the package's " +
    '[custom data](guide/viewer.md#editor-support).',
  experimental: (note) => `**Experimental:** ${note}`,
  import: (tag, subpath) =>
    subpath
      ? `\`import '@kgdiff/viewer/elements/${subpath}'\` defines \`<${tag}>\` alone; \`import '@kgdiff/viewer'\` defines every element.`
      : `\`import '@kgdiff/viewer'\` defines \`<${tag}>\` (and every other element).`,
  attributes: 'Attributes',
  properties: 'Properties',
  methods: 'Methods',
  events: 'Events',
  slots: 'Slots',
  states: 'Custom states',
  tokens: 'CSS custom properties',
  tokensIntro:
    'Set on `<kgdiff-viewer>` and `<kgdiff-root>` (the elements inside a root inherit them; ' +
    "an element bound with `for` outside it adopts the root's built-in set). The canvas and " +
    'the panels both draw with them: [Theming](interaction.md#theming).',
  head: {
    attribute: 'Attribute',
    property: 'Property',
    values: 'Values',
    type: 'Type',
    description: 'Description',
    method: 'Method',
    event: 'Event',
    detail: '`detail`',
    slot: 'Slot',
    state: 'State',
    token: 'Property',
    syntax: 'Syntax',
  },
  readonly: 'read-only',
  exp: 'experimental',
};

const ZH: Words = {
  title: '查看器元素：参考',
  intro:
    '`@kgdiff/viewer` 的每个元素：它的 HTML 属性及其对应的 JavaScript 属性、其他 JavaScript ' +
    '属性、方法、事件、插槽、CSS 自定义属性和自定义状态。它们如何配合见' +
    '[查看器：交互与 API](interaction.md)，用法示例见[嵌入查看器](guide/viewer.md)。\n\n' +
    '除 `<kgdiff-viewer>` 外，这些元素在 0.6 中是实验性的，0.7 起稳定：在此之前，名称、属性和结构' +
    '可能在次版本中变化。\n\n' +
    '本页由源码生成（`packages/viewer/custom-elements.json`）。API 名称和说明直接取自源码的英文' +
    '文档注释，没有翻译：同一份说明只有一个来源，表格才能随源码自动更新、不会与英文版不一致。' +
    '编辑器可以按包里的[自定义数据](guide/viewer.md#编辑器支持)补全标签和属性。',
  experimental: (note) => `**实验性：** ${note}`,
  import: (tag, subpath) =>
    subpath
      ? `\`import '@kgdiff/viewer/elements/${subpath}'\` 只定义 \`<${tag}>\`；\`import '@kgdiff/viewer'\` 定义所有元素。`
      : `\`import '@kgdiff/viewer'\` 定义 \`<${tag}>\`（以及其他所有元素）。`,
  attributes: 'HTML 属性',
  properties: 'JavaScript 属性',
  methods: '方法',
  events: '事件',
  slots: '插槽',
  states: '自定义状态',
  tokens: 'CSS 自定义属性',
  tokensIntro:
    '设在 `<kgdiff-viewer>` 和 `<kgdiff-root>` 上（根元素内部的元素继承它们；在根元素之外用 `for` ' +
    '绑定的元素采用根元素的内置令牌集）。画布和各个面板都用它们绘制：见[主题](interaction.md#主题)。',
  head: {
    attribute: 'HTML 属性',
    property: 'JavaScript 属性',
    values: '取值',
    type: '类型',
    description: '说明',
    method: '方法',
    event: '事件',
    detail: '`detail`',
    slot: '插槽',
    state: '状态',
    token: '属性',
    syntax: '语法',
  },
  readonly: '只读',
  exp: '实验性',
};

/** A table cell: pipes escaped, paragraphs kept, `<` outside code made text. */
function cell(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('')
    .replace(/\|/g, '\\|')
    .replace(/\n\n/g, '<br><br>');
}

const code = (text: string): string => `\`${text}\``;

function table(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(head), line(head.map(() => '---')), ...rows.map(line)].join('\n');
}

/** The element subpath that defines `tag` alone (`null`: the main entry only). */
const subpathOf = (path: string): string | null => {
  const m = /^dist\/elements\/([\w-]+)\.js$/.exec(path);
  return m?.[1] ?? null;
};

/** `name(a: A, b?: B): R` */
function signature(m: Member): string {
  const params = (m.parameters ?? [])
    .map((p) => `${p.name}${p.optional ? '?' : ''}${p.type ? `: ${p.type.text}` : ''}`)
    .join(', ');
  return `${m.name}(${params})${m.return?.type ? `: ${m.return.type.text}` : ''}`;
}

function referencePage(manifest: Manifest, w: Words, generatedFrom: string): string {
  const out: string[] = [`# ${w.title}`, `<!-- ${generatedFrom} -->`, w.intro];
  const elements = manifest.modules.flatMap((m) =>
    m.declarations.map((d) => ({ element: d, path: m.path })),
  );
  out.push(
    elements.map(({ element }) => `- [\`<${element.tagName}>\`](#${element.tagName})`).join('\n'),
  );
  for (const { element: e, path } of elements) {
    out.push(`<a id="${e.tagName}"></a>\n\n## \`<${e.tagName}>\``);
    if (e.experimental) {
      out.push(w.experimental(typeof e.experimental === 'string' ? e.experimental : ''));
    }
    out.push(cell(e.description).replace(/<br><br>/g, '\n\n'));
    out.push(w.import(e.tagName, subpathOf(path)));
    const flag = (x: { experimental?: boolean | string }): string =>
      x.experimental ? ` (${w.exp})` : '';
    if (e.attributes.length > 0) {
      out.push(`### ${w.attributes}`);
      out.push(
        table(
          [w.head.attribute, w.head.property, w.head.values, w.head.description],
          e.attributes.map((a) => [
            code(a.name),
            a.fieldName ? code(a.fieldName) : '',
            a.type ? cell(code(a.type.text)) : '',
            cell(a.description ?? '') + flag(a),
          ]),
        ),
      );
    }
    const props = e.members.filter((m) => m.kind === 'field' && !m.attribute);
    if (props.length > 0) {
      out.push(`### ${w.properties}`);
      out.push(
        table(
          [w.head.property, w.head.type, w.head.description],
          props.map((m) => [
            code(m.name) + (m.readonly ? ` (${w.readonly})` : ''),
            m.type ? cell(code(m.type.text)) : '',
            cell(m.description ?? '') + flag(m),
          ]),
        ),
      );
    }
    const methods = e.members.filter((m) => m.kind === 'method');
    if (methods.length > 0) {
      out.push(`### ${w.methods}`);
      out.push(
        table(
          [w.head.method, w.head.description],
          methods.map((m) => [cell(code(signature(m))), cell(m.description ?? '') + flag(m)]),
        ),
      );
    }
    if (e.events.length > 0) {
      out.push(`### ${w.events}`);
      out.push(
        table(
          [w.head.event, w.head.detail, w.head.description],
          e.events.map((ev) => [
            code(ev.name),
            cell(code(ev.type.text.replace(/^CustomEvent<([\s\S]*)>$/, '$1'))),
            cell(ev.description ?? ''),
          ]),
        ),
      );
    }
    if (e.slots.length > 0) {
      out.push(`### ${w.slots}`);
      out.push(
        table(
          [w.head.slot, w.head.description],
          e.slots.map((sl) => [code(sl.name), cell(sl.description ?? '')]),
        ),
      );
    }
    if (e.cssStates.length > 0) {
      out.push(`### ${w.states}`);
      out.push(
        table(
          [w.head.state, w.head.description],
          e.cssStates.map((st) => [code(`:state(${st.name})`), cell(st.description ?? '')]),
        ),
      );
    }
  }
  const tokens = elements.find(({ element }) => element.cssProperties.length > 0)?.element;
  if (tokens) {
    out.push(`<a id="tokens"></a>\n\n## ${w.tokens}`);
    out.push(w.tokensIntro);
    out.push(
      table(
        [w.head.token, w.head.syntax, w.head.description],
        tokens.cssProperties.map((t) => [
          code(t.name),
          t.syntax ? code(t.syntax) : '',
          cell(t.description ?? ''),
        ]),
      ),
    );
  }
  return `${out.join('\n\n')}\n`;
}

const REFERENCE = 'https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md';

/** An experimental part's description, said first. */
const marked = (x: { experimental?: boolean | string }, description: string): string => {
  if (!x.experimental) return description;
  const note = typeof x.experimental === 'string' ? ` ${x.experimental}` : '';
  return `**Experimental:**${note} ${description}`;
};

/** The literal values of an attribute's type (`'a' | 'b'`), if it has only those. */
function valuesOf(type: Type | undefined): string[] | null {
  const parts = type?.text.split('|').map((p) => p.trim()) ?? [];
  if (parts.length === 0 || !parts.every((p) => /^'[^']*'$/.test(p))) return null;
  return parts.map((p) => p.slice(1, -1));
}

/**
 * VS Code's HTML custom data (`html.customData`): every tag and its attributes, with their
 * values, so the editor completes and describes them.
 */
function customData(manifest: Manifest): string {
  const tags = elementsOf(manifest).map((e) => ({
    name: e.tagName,
    description: { kind: 'markdown', value: marked(e, e.description) },
    attributes: e.attributes.map((a) => {
      const values = valuesOf(a.type);
      return {
        name: a.name,
        description: { kind: 'markdown', value: marked(a, a.description ?? '') },
        ...(a.type?.text === 'boolean' ? { valueSet: 'v' } : {}),
        ...(values ? { values: values.map((name) => ({ name })) } : {}),
      };
    }),
    references: [{ name: 'Reference', url: `${REFERENCE}#${e.tagName}` }],
  }));
  return `${JSON.stringify({ version: 1.1, tags }, null, 2)}\n`;
}

/** A TSDoc comment, indented, its lines wrapped at 100 columns. */
function tsdoc(text: string, indent: string): string {
  const width = 100 - indent.length - 3;
  const lines: string[] = [];
  text.split('\n\n').forEach((para, i) => {
    if (i > 0) lines.push('');
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (line && line.length + word.length + 1 > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
  });
  return [
    `${indent}/**`,
    ...lines.map((l) => `${indent} *${l ? ` ${l}` : ''}`),
    `${indent} */`,
  ].join('\n');
}

/**
 * React 19's JSX types for the elements (`src/react.ts`): the properties a page sets (React
 * sets a prop as the property when the element has one, as an attribute otherwise), the
 * attributes without a property, and the roots' events as React listens to them
 * (`onkgdiff-select`).
 */
function reactTypes(manifest: Manifest): string {
  const names = new Set<string>();
  const blocks: string[] = [];
  for (const e of elementsOf(manifest)) {
    const lines: string[] = [];
    for (const m of e.members) {
      if (m.kind !== 'field' || m.readonly || !m.type) continue;
      const attr = e.attributes.find((a) => a.fieldName === m.name);
      // A property that takes its attribute's text too (`panels`, `keymap`).
      const own = `Tag<'${e.tagName}'>['${m.name}']`;
      const type =
        attr?.type?.text === 'string' && !/\bstring\b/.test(m.type.text) ? `${own} | string` : own;
      lines.push(tsdoc(marked(m, m.description ?? ''), '        '));
      lines.push(`        ${m.name}?: ${type};`);
    }
    for (const a of e.attributes.filter((x) => !x.fieldName)) {
      lines.push(tsdoc(marked(a, a.description ?? ''), '        '));
      const key = /^[a-z]\w*$/i.test(a.name) ? a.name : `'${a.name}'`;
      lines.push(`        ${key}?: ${a.type?.text ?? 'string'};`);
    }
    for (const ev of e.events) {
      lines.push(tsdoc(ev.description ?? '', '        '));
      lines.push(`        'on${ev.name}'?: (event: KgdiffEventMap['${ev.name}']) => void;`);
    }
    if (e.events.length > 0) names.add('KgdiffEventMap');
    const doc = tsdoc(marked(e, `\`<${e.tagName}>\`: ${REFERENCE}#${e.tagName}`), '      ');
    blocks.push(
      `${doc}\n      '${e.tagName}': Props<'${e.tagName}'> & {\n${lines.join('\n')}\n      };`,
    );
  }
  const imports = [...names].sort();
  return `/**
 * React 19's JSX types for the viewer's elements (RFC 0001 §8). Generated from
 * custom-elements.json by scripts/manifest.ts: do not edit; run
 * \`pnpm --filter @kgdiff/viewer manifest\` after changing the sources.
 *
 * A TypeScript project with React 19 enables them once, anywhere:
 *
 *   import type {} from '@kgdiff/viewer/react';
 *
 * Props are the elements' properties (React 19 sets a prop as the property the element has,
 * and as an attribute otherwise), their attributes without a property, and the roots' events
 * as React 19 listens to them: \`onkgdiff-select\`. Methods go through a \`ref\`.
 *
 * @experimental In 0.6; stable from 0.7 (RFC 0001, decision 7), as the elements it describes.
 */
import type { HTMLAttributes, Ref } from 'react';
import type { ${imports.join(', ')} } from './index.js';

/** The element of a tag: a prop's type is its property's. */
type Tag<T extends keyof HTMLElementTagNameMap> = HTMLElementTagNameMap[T];

/** What every element takes: React's HTML attributes and a ref to the element. */
type Props<T extends keyof HTMLElementTagNameMap> = HTMLAttributes<Tag<T>> & { ref?: Ref<Tag<T>> };

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
${blocks.join('\n')}
    }
  }
}
`;
}

const GENERATED =
  'Generated from packages/viewer/custom-elements.json by packages/viewer/scripts/manifest.ts: ' +
  'do not edit. Run `pnpm --filter @kgdiff/viewer manifest` after changing the sources.';

export function generate(): Generated[] {
  const manifest = buildManifest();
  return [
    {
      path: 'packages/viewer/custom-elements.json',
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    { path: 'docs/viewer-elements.md', content: referencePage(manifest, EN, GENERATED) },
    { path: 'docs/zh/viewer-elements.md', content: referencePage(manifest, ZH, GENERATED) },
    { path: 'packages/viewer/vscode.html-custom-data.json', content: customData(manifest) },
    { path: 'packages/viewer/src/react.ts', content: reactTypes(manifest) },
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

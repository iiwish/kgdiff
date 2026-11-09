/**
 * JSON graph dialects → `GraphInput`.
 *
 * Supported shapes (auto-detected, reported as `dialect`):
 *  - `kgdiff`      `{ nodes: [{ id, label, type, aliases, attrs, … }], edges: [{ source, target, predicate, … }] }`,
 *                  recognised for certain by its optional marker `format: 'kgdiff.graph', version: 1`
 *  - `d3`          `{ nodes, links }`, link ends as id, index or node object (also NetworkX node-link)
 *  - `cytoscape`   `{ elements: { nodes, edges } }`, `{ elements: [{ group, data }] }` or a bare element array
 *  - `g6`          AntV G6 v5 `{ nodes: [{ id, data, style }], edges: [{ source, target, data }], combos }`
 *  - `graphology`  serialized `{ nodes: [{ key, attributes }], edges: [{ key, source, target, attributes }] }`
 *  - `vis`         vis-network `{ nodes, edges: [{ from, to }] }`
 *
 * JSON-LD documents never get here: `parseGraph` reads them as RDF (`jsonld.ts`).
 */
import type { EdgeInput, GraphInput, GraphMeta, NodeInput, Point } from '@kgdiff/core';
import { KgdiffError } from '@kgdiff/core';
import type { JsonDialect, JsonOptions } from './index.js';
import {
  AttrBag,
  assertNever,
  compareStrings,
  getOwn,
  invalidInput,
  isRecord,
  lineAndColumn,
  MAX_NESTING,
  makeEdge,
  makeMeta,
  makeNode,
  plural,
  setOwn,
  sortEdges,
  sortNodes,
  stripBom,
  toAttrValue,
  type Warnings,
} from './shared.js';

export interface JsonParseOutput {
  readonly graph: GraphInput;
  readonly dialect: JsonDialect;
  /** kgdiff JSON only: `meta.predicateLabels`, when it maps strings to strings. */
  readonly predicateLabels: Readonly<Record<string, string>>;
}

type JsonRecord = Record<string, unknown>;

/**
 * Maps a parsed JSON graph (see `parseJsonText`) in any supported dialect. Throws
 * `KgdiffError('invalid-input')` for unrecognised shapes.
 */
export function parseJson(
  data: unknown,
  options: JsonOptions | undefined,
  warnings: Warnings,
): JsonParseOutput {
  const shape = detectShape(data);
  const mapper = new JsonMapper(shape, options?.fields ?? {}, warnings);
  // Nodes first: d3 links may reference nodes by index.
  const nodes = sortNodes(mapper.nodes());
  const edges = sortEdges(mapper.edges());
  mapper.reportDropped();
  const graph: GraphInput = { nodes, edges };
  const meta = graphMeta(shape, nonFiniteCounter(warnings));
  const labels = meta?.predicateLabels;
  const predicateLabels =
    isRecord(labels) && Object.values(labels).every((label) => typeof label === 'string')
      ? (labels as Record<string, string>)
      : {};
  return { graph: meta ? { ...graph, meta } : graph, dialect: shape.dialect, predicateLabels };
}

/**
 * `JSON.parse`, with line / column in the `KgdiffError('invalid-input')` on bad input. A lone
 * surrogate escape (`"\ud83d"` without its other half), which `JSON.parse` accepts, is bad
 * input too: kgdiff's text is well-formed Unicode in every implementation (RFC 0002, D-2).
 */
export function parseJsonText(text: string): unknown {
  const source = stripBom(text);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    // Engines word (and locate) JSON errors differently; find the position ourselves.
    const { offset, expected, lone } = locateJsonError(source);
    const at = lineAndColumn(source, offset);
    const found = offset < source.length ? JSON.stringify(source[offset]) : 'end of input';
    const reason = lone
      ? loneSurrogateReason(source, offset)
      : expected
        ? `expected ${expected}, found ${found}`
        : String(error);
    throw invalidInput(`Invalid JSON on line ${at.line}, column ${at.column}: ${reason}.`, at);
  }
  const lone = loneSurrogateEscape(source);
  if (lone !== -1) {
    const at = lineAndColumn(source, lone);
    throw invalidInput(
      `Invalid JSON on line ${at.line}, column ${at.column}: ${loneSurrogateReason(source, lone)}.`,
      at,
    );
  }
  return value;
}

/** Why the escape at `offset` is refused (without the position or a final period). */
export function loneSurrogateReason(text: string, offset: number): string {
  return `the escape ${text.slice(offset, offset + 6)} is a lone surrogate (half of a UTF-16 pair), which kgdiff does not accept`;
}

/** The UTF-16 unit of the four hex digits at `at`, or -1 when they are not four hex digits. */
function hexUnit(text: string, at: number): number {
  const digits = text.slice(at, at + 4);
  return /^[0-9a-fA-F]{4}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
}

/**
 * The length of the escape sequence `\u…` at `at` (its backslash) when it is not a lone
 * surrogate: 6, or 12 for an escaped surrogate pair; 0 when it is one. `\u` must be followed
 * by four hex digits.
 */
function unicodeEscapeLength(text: string, at: number): number {
  const unit = hexUnit(text, at + 2);
  if (unit < 0xd800 || unit > 0xdfff) return 6;
  if (unit <= 0xdbff && text[at + 6] === '\\' && text[at + 7] === 'u') {
    const low = hexUnit(text, at + 8);
    if (low >= 0xdc00 && low <= 0xdfff) return 12;
  }
  return 0;
}

/**
 * Offset of the first lone surrogate escape in valid JSON text, or -1. In valid JSON a
 * backslash only occurs inside a string, so no tokenizing is needed.
 */
export function loneSurrogateEscape(text: string): number {
  // Fast path: no `\uD800`–`\uDFFF` escape at all.
  if (!/\\u[dD][89a-fA-F]/.test(text)) return -1;
  for (let i = text.indexOf('\\'); i !== -1; i = text.indexOf('\\', i)) {
    if (text[i + 1] !== 'u') {
      i += 2;
      continue;
    }
    const length = unicodeEscapeLength(text, i);
    if (length === 0) return i;
    i += length;
  }
  return -1;
}

/** Internal signal of `locateJsonError`; never escapes this module. */
class JsonSyntaxError {
  constructor(
    readonly offset: number,
    readonly expected: string,
    readonly lone = false,
  ) {}
}

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_ESCAPE = /["\\/bfnrt]|u[0-9a-fA-F]{4}/y;

/**
 * Finds the first syntax error in invalid JSON text (RFC 8259) and what was expected there, or
 * the first lone surrogate escape (`lone`) when it comes first. Only runs after `JSON.parse`
 * failed, so it favours clarity over speed.
 */
function locateJsonError(text: string): {
  offset: number;
  expected: string | undefined;
  lone: boolean;
} {
  let i = 0;
  const fail = (expected: string): never => {
    throw new JsonSyntaxError(i, expected);
  };
  const space = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i] ?? '')) i++;
  };
  const string = () => {
    i++;
    for (;;) {
      const c = text[i];
      if (c === undefined) fail('a closing quote');
      else if (c === '"') {
        i++;
        return;
      } else if (c === '\\') {
        const start = i;
        i++;
        JSON_ESCAPE.lastIndex = i;
        if (!JSON_ESCAPE.test(text)) fail('an escape sequence');
        if (text[i] === 'u') {
          // An escaped surrogate pair is one escape; half of one is refused (RFC 0002, D-2).
          const length = unicodeEscapeLength(text, start);
          if (length === 0) throw new JsonSyntaxError(start, '', true);
          i = start + length;
        } else i = JSON_ESCAPE.lastIndex;
      } else if (c < ' ') fail('an escaped control character');
      else i++;
    }
  };
  const value = (depth: number): void => {
    space();
    const c = text[i];
    if ((c === '{' || c === '[') && depth >= MAX_NESTING) {
      const at = lineAndColumn(text, i);
      throw invalidInput(
        `Invalid JSON on line ${at.line}, column ${at.column}: nested deeper than ${MAX_NESTING} levels.`,
        at,
      );
    }
    if (c === '{') {
      i++;
      space();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        space();
        if (text[i] !== '"') fail('a property name in double quotes');
        string();
        space();
        if (text[i] !== ':') fail("':'");
        i++;
        value(depth + 1);
        space();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return;
        } else fail("',' or '}'");
      }
    }
    if (c === '[') {
      i++;
      space();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        value(depth + 1);
        space();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return;
        } else fail("',' or ']'");
      }
    }
    if (c === '"') {
      string();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return;
      }
    }
    JSON_NUMBER.lastIndex = i;
    if (JSON_NUMBER.test(text)) {
      i = JSON_NUMBER.lastIndex;
      return;
    }
    fail('a value');
  };
  try {
    value(0);
    space();
    if (i < text.length) fail('end of input');
  } catch (error) {
    if (error instanceof JsonSyntaxError) return error;
    throw error;
  }
  return { offset: text.length, expected: undefined, lone: false };
}

// ─── Shape detection ────────────────────────────────────────────────────────

interface Shape {
  readonly dialect: JsonDialect;
  readonly root: JsonRecord | undefined;
  readonly nodes: readonly unknown[];
  readonly edges: readonly unknown[];
  /** Name of the edge array in the source, for error messages. */
  readonly edgesKey: string;
  readonly nodesKey: string;
}

/** Top-level keys of AntV G6 v5 nodes / combos and edges. */
const G6_NODE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'data',
  'style',
  'states',
  'combo',
  'children',
  'depth',
]);
const G6_EDGE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'source',
  'target',
  'type',
  'data',
  'style',
  'states',
]);

const SHAPES_HELP =
  'expected { nodes, edges } (kgdiff, AntV G6, graphology, vis-network), { nodes, links } (d3, ' +
  'NetworkX) or { elements } (Cytoscape.js)';

/**
 * Reads the kgdiff JSON marker: true for `kgdiff.graph` version 1, false when there is none.
 * Only `kgdiff.*` formats are kgdiff's; any other `format` value is left to shape detection.
 */
function hasGraphMarker(data: JsonRecord): boolean {
  const format = getOwn(data, 'format');
  if (typeof format !== 'string' || !format.startsWith('kgdiff.')) return false;
  switch (format) {
    case 'kgdiff.graph':
      break;
    case 'kgdiff.diff':
      throw new KgdiffError(
        'unsupported-version',
        'This is a kgdiff diff (format "kgdiff.diff", as `kgdiff --json` writes it), not a graph.',
        { format },
      );
    case 'kgdiff.delta':
      throw new KgdiffError(
        'unsupported-version',
        'This is a kgdiff delta (format "kgdiff.delta"), not a graph: apply it to a graph with `kgdiff apply`.',
        { format },
      );
    default:
      throw new KgdiffError(
        'unsupported-version',
        `Unknown kgdiff format "${format}"; expected "kgdiff.graph".`,
        { format },
      );
  }
  const version = getOwn(data, 'version');
  if (version !== 1) {
    throw new KgdiffError(
      'unsupported-version',
      `Unsupported kgdiff graph version ${String(version)}; this reader supports version 1.`,
      { version },
    );
  }
  return true;
}

function detectShape(data: unknown): Shape {
  if (isRecord(data) && hasGraphMarker(data)) {
    if (!Array.isArray(data.nodes)) throw invalidInput('A kgdiff graph needs a `nodes` array.');
    const edges = arrayField(data, 'edges');
    return {
      dialect: 'kgdiff',
      root: data,
      nodes: data.nodes,
      edges,
      nodesKey: 'nodes',
      edgesKey: 'edges',
    };
  }
  if (Array.isArray(data)) {
    if (data.length > 0 && data.every((element) => isRecord(element) && isRecord(element.data))) {
      return cytoscapeShape(undefined, data);
    }
    throw invalidInput(`Unrecognized JSON graph: got an array; ${SHAPES_HELP}.`);
  }
  if (!isRecord(data)) throw invalidInput(`Unrecognized JSON graph: ${SHAPES_HELP}.`);
  if ('elements' in data) return cytoscapeShape(data, data.elements);

  const nodes = data.nodes;
  if (!Array.isArray(nodes)) {
    throw invalidInput(
      `Unrecognized JSON graph: ${'nodes' in data ? '`nodes` is not an array' : 'no `nodes` array'}; ${SHAPES_HELP}.`,
    );
  }
  if ('links' in data) {
    return {
      dialect: 'd3',
      root: data,
      nodes,
      edges: arrayField(data, 'links'),
      nodesKey: 'nodes',
      edgesKey: 'links',
    };
  }
  const edges = 'edges' in data ? arrayField(data, 'edges') : [];
  const base = { root: data, nodes, edges, nodesKey: 'nodes', edgesKey: 'edges' };
  const records = (list: readonly unknown[]) => list.filter(isRecord);
  const has = (element: JsonRecord, key: string) => Object.hasOwn(element, key);
  if (records(edges).some((edge) => has(edge, 'from') && has(edge, 'to') && !has(edge, 'source'))) {
    return { ...base, dialect: 'vis' };
  }
  if (records(nodes).some((node) => has(node, 'key') && !has(node, 'id'))) {
    return { ...base, dialect: 'graphology' };
  }
  const nodeRecords = records(nodes);
  if (
    nodeRecords.length > 0 &&
    nodeRecords.every((node) => !has(node, 'id') && isRecord(node.data) && has(node.data, 'id'))
  ) {
    return { ...base, dialect: 'cytoscape' };
  }
  const combos = Array.isArray(data.combos) ? data.combos : [];
  const comboRecords = records(combos);
  const edgeRecords = records(edges);
  const wrapped = [...nodeRecords, ...edgeRecords, ...comboRecords].some(
    (element) => isRecord(element.data) || isRecord(element.style),
  );
  // G6 v5 elements have nothing but these keys; any other key (label, predicate, attrs,
  // types, …) means native kgdiff JSON that merely has a `data` or `style` attribute.
  const only = (list: readonly JsonRecord[], allowed: ReadonlySet<string>) =>
    list.every((element) => Object.keys(element).every((key) => allowed.has(key)));
  if (
    wrapped &&
    only(nodeRecords, G6_NODE_KEYS) &&
    only(edgeRecords, G6_EDGE_KEYS) &&
    only(comboRecords, G6_NODE_KEYS)
  ) {
    return { ...base, nodes: [...nodes, ...combos], dialect: 'g6' };
  }
  return { ...base, dialect: 'kgdiff' };
}

function cytoscapeShape(root: JsonRecord | undefined, elements: unknown): Shape {
  if (Array.isArray(elements)) {
    const nodes: unknown[] = [];
    const edges: unknown[] = [];
    for (const element of elements) {
      const group = isRecord(element) ? element.group : undefined;
      const data = isRecord(element) ? element.data : undefined;
      const isEdge =
        group === 'edges' ||
        (group !== 'nodes' && isRecord(data) && 'source' in data && 'target' in data);
      (isEdge ? edges : nodes).push(element);
    }
    return { dialect: 'cytoscape', root, nodes, edges, nodesKey: 'elements', edgesKey: 'elements' };
  }
  if (isRecord(elements)) {
    return {
      dialect: 'cytoscape',
      root,
      nodes: Array.isArray(elements.nodes) ? elements.nodes : [],
      edges: Array.isArray(elements.edges) ? elements.edges : [],
      nodesKey: 'elements.nodes',
      edgesKey: 'elements.edges',
    };
  }
  throw invalidInput(
    'Cytoscape.js `elements` must be an array or an object with `nodes` / `edges`.',
  );
}

function arrayField(data: JsonRecord, key: string): readonly unknown[] {
  const value = data[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidInput(`\`${key}\` must be an array.`);
  return value;
}

/**
 * Counts the numbers beyond the double range that `toAttrValue` keeps as strings, for one
 * `json-non-finite` warning per parse (RFC 0002, D-11).
 */
function nonFiniteCounter(warnings: Warnings): () => void {
  return () =>
    warnings.count(
      'json-non-finite',
      (n) =>
        `Kept ${plural(n, 'number')} beyond the range of a double (such as 1e400) as the string "Infinity" or "-Infinity".`,
    );
}

function graphMeta(shape: Shape, onNonFinite: () => void): GraphMeta | undefined {
  const root = shape.root;
  if (!root) return undefined;
  if (shape.dialect === 'kgdiff') {
    if (!isRecord(root.meta)) return undefined;
    const meta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(root.meta)) {
      setOwn(meta, key, toAttrValue(value, 0, onNonFinite));
    }
    return makeMeta(meta);
  }
  const source =
    shape.dialect === 'graphology'
      ? root.attributes
      : shape.dialect === 'd3'
        ? root.graph
        : shape.dialect === 'cytoscape'
          ? root.data
          : undefined;
  if (!isRecord(source)) return undefined;
  const text = (value: unknown) =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  return makeMeta({ name: text(source.name), version: text(source.version) });
}

// ─── Element mapping ────────────────────────────────────────────────────────

/** Rendering / simulation state that would only add noise to a diff. */
const IGNORED_KEYS: Readonly<
  Record<JsonDialect, { nodes: ReadonlySet<string>; edges: ReadonlySet<string> }>
> = {
  kgdiff: { nodes: new Set(), edges: new Set() },
  d3: { nodes: new Set(['index', 'x', 'y', 'vx', 'vy', 'fx', 'fy']), edges: new Set(['index']) },
  // Cytoscape desktop session ids and selection state.
  cytoscape: { nodes: new Set(['SUID', 'selected']), edges: new Set(['SUID', 'selected']) },
  g6: { nodes: new Set(), edges: new Set() },
  graphology: {
    nodes: new Set(['x', 'y', 'size', 'color', 'hidden', 'forceLabel', 'zIndex', 'highlighted']),
    edges: new Set(['size', 'color', 'hidden', 'forceLabel', 'zIndex']),
  },
  vis: {
    nodes: new Set([
      'x',
      'y',
      'fixed',
      'physics',
      'shape',
      'color',
      'size',
      'font',
      'borderWidth',
      'borderWidthSelected',
      'image',
      'brokenImage',
      'shadow',
      'margin',
      'widthConstraint',
      'heightConstraint',
      'level',
      'mass',
      'hidden',
      'opacity',
      'chosen',
      'icon',
      'scaling',
      'shapeProperties',
      'imagePadding',
      'labelHighlightBold',
    ]),
    edges: new Set([
      'arrows',
      'arrowStrikethrough',
      'color',
      'dashes',
      'width',
      'smooth',
      'physics',
      'hidden',
      'length',
      'font',
      'chosen',
      'endPointOffset',
      'hoverWidth',
      'selectionWidth',
      'shadow',
      'scaling',
      'background',
      'widthConstraint',
      'selfReference',
      'labelHighlightBold',
    ]),
  },
};

type Fields = NonNullable<JsonOptions['fields']>;

/**
 * One JSON element: the raw object and the record that holds its properties (`data` for
 * Cytoscape / G6, `attributes` for graphology, the element itself otherwise). Tracks which
 * keys were mapped, so unmapped record keys become attrs and unmapped raw keys are reported.
 */
class ElementReader {
  private readonly consumed = new Set<string>();
  private readonly consumedRaw = new Set<string>();

  constructor(
    readonly raw: JsonRecord,
    readonly record: JsonRecord,
    /** Raw key holding the record, or undefined when the record is the element itself. */
    private readonly container: string | undefined,
    private readonly ignored: ReadonlySet<string>,
  ) {}

  /** Marks a record key as mapped, so it does not reappear in attrs. */
  consume(key: string): void {
    this.consumed.add(key);
    if (this.container === undefined) this.consumedRaw.add(key);
  }

  /** Reads (and marks as mapped) a key of the raw element, outside the record. */
  rawValue(key: string): unknown {
    this.consumedRaw.add(key);
    if (this.container === undefined) this.consumed.add(key);
    return getOwn(this.raw, key);
  }

  /** First of `keys` holding a usable value (per `accept`); that key is consumed. */
  first<T>(keys: readonly string[], accept: (value: unknown) => T | undefined): T | undefined {
    for (const key of keys) {
      const value = accept(getOwn(this.record, key));
      if (value !== undefined) {
        this.consume(key);
        return value;
      }
    }
    return undefined;
  }

  /** Value at a dotted path, looked up in the record, then in the raw element. */
  path<T>(path: string, accept: (value: unknown) => T | undefined): T | undefined {
    const top = path.split('.')[0] ?? path;
    const inRecord = accept(getPath(this.record, path));
    if (inRecord !== undefined) {
      if (top === path) this.consume(path);
      return inRecord;
    }
    const inRaw = accept(getPath(this.raw, path));
    if (inRaw !== undefined) this.consumedRaw.add(top);
    return inRaw;
  }

  /** Remaining record keys as attributes (JSON values only, object keys sorted). */
  rest(into: AttrBag, onNonFinite: () => void): void {
    for (const key of Object.keys(this.record)) {
      if (this.consumed.has(key) || this.ignored.has(key)) continue;
      const value = toAttrValue(this.record[key], 0, onNonFinite);
      if (value !== undefined) into.add(key, value);
    }
  }

  /** Keys that did not make it into the graph: rendering state and unmapped raw keys. */
  dropped(): string[] {
    const keys = Object.keys(this.record).filter(
      (key) => this.ignored.has(key) && !this.consumed.has(key),
    );
    if (this.container !== undefined) {
      for (const key of Object.keys(this.raw)) {
        if (key !== this.container && !this.consumedRaw.has(key)) keys.push(key);
      }
    }
    return keys;
  }
}

/** G6 v5 keeps the visible label in `style.labelText`. */
function g6Label(reader: ElementReader): string | undefined {
  const label = asText(asRecord(getOwn(reader.raw, 'style'))?.labelText);
  if (label !== undefined) reader.rawValue('style');
  return label;
}

function getPath(source: JsonRecord, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = getOwn(current, part);
  }
  return current;
}

const asId = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : undefined;

const asText = asId;

const asStrings = (value: unknown): string[] | undefined => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  return undefined;
};

const asIds = (value: unknown): string[] | undefined => {
  const single = asId(value);
  if (single !== undefined) return [single];
  if (!Array.isArray(value)) return undefined;
  const ids = value.map(asId);
  return ids.every((id) => id !== undefined) ? (ids as string[]) : undefined;
};

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const asPoint = (value: unknown): Point | undefined =>
  isRecord(value) && typeof value.x === 'number' && typeof value.y === 'number'
    ? { x: value.x, y: value.y }
    : undefined;

const asRecord = (value: unknown): JsonRecord | undefined => (isRecord(value) ? value : undefined);

const LABEL_KEYS = ['label', 'name', 'title'];
const TYPE_KEYS = ['type', 'types', 'category', 'labels'];
const VIS_TYPE_KEYS = [...TYPE_KEYS, 'group'];
const ALIAS_KEYS = ['aliases', 'synonyms'];
/** `interaction` is Cytoscape's (desktop) name for the relation type. */
const PREDICATE_KEYS = ['predicate', 'relation', 'rel', 'type', 'interaction'];

class JsonMapper {
  private readonly ignored: (typeof IGNORED_KEYS)[JsonDialect];
  private readonly extraEdges: EdgeInput[] = [];
  /** d3 only: node ids by array index, for links that reference nodes by index. */
  private readonly idsByIndex: (string | undefined)[] = [];
  private readonly idSet = new Set<string>();
  /** Dropped field name → number of elements that had it. */
  private readonly dropped = new Map<string, number>();
  private readonly nonFinite: () => void;

  constructor(
    private readonly shape: Shape,
    private readonly fields: Fields,
    private readonly warnings: Warnings,
  ) {
    this.ignored = IGNORED_KEYS[shape.dialect];
    this.nonFinite = nonFiniteCounter(warnings);
  }

  nodes(): NodeInput[] {
    const nodes: NodeInput[] = [];
    this.shape.nodes.forEach((raw, index) => {
      const node = this.node(raw, index);
      if (node) nodes.push(node);
    });
    return nodes;
  }

  edges(): EdgeInput[] {
    const edges = this.shape.edges.map((raw, index) => this.edge(raw, index));
    return [...edges, ...this.extraEdges];
  }

  private where(kind: 'node' | 'edge', index: number): string {
    return `${kind === 'node' ? this.shape.nodesKey : this.shape.edgesKey}[${index}]`;
  }

  private reader(raw: unknown, kind: 'node' | 'edge', index: number): ElementReader {
    if (!isRecord(raw)) throw invalidInput(`${this.where(kind, index)} is not an object.`);
    const ignored = kind === 'node' ? this.ignored.nodes : this.ignored.edges;
    switch (this.shape.dialect) {
      case 'cytoscape':
      case 'g6': {
        const data = getOwn(raw, 'data') ?? {};
        if (!isRecord(data))
          throw invalidInput(`${this.where(kind, index)}.data is not an object.`);
        const reader = new ElementReader(raw, data, 'data', ignored);
        if (this.shape.dialect === 'cytoscape') reader.rawValue('group');
        return reader;
      }
      case 'graphology': {
        const attributes = getOwn(raw, 'attributes') ?? {};
        if (!isRecord(attributes)) {
          throw invalidInput(`${this.where(kind, index)}.attributes is not an object.`);
        }
        return new ElementReader(raw, attributes, 'attributes', ignored);
      }
      case 'kgdiff':
      case 'd3':
      case 'vis':
        return new ElementReader(raw, raw, undefined, ignored);
    }
  }

  private nodeId(reader: ElementReader, index: number): string {
    let id: string | undefined;
    if (this.fields.id !== undefined) id = reader.path(this.fields.id, asId);
    else {
      switch (this.shape.dialect) {
        case 'cytoscape':
          id = reader.first(['id'], asId);
          break;
        case 'g6':
          id = asId(reader.rawValue('id')) ?? reader.first(['id'], asId);
          break;
        case 'graphology':
          id = asId(reader.rawValue('key'));
          break;
        case 'kgdiff':
        case 'd3':
        case 'vis':
          id = reader.first(['id'], asId);
          break;
        default:
          assertNever(this.shape.dialect);
      }
    }
    if (id !== undefined) return id;
    if (this.shape.dialect === 'd3' && this.fields.id === undefined) {
      this.warnings.count(
        'json-index-ids',
        (n) => `${plural(n, 'node')} without an id: using the array index as id (d3 index links).`,
      );
      return String(index);
    }
    const expected =
      this.fields.id !== undefined
        ? `\`${this.fields.id}\``
        : this.shape.dialect === 'graphology'
          ? '`key`'
          : this.shape.dialect === 'cytoscape'
            ? '`data.id`'
            : '`id`';
    throw invalidInput(
      `${this.where('node', index)} has no id (expected ${expected} as a string or number).`,
      { index },
    );
  }

  private node(raw: unknown, index: number): NodeInput | undefined {
    const reader = this.reader(raw, 'node', index);
    const id = this.nodeId(reader, index);
    this.idsByIndex[index] = id;
    this.idSet.add(id);
    const { fields } = this;
    const dialect = this.shape.dialect;

    const label =
      fields.label !== undefined
        ? reader.path(fields.label, asText)
        : (reader.first(LABEL_KEYS, asText) ?? (dialect === 'g6' ? g6Label(reader) : undefined));
    const types =
      fields.type !== undefined
        ? reader.path(fields.type, asStrings)
        : reader.first(dialect === 'vis' ? VIS_TYPE_KEYS : TYPE_KEYS, asStrings);
    const aliases = reader.first(ALIAS_KEYS, asStrings);
    const deprecated = reader.first(['deprecated'], asBoolean);
    const replaces = reader.first(['replaces'], asIds);
    const replacedBy = reader.first(['replacedBy'], asIds);
    const position = dialect === 'kgdiff' ? reader.first(['position'], asPoint) : undefined;
    // Core's graphToJSON marks nodes it created for dangling edge ends; normalize recreates them.
    const implicit = dialect === 'kgdiff' ? reader.first(['implicit'], asBoolean) : undefined;

    const parent = this.parentOf(reader);
    if (parent !== undefined) {
      this.extraEdges.push(makeEdge({ source: id, target: parent, predicate: 'parent' }));
    }

    const attrs = new AttrBag();
    if (dialect === 'kgdiff') {
      const own = reader.first(['attrs'], asRecord);
      reader.rest(attrs, this.nonFinite);
      // Explicit `attrs` win over loose top-level fields with the same key.
      if (own) mergeAttrs(attrs, own, this.nonFinite);
    } else reader.rest(attrs, this.nonFinite);

    this.noteDropped(reader);
    const node = makeNode({
      id,
      label,
      types,
      aliases,
      attrs: attrs.build(),
      deprecated: deprecated === true,
      replaces,
      replacedBy,
      position,
    });
    return implicit === true && Object.keys(node).length === 1 ? undefined : node;
  }

  /** Counts the keys an element loses, for one `json-ignored-fields` warning per parse. */
  private noteDropped(reader: ElementReader): void {
    for (const key of reader.dropped()) this.dropped.set(key, (this.dropped.get(key) ?? 0) + 1);
  }

  /** Reports fields that were dropped (rendering state, shape types, unknown wrapper keys). */
  reportDropped(): void {
    if (this.dropped.size === 0) return;
    const fields = [...this.dropped.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([key, count]) => `${key} (${count})`);
    this.warnings.add(
      'json-ignored-fields',
      `Ignored ${this.shape.dialect} fields that are not part of the graph: ${fields.join(', ')}.`,
    );
  }

  /** Compound parents (Cytoscape `data.parent`, G6 `combo`) become `parent` edges. */
  private parentOf(reader: ElementReader): string | undefined {
    switch (this.shape.dialect) {
      case 'cytoscape':
        return reader.first(['parent'], asId);
      case 'g6':
        return asId(reader.rawValue('combo'));
      default:
        return undefined;
    }
  }

  private endpoint(reader: ElementReader, end: 'source' | 'target', index: number): string {
    const field = end === 'source' ? this.fields.source : this.fields.target;
    const dialect = this.shape.dialect;
    let value: unknown;
    if (field !== undefined) {
      value = reader.path(field, (v) => (v === undefined || v === null ? undefined : v));
    } else if (dialect === 'cytoscape') {
      value = getOwn(reader.record, end);
      reader.consume(end);
    } else {
      value = reader.rawValue(dialect === 'vis' ? (end === 'source' ? 'from' : 'to') : end);
    }
    const id = dialect === 'd3' ? this.d3Endpoint(value) : asId(value);
    if (id === undefined) {
      const expected = field ?? (dialect === 'vis' ? (end === 'source' ? 'from' : 'to') : end);
      throw invalidInput(
        `${this.where('edge', index)} has no ${end} (expected \`${expected}\` as a node id).`,
        { index },
      );
    }
    return id;
  }

  /** d3 link ends: a node id, a node index (when no node has that id) or a node object. */
  private d3Endpoint(value: unknown): string | undefined {
    if (isRecord(value)) {
      const id = asId(value.id);
      if (id !== undefined) return id;
      return typeof value.index === 'number' ? this.idsByIndex[value.index] : undefined;
    }
    if (typeof value === 'number' && !this.idSet.has(String(value))) {
      if (Number.isInteger(value) && value >= 0 && value < this.idsByIndex.length) {
        return this.idsByIndex[value];
      }
    }
    return asId(value);
  }

  private edge(raw: unknown, index: number): EdgeInput {
    const reader = this.reader(raw, 'edge', index);
    const dialect = this.shape.dialect;
    const source = this.endpoint(reader, 'source', index);
    const target = this.endpoint(reader, 'target', index);
    let id: string | undefined;
    if (dialect === 'graphology') id = asId(reader.rawValue('key'));
    else if (dialect === 'g6') id = asId(reader.rawValue('id')) ?? reader.first(['id'], asId);
    else id = reader.first(['id'], asId);

    let predicate =
      this.fields.predicate !== undefined
        ? reader.path(this.fields.predicate, asText)
        : reader.first(PREDICATE_KEYS, asText);
    const label = reader.first(['label'], asText);
    // Visualisation formats often name the relation only in `label`; kgdiff JSON never does
    // (core omits a default label and an empty predicate), so it must round-trip as is.
    if (dialect !== 'kgdiff') predicate ??= label;

    const attrs = new AttrBag();
    if (dialect === 'kgdiff') {
      const own = reader.first(['attrs'], asRecord);
      reader.rest(attrs, this.nonFinite);
      if (own) mergeAttrs(attrs, own, this.nonFinite);
    } else reader.rest(attrs, this.nonFinite);
    if (dialect === 'graphology' && reader.rawValue('undirected') === true) {
      attrs.add('undirected', true);
    }

    this.noteDropped(reader);
    return makeEdge({ id, source, target, predicate, label, attrs: attrs.build() });
  }
}

/** Overwrites bag entries with `own` (the explicit `attrs` object). */
function mergeAttrs(bag: AttrBag, own: JsonRecord, onNonFinite: () => void): void {
  for (const [key, value] of Object.entries(own)) {
    const converted = toAttrValue(value, 0, onNonFinite);
    if (converted !== undefined) bag.set(key, converted);
  }
}

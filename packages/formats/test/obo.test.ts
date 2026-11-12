import type { NodeInput } from '@kgdiff/core';
import { describe, expect, it } from 'vitest';
import { parseGraph } from '../src/sync.js';
import { catchError, parseFixture } from './helpers.js';

const obo = (text: string) => parseGraph(text, { format: 'obo' });
const term = (body: string) => obo(`format-version: 1.4\n\n[Term]\n${body}\n`);
const onlyNode = (body: string): NodeInput => {
  const [node] = term(body).graph.nodes;
  if (!node) throw new Error('no node');
  return node;
};

describe('OBO fixture (GO excerpt)', () => {
  const result = parseFixture('go-mini.obo');

  it('reads the header into meta and prefixes', () => {
    expect(result.format).toBe('obo');
    expect(result.graph.meta).toEqual({
      name: 'go',
      version: 'releases/2024-01-17',
      predicateLabels: { part_of: 'part of' },
      source: 'go-mini.obo',
    });
    expect(result.predicateLabels).toEqual({ part_of: 'part of' });
    expect(result.prefixes.GO).toBe('http://purl.obolibrary.org/obo/GO_');
    expect(result.prefixes.rdfs).toBe('http://www.w3.org/2000/01/rdf-schema#');
    expect(result.warnings).toEqual([]);
  });

  it('maps [Term] stanzas to nodes', () => {
    expect(result.graph.nodes).toEqual([
      {
        id: 'GO:0000001',
        label: 'mitochondrion inheritance',
        type: 'Term',
        aliases: ['mitochondrial inheritance'],
        attrs: {
          'GOREL:0000040': 2,
          'IAO:0000233': 'https://github.com/geneontology/go-ontology/issues/1',
          def: 'The distribution of "mitochondria", including the mitochondrial genome, into daughter cells after mitosis or meiosis.',
          def_xrefs: ['GOC:mcc', 'PMID:10873824', 'PMID:11389764'],
          namespace: 'gene_ontology',
          synonyms: ['mitochondrial inheritance (EXACT)'],
        },
      },
      {
        id: 'GO:0000005',
        label: 'obsolete ribosomal chaperone activity',
        type: 'Term',
        attrs: {
          comment:
            'This term was made obsolete because it refers to a class of gene products and a biological process rather than a molecular function.',
          consider: ['GO:0042254', 'GO:0044183'],
          def: 'OBSOLETE. Assists in the correct assembly of ribosomes or ribosomal subunits in vivo.',
          def_xrefs: ['GOC:jl'],
          namespace: 'molecular_function',
        },
        deprecated: true,
        replacedBy: ['GO:0042254'],
      },
      {
        id: 'GO:0005739',
        label: 'mitochondrion',
        type: 'Term',
        aliases: ['mito', 'mitochondria'],
        attrs: {
          def: 'A semiautonomous, self replicating organelle that occurs in varying numbers, shapes, and sizes in the cytoplasm of virtually all eukaryotic cells.',
          def_xrefs: ['GOC:giardia', 'ISBN:0198506732'],
          namespace: 'cellular_component',
          synonyms: ['mito (RELATED)', 'mitochondria (EXACT)'],
          xref: ['NIF_Subcellular:sao1860313010', 'Wikipedia:Mitochondrion'],
        },
      },
      {
        id: 'GO:0008150',
        label: 'biological_process',
        type: 'Term',
        aliases: ['biological process', 'physiological process'],
        attrs: {
          alt_id: ['GO:0000004', 'GO:0007582'],
          comment:
            'Note that this term is recommended for the annotation of gene products whose biological process is unknown.',
          created_by: 'jl',
          creation_date: '2009-04-28T10:13:17Z',
          def: 'A biological process is the execution of a genetically-encoded biological module or program.',
          def_xrefs: ['GOC:pdt'],
          namespace: 'biological_process',
          subset: ['goslim_generic'],
          synonyms: ['biological process (EXACT)', 'physiological process (EXACT)'],
          xref: ['Wikipedia:Biological_process'],
        },
        replaces: ['GO:0000004', 'GO:0007582'],
      },
      {
        id: 'GO:0031966',
        label: 'mitochondrial membrane',
        type: 'Term',
        attrs: {
          def: 'Either of the lipid bilayers that surround the mitochondrion and form the mitochondrial envelope.',
          def_xrefs: ['GOC:mah', 'NIF_Subcellular:sao1045389829'],
          namespace: 'cellular_component',
        },
      },
    ]);
  });

  it('maps is_a, relationship and intersection_of to edges labelled by their Typedef', () => {
    expect(result.graph.edges).toEqual([
      { source: 'GO:0000001', target: 'GO:0048308', predicate: 'is_a', label: 'is a' },
      { source: 'GO:0000001', target: 'GO:0048311', predicate: 'is_a', label: 'is a' },
      { source: 'GO:0005739', target: 'GO:0043231', predicate: 'is_a', label: 'is a' },
      { source: 'GO:0005739', target: 'GO:0005737', predicate: 'part_of', label: 'part of' },
      {
        source: 'GO:0031966',
        target: 'GO:0005740',
        predicate: 'intersection_of',
        label: 'intersection of (part of)',
        attrs: { relation: 'part_of' },
      },
      {
        source: 'GO:0031966',
        target: 'GO:0016020',
        predicate: 'intersection_of',
        label: 'intersection of',
      },
      { source: 'GO:0031966', target: 'GO:0031090', predicate: 'is_a', label: 'is a' },
      { source: 'GO:0031966', target: 'GO:0005740', predicate: 'part_of', label: 'part of' },
    ]);
  });

  it('does not turn [Typedef] stanzas into nodes', () => {
    expect(result.graph.nodes.map((node) => node.id)).not.toContain('part_of');
  });
});

describe('OBO values', () => {
  it('decodes escapes in quoted and unquoted values', () => {
    const node = onlyNode(
      [
        'id: X:1',
        'name: a \\"quoted\\" name with a \\! bang and a back\\\\slash',
        'def: "line one\\nline two \\"quoted\\" \\{braces\\} \\[brackets\\]" []',
        'comment: tab\\there\\Wspace',
      ].join('\n'),
    );
    expect(node.label).toBe('a "quoted" name with a ! bang and a back\\slash');
    expect(node.attrs).toEqual({
      comment: 'tab\there space',
      def: 'line one\nline two "quoted" {braces} [brackets]',
    });
  });

  it('strips trailing ! comments, but not inside quotes or when escaped', () => {
    const node = onlyNode(
      [
        'id: X:1 ! the id',
        'name: Wow\\! that is it ! a comment',
        'def: "Stop! Hammer time!" [PMID:1] ! trailing [not, xrefs]',
        'is_a: X:2 ! parent',
      ].join('\n'),
    );
    expect(node).toMatchObject({ id: 'X:1', label: 'Wow! that is it' });
    expect(node.attrs).toEqual({ def: 'Stop! Hammer time!', def_xrefs: ['PMID:1'] });
  });

  it('treats quotes as plain characters in tags without quoted strings', () => {
    const node = onlyNode(
      [
        'id: X:1',
        'name: 5" pipe ! comment',
        'comment: a 12" ruler {source="a!b"} ! trailing',
        'synonym: "6\\" pipe" EXACT [] ! comment',
      ].join('\n'),
    );
    expect(node.label).toBe('5" pipe');
    expect(node.attrs).toEqual({ comment: 'a 12" ruler', synonyms: ['6" pipe (EXACT)'] });
  });

  it('keeps prototype-named tags and id spaces as ordinary keys', () => {
    const result = obo(
      [
        'idspace: __proto__ http://example.org/proto_',
        '',
        '[Term]',
        'id: X:1',
        '__proto__: polluted?',
        'constructor: c',
        'property_value: __proto__ "v" xsd:string',
      ].join('\n'),
    );
    const [node] = result.graph.nodes;
    expect(JSON.stringify(node?.attrs)).toBe('{"__proto__":["polluted?","v"],"constructor":"c"}');
    expect(Object.keys(result.prefixes)).toContain('__proto__');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('strips {qualifier} blocks, keeping braces inside quotes', () => {
    const result = term(
      [
        'id: X:1',
        'def: "A {curly} definition." [PMID:2 {note="x"}, ISBN:3 "Book, 2nd ed."] {source="GOC"}',
        'is_a: X:2 {is_inferred="true", source="x!y"} ! parent',
        'relationship: part_of X:3 {cardinality="1"}',
        'synonym: "syn" NARROW [] {source="x"}',
      ].join('\n'),
    );
    expect(result.graph.nodes[0]?.attrs).toEqual({
      def: 'A {curly} definition.',
      def_xrefs: ['ISBN:3', 'PMID:2'],
      synonyms: ['syn (NARROW)'],
    });
    expect(result.graph.edges).toEqual([
      { source: 'X:1', target: 'X:2', predicate: 'is_a', label: 'is a' },
      { source: 'X:1', target: 'X:3', predicate: 'part_of', label: 'part of' },
    ]);
  });

  it('reads synonym scopes, defaulting to RELATED, and the OBO 1.2 scoped synonym tags', () => {
    const node = onlyNode(
      [
        'id: X:1',
        'synonym: "exact one" EXACT systematic_synonym [GOC:x]',
        'synonym: "plain one" []',
        'synonym: "broad one" BROAD',
        'exact_synonym: "legacy exact" []',
        'narrow_synonym: "legacy narrow" []',
        'related_synonym: "legacy related" []',
        'broad_synonym: "legacy broad" []',
      ].join('\n'),
    );
    expect(node.aliases).toEqual([
      'broad one',
      'exact one',
      'legacy broad',
      'legacy exact',
      'legacy narrow',
      'legacy related',
      'plain one',
    ]);
    expect(node.attrs?.synonyms).toEqual([
      'broad one (BROAD)',
      'exact one (EXACT)',
      'legacy broad (BROAD)',
      'legacy exact (EXACT)',
      'legacy narrow (NARROW)',
      'legacy related (RELATED)',
      'plain one (RELATED)',
    ]);
  });

  it('marks obsolete terms deprecated and records replacements as hints', () => {
    const node = onlyNode(
      [
        'id: X:9',
        'name: obsolete thing',
        'is_obsolete: true',
        'replaced_by: X:2',
        'replaced_by: X:1',
        'consider: X:5',
      ].join('\n'),
    );
    expect(node).toEqual({
      id: 'X:9',
      label: 'obsolete thing',
      type: 'Term',
      attrs: { consider: ['X:5'] },
      deprecated: true,
      replacedBy: ['X:1', 'X:2'],
    });
    expect(onlyNode('id: X:1\nis_obsolete: false').deprecated).toBeUndefined();
  });

  it('types property_value literals by their XSD datatype', () => {
    const node = onlyNode(
      [
        'id: X:1',
        'property_value: count "42" xsd:integer',
        'property_value: ratio "0.5" xsd:decimal',
        'property_value: flag "true" xsd:boolean',
        'property_value: when "2020-01-01" xsd:date',
        'property_value: huge "123456789012345678901" xsd:integer',
        'property_value: http://purl.org/dc/terms/creator "Ada \\"A\\" Lovelace" xsd:string',
        'property_value: RO:0002161 NCBITaxon:4896',
        'property_value: count "7" http://www.w3.org/2001/XMLSchema#int',
      ].join('\n'),
    );
    expect(node.attrs).toEqual({
      'RO:0002161': 'NCBITaxon:4896',
      count: [7, 42],
      flag: true,
      'http://purl.org/dc/terms/creator': 'Ada "A" Lovelace',
      huge: '123456789012345678901',
      ratio: 0.5,
      when: '2020-01-01',
    });
  });

  it('keeps unknown tags verbatim as attrs and repeated single tags as sorted arrays', () => {
    const node = onlyNode(
      ['id: X:1', 'is_anonymous: false', 'comment: second', 'comment: first', 'builtin: true'].join(
        '\n',
      ),
    );
    expect(node.attrs).toEqual({
      builtin: 'true',
      comment: ['first', 'second'],
      is_anonymous: 'false',
    });
  });

  it('maps union_of, disjoint_from, equivalent_to and [Instance] instance_of to edges', () => {
    const result = obo(
      [
        '[Term]',
        'id: X:1',
        'union_of: X:2',
        'union_of: X:3',
        'disjoint_from: X:4',
        'equivalent_to: X:5',
        '',
        '[Instance]',
        'id: I:1',
        'name: an instance',
        'instance_of: X:1',
        'property_value: weight "3" xsd:integer',
      ].join('\n'),
    );
    expect(result.graph.nodes).toEqual([
      { id: 'I:1', label: 'an instance', type: 'Instance', attrs: { weight: 3 } },
      { id: 'X:1', type: 'Term' },
    ]);
    expect(result.graph.edges).toEqual([
      { source: 'I:1', target: 'X:1', predicate: 'instance_of', label: 'instance of' },
      { source: 'X:1', target: 'X:4', predicate: 'disjoint_from', label: 'disjoint from' },
      { source: 'X:1', target: 'X:5', predicate: 'equivalent_to', label: 'equivalent to' },
      { source: 'X:1', target: 'X:2', predicate: 'union_of', label: 'union of' },
      { source: 'X:1', target: 'X:3', predicate: 'union_of', label: 'union of' },
    ]);
  });

  it('labels edges from relation ids and reports Typedef names separately', () => {
    const result = obo(
      [
        '[Term]',
        'id: X:1',
        'relationship: BFO:0000050 X:2',
        'relationship: regulates X:3',
        'relationship: has_part X:4',
        '',
        '[Typedef]',
        'id: BFO:0000050',
        'name: part of',
        '',
        '[Typedef]',
        'id: regulates',
        'name: regulates',
      ].join('\n'),
    );
    // A Typedef appearing or disappearing must not relabel every edge that uses it.
    expect(result.graph.edges.map((edge) => [edge.predicate, edge.label])).toEqual([
      ['BFO:0000050', 'BFO:0000050'],
      ['has_part', 'has part'],
      ['regulates', 'regulates'],
    ]);
    expect(result.predicateLabels).toEqual({ 'BFO:0000050': 'part of', regulates: 'regulates' });
  });

  it('applies default-namespace only to terms without a namespace', () => {
    const result = obo(
      [
        'default-namespace: my_ns',
        '',
        '[Term]',
        'id: X:1',
        '',
        '[Term]',
        'id: X:2',
        'namespace: other_ns',
      ].join('\n'),
    );
    expect(result.graph.nodes.map((node) => node.attrs?.namespace)).toEqual(['my_ns', 'other_ns']);
  });

  it('handles CRLF line endings, a BOM, blank lines, comments and Unicode', () => {
    const result = parseGraph(
      '﻿ormat-version: 1.4\r\n! comment\r\n\r\n[Term]\r\nid: X:1\r\nname: 线粒体 (mitochondrion) 🧬\r\n',
    );
    expect(result.format).toBe('obo');
    expect(result.graph.nodes).toEqual([
      { id: 'X:1', label: '线粒体 (mitochondrion) 🧬', type: 'Term' },
    ]);
  });

  it('parses an empty OBO document to an empty graph', () => {
    expect(obo('format-version: 1.4\n').graph).toEqual({ nodes: [], edges: [] });
  });
});

describe('OBO warnings', () => {
  it('merges duplicate stanzas and skips unknown stanza types, with line numbers', () => {
    const result = obo(
      [
        '[Term]',
        'id: X:1',
        'name: one',
        '',
        '[Annotation]',
        'id: A:1',
        '',
        '[Term]',
        'id: X:1',
        'is_a: X:0',
        'name: uno',
      ].join('\n'),
    );
    expect(result.graph.nodes).toEqual([
      { id: 'X:1', label: 'one', type: 'Term', aliases: ['uno'] },
    ]);
    expect(result.graph.edges).toHaveLength(1);
    expect(result.warnings).toEqual([
      { code: 'obo-unknown-stanza', message: 'Skipped unsupported [Annotation] stanza.', line: 5 },
      {
        code: 'obo-duplicate-id',
        message: '[Term] X:1 is defined more than once; the stanzas were merged.',
        line: 8,
      },
      { code: 'obo-multiple-names', message: 'X:1 has more than one name.', line: 11 },
    ]);
  });

  it('warns about values it cannot use', () => {
    const result = term(
      ['id: X:1', 'relationship: part_of', 'is_a:', 'def: not quoted'].join('\n'),
    );
    expect(result.graph.nodes[0]?.attrs).toEqual({ def: 'not quoted' });
    expect(result.warnings.map((warning) => [warning.code, warning.line])).toEqual([
      ['obo-invalid-relationship', 5],
      ['obo-missing-value', 6],
      ['obo-unquoted-def', 7],
    ]);
    const empty = term(
      ['id: X:1', 'alt_id:', 'consider:', 'xref:', 'replaced_by:', 'property_value: lonely'].join(
        '\n',
      ),
    );
    expect(empty.graph.nodes).toEqual([{ id: 'X:1', type: 'Term' }]);
    expect(empty.warnings.map((warning) => warning.line)).toEqual([5, 6, 7, 8, 9]);
    expect(obo('idspace: GO\n').warnings).toEqual([
      { code: 'obo-invalid-idspace', message: '`idspace` needs a prefix and an IRI.', line: 1 },
    ]);
  });
});

describe('OBO errors', () => {
  it('reports lines that are not tag-value pairs', () => {
    const error = catchError(() =>
      obo('format-version: 1.4\n\n[Term]\nid: X:1\nthis is not a tag\n'),
    );
    expect(error.code).toBe('invalid-input');
    expect(error.message).toBe(
      'Invalid OBO on line 5: expected "tag: value", got "this is not a tag".',
    );
    expect(error.details).toEqual({ line: 5 });
  });

  it('reports stanzas without an id', () => {
    const error = catchError(() => obo('[Term]\nname: nameless\n\n[Term]\nid: X:2\n'));
    expect(error.message).toBe('Invalid OBO: [Term] stanza on line 1 has no id.');
    expect(error.details).toEqual({ line: 1 });
  });

  it('reports unterminated quotes and xref lists', () => {
    expect(catchError(() => term('id: X:1\ndef: "never closed [GOC:x]')).message).toBe(
      'Invalid OBO on line 5: unterminated quoted string in `def`.',
    );
    expect(catchError(() => term('id: X:1\ndef: "closed" [GOC:x, PMID:1')).message).toBe(
      'Invalid OBO on line 5: unterminated xref list in `def`.',
    );
  });

  it('reports malformed stanza headers', () => {
    expect(catchError(() => obo('[Term\nid: X:1')).message).toBe(
      'Invalid OBO on line 1: malformed stanza header "[Term".',
    );
  });
});

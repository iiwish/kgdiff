// Dumps what kgdiff's TypeScript RDF readers give for each file: quads (blank nodes renamed by
// first appearance) and declared prefixes, or the error.
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { readN3 } from '../../packages/formats/src/rdf.ts';
import { readRdfXml } from '../../packages/formats/src/rdfxml.ts';
import { readJsonLd } from '../../packages/formats/src/jsonld.ts';
import { parseJsonText } from '../../packages/formats/src/json.ts';
import { Warnings } from '../../packages/formats/src/shared.ts';

const formats: Record<string, string> = { '.ttl': 'turtle', '.nt': 'ntriples', '.nq': 'nquads', '.trig': 'trig', '.rdf': 'rdfxml', '.owl': 'rdfxml', '.jsonld': 'jsonld' };

for (const file of process.argv.slice(2)) {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const format = formats[extname(file)] ?? 'turtle';
  let out: string;
  try {
    const doc =
      format === 'rdfxml'
        ? readRdfXml(text, undefined)
        : format === 'jsonld'
          ? readJsonLd(parseJsonText(text), {}, new Warnings())
          : readN3(text, format as never, undefined);
    const blanks = new Map<string, string>();
    const term = (t: any): string => {
      if (t.termType === 'BlankNode') {
        if (!blanks.has(t.value)) blanks.set(t.value, `b${blanks.size}`);
        return `_:${blanks.get(t.value)}`;
      }
      if (t.termType === 'NamedNode') return `<${t.value}>`;
      if (t.termType === 'Literal') return `${JSON.stringify(t.value)}${t.language ? `@${t.language}` : ''}^^<${t.datatype.value}>${t.direction ? `--${t.direction}` : ''}`;
      if (t.termType === 'DefaultGraph') return '';
      if (t.termType === 'Quad') return `<<( ${term(t.subject)} ${term(t.predicate)} ${term(t.object)} )>>`;
      return `?${t.termType}`;
    };
    const lines = doc.quads.map((q: any) => `${term(q.subject)} ${term(q.predicate)} ${term(q.object)} ${term(q.graph)}`.trimEnd());
    out = `${lines.join('\n')}\nprefixes ${JSON.stringify(doc.prefixes)}`;
  } catch (error) {
    out = `ERROR ${(error as Error).message}`;
  }
  console.log(`=== ${basename(file)}\n${out}`);
}

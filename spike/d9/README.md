# D-9 spike: Oxigraph's parsers against kgdiff's RDF readers

RFC 0002, phase 3, decision D-9. **Not for merge**: this branch holds the evidence for the
decision recorded in the RFC; `crates/kgdiff-formats` is written on its own branches.

`sh spike/d9/run.sh` (from the repository root, after `pnpm install`) dumps the quads and declared
prefixes that kgdiff's TypeScript readers produce (n3 2.13 for Turtle, N-Triples, N-Quads and
TriG; `rdfxml.ts` + `xml.ts`; `jsonld.ts`) and those of `oxttl` 0.2.5, `oxrdfxml` 0.2.5 and
`oxjsonld` 0.2.7 (all with `rdf-12`), strict and lenient, for

- the RDF inputs of the corpus (`rdf-turtle-ntriples`, `rdf-nquads-trig`, `dataset-schema-vocab`,
  `rdf-xml`, `jsonld`) and the RDF fixtures of `packages/formats/test`;
- the probes here, one per risk RFC 0002 §5 lists: relative IRIs with and without a base, IRI
  syntax n3 and oxiri judge differently, RDF 1.2 annotations, reifiers and triple terms, lexical
  forms of numbers and booleans, language tags (case, private use, base direction), escapes,
  prefix redefinition, blank node structures, DTD entities (and an exponential "billion laughs"
  expansion), external entities, XML literals, `rdf:ID` reification, JSON-LD numbers, `@json`,
  `@direction` and keys without a mapping.

It compares quads as multisets with blank node labels anonymized (kgdiff's mapping identifies
blank nodes by content hash, so their labels do not reach `parse.*.json`) and the prefix maps
(which `ParseResult.prefixes` reports). `n3dump.ts` and `oxprobe/` are the two dumpers.

## Results (2026-11-09)

Turtle family, **oxttl strict**: identical on all 11 corpus and fixture inputs. Of 39 probes, 30
agree (both read the same quads, or both reject the text); 5 differ, all because oxttl validates
IRIs and n3 does not:

| Probe | n3 (TypeScript) | oxttl strict |
| --- | --- | --- |
| `rel-nobase.ttl` `<a> <b> <../c>`, no base | reads it, resolving against the empty base: `</c>`, `<#x>` | error: no scheme |
| `dt-rel.ttl` `"y"^^<dt>`, no base | reads it | error: no scheme |
| `base-rel.ttl` `@base <rel/>` | reads it: `<rel/x>` | error: no scheme |
| `iri-badpct.ttl` `<http://e/%zz>`, `<http://e:abc/>` | reads it as written | error: percent encoding, port |

(`rel-nobase` shows that n3 does not keep relative IRIs "as written", as the RFC assumed: it
removes dot segments against an empty base.) **oxttl lenient** reads all of those, the relative
ones as written (`../c`, where n3 gives `/c`), but also reads 7 texts n3 rejects (a space, `|`,
`"` or `` ` `` in an IRI, a line break in a short string, `"x"^^rdf:langString`, an escaped
surrogate pair `😀`).

RDF/XML, **oxrdfxml**: differs on **both corpus inputs** — XML literals (`rdf:parseType="Literal"`)
carry every in-scope namespace declaration instead of kgdiff's exclusive canonical form, and the
document's `xmlns` declarations are not reported as prefixes (also on both fixtures). It expands
the exponential entity probe to 10 MB where kgdiff stops at its limit, and rejects relative IRIs
without a base, which kgdiff keeps.

JSON-LD, **oxjsonld**: differs on **both corpus inputs** — the integer `100000000000000000000`
becomes `"1.0E20"^^xsd:double` (kgdiff, per JSON-LD 1.1: `xsd:integer`, since it is below 10²¹),
and `@vocab` is not reported as the `""` prefix. Without a base it drops every statement about a
relative IRI without a word (`rel.jsonld`: nothing at all), and lenient mode reorders or differs
on the fixtures. It has no way to report `jsonld-unmapped-terms`, and it reads JSON with its own
parser (kgdiff's errors, lone surrogates, BOM and nesting limits are `js::json`'s).

## Decision

See RFC 0002, D-9: oxttl for the Turtle family, strict, with a lenient re-read that resolves IRIs
the way n3 does when only IRI validation fails; ports of `rdfxml.ts` / `xml.ts` and `jsonld.ts`.

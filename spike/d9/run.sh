#!/bin/sh
# The D-9 spike (RFC 0002, phase 3): the quads kgdiff's TypeScript readers produce (n3 for the
# Turtle family, rdfxml.ts, jsonld.ts) against oxttl, oxrdfxml and oxjsonld, on the corpus's RDF
# inputs, the formats test fixtures and the probes in this directory. Run from the repository
# root after `pnpm install`:  sh spike/d9/run.sh
set -e
root=$(pwd)
out=${TMPDIR:-/tmp}/kgdiff-d9
rm -rf "$out" && mkdir -p "$out/corpus"
for c in rdf-turtle-ntriples rdf-nquads-trig dataset-schema-vocab rdf-xml jsonld; do
  for f in conformance/cases/$c/before.* conformance/cases/$c/after.*; do
    name=$(basename "$f")
    case "$c/$name" in jsonld/after.json) name=after.jsonld ;; esac
    cp "$f" "$out/corpus/$c-$name"
  done
done
cp packages/formats/test/fixtures/*.ttl packages/formats/test/fixtures/*.nt packages/formats/test/fixtures/*.nq \
  packages/formats/test/fixtures/*.trig packages/formats/test/fixtures/*.rdf packages/formats/test/fixtures/*.owl \
  packages/formats/test/fixtures/*.jsonld "$out/corpus/"
files="$out/corpus/* $root/spike/d9/ttl/* $root/spike/d9/xml/* $root/spike/d9/jsonld/*"
(cd packages/formats && npx tsx ../../spike/d9/n3dump.ts $files) > "$out/ts.txt" 2>&1
cargo build -q --manifest-path spike/d9/oxprobe/Cargo.toml
spike/d9/oxprobe/target/debug/oxprobe $files > "$out/ox-strict.txt" 2>&1
LENIENT=1 spike/d9/oxprobe/target/debug/oxprobe $files > "$out/ox-lenient.txt" 2>&1
python3 - "$out" <<'PY'
import json, re, sys
out = sys.argv[1]
def load(path):
    files, cur = {}, None
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        if line.startswith('=== '):
            cur = line[4:]; files[cur] = []
        elif cur is not None:
            files[cur].append(line)
    return files
def view(lines):
    if lines and lines[0].startswith('ERROR'):
        return ('error', None)
    quads = sorted(re.sub(r'_:b\d+', '_:B', l) for l in lines if l and not l.startswith('prefixes '))
    prefixes = [json.loads(l[9:]) for l in lines if l.startswith('prefixes ')]
    return (quads, prefixes[0] if prefixes else {})
ts = load(f'{out}/ts.txt')
for mode in ('strict', 'lenient'):
    ox = load(f'{out}/ox-{mode}.txt')
    print(f'\n## ox* {mode} against the TypeScript readers (quads as multisets, blank labels anonymized)\n')
    for name in ts:
        a, b = view(ts[name]), view(ox.get(name, ['ERROR missing']))
        if a == b: verdict = 'same' if a[0] != 'error' else 'both errors'
        elif a[0] == 'error': verdict = 'TS error, ox* reads it'
        elif b[0] == 'error': verdict = 'ox* error: ' + ox[name][0][6:120]
        else:
            parts = []
            if a[0] != b[0]: parts.append('quads differ')
            if a[1] != b[1]: parts.append('prefixes differ')
            verdict = ', '.join(parts)
        print(f'- {name}: {verdict}')
PY
echo "\nraw outputs: $out"

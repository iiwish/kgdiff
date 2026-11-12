# Deltas: apply and invert

A delta is the change from one graph to another as a list of operations that add, remove or
update nodes and edges, together with the content hashes of the base and the target. It is
invertible: the inverse delta takes the target back to the base. The operations come in a
canonical order, so the same diff always gives the same delta. [Delta format](../delta-format.md)
specifies the JSON.

## Write a delta

```sh
kgdiff before.obo after.obo --delta patch.json
```

writes the delta and still prints the summary; add `-q` to skip it. `kgdiff apply` also accepts
the complete diff that `--json` writes.

## Apply it

```sh
kgdiff apply before.obo patch.json -o patched.json
```

```
✓ Wrote patched graph (115 operations applied, c53:1019a1b806733b) patched.json (79 kB)
```

`kgdiff apply` writes the patched graph as [kgdiff JSON](../formats.md#kgdiff-json), which
kgdiff reads back losslessly. Check it against the target:

```sh
kgdiff after.obo patched.json --exit-code -q && echo identical
```

## The base must match

A delta applies only to its base. kgdiff compares content hashes first and refuses any other
graph, with exit code 2:

```
$ kgdiff apply after.obo patch.json -o patched.json
error: <graph> "after.obo" is not the base of this delta (graph c53:1019a1b806733b, delta base c53:099a5149fa1cd6).
hint: If it is the same graph, parse it as when the delta was made: --format and --lang must match the options given to `kgdiff … --delta` (they change what the graph contains). Otherwise --no-strict applies what fits and reports the rest.
```

Parse options matter because they change what the graph contains: a different `--lang` picks
other labels. `--no-strict` applies every operation whose precondition holds and reports how many
were skipped on standard error; `--verbose` lists them.

## Invert it

The CLI applies deltas forwards. In code, `invertDelta` gives the inverse:

```ts
import { readFile } from 'node:fs/promises';
import { applyDelta, invertDelta, normalize } from '@kgdiff/core';
import { parseGraph } from '@kgdiff/compute';

const delta = JSON.parse(await readFile('patch.json', 'utf8'));
const after = await parseGraph(await readFile('after.obo', 'utf8'), { filename: 'after.obo' });
const before = applyDelta(normalize(after.graph), invertDelta(delta));
```

## Uses

- Publish an update as a patch, and let users check that their copy is exactly the release it
  was made for.
- Keep the changes a review accepted: the viewer's `exportDelta()` returns the delta of the
  current diff.
- Undo a change with its inverse.

`kgdiff apply` writes kgdiff JSON; it does not write Turtle or OBO back.

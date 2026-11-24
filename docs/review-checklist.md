# Review checklist

Every change is reviewed against this list — by its author before handing it over, and again
by an independent reviewer. "Done" means every applicable box is true.

## Correctness

- [ ] Behaviour matches the contract in `src/index.ts` and the specs in `docs/`.
- [ ] Edge cases covered: empty graphs, single node, self-loops, parallel edges, unicode / CJK
      labels, very long labels, ids with special characters (`|`, quotes, spaces, IRIs), cycles,
      disconnected components, identical inputs.
- [ ] Deterministic: shuffled inputs give identical output; no `Math.random` / `Date.now` in
      results.
- [ ] No mutation of inputs; returned data is immutable in practice (frozen in tests where cheap).
- [ ] Errors are `KgdiffError` with a stable code and an actionable message.

## Tests

- [ ] Unit tests for every public function, including failure modes.
- [ ] Property-based tests where an invariant exists (round trips, symmetry, idempotence).
- [ ] Tests read like a specification (names describe behaviour, not implementation).
- [ ] `pnpm vitest run packages/<pkg>` green; no skipped or focused tests.

## Performance

- [ ] Meets the budgets in `docs/architecture.md`; a benchmark (`test/*.bench.ts`, `pnpm bench`)
      exists for hot paths, and unit tests assert no wall-clock times.
- [ ] No accidental O(n²) on the number of nodes / edges (nested loops over all elements).
- [ ] Hot loops allocation-free where the spec asks for it (resolver, renderer).
- [ ] No data-sized array is spread into a call (`xs.push(...ys)`, `Math.max(...ys)`): argument
      counts are limited by the stack (~100k elements) and overflow with `RangeError`; loop instead.

## API and code quality

- [ ] Public API is minimal, named consistently, and documented with TSDoc (defaults, units,
      complexity where non-obvious).
- [ ] No `any`; no non-null assertions that can fail; exhaustive `switch` with `never` checks.
- [ ] Small focused modules; no dead code; comments explain _why_, not _what_.
- [ ] `pnpm typecheck` and `pnpm lint` clean for the package.
- [ ] No new runtime dependency without justification.

## Visual and interaction (renderer, viewer, site)

- [ ] Matches `docs/visual-language.md` and `docs/interaction.md` exactly (tokens, encodings,
      LOD, motion).
- [ ] Crisp at DPR 1, 2, 3; no blurry text; no layout shift.
- [ ] Light and dark themes both polished; color-blind palette works.
- [ ] Keyboard-operable; visible focus; ARIA roles / names; reduced motion respected.
- [ ] 60 fps interactions at the budgeted size; idle CPU ~0 (render loop sleeps).
- [ ] Empty, loading and error states designed, not accidental.

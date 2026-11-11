---
'@kgdiff/viewer': minor
'@kgdiff/cli': minor
---

Remove three compatibility paths. Breaking before 1.0:

- **GitHub Action: `version` below 0.8.0.** Before 0.8.0 `@kgdiff/cli` was a TypeScript CLI without
  platform packages, and the action ran it with `npx`. The action now runs only the native
  kgdiff, so a `version` input that resolves to a release before 0.8.0 fails with an error that
  names the minimum. A runner with no native build for it also fails, with its own error, instead
  of falling back to `npx`. To keep using an older version, pin an earlier release of the
  action: `iiwish/kgdiff@v0.7.0`. The default (the action's own release) is not affected.
- **Viewer: the mode `changes`.** Before scopes existed, "only the changes" was a fourth mode.
  `mode="changes"` (attribute or property), `mode:changes` in `sync-hash` deep links and
  `view.mode: "changes"` in a report's payload were read as `overlay` plus scope `changes`; they
  are now unknown values, like any other: the attribute and the property use the default,
  `overlay`; a deep link drops that field; a report's `view` drops it and the viewer logs a
  warning. The scope is not implied any more. Write `mode="overlay" scope="changes"`. The
  TypeScript types of `mode` and `setMode` no longer accept `'changes'`.
- **Site playground.** Links with `mode=changes` open in the default mode; use `mode=overlay` and
  `scope=changes`.

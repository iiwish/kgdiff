---
"@kgdiff/cli": patch
---

The GitHub Action runs the native kgdiff directly. From 0.8.0 on, it resolves its `version` input on npm, downloads the platform package of that version for the runner with `npm pack`, checks it against the integrity the npm registry publishes, and runs its binary for every file, with no npm process per comparison. Versions before 0.8.0 still run with `npx`. `KGDIFF_BINARY` in the step's environment runs another binary instead.

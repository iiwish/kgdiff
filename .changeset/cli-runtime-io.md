---
'@kgdiff/cli': patch
---

The bug report link of an unexpected error takes the platform and the Node.js version from `CliIO.runtime` instead of reading `process` in `main`, so `main` keeps taking every side effect from `io` and runs in hosts other than Node.js. `nodeIO()` fills it in, so the link is unchanged for the `kgdiff` command; a custom `io` without `runtime` gets a link that names only the CLI version.

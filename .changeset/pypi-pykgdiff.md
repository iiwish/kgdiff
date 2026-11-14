---
'@kgdiff/cli': patch
---

kgdiff installs from PyPI too, without Node.js or Rust: `pipx install pykgdiff` (or `uv tool install pykgdiff`, `pip install pykgdiff`), or `uvx --from pykgdiff kgdiff a.ttl b.ttl` without installing. The wheels hold the same native `kgdiff` as `@kgdiff/cli`, for macOS, Linux (glibc and musl) and Windows, and only the command line: there is no Python API yet, and `import pykgdiff` is kept for one after 1.0.

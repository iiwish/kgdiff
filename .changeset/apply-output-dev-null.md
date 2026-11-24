---
'@kgdiff/cli': patch
---

`kgdiff` can write its outputs to `/dev/null`, a named pipe or another file that is not a regular file. `kgdiff apply … -o /dev/null` failed with "operation not permitted", because every output was written to a temporary file that was then renamed over the target, and a device cannot be replaced that way; this kept `apply --verify-target -o /dev/null` from checking a delta without keeping the result. Such a target is now opened and written in place; regular files and new files are still written atomically. The same holds for `-o`, `--json`, `--delta` and `--markdown` of a diff.

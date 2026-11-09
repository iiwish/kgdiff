---
'@kgdiff/formats': minor
---

Numbers beyond the range of a double in JSON graphs are kept instead of lost. JSON may write `1e400`, which `JSON.parse` reads as `Infinity`; the JSON reader used to drop such a number without a word (an attribute or `meta` member disappeared, an array item became `null`), so a diff could report nothing for a value that changed, or a change that did not happen. It now keeps the value as the string `"Infinity"` or `"-Infinity"`, as `normalize` keeps a non-finite number an API caller passes, and reports how many with a `json-non-finite` warning (`ParseWarningCode`), in every JSON dialect.

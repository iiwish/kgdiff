---
"@kgdiff/layout": minor
---

`layoutToJSON` writes a layout read from version 2 back as version 2, with its `generator` (RFC 0002, D-3). Before, it wrote version 1 and dropped the `generator`, so a layout of kgdiff's Rust engine that went through `layoutFromJSON` and `layoutToJSON` no longer said which engine computed its positions. Layouts this package computes, and layouts `extendLayout` added a node to, are still written as version 1. Version 2 has the member order of the Rust engine's documents (`format`, `version`, `generator`, then version 1's members), so `layoutToJSON(layoutFromJSON(json))` reproduces `json` of either version. Types: `layoutToJSON` returns `LayoutJSON` (`LayoutJSONV1 | LayoutJSONV2`) instead of `LayoutJSONV1`; code that needs version 1 checks `version`.

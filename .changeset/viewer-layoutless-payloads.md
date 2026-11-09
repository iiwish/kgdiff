---
'@kgdiff/viewer': minor
---

Report payloads may leave their layout out. `ReportPayload.layout` is optional: a payload without one (the member left out) is laid out in the browser when the viewer reads it, with `layoutDiff`'s default options, so an application that computed a diff itself can show it by passing its `diff.v1` JSON as a payload. The ESM build imports the compute module on demand for it; the standalone viewer takes it from the `@kgdiff/viewer/standalone/compute` add-on (`globalThis.KgdiffCompute`), and without the add-on shows an error that says what is missing instead of failing to read the layout. The diff engine never runs for a payload, and payloads with a layout open exactly as before, without loading the compute module. A `layout` that is present but not an object (`null`, for instance) is rejected. The CLI keeps writing the layout into its reports.

/**
 * What `@kgdiff/core`, `@kgdiff/formats` and `@kgdiff/layout` see of `@kgdiff/compute` when they
 * are type-checked and built. `@kgdiff/compute` depends on those three packages, and they import
 * it with a dynamic `import()` typed by an interface of their own, so this stands in for it:
 * building them does not need `@kgdiff/compute` built first, and their programs do not include
 * its sources (written for the DOM's `fetch` types). Vitest, Vite and every bundler resolve the
 * real package; compute's tests check that it provides each package's interface.
 */
export {};

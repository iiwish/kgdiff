/**
 * What `@kgdiff/core` and `@kgdiff/layout` see of `@kgdiff/compute` when they are built.
 * `@kgdiff/compute` depends on those two packages, and they import it with a dynamic `import()`
 * typed by an interface of their own, so this stands in for it: building them does not need
 * `@kgdiff/compute` built first. Vitest, Vite and every bundler resolve the real package;
 * compute's tests check that it provides each package's interface.
 */
export {};

/**
 * The loader of `layout.wasm`, shared by `@kgdiff/compute` and `@kgdiff/compute/layout` (one
 * module instance for both entry points) and exported by neither.
 */
import type * as Glue from '../wasm/layout.js';
import { Module } from './loader.js';

export const layoutModule = new Module<typeof Glue>(
  'layout',
  () => import('../wasm/layout.js'),
  () => new URL('../wasm/layout.wasm', import.meta.url),
);

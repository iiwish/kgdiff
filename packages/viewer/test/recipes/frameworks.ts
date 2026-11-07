/**
 * Compile the Vue and Svelte recipes (`GraphDiff.vue`, `GraphDiff.svelte`) with their own
 * compilers, as a bundler's plugin would, into modules the test imports: what the docs show is
 * what runs.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';
import { compileScript, parse } from 'vue/compiler-sfc';

// Paths, not URLs: under happy-dom the global `URL` is not the one `node:fs` takes.
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '.out');

/** The recipe file's text. */
export const recipe = (name: string): string => readFileSync(join(here, name), 'utf8');

function write(name: string, code: string): string {
  mkdirSync(out, { recursive: true });
  const file = join(out, name);
  writeFileSync(file, code);
  return file;
}

/**
 * `GraphDiff.vue` as a module, with the compiler option the recipe sets in `vite.config.js`:
 * `kgdiff-*` tags are custom elements.
 */
export function compileVue(): string {
  const { descriptor, errors } = parse(recipe('GraphDiff.vue'), { filename: 'GraphDiff.vue' });
  if (errors.length > 0) throw errors[0];
  const script = compileScript(descriptor, {
    id: 'graph-diff',
    inlineTemplate: true,
    templateOptions: {
      compilerOptions: { isCustomElement: (tag: string) => tag.startsWith('kgdiff-') },
    },
  });
  return write('GraphDiff.vue.ts', script.content);
}

/** `GraphDiff.svelte` as a client module. */
export function compileSvelte(): string {
  const result = compile(recipe('GraphDiff.svelte'), {
    filename: 'GraphDiff.svelte',
    generate: 'client',
  });
  if (result.warnings.length > 0) throw new Error(result.warnings.map((w) => w.message).join('\n'));
  return write('GraphDiff.svelte.js', result.js.code);
}

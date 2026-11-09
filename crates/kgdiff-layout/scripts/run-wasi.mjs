// Runs a wasm32-wasip1 build of an example under Node's WASI, with the conformance corpus
// mounted at /corpus: `node run-wasi.mjs <module.wasm> <conformance directory>`. The `targets`
// CI job runs `examples/corpus_hashes.rs` this way.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';

const [module, corpus] = process.argv.slice(2);
if (module === undefined || corpus === undefined) {
  console.error('usage: node run-wasi.mjs <module.wasm> <conformance directory>');
  process.exit(2);
}
const wasi = new WASI({
  version: 'preview1',
  args: ['corpus_hashes', '/corpus'],
  preopens: { '/corpus': corpus },
  returnOnExit: true,
});
const compiled = await WebAssembly.compile(await readFile(module));
const instance = await WebAssembly.instantiate(compiled, wasi.getImportObject());
process.exitCode = wasi.start(instance);

/**
 * What the three modules share: loading one (fetched in browsers, read from the package in Node,
 * or given by the caller) and turning the failures they throw into `KgdiffError`s.
 */
import { KgdiffError, type KgdiffErrorCode } from '@kgdiff/core';

/** Where a module comes from: a URL or path to fetch, its bytes, or a compiled module. */
export type InitSource = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

interface Glue {
  default(input: { module_or_path: InitSource | Promise<InitSource> }): Promise<unknown>;
}

/** One WebAssembly module: compiled at most once, however many callers ask at the same time. */
export class Module<T extends Glue> {
  private engine: T | undefined;
  private loading: Promise<T> | undefined;

  constructor(
    private readonly label: string,
    private readonly glue: () => Promise<T>,
    private readonly url: () => URL,
  ) {}

  get loaded(): boolean {
    return this.engine !== undefined;
  }

  async init(source?: InitSource): Promise<void> {
    if (this.engine !== undefined) return;
    this.loading ??= this.load(source).catch((error: unknown) => {
      this.loading = undefined;
      throw error;
    });
    this.engine = await this.loading;
  }

  private async load(source: InitSource | undefined): Promise<T> {
    const glue = await this.glue();
    let input: InitSource = source ?? this.url();
    if (input instanceof URL && input.protocol === 'file:') {
      // Node's fetch does not read files. Not a literal, so that bundlers for browsers leave it.
      const fs = 'node:fs/promises';
      const { readFile } = (await import(
        /* @vite-ignore */ fs
      )) as typeof import('node:fs/promises');
      input = await readFile(input);
    }
    await glue.default({ module_or_path: input });
    return glue;
  }

  /** Runs `use` on the module, failures as `KgdiffError`s. */
  call<R>(use: (engine: T) => R): R {
    if (this.engine === undefined) {
      throw new Error(
        `@kgdiff/compute: the ${this.label} module is not initialized: await init() first`,
      );
    }
    try {
      return use(this.engine);
    } catch (error) {
      throw failure(error);
    }
  }
}

/** A failure of the engine, thrown as `{ code, message, details }` text, as a KgdiffError. */
function failure(error: unknown): unknown {
  if (typeof error !== 'string') return error;
  try {
    const { code, message, details } = JSON.parse(error) as {
      code: KgdiffErrorCode;
      message: string;
      details?: Record<string, unknown>;
    };
    return new KgdiffError(code, message, details);
  } catch {
    return new Error(error);
  }
}

/**
 * Keeps the version of the Rust workspace at the version the npm packages share (one fixed
 * Changesets group; RFC 0002, §8, "One version, four registries"): the `[workspace.package]`
 * version of Cargo.toml, and the entries of the workspace's own crates in Cargo.lock.
 * `pnpm version-packages` runs it after `changeset version`:
 *
 *   pnpm tsx scripts/sync-versions.ts
 *
 * tests/release.test.ts fails when they drift apart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagesVersion } from './sync-citation.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const CARGO_TOML = join(ROOT, 'Cargo.toml');
export const CARGO_LOCK = join(ROOT, 'Cargo.lock');

/** The `[workspace.package]` table of a Cargo.toml: from its header to the next table. */
const WORKSPACE_PACKAGE = /^\[workspace\.package\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/m;
const VERSION_LINE = /^version[ \t]*=[ \t]*"([^"]*)"/m;

/** The version of `[workspace.package]`, or `undefined`. */
export function workspaceVersion(cargoToml: string): string | undefined {
  const table = WORKSPACE_PACKAGE.exec(cargoToml)?.[0];
  return table === undefined ? undefined : VERSION_LINE.exec(table)?.[1];
}

/** `cargoToml` with the version of `[workspace.package]` set to `version`. */
export function withWorkspaceVersion(cargoToml: string, version: string): string {
  const table = WORKSPACE_PACKAGE.exec(cargoToml)?.[0];
  if (table === undefined || !VERSION_LINE.test(table)) {
    throw new Error('Cargo.toml has no `version` in `[workspace.package]`.');
  }
  return cargoToml.replace(table, table.replace(VERSION_LINE, `version = "${version}"`));
}

/**
 * The packages of a Cargo.lock that belong to the workspace: those without a `source` (crates
 * from a registry or git have one), with their versions.
 */
export function lockedWorkspaceCrates(cargoLock: string): { name: string; version: string }[] {
  return cargoLock
    .split(/^(?=\[\[package\]\]$)/m)
    .filter((block) => block.startsWith('[[package]]') && !/^source[ \t]*=/m.test(block))
    .map((block) => ({
      name: /^name[ \t]*=[ \t]*"([^"]*)"/m.exec(block)?.[1] ?? '',
      version: VERSION_LINE.exec(block)?.[1] ?? '',
    }));
}

/** `cargoLock` with the workspace's own crates at `version`. */
export function withLockedVersion(cargoLock: string, version: string): string {
  return cargoLock
    .split(/^(?=\[\[package\]\]$)/m)
    .map((block) =>
      block.startsWith('[[package]]') && !/^source[ \t]*=/m.test(block)
        ? block.replace(VERSION_LINE, `version = "${version}"`)
        : block,
    )
    .join('');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = packagesVersion();
  for (const [file, update] of [
    [CARGO_TOML, withWorkspaceVersion],
    [CARGO_LOCK, withLockedVersion],
  ] as const) {
    const text = readFileSync(file, 'utf8');
    const next = update(text, version);
    if (next !== text) writeFileSync(file, next);
  }
}

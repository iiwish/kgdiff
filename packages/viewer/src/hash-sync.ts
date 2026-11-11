/**
 * Deep links for `sync-hash`: `#kgdiff=hunk:<id>;mode:<mode>;scope:<scope>`.
 *
 * Values are percent-encoded (hunk ids embed union ids, which may be IRIs containing `;`, `#`
 * or `:`), so parsing splits on the first `:` of each `;`-separated field. Unknown fields are
 * ignored; a malformed value drops just that field.
 */
import type { ViewerMode, ViewerScope } from './index.js';
import { toMode, toScope } from './prefs.js';

export interface HashState {
  readonly hunk?: string;
  readonly mode?: ViewerMode;
  readonly scope?: ViewerScope;
}

const PREFIX = 'kgdiff=';

export function isViewerMode(value: unknown): value is ViewerMode {
  return toMode(value) !== null;
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** Parse a location hash (with or without `#`). Returns null when it is not a kgdiff link. */
export function parseHash(hash: string): HashState | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.startsWith(PREFIX)) return null;
  let hunk: string | undefined;
  let mode: ViewerMode | undefined;
  let scope: ViewerScope | undefined;
  for (const field of raw.slice(PREFIX.length).split(';')) {
    const colon = field.indexOf(':');
    if (colon <= 0) continue;
    const key = field.slice(0, colon);
    const value = decode(field.slice(colon + 1));
    if (value === undefined || value === '') continue;
    if (key === 'hunk') hunk = value;
    else if (key === 'mode') mode = toMode(value) ?? mode;
    else if (key === 'scope') scope = toScope(value) ?? scope;
  }
  return {
    ...(hunk !== undefined ? { hunk } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(scope !== undefined ? { scope } : {}),
  };
}

/** Encode `state` as a hash (`#kgdiff=…`); empty state gives `#kgdiff=`. */
export function formatHash(state: HashState): string {
  const fields: string[] = [];
  if (state.hunk !== undefined) fields.push(`hunk:${encodeURIComponent(state.hunk)}`);
  if (state.mode !== undefined) fields.push(`mode:${state.mode}`);
  if (state.scope !== undefined) fields.push(`scope:${state.scope}`);
  return `#${PREFIX}${fields.join(';')}`;
}

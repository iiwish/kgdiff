/**
 * The keyboard map (docs/interaction.md §Keyboard map), as a pure function from a key event to
 * an action, so it can be tested without a DOM.
 */
import type { ViewerMode, ViewerScope } from './index.js';

export type KeyAction =
  | { readonly type: 'mode'; readonly mode: ViewerMode }
  | { readonly type: 'scope' }
  | { readonly type: 'next' }
  | { readonly type: 'prev' }
  | { readonly type: 'first' }
  | { readonly type: 'last' }
  | { readonly type: 'fly' }
  | { readonly type: 'escape' }
  | { readonly type: 'play-pause' }
  | { readonly type: 'step'; readonly direction: 1 | -1 }
  | { readonly type: 'divider'; readonly delta: number }
  | { readonly type: 'fit' }
  | { readonly type: 'zoom'; readonly direction: 1 | -1 }
  | { readonly type: 'search' }
  | { readonly type: 'review' }
  | { readonly type: 'sidebar' }
  | { readonly type: 'theme' }
  | { readonly type: 'expand' }
  | { readonly type: 'help' };

export interface KeyLike {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

/** Divider steps for swipe, as a fraction of the width. */
export const DIVIDER_STEP = 0.02;
export const DIVIDER_STEP_LARGE = 0.1;

/**
 * The shortcuts a key can be bound to (`keymap`). `left` / `right` step the replay, or move the
 * swipe divider (further with Shift); `play-pause` acts in replay, `expand` with the `changes`
 * scope.
 */
export type ShortcutName =
  | 'overlay'
  | 'swipe'
  | 'replay'
  | 'scope'
  | 'expand'
  | 'next'
  | 'prev'
  | 'first'
  | 'last'
  | 'fly'
  | 'escape'
  | 'play-pause'
  | 'left'
  | 'right'
  | 'fit'
  | 'zoom-in'
  | 'zoom-out'
  | 'search'
  | 'review'
  | 'sidebar'
  | 'theme'
  | 'help';

/**
 * Keys (as `KeyboardEvent.key`) bound to a shortcut, or to `null` to leave the key unbound. A
 * letter stands for both its cases (`x` also binds Shift+x, `X`) unless the other case is named
 * too.
 */
export type Keymap = Readonly<Record<string, ShortcutName | null>>;

/** The default keyboard map (docs/interaction.md §Keyboard map); each letter once. */
export const DEFAULT_KEYMAP: Keymap = {
  '1': 'overlay',
  '2': 'swipe',
  '3': 'replay',
  '4': 'scope',
  j: 'next',
  ArrowDown: 'next',
  k: 'prev',
  ArrowUp: 'prev',
  Home: 'first',
  End: 'last',
  Enter: 'fly',
  Escape: 'escape',
  ' ': 'play-pause',
  Spacebar: 'play-pause',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  f: 'fit',
  '+': 'zoom-in',
  '=': 'zoom-in',
  '-': 'zoom-out',
  _: 'zoom-out',
  '−': 'zoom-out',
  '/': 'search',
  x: 'review',
  '\\': 'sidebar',
  t: 'theme',
  e: 'expand',
  '?': 'help',
};

/** Every shortcut (each is bound to a key by default). */
export const SHORTCUT_NAMES: ReadonlySet<string> = new Set(
  Object.values(DEFAULT_KEYMAP).filter((name) => name !== null),
);

/** What `name` does in `mode` and `scope`, or null when it does nothing there. */
function resolve(
  name: ShortcutName,
  e: KeyLike,
  mode: ViewerMode,
  scope: ViewerScope,
): KeyAction | null {
  switch (name) {
    case 'overlay':
    case 'swipe':
    case 'replay':
      return { type: 'mode', mode: name };
    case 'scope':
      return { type: 'scope' };
    case 'expand':
      return scope === 'changes' ? { type: 'expand' } : null;
    case 'play-pause':
      return mode === 'replay' ? { type: 'play-pause' } : null;
    case 'left':
    case 'right': {
      const direction = name === 'right' ? 1 : -1;
      if (mode === 'replay') return { type: 'step', direction };
      if (mode === 'swipe') {
        return {
          type: 'divider',
          delta: direction * (e.shiftKey ? DIVIDER_STEP_LARGE : DIVIDER_STEP),
        };
      }
      return null;
    }
    case 'zoom-in':
    case 'zoom-out':
      return { type: 'zoom', direction: name === 'zoom-in' ? 1 : -1 };
    default:
      return { type: name };
  }
}

/**
 * What `map` binds `key` to: the key itself, else the other case of a letter; undefined when
 * `map` names neither.
 */
function lookup(map: Keymap, key: string): ShortcutName | null | undefined {
  if (Object.hasOwn(map, key)) return map[key];
  const lower = key.toLowerCase();
  const other = key === lower ? key.toUpperCase() : lower;
  return key.length === 1 && other !== key && Object.hasOwn(map, other) ? map[other] : undefined;
}

/**
 * Map a key press to an action in `mode` and `scope`, or null when the key means nothing here.
 * `keymap` overrides single keys of the default map (null unbinds one); a letter in either map
 * stands for both its cases unless the other case is named too. Chords with Ctrl / Meta / Alt
 * are never handled (they belong to the browser and the host page).
 */
export function keyAction(
  e: KeyLike,
  mode: ViewerMode,
  scope: ViewerScope = 'all',
  keymap: Keymap | null = null,
): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const custom = keymap === null ? undefined : lookup(keymap, e.key);
  const name = custom === undefined ? lookup(DEFAULT_KEYMAP, e.key) : custom;
  return name ? resolve(name, e, mode, scope) : null;
}

/** `Space` names the space bar in a `keymap` attribute. */
const KEY_NAMES: Readonly<Record<string, string>> = { Space: ' ' };

/**
 * A keymap from an attribute (`"x:none r:review"`: `key:shortcut` pairs separated by spaces,
 * `none` unbinds a key, `Space` is the space bar) or a property (an object of the same pairs).
 * Pairs that name no shortcut are left out and returned in `invalid`.
 */
export function toKeymap(value: unknown): { keymap: Keymap | null; invalid: string[] } {
  const invalid: string[] = [];
  const out: Record<string, ShortcutName | null> = {};
  const add = (key: string, name: unknown, raw: string): void => {
    const k = KEY_NAMES[key] ?? key;
    if (k === '' || !(name === null || name === 'none' || SHORTCUT_NAMES.has(name as string))) {
      invalid.push(raw);
    } else out[k] = name === null || name === 'none' ? null : (name as ShortcutName);
  };
  if (typeof value === 'string') {
    for (const token of value.split(/\s+/)) {
      if (token === '') continue;
      const at = token.lastIndexOf(':');
      if (at <= 0) invalid.push(token);
      else add(token.slice(0, at), token.slice(at + 1), token);
    }
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, name] of Object.entries(value)) add(key, name, `${key}:${String(name)}`);
  } else return { keymap: null, invalid };
  return { keymap: Object.keys(out).length > 0 ? out : null, invalid };
}

/** Whether a key event comes from a place where the user types (shortcuts must not fire). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof (target as Element).tagName !== 'string') return false;
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type ?? 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(
      type,
    );
  }
  return el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true';
}

import { describe, expect, it } from 'vitest';
import {
  DIVIDER_STEP,
  DIVIDER_STEP_LARGE,
  isTypingTarget,
  keyAction,
  shortcutKeys,
} from '../src/keyboard.js';

describe('keyboard map', () => {
  it('maps the documented keys', () => {
    const cases: [string, object | null][] = [
      ['1', { type: 'mode', mode: 'overlay' }],
      ['2', { type: 'mode', mode: 'swipe' }],
      ['3', { type: 'mode', mode: 'replay' }],
      ['4', { type: 'scope' }],
      ['j', { type: 'next' }],
      ['ArrowDown', { type: 'next' }],
      ['k', { type: 'prev' }],
      ['ArrowUp', { type: 'prev' }],
      ['Home', { type: 'first' }],
      ['End', { type: 'last' }],
      ['Enter', { type: 'fly' }],
      ['Escape', { type: 'escape' }],
      ['f', { type: 'fit' }],
      ['+', { type: 'zoom', direction: 1 }],
      ['=', { type: 'zoom', direction: 1 }],
      ['-', { type: 'zoom', direction: -1 }],
      ['/', { type: 'search' }],
      ['x', { type: 'review' }],
      ['\\', { type: 'sidebar' }],
      ['t', { type: 'theme' }],
      ['?', { type: 'help' }],
      ['q', null],
    ];
    for (const [key, action] of cases) expect(keyAction({ key }, 'overlay'), key).toEqual(action);
  });

  it('space and arrows depend on the mode', () => {
    expect(keyAction({ key: ' ' }, 'overlay')).toBeNull();
    expect(keyAction({ key: ' ' }, 'replay')).toEqual({ type: 'play-pause' });
    expect(keyAction({ key: 'ArrowRight' }, 'replay')).toEqual({ type: 'step', direction: 1 });
    expect(keyAction({ key: 'ArrowLeft' }, 'replay')).toEqual({ type: 'step', direction: -1 });
    expect(keyAction({ key: 'ArrowRight' }, 'swipe')).toEqual({
      type: 'divider',
      delta: DIVIDER_STEP,
    });
    expect(keyAction({ key: 'ArrowLeft', shiftKey: true }, 'swipe')).toEqual({
      type: 'divider',
      delta: -DIVIDER_STEP_LARGE,
    });
    expect(keyAction({ key: 'ArrowLeft' }, 'overlay')).toBeNull();
  });

  it('binds a letter in both cases, also in a keymap, unless the other case is named', () => {
    for (const key of ['F', 'X', 'T', 'J', 'K'])
      expect(keyAction({ key }, 'overlay'), key).not.toBeNull();
    expect(keyAction({ key: 'E' }, 'overlay', 'changes')).toEqual({ type: 'expand' });
    // Unbinding a letter unbinds Shift+letter too.
    for (const key of ['x', 'X'])
      expect(keyAction({ key }, 'overlay', 'all', { x: null })).toBeNull();
    expect(keyAction({ key: 'T' }, 'overlay', 'all', { t: null })).toBeNull();
    // An upper-case entry covers the lower case the same way.
    expect(keyAction({ key: 'r' }, 'overlay', 'all', { R: 'review' })).toEqual({ type: 'review' });
    // Naming the other case keeps them apart.
    const apart = { x: null, X: 'review' } as const;
    expect(keyAction({ key: 'x' }, 'overlay', 'all', apart)).toBeNull();
    expect(keyAction({ key: 'X' }, 'overlay', 'all', apart)).toEqual({ type: 'review' });
    // Keys that are not single letters are taken as they are.
    expect(keyAction({ key: 'arrowdown' }, 'overlay')).toBeNull();
  });

  it('leaves browser chords alone', () => {
    expect(keyAction({ key: 'f', metaKey: true }, 'overlay')).toBeNull();
    expect(keyAction({ key: '1', ctrlKey: true }, 'overlay')).toBeNull();
    expect(keyAction({ key: 'j', altKey: true }, 'overlay')).toBeNull();
  });

  it('detects typing targets', () => {
    const input = document.createElement('input');
    expect(isTypingTarget(input)).toBe(true);
    input.type = 'checkbox';
    expect(isTypingTarget(input)).toBe(false);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    expect(isTypingTarget(div)).toBe(true);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('shortcutKeys', () => {
  it('lists the default keys once each, aliases left out', () => {
    const keys = shortcutKeys(null);
    expect(keys.get('overlay')).toEqual(['1']);
    expect(keys.get('next')).toEqual(['j', 'ArrowDown']);
    expect(keys.get('zoom-in')).toEqual(['+']);
    expect(keys.get('zoom-out')).toEqual(['-']);
    expect(keys.get('play-pause')).toEqual([' ']);
    expect(keys.size).toBe(22);
  });

  it('follows keymap: rebinds, unbinds, both cases of a letter', () => {
    const keys = shortcutKeys({ x: null, r: 'review', '2': null, X: 'theme', '=': 'fit' });
    expect(keys.get('review')).toEqual(['r']);
    expect(keys.has('swipe')).toBe(false);
    // x is unbound, and X, named too, is a key of its own.
    expect(keys.get('theme')).toEqual(['t', 'X']);
    // A letter alone stands for both its cases, listed once.
    expect(shortcutKeys({ X: 'theme' }).get('theme')).toEqual(['x', 't']);
    expect(shortcutKeys({ X: 'theme' }).has('review')).toBe(false);
    // An alias bound to something else is a key of its own.
    expect(keys.get('fit')).toEqual(['f', '=']);
    expect(keys.get('zoom-in')).toEqual(['+']);
  });
});

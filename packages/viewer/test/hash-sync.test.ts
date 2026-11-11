import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatHash, isViewerMode, parseHash } from '../src/hash-sync.js';

describe('hash sync', () => {
  it('parses hunk, mode and scope', () => {
    expect(parseHash('#kgdiff=hunk:merge%3ALEGAL_REP;mode:replay')).toEqual({
      hunk: 'merge:LEGAL_REP',
      mode: 'replay',
    });
    expect(parseHash('kgdiff=mode:swipe')).toEqual({ mode: 'swipe' });
    expect(parseHash('#kgdiff=mode:replay;scope:changes')).toEqual({
      mode: 'replay',
      scope: 'changes',
    });
    expect(parseHash('#kgdiff=scope:all')).toEqual({ scope: 'all' });
  });

  it('ignores the removed changes mode, keeping the other fields', () => {
    expect(parseHash('#kgdiff=hunk:a;mode:changes')).toEqual({ hunk: 'a' });
    expect(parseHash('#kgdiff=mode:changes;scope:all')).toEqual({ scope: 'all' });
  });

  it('ignores foreign hashes, unknown fields, bad modes and bad encodings', () => {
    expect(parseHash('#section-2')).toBeNull();
    expect(parseHash('')).toBeNull();
    expect(parseHash('#kgdiff=')).toEqual({});
    expect(parseHash('#kgdiff=mode:sideways;scope:some;zoom:3;hunk:%E0%A4%A')).toEqual({});
    expect(parseHash('#kgdiff=hunk:;mode:;scope:')).toEqual({});
  });

  it('round-trips ids with IRI characters, CJK and separators', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.constantFrom('overlay', 'swipe', 'replay' as const),
        fc.constantFrom('all', 'changes' as const),
        (hunk, mode, scope) => {
          expect(parseHash(formatHash({ hunk, mode, scope }))).toEqual({ hunk, mode, scope });
        },
      ),
    );
    const id = 'modify:http://ex.org/a#b;c?d=e 企业「x」';
    expect(parseHash(formatHash({ hunk: id }))).toEqual({ hunk: id });
  });

  it('validates modes', () => {
    expect(isViewerMode('swipe')).toBe(true);
    // A scope now, not a mode (deep links still accept it, see above).
    expect(isViewerMode('changes')).toBe(false);
    expect(isViewerMode('Swipe')).toBe(false);
    expect(isViewerMode(null)).toBe(false);
  });
});

import { getTheme } from '@kgdiff/scene';
import { describe, expect, it } from 'vitest';
import { composite, glowGradient, parseColor, withAlpha } from '../src/color.js';

describe('parseColor', () => {
  it('reads hex in 3, 4, 6 and 8 digits', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255, 1]);
    expect(parseColor('#0B0E14')).toEqual([11, 14, 20, 1]);
    expect(parseColor('#00000080')).toEqual([0, 0, 0, 128 / 255]);
    expect(parseColor('#f008')).toEqual([255, 0, 0, 136 / 255]);
  });

  it('reads rgb() / rgba() with commas, spaces and percentages', () => {
    expect(parseColor('rgba(52,211,153,0.16)')).toEqual([52, 211, 153, 0.16]);
    expect(parseColor('rgb(255 0 0 / 50%)')).toEqual([255, 0, 0, 0.5]);
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual([255, 0, 0, 1]);
    expect(parseColor('rgb(   1, 2, 3   )')).toEqual([1, 2, 3, 1]);
  });

  it('rejects a long unclosed rgb( in one pass', () => {
    expect(parseColor(`rgb(${' '.repeat(100_000)}`)).toBeNull();
  });

  it('returns null for anything else', () => {
    for (const s of ['red', '#12', 'rgb(1,2)', 'rgba(a,b,c,d)', 'hsl(0 0% 0%)']) {
      expect(parseColor(s)).toBeNull();
    }
  });
});

describe('composite', () => {
  it('paints a translucent tint over an opaque base', () => {
    expect(composite('rgba(255, 255, 255, 0.5)', '#000000')).toBe('rgb(128, 128, 128)');
  });

  it('returns opaque or unparsable colors unchanged', () => {
    expect(composite('#123456', '#000')).toBe('#123456');
    expect(composite('tomato', '#000')).toBe('tomato');
    expect(composite('rgba(1,2,3,0.5)', 'black')).toBe('rgba(1,2,3,0.5)');
  });

  it('makes every theme badge tint opaque', () => {
    for (const name of ['dark', 'light'] as const) {
      const theme = getTheme(name);
      for (const f of Object.values(theme.family)) {
        expect(parseColor(composite(f.soft, theme.canvas.background))?.[3]).toBe(1);
      }
    }
  });
});

describe('glow', () => {
  it('multiplies alpha into a color', () => {
    expect(withAlpha([1, 2, 3, 0.5], 0.5)).toBe('rgba(1, 2, 3, 0.25)');
  });

  it('builds a closest-side radial gradient with the native falloff', () => {
    const g = glowGradient('#34D399');
    expect(g).toBe(
      'radial-gradient(circle closest-side, rgba(52, 211, 153, 1) 0%, rgba(52, 211, 153, 0.9) 30%, rgba(52, 211, 153, 0.6) 50%, rgba(52, 211, 153, 0.28) 70%, rgba(52, 211, 153, 0.08) 86%, rgba(52, 211, 153, 0) 100%)',
    );
    expect(glowGradient('#34D399')).toBe(g);
    expect(glowGradient('tomato')).toBe('tomato');
  });
});

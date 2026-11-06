/**
 * CSS is the theme's single source of truth (RFC 0001 §6): the built-in themes are token sets
 * that carry every color and font the canvas draws with, and the canvas follows the tokens as
 * computed on the element, host overrides included.
 */
import { getTheme, type PaletteName, type Theme, type ThemeName } from '@kgdiff/scene';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KgdiffViewer } from '../src/element.js';
import '../src/index.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { themeFromStyle, themeVariables, tokenSheet } from '../src/theme.js';
import { mockBackend, tick, zoo } from './support.js';

const COMBOS: readonly [ThemeName, PaletteName][] = [
  ['dark', 'default'],
  ['dark', 'colorblind'],
  ['light', 'default'],
  ['light', 'colorblind'],
];

/** The declarations of a `themeVariables` body, as a computed style would report them. */
function declared(body: string): { getPropertyValue(name: string): string } {
  const map = new Map<string, string>();
  for (const decl of body.split(/;\s*/)) {
    const at = decl.indexOf(':');
    if (at > 0) map.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
  }
  return { getPropertyValue: (name) => map.get(name) ?? '' };
}

/** Every color and font string of a theme, by path. */
function strings(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
}

describe.each(COMBOS)('the %s / %s token set', (name, palette) => {
  const theme = getTheme(name, palette);

  it('gives the canvas back the built-in theme itself (its contrast is tested in scene)', () => {
    expect(themeFromStyle(theme, declared(themeVariables(theme)))).toBe(theme);
  });

  it('has a token for every color and font of the theme', () => {
    const values = new Set(
      themeVariables(theme)
        .split(/;\s*/)
        .map((d) => d.slice(d.indexOf(':') + 1).trim()),
    );
    const visual = strings(theme).filter(([path]) => !['name', 'palette'].includes(path));
    expect(visual.length).toBeGreaterThan(40);
    for (const [path, value] of visual) expect(values.has(value), path).toBe(true);
  });

  it('is one shared stylesheet on :host', () => {
    expect(tokenSheet(theme)).toBe(tokenSheet(theme));
    expect(tokenSheet(theme).cssRules[0]?.cssText).toMatch(/^:host \{/);
  });
});

describe('themeFromStyle', () => {
  const base = getTheme('dark');
  const style = (vars: Record<string, string>) => ({
    getPropertyValue: (n: string) => vars[n] ?? '',
  });

  it('applies overrides, keeping untouched branches and stable identities', () => {
    const a = themeFromStyle(
      base,
      style({ '--kgdiff-accent': '#ff00ff', '--kgdiff-font': 'Serif' }),
    );
    expect(a.accent.base).toBe('#ff00ff');
    expect(a.accent.text).toBe(base.accent.text);
    expect(a.font.family).toBe('Serif');
    expect(a.family).toBe(base.family);
    expect(a.motion).toBe(base.motion);
    expect(
      themeFromStyle(base, style({ '--kgdiff-accent': '#ff00ff', '--kgdiff-font': 'Serif' })),
    ).toBe(a);
  });

  it('ignores a value the canvas cannot draw, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(themeFromStyle(base, style({ '--kgdiff-added': 'not-a-color' }))).toBe(base);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe('<kgdiff-viewer> theming', () => {
  // Overrides are set inline here: happy-dom lets `:host` win over page rules, browsers do not
  // (page styles win over :host; both reach the computed style the canvas reads).
  let backend: ReturnType<typeof mockBackend>;

  beforeEach(() => {
    backend = mockBackend();
    setRenderBackend(backend);
  });

  afterEach(() => {
    document.body.textContent = '';
    setRenderBackend(null);
  });

  async function loaded(
    attrs: Record<string, string> = {},
    tokens: Record<string, string> = {},
  ): Promise<KgdiffViewer> {
    const el = document.createElement('kgdiff-viewer') as KgdiffViewer;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    for (const [k, v] of Object.entries(tokens)) el.style.setProperty(k, v);
    document.body.append(el);
    await el.load(zoo());
    await tick();
    return el;
  }

  it('sets the built-in token set on :host and draws with the built-in theme', async () => {
    const el = await loaded({ theme: 'light' });
    const sheets = el.shadowRoot?.adoptedStyleSheets ?? [];
    expect(sheets).toHaveLength(2);
    expect(sheets[1]).toBe(tokenSheet(getTheme('light')));
    expect(getComputedStyle(el).getPropertyValue('--kgdiff-accent')).toBe('#3B5BDB');
    expect(backend.last().theme).toBe(getTheme('light'));
    el.palette = 'colorblind';
    expect(el.shadowRoot?.adoptedStyleSheets[1]).toBe(tokenSheet(getTheme('light', 'colorblind')));
    expect(backend.last().theme).toBe(getTheme('light', 'colorblind'));
  });

  it('draws the canvas with the tokens the host overrides, on connect and on refresh', async () => {
    const el = await loaded({ theme: 'dark' }, { '--kgdiff-accent': '#ff00ff' });
    expect(backend.last().theme.accent.base).toBe('#ff00ff');
    expect(el.controller.scene?.theme.accent.base).toBe('#ff00ff');
    el.style.removeProperty('--kgdiff-accent');
    el.style.setProperty('--kgdiff-removed', '#00ffff');
    el.controller.refreshTheme();
    expect(backend.last().theme.accent.base).toBe(getTheme('dark').accent.base);
    expect(backend.last().theme.family.removed.base).toBe('#00ffff');
    el.style.removeProperty('--kgdiff-removed');
    el.controller.refreshTheme();
    expect(backend.last().theme).toBe(getTheme('dark'));
  });

  it('keeps an override across theme switches (the token set changes beneath it)', async () => {
    const el = await loaded({ theme: 'dark' }, { '--kgdiff-accent': '#ff00ff' });
    el.theme = 'light';
    const theme: Theme = backend.last().theme;
    expect(theme.name).toBe('light');
    expect(theme.accent.base).toBe('#ff00ff');
    expect(theme.canvas.background).toBe(getTheme('light').canvas.background);
  });
});

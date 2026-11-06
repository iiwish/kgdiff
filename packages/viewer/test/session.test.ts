/**
 * The session / view boundary (RFC 0001 §1): `DiffSession` runs without a renderer, tells its
 * views what to draw and frame, and owns the search query. The frame scheduler races animation
 * frames against a timer, so loading never stalls where frames do not come.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rect } from '@kgdiff/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelFrame, FRAME_TIMEOUT, nextPaint, requestFrame } from '../src/schedule.js';
import { DiffSession, type SessionView, type Topic } from '../src/session.js';
import { manualDeps, recordingHost, tick, zoo } from './support.js';

class RecordingView implements SessionView {
  readonly calls: string[] = [];
  readonly shown: Rect[] = [];
  draws = 0;
  draw(): void {
    this.draws++;
  }
  sceneChanged(): void {
    this.calls.push('sceneChanged');
  }
  installed(): void {
    this.calls.push('installed');
  }
  drawnChanged(): void {
    this.calls.push('drawnChanged');
  }
  show(bounds: Rect): void {
    this.shown.push(bounds);
  }
  follow(): void {
    this.calls.push('follow');
  }
  looped(): void {
    this.calls.push('looped');
  }
  viewport(): Rect | null {
    return null;
  }
}

async function session(): Promise<{
  s: DiffSession;
  view: RecordingView;
  deps: ReturnType<typeof manualDeps>;
}> {
  const deps = manualDeps();
  const s = new DiffSession(recordingHost(), deps);
  const view = new RecordingView();
  s.addView(view);
  await s.load(zoo());
  return { s, view, deps };
}

describe('DiffSession', () => {
  it('knows nothing of the renderer, the camera, the framing or the DOM', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/session.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import[^;]*?from '([^']+)'/gms)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/renderer|framing|controller|element|ui\/|dom|styles/);
    }
    expect(source).not.toMatch(/\b(document|window)\.[a-z]|HTMLElement|getComputedStyle/);
  });

  it('loads headless and tells its views what changed and what to bring into view', async () => {
    const { s, view, deps } = await session();
    expect(s.status).toBe('ready');
    expect(view.calls).toContain('sceneChanged');
    expect(view.calls).toContain('installed');
    deps.frame();
    expect(view.draws).toBeGreaterThan(0);
    s.next();
    expect(view.shown).toHaveLength(1);
    s.setScope('changes');
    expect(view.calls.at(-1)).toBe('drawnChanged');
  });

  it('owns the search: the query and its hits, delivered at once', async () => {
    const { s } = await session();
    const seen: ReadonlySet<Topic>[] = [];
    s.subscribe((topics) => seen.push(topics));
    s.setQuery('gecko');
    expect(seen.at(-1)?.has('search')).toBe(true);
    expect(s.hits.map((h) => h.node.id)).toContain('G');
    s.setQuery('   ');
    expect(s.hits).toEqual([]);
    expect(s.query).toBe('   ');
  });

  it('keeps the query across loads and searches the new diff', async () => {
    const { s } = await session();
    s.setQuery('gecko');
    await s.load(zoo());
    expect(s.query).toBe('gecko');
    expect(s.hits.map((h) => h.node.id)).toContain('G');
    s.fail(new Error('gone'));
    expect(s.hits).toEqual([]);
  });

  it('builds the theme through its deps (the root’s CSS) and refreshes it on request', async () => {
    const deps = manualDeps();
    let accent = '#123456';
    const s = new DiffSession(recordingHost(), {
      ...deps,
      theme: (base) => ({ ...base, accent: { ...base.accent, base: accent } }),
    });
    await s.load(zoo());
    expect(s.theme.accent.base).toBe('#123456');
    expect(s.scene?.theme).toBe(s.theme);
    const before = s.scene;
    accent = '#654321';
    s.refreshTheme();
    expect(s.theme.accent.base).toBe('#654321');
    expect(s.scene).not.toBe(before);
    expect(s.scene?.theme.accent.base).toBe('#654321');
  });
});

describe('requestFrame', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs on a timer when animation frames do not come (hidden containers)', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const cb = vi.fn();
    requestFrame(cb);
    await tick(FRAME_TIMEOUT + 20);
    expect(cb).toHaveBeenCalledTimes(1);
    await expect(nextPaint()).resolves.toBeUndefined();
  });

  it('runs once, on whichever comes first, and can be cancelled', async () => {
    let frame: ((t: number) => void) | null = null;
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => {
      frame = f;
      return 7;
    });
    const cancelled = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancelled);
    const cb = vi.fn();
    requestFrame(cb);
    (frame as unknown as (t: number) => void)(5);
    await tick(FRAME_TIMEOUT + 20);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(5);
    expect(cancelled).toHaveBeenCalledWith(7);
    const never = vi.fn();
    cancelFrame(requestFrame(never));
    await tick(FRAME_TIMEOUT + 20);
    expect(never).not.toHaveBeenCalled();
  });
});

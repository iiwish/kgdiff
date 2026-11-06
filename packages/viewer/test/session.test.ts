/**
 * The session / view boundary (RFC 0001 §1): `DiffSession` runs without a renderer, tells its
 * views what to draw and frame, and owns the search query. Its frame loop runs on animation
 * frames only; one-off work (loading steps) races a frame against a timer, so loading never
 * stalls where frames do not come.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rect } from '@kgdiff/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KgdiffViewer } from '../src/element.js';
import '../src/index.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { FRAME_TIMEOUT, frameOrTimeout, nextPaint, requestFrame } from '../src/schedule.js';
import { DiffSession, type SessionView, type Topic } from '../src/session.js';
import { manualDeps, mockBackend, recordingHost, tick, zoo } from './support.js';

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

describe('scheduling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setRenderBackend(null);
    document.body.textContent = '';
  });

  /** Animation frames that come only when `flush` is called (none: a background tab). */
  function heldFrames(): { flush(): void; cancelled: number[] } {
    const queued = new Map<number, (t: number) => void>();
    const cancelled: number[] = [];
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => {
      queued.set(++id, f);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (n: number) => {
      cancelled.push(n);
      queued.delete(n);
    });
    return {
      cancelled,
      flush: () => {
        const due = [...queued.values()];
        queued.clear();
        for (const f of due) f(performance.now());
      },
    };
  }

  it('runs the frame loop on animation frames only: no timer draws while they are held', async () => {
    const frames = heldFrames();
    const cb = vi.fn();
    requestFrame(cb);
    await tick(FRAME_TIMEOUT + 20);
    expect(cb).not.toHaveBeenCalled();
    frames.flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not let one-off work wait for frames that never come (loading in hidden containers)', async () => {
    heldFrames();
    const cb = vi.fn();
    frameOrTimeout(cb);
    await tick(FRAME_TIMEOUT + 20);
    expect(cb).toHaveBeenCalledTimes(1);
    await expect(nextPaint()).resolves.toBeUndefined();
  });

  it('runs one-off work once, on the frame when it comes first', async () => {
    const frames = heldFrames();
    const cb = vi.fn();
    frameOrTimeout(cb);
    frames.flush();
    await tick(FRAME_TIMEOUT + 20);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(frames.cancelled).toEqual([1]);
  });

  it('loads a looping replay without frames, and plays it only when frames come', async () => {
    const frames = heldFrames();
    setRenderBackend(mockBackend());
    const el = document.createElement('kgdiff-viewer') as KgdiffViewer;
    el.setAttribute('mode', 'replay');
    el.setAttribute('loop', '');
    document.body.append(el);
    await el.load(zoo());
    expect(el.controller.status).toBe('ready');
    expect(el.controller.clock?.playing).toBe(true);
    await tick(FRAME_TIMEOUT * 3);
    expect(el.controller.clock?.t).toBe(0);
    frames.flush();
    await tick(20);
    frames.flush();
    expect(el.controller.clock?.t).toBeGreaterThan(0);
  });
});

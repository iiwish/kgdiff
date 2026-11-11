import type { Rect } from '@kgdiff/core';
import { KgdiffError } from '@kgdiff/core';
import { labelFootprint, type SplitFrame } from '@kgdiff/renderer';
import { createViewState, type FrameVisuals } from '@kgdiff/scene';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coverage, FLY_MAX_ZOOM, USER_CAMERA_GRACE, ViewerController } from '../src/controller.js';
import { setRenderBackend } from '../src/renderer-port.js';
import { reviewKey } from '../src/review-store.js';
import {
  hub,
  MemoryStorage,
  manualDeps,
  mockBackend,
  type RecordedHost,
  recordingHost,
  VIEWPORT,
  zoo,
} from './support.js';

let backend: ReturnType<typeof mockBackend>;
let deps: ReturnType<typeof manualDeps>;
let host: RecordedHost;
let c: ViewerController;

function make(storage = new MemoryStorage()): ViewerController {
  deps = manualDeps(storage);
  host = recordingHost();
  const ctl = new ViewerController(host, deps);
  ctl.attach(document.createElement('div'), document.createElement('div'));
  return ctl;
}

function hunkId(ctl: ViewerController, kind: string): string {
  const h = ctl.scene?.hunks.find((x) => x.kind === kind);
  if (!h) throw new Error(`no ${kind} hunk`);
  return h.id;
}

beforeEach(() => {
  backend = mockBackend();
  setRenderBackend(backend);
  c = make();
});

afterEach(() => {
  c.destroy();
  setRenderBackend(null);
});

describe('load pipeline', () => {
  it('runs match → layout → scene and becomes ready', async () => {
    const seen: string[] = [];
    c.subscribe(() => {
      if (c.step && seen[seen.length - 1] !== c.step) seen.push(c.step);
    });
    const done = c.load(zoo());
    expect(c.status).toBe('loading');
    await done;
    expect(seen).toEqual(['match', 'layout', 'scene']);
    expect(c.status).toBe('ready');
    expect(c.scene?.hunks.length).toBeGreaterThanOrEqual(4);
    expect(host.events[0]?.type).toBe('ready');
  });

  it('adds a parse step for text sources and parses them with @kgdiff/formats', async () => {
    const { before, after } = zoo();
    await c.load({
      before: { text: JSON.stringify(before), filename: 'zoo-v1.json' },
      after: { text: JSON.stringify(after), filename: 'zoo-v2.json' },
    });
    expect(c.steps).toEqual(['parse', 'match', 'layout', 'scene']);
    expect(c.status).toBe('ready');
    expect(c.data?.names).toEqual({ before: 'Zoo', after: 'Zoo' });
    expect(c.data?.versions).toEqual({ before: 'v1', after: 'v2' });
  });

  it('rejects malformed input with a KgdiffError and shows the error state', async () => {
    await expect(c.load({ before: 42 as never, after: zoo().after })).rejects.toBeInstanceOf(
      KgdiffError,
    );
    expect(c.status).toBe('error');
    expect(c.error).toBeInstanceOf(KgdiffError);
    expect(host.events.some((e) => e.type === 'error')).toBe(true);
  });

  it('a newer load supersedes a running one', async () => {
    const first = c.load(zoo());
    const second = c.load(hub(3));
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe('rejected');
    expect((a as PromiseRejectedResult).reason).toMatchObject({ name: 'AbortError' });
    expect(b.status).toBe('fulfilled');
    expect(c.status).toBe('ready');
    expect(c.diff?.nodes.some((n) => n.id === 'H')).toBe(true);
    expect(host.events.filter((e) => e.type === 'ready')).toHaveLength(1);
  });

  it('starts in the changes scope when the layout is scoped to changes', async () => {
    await c.load({ ...hub(12), layout: { largeGraphThreshold: 4 } });
    expect(c.layout?.scope).toBe('changes');
    expect([c.mode, c.scope]).toEqual(['overlay', 'changes']);
    expect(c.focus).not.toBeNull();
  });

  it('keeps an explicitly chosen mode for large graphs, but not the whole-graph scope', async () => {
    c.explicit.add('mode');
    c.explicit.add('scope');
    c.setView('swipe', 'all');
    await c.load({ ...hub(12), layout: { largeGraphThreshold: 4 } });
    // Only the changes are laid out: there is no whole graph to show.
    expect([c.mode, c.scope]).toEqual(['swipe', 'changes']);
    expect(c.scopeLocked).toBe(true);
    c.toggleScope();
    expect(c.scope).toBe('changes');
    expect(host.announcements.at(-1)).toMatch(/laid out around its changes only/);
  });
});

describe('selection', () => {
  beforeEach(async () => {
    await c.load(zoo());
    host.events.length = 0;
  });

  it('next / prev start at the ends and clamp', () => {
    const order = c.list.order;
    c.next();
    expect(c.selectedHunk).toBe(order[0]);
    c.prev();
    expect(c.selectedHunk).toBe(order[0]);
    c.clearSelection();
    c.prev();
    expect(c.selectedHunk).toBe(order[order.length - 1]);
    c.next();
    expect(c.selectedHunk).toBe(order[order.length - 1]);
    c.first();
    expect(c.selectedHunk).toBe(order[0]);
    c.last();
    expect(c.selectedHunk).toBe(order[order.length - 1]);
  });

  it('steps through the list in phase order (removed, restructured, modified, added)', () => {
    const phases: string[] = [];
    for (let i = 0; i < c.list.order.length; i++) {
      c.next();
      phases.push(c.scene?.hunks[c.selectedHunk]?.phase ?? '');
    }
    const rank = (p: string) => ['remove', 'restructure', 'modify', 'add'].indexOf(p);
    expect(phases.map(rank)).toEqual([...phases.map(rank)].sort((a, b) => a - b));
  });

  it('emits select events, announces the change and flies to it', () => {
    c.next();
    const id = c.scene?.hunks[c.selectedHunk]?.id;
    expect(host.events).toContainEqual({ type: 'select', detail: { hunk: id, node: null } });
    expect(host.announcements.at(-1)).toMatch(/^Change 1 of \d+: /);
    expect(backend.last().camera.flights).toHaveLength(1);
    c.clearSelection();
    expect(host.events.at(-1)).toEqual({ type: 'select', detail: { hunk: null, node: null } });
  });

  it('selects hunks by id, including before the data is ready', async () => {
    const other = make();
    other.selectHunkById('remove:E');
    await other.load(zoo());
    expect(other.scene?.hunks[other.selectedHunk]?.id).toBe('remove:E');
    other.destroy();
  });

  it('selecting a node selects its hunk; unchanged nodes are selected alone', () => {
    const scene = c.scene;
    if (!scene) throw new Error('no scene');
    const kitty = scene.nodeIndex.get('C') as number;
    c.selectNode(kitty);
    expect(c.selectedHunk).toBe(scene.nodes[kitty]?.hunk);
    expect(c.selectedNode).toBe(kitty);
    const animal = scene.nodeIndex.get('A') as number;
    c.selectNode(animal);
    expect(c.selectedHunk).toBe(-1);
    expect(c.selectedNode).toBe(animal);
    expect(host.events.at(-1)).toEqual({ type: 'select', detail: { hunk: null, node: 'A' } });
  });

  it('canvas clicks select nodes and clear on empty space', () => {
    const r = backend.last();
    const kitty = c.scene?.nodeIndex.get('C') as number;
    r.click({ type: 'node', index: kitty });
    expect(c.selectedNode).toBe(kitty);
    expect(r.camera.flights).toHaveLength(0);
    r.click(null);
    expect(c.selectedHunk).toBe(-1);
    expect(c.selectedNode).toBe(-1);
  });

  it('animates the spotlight emphasis over motion.base, or jumps with reduced motion', () => {
    c.next();
    expect(c.emphasis).toBe(0);
    deps.frame(110);
    expect(c.emphasis).toBeGreaterThan(0.5);
    expect(c.emphasis).toBeLessThan(1);
    deps.run(400);
    expect(c.emphasis).toBe(1);
    c.setReducedMotion(true);
    c.next();
    expect(c.emphasis).toBe(1);
  });

  it('fades the spotlight out when the selection is cleared', () => {
    c.next();
    deps.run(400);
    const h = c.selectedHunk;
    c.clearSelection();
    deps.frame(16);
    const frame = backend.last().frame as FrameVisuals;
    expect(frame.spotlight).toBeGreaterThan(0);
    deps.run(400);
    const after = backend.last().frame as FrameVisuals;
    expect(after.spotlight).toBe(0);
    expect(h).toBeGreaterThanOrEqual(0);
  });
});

describe('filters', () => {
  beforeEach(async () => {
    await c.load(zoo());
  });

  it('hides hunks of other families from the list and navigation', () => {
    c.toggleFamily('added');
    expect(c.list.order.every((h) => c.scene?.hunks[h]?.family === 'added')).toBe(true);
    c.next();
    expect(c.scene?.hunks[c.selectedHunk]?.family).toBe('added');
    c.toggleFamily('added');
    expect(c.list.order).toHaveLength(c.scene?.hunks.length ?? -1);
  });

  it('setFamilies replaces the filter, and the same set again clears it', () => {
    c.setFamilies(['structure', 'identity']);
    expect([...c.families].sort()).toEqual(['identity', 'structure']);
    c.setFamilies(['structure', 'identity']);
    expect(c.families.size).toBe(0);
  });

  it('continues from a filtered-out selection in scene order', () => {
    c.next(); // first hunk (remove)
    c.toggleFamily('added');
    c.next();
    expect(c.scene?.hunks[c.selectedHunk]?.family).toBe('added');
  });
});

describe('review', () => {
  it('persists reviewed hunks per diff and emits review events', async () => {
    const storage = new MemoryStorage();
    const a = make(storage);
    await a.load(zoo());
    const id = hunkId(a, 'remove');
    a.setReviewed(id, true);
    expect(a.reviewState().reviewed).toEqual([id]);
    const key = reviewKey(a.diff?.delta.base.hash ?? '', a.diff?.delta.target.hash ?? '');
    expect(storage.getItem(key)).toContain(id);
    expect(host.events.at(-1)?.type).toBe('review');
    const b = make(storage);
    await b.load(zoo());
    expect(b.isReviewed(id)).toBe(true);
    b.toggleReviewed(id);
    expect(b.isReviewed(id)).toBe(false);
    expect(storage.getItem(key)).toBeNull();
    a.destroy();
    b.destroy();
  });

  it('x toggles the selected hunk and ignores unknown ids', async () => {
    await c.load(zoo());
    c.toggleReviewed();
    expect(c.reviewState().reviewed).toEqual([]);
    c.next();
    c.toggleReviewed();
    expect(c.reviewState().reviewed).toHaveLength(1);
    c.setReviewed('nope', true);
    expect(c.reviewState().reviewed).toHaveLength(1);
    expect(c.reviewState().total).toBe(c.scene?.hunks.length);
  });

  it('survives storage that throws', async () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    deps = manualDeps(broken);
    const x = new ViewerController(recordingHost(), deps);
    await x.load(zoo());
    x.next();
    x.toggleReviewed();
    expect(x.reviewState().reviewed).toHaveLength(1);
    x.destroy();
  });
});

describe('modes and frames', () => {
  beforeEach(async () => {
    await c.load(zoo());
  });

  it('switches modes and scopes without moving the camera and emits mode events', () => {
    const cam = backend.last().camera;
    cam.state = { x: 12, y: 34, k: 1.5 };
    c.setMode('swipe');
    c.setMode('replay');
    c.setScope('changes');
    expect(cam.get()).toEqual({ x: 12, y: 34, k: 1.5 });
    expect(host.events.filter((e) => e.type === 'mode').map((e) => e.detail)).toEqual([
      { mode: 'swipe', scope: 'all' },
      { mode: 'replay', scope: 'all' },
      { mode: 'replay', scope: 'changes' },
    ]);
    c.setView('replay', 'changes');
    expect(host.events.filter((e) => e.type === 'mode')).toHaveLength(3);
  });

  it('keeps the changes-scope focus in every mode', async () => {
    await c.load(hub(6));
    c.setScope('changes');
    c.setHops(0);
    const focus = c.focus;
    expect(focus).not.toBeNull();
    for (const mode of ['swipe', 'replay', 'overlay'] as const) {
      c.setMode(mode);
      expect(c.focus, mode).toBe(focus);
    }
    c.setMode('swipe');
    deps.frame();
    const f = backend.last().frame as SplitFrame;
    const hidden = (c.focus?.nodes ?? []).filter((v) => v === 0).length;
    expect(hidden).toBeGreaterThan(0);
    expect(f.before.collapsed).toBe(c.focus?.collapsed);
    expect(f.after.collapsed).toBe(c.focus?.collapsed);
  });

  it('draws a split frame in swipe mode and moves the divider', () => {
    c.setMode('swipe');
    c.setSplit(0.3);
    deps.frame();
    const f = backend.last().frame as SplitFrame;
    expect(f.split).toBe(0.3);
    expect(f.before.nodes).toHaveLength(c.scene?.nodes.length ?? -1);
    c.setSplit(4);
    expect(c.split).toBe(1);
  });

  it('computes the changes-scope focus with a hop stepper', () => {
    c.setScope('changes');
    expect(c.focus).not.toBeNull();
    const visible1 = c.focus?.nodes.reduce((a, b) => a + b, 0) ?? 0;
    c.setHops(0);
    const visible0 = c.focus?.nodes.reduce((a, b) => a + b, 0) ?? 0;
    expect(visible0).toBeLessThanOrEqual(visible1);
    c.setScope('all');
    expect(c.focus).toBeNull();
  });

  it('tracks whether everything is in view (the minimap hides then)', () => {
    const r = backend.last();
    const cam = r.camera;
    const b = c.scene?.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
    const center = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    cam.state = { ...center, k: 0.01 };
    r.emit('camera', { ...cam.state, source: 'user' });
    expect(c.overview).toBe(true);
    cam.state = { ...center, k: 40 };
    r.emit('camera', { ...cam.state, source: 'user' });
    expect(c.overview).toBe(false);
    c.flush();
    cam.state = { ...center, k: 0.01 };
    r.emit('camera', { ...cam.state, source: 'program' });
    expect(c.overview).toBe(true);
  });

  it('rebuilds the scene for theme and locale changes, keeping the selection', () => {
    c.next();
    const id = c.scene?.hunks[c.selectedHunk]?.id;
    const before = c.scene;
    c.setLocale('zh-CN');
    expect(c.scene).not.toBe(before);
    expect(c.scene?.locale).toBe('zh-CN');
    expect(c.scene?.hunks[c.selectedHunk]?.id).toBe(id);
    c.setThemePreference('light');
    expect(c.scene?.theme.name).toBe('light');
    expect(backend.last().theme.name).toBe('light');
    c.setPalette('colorblind');
    expect(backend.last().theme.palette).toBe('colorblind');
  });
});

describe('replay', () => {
  beforeEach(async () => {
    await c.load(zoo());
  });

  it('plays at the chosen speed, stops at the end and announces it', () => {
    c.play();
    expect(c.mode).toBe('replay');
    deps.frame(16); // first frame only arms the clock
    deps.frame(100);
    expect(c.clock?.t).toBeCloseTo(100, 5);
    c.setSpeed(2);
    deps.frame(50);
    expect(c.clock?.t).toBeCloseTo(200, 5);
    deps.run(60_000, 100);
    expect(c.clock?.finished).toBe(true);
    expect(c.clock?.t).toBe(c.clock?.duration);
    expect(host.announcements).toContain('Replay finished');
    c.restart();
    expect(c.clock?.t).toBe(0);
    expect(c.clock?.playing).toBe(true);
  });

  it('selecting a hunk seeks to the end of its window and pauses', () => {
    c.play();
    c.selectHunk(2);
    expect(c.clock?.playing).toBe(false);
    expect(c.clock?.t).toBe(c.clock?.windowEnd(2));
  });

  it('follows the playing hunk unless the user moved the camera in the last 2 s', () => {
    const r = backend.last();
    const cam = r.camera;
    cam.state = { x: 1e6, y: 1e6, k: 1 };
    c.setMode('replay');
    // Programmatic camera changes do not count as the user steering.
    r.emit('camera', { ...cam.state, source: 'program' });
    c.stepReplay(1);
    expect(cam.flights).toHaveLength(1);
    c.stepReplay(-1);
    cam.state = { x: 1e6, y: 1e6, k: 1 };
    r.emit('camera', { ...cam.state, source: 'user' });
    c.play();
    deps.frame(16);
    deps.frame(200);
    expect(cam.flights).toHaveLength(1);
    deps.time += USER_CAMERA_GRACE;
    c.stepReplay(1);
    expect(cam.flights.length).toBeGreaterThan(1);
  });

  it('steps between window ends', () => {
    c.setMode('replay');
    c.stepReplay(1);
    expect(c.clock?.position()).toBe(1);
    c.stepReplay(1);
    expect(c.clock?.position()).toBe(2);
    c.stepReplay(-1);
    expect(c.clock?.position()).toBe(1);
  });
});

describe('focus expansion', () => {
  it('expands a collapsed group of in-scene nodes', async () => {
    await c.load(hub(6));
    c.setScope('changes');
    c.setHops(0);
    const group = c.focus?.collapsed.find((g) => g.nodes.length > 0);
    expect(group).toBeDefined();
    const before = c.focus?.nodes.reduce((a, b) => a + b, 0) ?? 0;
    c.expandGroup(c.focus?.collapsed.indexOf(group as never) ?? -1);
    const after = c.focus?.nodes.reduce((a, b) => a + b, 0) ?? 0;
    expect(after).toBe(before + (group?.nodes.length ?? 0));
  });

  it('places neighbours outside a changes-scoped layout without moving anything', async () => {
    await c.load({ ...hub(10), layout: { largeGraphThreshold: 4, contextHops: 0 } });
    expect(c.layout?.scope).toBe('changes');
    // Only X is laid out: “+1 unchanged” (the hub) sits next to it.
    expect([...(c.layout?.positions.keys() ?? [])]).toEqual(['X']);
    expect(c.focus?.collapsed.map((g) => [g.id, g.count])).toEqual([['near:X', 1]]);
    c.expandGroup(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.focus?.collapsed.map((g) => [g.id, g.count])).toEqual([['near:H', 10]]);
    const placed = new Map(c.layout?.positions);
    c.expandGroup(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.layout?.positions.size).toBe(12);
    for (const [id, p] of placed) expect(c.layout?.positions.get(id)).toEqual(p);
    expect(c.scene?.nodes).toHaveLength(12);
    expect(c.focus?.collapsed.reduce((a, g) => a + g.count, 0)).toBe(0);
  });

  it('reveals a search result outside the layout and selects it', async () => {
    await c.load({ ...hub(10), layout: { largeGraphThreshold: 4, contextHops: 0 } });
    expect(c.scene?.nodeIndex.has('L3')).toBe(false);
    expect(c.search('leaf 3')[0]?.node.id).toBe('L3');
    await c.revealNode('L3');
    const i = c.scene?.nodeIndex.get('L3');
    expect(i).toBeDefined();
    expect(c.selectedNode).toBe(i);
    expect(c.focus?.nodes[i as number]).toBe(1);
  });
});

describe('framing around chrome', () => {
  const legend = { x: 16, y: 520, width: 140, height: 64 };
  const minimap = { x: 560, y: 440, width: 224, height: 144 };
  const chrome = () => ({
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    obstacles: [legend, minimap],
  });
  const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it('fits a new diff once the UI is up, then frames every selected hunk clear of the chrome', async () => {
    c.setChrome(chrome);
    await c.load(zoo());
    await new Promise((r) => setTimeout(r, 0));
    const cam = backend.last().camera;
    expect(cam.fits).toBe(1);
    expect(cam.fitCalls[0]?.options?.animate).toBe(false);
    for (const h of c.list.order) {
      c.selectHunk(h);
      const options = cam.flightOptions.at(-1);
      expect(typeof options?.padding).toBe('object');
      expect(options?.maxZoom).toBe(FLY_MAX_ZOOM);
      const b = cam.flights.at(-1) as Rect;
      const t = cam.get();
      const s = {
        x: (b.x - t.x) * t.k + VIEWPORT.width / 2,
        y: (b.y - t.y) * t.k + VIEWPORT.height / 2,
        width: b.width * t.k,
        height: b.height * t.k,
      };
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.x + s.width).toBeLessThanOrEqual(VIEWPORT.width + 1e-6);
      expect(s.y + s.height).toBeLessThanOrEqual(VIEWPORT.height + 1e-6);
      expect(overlaps(s, legend)).toBe(false);
      expect(overlaps(s, minimap)).toBe(false);
    }
  });

  it('waits for a laid-out canvas before the initial fit', async () => {
    let size = 0;
    c.setChrome(() => ({ width: size, height: size, obstacles: [] }));
    await c.load(zoo());
    await new Promise((r) => setTimeout(r, 0));
    const cam = backend.last().camera;
    expect(cam.fits).toBe(0);
    size = 500;
    c.layoutChanged();
    c.layoutChanged();
    expect(cam.fits).toBe(1);
  });

  it('fits the visible focus in changes-only mode', async () => {
    c.setChrome(chrome);
    await c.load({ ...hub(10), layout: { largeGraphThreshold: 4, contextHops: 0 } });
    await new Promise((r) => setTimeout(r, 0));
    const fitted = backend.last().camera.fitCalls[0]?.bounds;
    expect(fitted).toBeDefined();
    // Only X and its pill are visible: a small, padded region, not the whole scene.
    expect(fitted?.width).toBeLessThan(400);
  });
});

describe('coverage', () => {
  it('is the share of the bounds inside the view', () => {
    const view = { x: 0, y: 0, width: 100, height: 100 };
    expect(coverage({ x: 0, y: 0, width: 50, height: 50 }, view)).toBe(1);
    expect(coverage({ x: 50, y: 0, width: 100, height: 100 }, view)).toBe(0.5);
    expect(coverage({ x: 200, y: 200, width: 10, height: 10 }, view)).toBe(0);
    expect(coverage({ x: 10, y: 10, width: 0, height: 0 }, view)).toBe(1);
  });
});

describe('label-aware fit', () => {
  const free = () => ({ width: VIEWPORT.width, height: VIEWPORT.height, obstacles: [] });

  /** A hub whose leaves carry long names, so the outermost labels reach past their discs. */
  function longNames() {
    const g = hub(14);
    const rename = (n: { id: string; label?: string }) =>
      n.id.startsWith('L') ? { ...n, label: `listed_top10_holder_${n.id}` } : n;
    return {
      before: { ...g.before, nodes: g.before.nodes.map(rename) },
      after: { ...g.after, nodes: g.after.nodes.map(rename) },
    };
  }

  it('keeps every node label inside a short canvas', async () => {
    const saved = { ...VIEWPORT };
    Object.assign(VIEWPORT, { width: 800, height: 320 });
    try {
      c.setChrome(free);
      await c.load(longNames());
      await new Promise((r) => setTimeout(r, 0));
      const cam = backend.last().camera;
      expect(cam.fits).toBe(1);
      const frame = c.resolver?.resolve(createViewState({ layer: 'union' })) as FrameVisuals;
      const { x, y, k } = cam.get();
      const box = labelFootprint(frame, c.theme).at(k) as Rect;
      const discs = labelFootprint(frame, c.theme).at(Infinity) as Rect;
      // Labels are shown and reach past the discs, and all of it is in the canvas.
      expect(box.width).toBeGreaterThan(discs.width + 50 / k);
      expect((box.x - x) * k + VIEWPORT.width / 2).toBeGreaterThanOrEqual(24 - 1e-6);
      expect((box.y - y) * k + VIEWPORT.height / 2).toBeGreaterThanOrEqual(24 - 1e-6);
      expect((box.x + box.width - x) * k + VIEWPORT.width / 2).toBeLessThanOrEqual(776 + 1e-6);
      expect((box.y + box.height - y) * k + VIEWPORT.height / 2).toBeLessThanOrEqual(296 + 1e-6);
    } finally {
      Object.assign(VIEWPORT, saved);
    }
  });

  it('takes a padding and keeps it for later fits', async () => {
    c.setChrome(free);
    await c.load(zoo());
    await new Promise((r) => setTimeout(r, 0));
    const cam = backend.last().camera;
    expect(cam.fitCalls.at(-1)?.options?.padding).toEqual({
      top: 24,
      right: 24,
      bottom: 24,
      left: 24,
    });
    await c.fit({ padding: 4, animate: false });
    expect(cam.fitCalls.at(-1)?.options).toMatchObject({
      animate: false,
      padding: { top: 4, right: 4, bottom: 4, left: 4 },
    });
    await c.fit();
    expect(cam.fitCalls.at(-1)?.options?.padding).toEqual({ top: 4, right: 4, bottom: 4, left: 4 });
  });

  it('with autoFit, fits again on resize until the user moves the camera', async () => {
    c.setChrome(free);
    c.autoFit = true;
    await c.load(zoo());
    await new Promise((r) => setTimeout(r, 0));
    const r = backend.last();
    expect(r.camera.fits).toBe(1);
    c.layoutChanged();
    expect(r.camera.fits).toBe(2);
    r.emit('camera', { ...r.camera.state, source: 'user' });
    c.layoutChanged();
    expect(r.camera.fits).toBe(2);
    c.autoFit = false;
    await c.fit();
    c.layoutChanged();
    expect(r.camera.fits).toBe(3);
  });

  it('ignores canvas clicks when selecting on click is off', async () => {
    await c.load(zoo());
    c.selectOnClick = false;
    backend.last().click({ type: 'node', index: 0 });
    expect(c.selectedNode).toBe(-1);
    expect(c.selectedHunk).toBe(-1);
  });
});

describe('looping replay', () => {
  const ends = () => host.events.filter((e) => e.type === 'replay-end');

  /** Replay chosen by the embedder (explicit, so a new diff keeps it). */
  function replayMode(): void {
    c.explicit.add('mode');
    c.setMode('replay');
  }

  /** Play until the clock stops (the replay ended). */
  function playOut(): void {
    deps.frame(16);
    let guard = 0;
    while (c.clock?.playing && guard++ < 10_000) deps.frame(100);
  }

  it('reports the end of a replay played once', async () => {
    await c.load(zoo());
    c.play();
    playOut();
    expect(c.clock?.finished).toBe(true);
    expect(ends()).toEqual([{ type: 'replay-end', detail: { loop: false } }]);
    deps.run(5000, 100);
    expect(c.clock?.finished).toBe(true);
    // Seeking or stepping to the end is not playback reaching it.
    c.seek(0);
    c.stepReplay(1);
    c.seek(c.clock?.duration ?? 0);
    expect(ends()).toHaveLength(1);
  });

  it('plays by itself and starts again after the loop delay', async () => {
    replayMode();
    c.setLoop(1200);
    await c.load(zoo());
    expect(c.clock?.playing).toBe(true);
    playOut();
    expect(ends()).toEqual([{ type: 'replay-end', detail: { loop: true } }]);
    deps.frame(1100);
    expect(c.clock?.finished).toBe(true);
    deps.frame(150);
    expect(c.clock?.playing).toBe(true);
    expect(c.clock?.t).toBeLessThan(200);
    playOut();
    expect(ends()).toHaveLength(2);
  });

  it('starts when looping is turned on or the replay is shown, not in other modes', async () => {
    await c.load(zoo());
    c.setLoop(500);
    expect(c.clock?.playing).toBe(false);
    c.setMode('replay');
    expect(c.clock?.playing).toBe(true);
    c.setLoop(null);
    c.pause();
    c.setLoop(800);
    expect(c.clock?.playing).toBe(true);
    expect(c.loopDelay).toBe(800);
  });

  it('pause() stops the loop, including during the pause before the restart', async () => {
    replayMode();
    c.setLoop(1000);
    await c.load(zoo());
    playOut();
    c.pause();
    deps.run(3000, 100);
    expect(c.clock?.finished).toBe(true);
    c.play();
    expect(c.clock?.playing).toBe(true);
    c.pause();
    deps.run(3000, 100);
    expect(c.clock?.playing).toBe(false);
  });

  it('holds while the pointer is over the graph and continues after', async () => {
    replayMode();
    c.setLoop(1000);
    await c.load(zoo());
    deps.frame(16);
    deps.frame(300);
    const t = c.clock?.t ?? 0;
    c.hold(true);
    expect(c.clock?.playing).toBe(false);
    deps.run(2000, 100);
    expect(c.clock?.t).toBe(t);
    c.hold(false);
    expect(c.clock?.playing).toBe(true);
    // Held during the pause before the restart: it waits, then the full delay after release.
    playOut();
    c.hold(true);
    deps.frame(5000);
    expect(c.clock?.finished).toBe(true);
    c.hold(false);
    deps.frame(16);
    deps.frame(900);
    expect(c.clock?.finished).toBe(true);
    deps.frame(200);
    expect(c.clock?.playing).toBe(true);
  });

  it('a held replay that is not playing stays put on release', async () => {
    await c.load(zoo());
    c.setMode('replay');
    c.hold(true);
    c.hold(false);
    expect(c.clock?.playing).toBe(false);
  });

  it('with autoFit, every loop starts from the fitted view', async () => {
    c.setChrome(() => ({ width: VIEWPORT.width, height: VIEWPORT.height, obstacles: [] }));
    c.autoFit = true;
    replayMode();
    c.setLoop(50);
    await c.load(zoo());
    await new Promise((r) => setTimeout(r, 0));
    const cam = backend.last().camera;
    const before = cam.fits;
    playOut();
    expect(cam.fits).toBe(before);
    deps.frame(100);
    expect(c.clock?.playing).toBe(true);
    expect(cam.fits).toBe(before + 1);
  });
});

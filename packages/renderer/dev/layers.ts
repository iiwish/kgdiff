/**
 * Example host layers for the harness (`Renderer.addLayer`): what an embedding host draws
 * itself. Under the graph, a tinted background behind each of two groups of nodes ("domains");
 * over it, a mark on some nodes. Both are drawn from the frame's positions in CSS pixels.
 */
import type { LayerView, RendererLayer } from '@kgdiff/renderer';
import type { FrameVisuals, Theme } from '@kgdiff/scene';

/** World units between a group's outermost node centers and its background's edge. */
const GROUP_PADDING = 28;
/** Every n-th node carries a mark. */
const MARK_EVERY = 6;
const MARK_R = 5;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The nodes left and right of the middle of the frame, as two bounding boxes. */
function groups(frame: FrameVisuals): Box[] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const n of frame.nodes) {
    if (!n.visible) continue;
    lo = Math.min(lo, n.x);
    hi = Math.max(hi, n.x);
  }
  if (!(lo <= hi)) return [];
  const mid = (lo + hi) / 2;
  const boxes: Box[] = [0, 1].map(() => ({
    x0: Number.POSITIVE_INFINITY,
    y0: Number.POSITIVE_INFINITY,
    x1: Number.NEGATIVE_INFINITY,
    y1: Number.NEGATIVE_INFINITY,
  }));
  for (const n of frame.nodes) {
    if (!n.visible) continue;
    const b = boxes[n.x < mid ? 0 : 1] as Box;
    b.x0 = Math.min(b.x0, n.x - n.r);
    b.y0 = Math.min(b.y0, n.y - n.r);
    b.x1 = Math.max(b.x1, n.x + n.r);
    b.y1 = Math.max(b.y1, n.y + n.r);
  }
  return boxes.filter((b) => b.x0 <= b.x1);
}

function inView(view: LayerView, x: number, y: number, margin: number): boolean {
  const v = view.viewport;
  return (
    x >= v.x - margin &&
    x <= v.x + v.width + margin &&
    y >= v.y - margin &&
    y <= v.y + v.height + margin
  );
}

export function exampleLayers(
  frame: (side: 'before' | 'after' | undefined) => FrameVisuals | null,
  theme: () => Theme,
): RendererLayer[] {
  const under: RendererLayer = {
    order: 'under',
    draw(ctx, view) {
      const f = frame(view.side);
      if (!f) return;
      const t = theme();
      const k = view.camera.k;
      // Soft tints (about 10–16% alpha) keep the labels' halo from showing as an outline.
      const tints = [t.family.structure, t.family.identity];
      const names = ['Domain A', 'Domain B'];
      groups(f).forEach((b, i) => {
        const tint = tints[i % tints.length] as (typeof tints)[number];
        const p = view.worldToScreen({ x: b.x0 - GROUP_PADDING, y: b.y0 - GROUP_PADDING });
        const w = (b.x1 - b.x0 + 2 * GROUP_PADDING) * k;
        const h = (b.y1 - b.y0 + 2 * GROUP_PADDING) * k;
        ctx.beginPath();
        ctx.roundRect(p.x, p.y, w, h, Math.min(16, w / 2, h / 2));
        ctx.fillStyle = tint.soft;
        ctx.fill();
        // 1 px at every zoom: sizes in CSS pixels do not scale with the camera.
        ctx.lineWidth = 1;
        ctx.strokeStyle = tint.base;
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.font = `600 11px ${t.font.family}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillStyle = tint.text;
        const name = names[i] ?? '';
        ctx.fillText(view.side ? `${name} · ${view.side}` : name, p.x + 10, p.y + 8);
      });
    },
  };
  const over: RendererLayer = {
    order: 'over',
    draw(ctx, view) {
      const f = frame(view.side);
      if (!f) return;
      const t = theme();
      const k = view.camera.k;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let i = 0; i < f.nodes.length; i += MARK_EVERY) {
        const n = f.nodes[i];
        // Too small to carry a mark, or outside what this call can show.
        if (!n?.visible || n.r * k < 4 || !inView(view, n.x, n.y, n.r + 16 / k)) continue;
        const p = view.worldToScreen(n);
        const d = n.r * k * Math.SQRT1_2;
        const x = p.x + d;
        const y = p.y - d;
        ctx.beginPath();
        ctx.arc(x, y, MARK_R, 0, Math.PI * 2);
        ctx.fillStyle = t.accent.base;
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x - 2.2, y + 0.2);
        ctx.lineTo(x - 0.6, y + 1.8);
        ctx.lineTo(x + 2.4, y - 1.6);
        ctx.strokeStyle = t.canvas.background;
        ctx.stroke();
      }
    },
  };
  return [under, over];
}

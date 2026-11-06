/**
 * Frames for the session's loop and its loading steps (RFC 0001 §1, Scheduling): an animation
 * frame raced against a timer. A hidden embedding container (an inactive tab panel, a collapsed
 * notebook output, a background pane) can pause `requestAnimationFrame` without the page
 * reporting itself hidden; with frames alone, loading stalled there forever.
 */

/** A frame comes at the latest this long after it was asked for (ms). */
export const FRAME_TIMEOUT = 32;

const pending = new Map<number, () => void>();
let lastId = 0;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Call `cb` on the next animation frame, or after `FRAME_TIMEOUT` ms if none comes first. */
export function requestFrame(cb: (time: number) => void): number {
  const id = ++lastId;
  let raf = 0;
  const run = (time: number): void => {
    if (!pending.delete(id)) return;
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(timer);
    cb(time);
  };
  const timer = setTimeout(() => run(now()), FRAME_TIMEOUT);
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(run);
  pending.set(id, () => {
    if (raf) cancelAnimationFrame(raf);
    clearTimeout(timer);
  });
  return id;
}

export function cancelFrame(id: number): void {
  pending.get(id)?.();
  pending.delete(id);
}

/** Resolve once the browser had a chance to paint (between loading steps). */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestFrame(() => setTimeout(resolve, 0)));
}

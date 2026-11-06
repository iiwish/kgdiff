/**
 * Frames (RFC 0001 §1, Scheduling).
 *
 * The session's frame loop runs on animation frames only (`requestFrame`). It pauses where the
 * browser pauses them, so a looping replay in a background tab costs nothing, and under load it
 * never draws a frame that is not presented.
 *
 * One-off work that must not wait forever races a frame against a timer (`frameOrTimeout`):
 * the loading steps and the change list's window. A hidden embedding container (an inactive
 * tab panel, a collapsed notebook output, a background pane) can pause animation frames without
 * the page reporting itself hidden; with frames alone, loading stalled there.
 */

/** One-off work waits at most this long for a frame (ms). */
export const FRAME_TIMEOUT = 32;

/** The next animation frame (0, and no call, where there are none). */
export function requestFrame(cb: (time: number) => void): number {
  return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0;
}

export function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
}

/** Call `cb` once: on the next animation frame, or after `FRAME_TIMEOUT` ms if none came. */
export function frameOrTimeout(cb: () => void): void {
  let done = false;
  const run = (): void => {
    if (done) return;
    done = true;
    cancelFrame(raf);
    clearTimeout(timer);
    cb();
  };
  const timer = setTimeout(run, FRAME_TIMEOUT);
  const raf = requestFrame(run);
}

/** Resolve once the browser had a chance to paint (between loading steps). */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => frameOrTimeout(() => setTimeout(resolve, 0)));
}

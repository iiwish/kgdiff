/**
 * `@kgdiff/viewer/session` (RFC 0001 §1; experimental): the headless core of the viewer, one
 * diff session without DOM or canvas. It loads two graphs or a report payload and holds what
 * the viewer shows: the scene, selection, hover, family filters, the node search and its hits,
 * focus and scope, review progress, the replay clock, and the theme, palette and language
 * preferences. Listeners subscribe to topic notifications (batched per microtask) and read its
 * fields; commands (`selectHunk`, `next`, `setMode`, `play`, `setQuery`, …) change it.
 *
 * Importing it defines no element. Its surface is experimental: it will shrink to a read-only
 * snapshot, commands and `subscribe` before it is stable.
 */
import type { ReviewState, ViewerMode, ViewerScope } from './index.js';
import { defaultStorage } from './review-store.js';
import { cancelFrame, nextPaint, requestFrame } from './schedule.js';
import { DiffSession, type SessionDeps, type SessionHost } from './session.js';

export type { LoadStep } from './pipeline.js';
export type { SearchHit } from './search.js';
export type { Preference, SessionDeps, SessionHost, SessionView, Status } from './session.js';
export { DiffSession } from './session.js';
export type { Topic } from './topics.js';
export { ALL_TOPICS } from './topics.js';

/** What a session reports, all optional (`SessionHost`). */
export interface SessionEvents {
  ready?(stats: Parameters<SessionHost['ready']>[0]): void;
  select?(hunk: string | null, node: string | null): void;
  mode?(mode: ViewerMode, scope: ViewerScope): void;
  review?(hunk: string, reviewed: boolean, progress: ReviewState): void;
  error?(error: Error): void;
  announce?(text: string): void;
  replayEnd?(loop: boolean): void;
}

/**
 * A session with the browser's clock, animation frames and `localStorage` (review progress),
 * unless `deps` says otherwise. `events` receives what the viewer turns into DOM events.
 */
export function createSession(
  events: SessionEvents = {},
  deps: Partial<SessionDeps> = {},
): DiffSession {
  const host: SessionHost = {
    ready: (stats) => events.ready?.(stats),
    select: (hunk, node) => events.select?.(hunk, node),
    mode: (mode, scope) => events.mode?.(mode, scope),
    review: (hunk, reviewed, progress) => events.review?.(hunk, reviewed, progress),
    error: (error) => events.error?.(error),
    announce: (text) => events.announce?.(text),
    replayEnd: (loop) => events.replayEnd?.(loop),
  };
  return new DiffSession(host, {
    now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    requestFrame,
    cancelFrame,
    yieldToPaint: nextPaint,
    storage: defaultStorage(),
    ...deps,
  });
}

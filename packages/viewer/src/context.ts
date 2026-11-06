/**
 * The Web Components community context protocol
 * (https://github.com/webcomponents-cg/community-protocols/blob/main/proposals/context.md),
 * without dependencies: how the viewer's regions find the root whose session they show
 * (RFC 0001 §2).
 *
 * A consumer dispatches a `context-request` event (bubbling, composed: it crosses shadow roots
 * on its way up); the nearest provider of that context answers through the callback and stops
 * the event. Requests nobody answered reach `document`, where they wait; a provider that
 * connects later announces itself with `context-provider` and the waiting requests are sent
 * again, so definition and connection order do not matter. A consumer outside the provider's
 * subtree sends its request through an element inside it (`via`: the root named by `for`).
 */

export interface Context<T> {
  /**
   * `Symbol.for(name)`: equal across copies of the library on one page (an IIFE report bundle
   * next to an ESM build), so a component of one copy finds the root of another. The name is
   * versioned when the provided value changes incompatibly.
   */
  readonly key: symbol;
  /** Carries the value type only. */
  readonly __value?: T;
}

export const createContext = <T>(name: string): Context<T> => ({ key: Symbol.for(name) });

export class ContextRequestEvent<T> extends Event {
  constructor(
    readonly context: Context<T>,
    /** The consumer, which may differ from the element the event is dispatched on (`via`). */
    readonly consumer: Element,
    readonly callback: (value: T) => void,
  ) {
    super('context-request', { bubbles: true, composed: true });
  }
}

export class ContextProviderEvent<T> extends Event {
  constructor(readonly context: Context<T>) {
    super('context-provider', { bubbles: true, composed: true });
  }
}

interface Waiting {
  readonly context: Context<unknown>;
  readonly consumer: Element;
  readonly via: EventTarget;
  readonly callback: (value: unknown) => void;
}

const waiting = new Set<Waiting>();
let collecting = false;

/** Keep the requests nobody answered, and send them again when a provider connects. */
function collect(): void {
  if (collecting || typeof document === 'undefined') return;
  collecting = true;
  document.addEventListener('context-request', (e) => {
    const r = e as ContextRequestEvent<unknown>;
    waiting.add({
      context: r.context,
      consumer: r.consumer,
      via: e.composedPath()[0] ?? r.consumer,
      callback: r.callback,
    });
  });
  document.addEventListener('context-provider', (e) => {
    const key = (e as ContextProviderEvent<unknown>).context.key;
    for (const w of [...waiting]) {
      if (w.context.key !== key) continue;
      waiting.delete(w);
      // Unanswered again: it waits again on its way through `document`.
      if (w.consumer.isConnected) {
        w.via.dispatchEvent(new ContextRequestEvent(w.context, w.consumer, w.callback));
      }
    }
  });
}

/** Ask for `context` for `consumer`, through `via` (an element of the provider's subtree). */
export function requestContext<T>(
  consumer: Element,
  context: Context<T>,
  callback: (value: T) => void,
  via: Element | null = null,
): void {
  collect();
  (via ?? consumer).dispatchEvent(new ContextRequestEvent(context, consumer, callback));
}

/** Answer requests for `context` reaching `host`; returns the function that stops answering. */
export function provideContext<T>(host: Element, context: Context<T>, value: () => T): () => void {
  collect();
  const answer = (e: Event): void => {
    const r = e as ContextRequestEvent<T>;
    if (r.context?.key !== context.key) return;
    e.stopPropagation();
    r.callback(value());
  };
  host.addEventListener('context-request', answer);
  host.dispatchEvent(new ContextProviderEvent(context));
  return () => host.removeEventListener('context-request', answer);
}

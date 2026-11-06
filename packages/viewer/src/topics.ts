/**
 * What the session notifies its listeners about (`DiffSession.subscribe`): one topic per part
 * of its state. A module of its own, so elements can name them without importing the session.
 */
export type Topic =
  | 'status'
  | 'data'
  | 'mode'
  | 'selection'
  | 'filters'
  | 'search'
  | 'review'
  | 'replay'
  | 'hover'
  | 'theme'
  | 'locale'
  | 'focus'
  | 'swipe'
  | 'overview';

/** Every topic: a full render. */
export const ALL_TOPICS: ReadonlySet<Topic> = new Set<Topic>([
  'status',
  'data',
  'mode',
  'selection',
  'filters',
  'search',
  'review',
  'replay',
  'hover',
  'theme',
  'locale',
  'focus',
  'swipe',
  'overview',
]);

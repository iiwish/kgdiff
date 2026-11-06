/**
 * Inline SVG icon bodies for a 16 × 16 viewBox, drawn with a 1.5 px `currentColor` stroke.
 * Static markup only (never user data).
 */
export const ICONS = {
  overlay:
    '<path d="M8 2.25 14 5.5 8 8.75 2 5.5Z"/><path d="m2 8.25 6 3.25 6-3.25"/><path d="m2 11 6 3.25L14 11" opacity=".55"/>',
  swipe:
    '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M8 1.75v12.5"/><path d="M4.75 8h-1M12.25 8h-1" opacity=".55"/>',
  replay:
    '<path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.78"/><path d="M2.5 2.5v2.75h2.75"/><path d="M8 5.25V8l1.9 1.3"/>',
  changes:
    '<path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2"/><circle cx="8" cy="8" r="1.9"/>',
  fit: '<path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10"/>',
  help: '<circle cx="8" cy="8" r="6"/><path d="M6.25 6.25a1.8 1.8 0 0 1 3.5.5c0 1.25-1.75 1.5-1.75 2.6"/><path d="M8 11.3v.01"/>',
  sidebar: '<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="M10 2.75v10.5"/>',
  contrast:
    '<circle cx="8" cy="8" r="5.75"/><path d="M8 2.25a5.75 5.75 0 0 1 0 11.5Z" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05"/>',
  moon: '<path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85Z"/>',
  monitor:
    '<rect x="2" y="2.75" width="12" height="8.5" rx="1.5"/><path d="M5.5 13.75h5M8 11.25v2.5"/>',
  filter: '<path d="M2.5 3.25h11L9.25 8.5v3.75l-2.5 1.25v-5Z"/>',
  search: '<circle cx="7.25" cy="7.25" r="4.5"/><path d="m10.6 10.6 3 3"/>',
  close: '<path d="m4.25 4.25 7.5 7.5M11.75 4.25l-7.5 7.5"/>',
  check: '<path d="m3.5 8.4 3 2.9 6-6.6"/>',
  'chevron-left': '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  'chevron-right': '<path d="M6 3.5 10.5 8 6 12.5"/>',
  'chevron-up': '<path d="M3.5 10 8 5.5l4.5 4.5"/>',
  'chevron-down': '<path d="M3.5 6 8 10.5 12.5 6"/>',
  play: '<path d="M5.25 3.6v8.8a.5.5 0 0 0 .77.42l6.6-4.4a.5.5 0 0 0 0-.84l-6.6-4.4a.5.5 0 0 0-.77.42Z" fill="currentColor"/>',
  pause: '<path d="M5.5 3.75v8.5M10.5 3.75v8.5" stroke-width="2"/>',
  'skip-back':
    '<path d="M12 4.1v7.8a.5.5 0 0 1-.78.41L5.6 8.41a.5.5 0 0 1 0-.82l5.62-3.9A.5.5 0 0 1 12 4.1Z" fill="currentColor"/><path d="M3.75 4v8"/>',
  'skip-forward':
    '<path d="M4 4.1v7.8a.5.5 0 0 0 .78.41l5.62-3.9a.5.5 0 0 0 0-.82L4.78 3.69A.5.5 0 0 0 4 4.1Z" fill="currentColor"/><path d="M12.25 4v8"/>',
  restart: '<path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.78"/><path d="M2.5 2.5v2.75h2.75"/>',
  plus: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  minus: '<path d="M3.25 8h9.5"/>',
  target:
    '<circle cx="8" cy="8" r="4.25"/><path d="M8 1.75v2.5M8 11.75v2.5M1.75 8h2.5M11.75 8h2.5"/>',
  'check-circle': '<circle cx="8" cy="8" r="6"/><path d="m5.4 8.2 1.85 1.85L10.75 6.3"/>',
  alert:
    '<path d="M8 2.25 14.25 13a.5.5 0 0 1-.43.75H2.18a.5.5 0 0 1-.43-.75Z"/><path d="M8 6.5v3"/><path d="M8 11.6v.01"/>',
  keyboard:
    '<rect x="1.75" y="4" width="12.5" height="8" rx="1.5"/><path d="M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5.5 9.5h5"/>',
} as const;

export type IconName = keyof typeof ICONS;

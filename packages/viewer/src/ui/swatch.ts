/**
 * Family swatches: the node cue of each family (docs/visual-language.md §Meaning families), drawn
 * the same in the legend and on the sidebar's filter chips so the chips double as a legend.
 */
import type { Family } from '@kgdiff/scene';

export function swatch(family: Family): SVGSVGElement {
  const v = (name: string) => `var(--kgdiff-${name})`;
  const c = family === 'neutral' ? v('neutral') : v(family);
  let body: string;
  switch (family) {
    case 'added':
      body = `<circle cx="11" cy="11" r="8.5" fill="none" stroke="${c}" stroke-opacity=".35" stroke-width="2"/><circle cx="11" cy="11" r="5" fill="${c}"/>`;
      break;
    case 'removed':
      body = `<circle cx="11" cy="11" r="5.25" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="3 2.5"/>`;
      break;
    case 'identity':
      body = `<circle cx="11" cy="11" r="9.5" fill="none" stroke="${c}" stroke-opacity=".3" stroke-width="1.5"/><circle cx="11" cy="11" r="7.25" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="11" cy="11" r="4.25" fill="${c}"/>`;
      break;
    case 'content':
    case 'structure':
      body = `<circle cx="11" cy="11" r="7.75" fill="none" stroke="${c}" stroke-width="1.5"/><circle cx="11" cy="11" r="4.5" fill="${c}"/>`;
      break;
    default:
      body = `<circle cx="11" cy="11" r="3.5" fill="${c}"/>`;
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="swatch" viewBox="0 0 22 22" aria-hidden="true" focusable="false">${body}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}

/**
 * Node search (RFC 0001 §3, `<kgdiff-search>` from phase 2): a combobox and the results list it
 * owns. ID references (`aria-controls`, `aria-activedescendant`) do not cross shadow roots, so
 * input and results stay in one component; the layout decides where the results show (the
 * default layout puts them in the change list's place). The query and its hits live in the
 * session, so the change list steps aside without either knowing the other. Registers itself
 * as the root's `search` focus target (`/`).
 */
import { attr, h, icon, replace } from '../dom.js';
import type { Topic } from '../session.js';
import type { UiContext } from './context.js';

export class Search {
  /** The search box. */
  readonly box: HTMLElement;
  /** The results listbox. */
  readonly results: HTMLElement;
  readonly input: HTMLInputElement;
  readonly #kbd: HTMLElement;
  readonly #clear: HTMLButtonElement;
  #activeHit = 0;
  /** The query the results were rendered for (a new one starts at its first hit). */
  #rendered = '';

  readonly #ctx: UiContext;

  constructor(ctx: UiContext) {
    this.#ctx = ctx;
    this.input = h('input', {
      type: 'search',
      autocomplete: 'off',
      spellcheck: 'false',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': 'kg-results',
      enterkeyhint: 'go',
    });
    this.#kbd = h('kbd', { 'aria-hidden': 'true', text: '/' });
    this.#clear = h(
      'button',
      { type: 'button', class: 'clear', hidden: true, onclick: () => this.#setQuery('', true) },
      icon('close'),
    );
    this.input.addEventListener('input', () => this.#setQuery(this.input.value));
    this.input.addEventListener('keydown', (e) => this.#onKey(e));
    this.input.addEventListener('focus', () => this.#renderChrome());
    this.input.addEventListener('blur', () => this.#renderChrome());
    this.results = h('div', {
      class: 'results list scroll',
      id: 'kg-results',
      role: 'listbox',
      hidden: true,
    });
    this.box = h('div', { class: 'search' }, icon('search'), this.input, this.#kbd, this.#clear);
    ctx.target('search', () => {
      this.input.focus();
      this.input.select();
    });
  }

  update(topics: ReadonlySet<Topic>): void {
    const all = topics.has('status') || topics.has('data') || topics.has('locale');
    if (all) {
      const tr = this.#ctx.tr();
      this.input.placeholder = tr.t('sidebar.searchPlaceholder');
      attr(this.input, 'aria-label', tr.t('sidebar.search'));
      attr(this.#clear, 'aria-label', tr.t('sidebar.searchClear'));
      this.input.disabled = this.#ctx.controller.status !== 'ready';
    }
    if (all || topics.has('search')) this.#render();
  }

  #setQuery(query: string, focus = false): void {
    this.#ctx.controller.setQuery(query);
    if (focus) this.input.focus();
  }

  #render(): void {
    const query = this.#ctx.controller.query;
    if (this.input.value !== query) this.input.value = query;
    if (query !== this.#rendered) this.#activeHit = 0;
    this.#rendered = query;
    const searching = query.trim() !== '';
    this.results.hidden = !searching;
    attr(this.input, 'aria-expanded', String(searching));
    this.#renderChrome();
    if (searching) this.#renderResults();
    else replace(this.results);
  }

  #renderChrome(): void {
    const query = this.#ctx.controller.query;
    const focused = this.#ctx.root.activeElement === this.input;
    this.#kbd.hidden = query !== '' || focused;
    this.#clear.hidden = query === '';
  }

  #renderResults(): void {
    const tr = this.#ctx.tr();
    const c = this.#ctx.controller;
    const q = c.query.trim();
    const hits = c.hits;
    if (hits.length === 0) {
      replace(
        this.results,
        h(
          'div',
          { class: 'list-empty' },
          icon('search'),
          h('span', { text: tr.t('sidebar.noResults', { q }) }),
        ),
      );
      attr(this.input, 'aria-activedescendant', null);
      return;
    }
    const scene = c.scene;
    const rows = hits.map((hit, i) => {
      const sceneIndex = scene?.nodeIndex.get(hit.node.id);
      const sn = sceneIndex !== undefined ? scene?.nodes[sceneIndex] : undefined;
      const family =
        sn?.family ??
        (hit.node.status === 'added'
          ? 'added'
          : hit.node.status === 'removed'
            ? 'removed'
            : hit.node.status === 'modified'
              ? 'content'
              : 'neutral');
      const sub =
        hit.field === 'label' ? hit.node.id : hit.field === 'alias' ? hit.matched : hit.matched;
      return h(
        'button',
        {
          type: 'button',
          class: 'result',
          role: 'option',
          id: `kg-hit-${i}`,
          tabindex: '-1',
          'data-family': family,
          'aria-selected': String(i === this.#activeHit),
          onclick: () => this.#choose(i),
          onpointermove: () => this.#setActiveHit(i),
        },
        h('span', { class: 'sdot', 'aria-hidden': 'true' }),
        h(
          'span',
          { class: 'txt' },
          h('span', { class: 'title' }, highlight(hit.node.label, hit.field === 'label' ? q : '')),
          h('span', { class: 'sub' }, highlight(sub, hit.field === 'label' ? '' : q)),
        ),
        h('span', { class: 'status', text: tr.t(`status.${hit.node.status}`) }),
      );
    });
    replace(
      this.results,
      h('div', {
        class: 'results-head',
        text: tr.plural('sidebar.results', hits.length),
      }),
      rows,
    );
    attr(this.input, 'aria-activedescendant', `kg-hit-${this.#activeHit}`);
  }

  #setActiveHit(i: number): void {
    if (i === this.#activeHit || i < 0 || i >= this.#ctx.controller.hits.length) return;
    this.#activeHit = i;
    for (const el of this.results.querySelectorAll('.result')) {
      attr(el, 'aria-selected', String(el.id === `kg-hit-${i}`));
    }
    attr(this.input, 'aria-activedescendant', `kg-hit-${i}`);
    this.results.querySelector(`#kg-hit-${i}`)?.scrollIntoView?.({ block: 'nearest' });
  }

  /** Choose a hit: its node is revealed and selected, and focus moves to the change list. */
  #choose(i: number): void {
    const hit = this.#ctx.controller.hits[i];
    if (!hit) return;
    this.#setQuery('');
    this.#ctx.controller.revealNode(hit.node.id);
    this.#ctx.focus('list');
  }

  #onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.#setActiveHit(Math.min(this.#ctx.controller.hits.length - 1, this.#activeHit + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.#setActiveHit(Math.max(0, this.#activeHit - 1));
        break;
      case 'Enter':
        e.preventDefault();
        this.#choose(this.#activeHit);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (this.#ctx.controller.query) this.#setQuery('');
        else this.#ctx.focus('list');
        break;
      default:
        return;
    }
  }
}

/** The label with the first occurrence of `q` (case-insensitive) marked. */
function highlight(text: string, q: string): (string | HTMLElement)[] {
  if (!q) return [text];
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return [text];
  return [
    text.slice(0, at),
    h('mark', { text: text.slice(at, at + q.length) }),
    text.slice(at + q.length),
  ];
}

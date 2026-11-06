/**
 * The replay transport (RFC 0001 §3, `<kgdiff-transport>`): previous / play-pause / next, the
 * scrubber with one tick per change (colored by family, the change under the pointer named in a
 * tip), the position and the speed; and the "Replay finished · Restart" pill shown above it at
 * the end. Shown in replay mode only. The stage stacks it above the view dock.
 */
import type { ChangeFamily } from '@kgdiff/scene';
import {
  attr,
  h,
  icon,
  iconButton,
  relabel,
  replace,
  replaceKeepingFocus,
  setText,
} from '../dom.js';
import type { Translator } from '../i18n.js';
import type { Topic } from '../topics.js';
import { sceneHunkGlyph, type UiContext } from './context.js';

const TICK_W = 1000;

export class Transport {
  /** The toolbar. */
  readonly el: HTMLElement;
  /** The pill shown at the end of a replay (it takes the caption's place). */
  readonly finished: HTMLElement;
  readonly #play: HTMLButtonElement;
  readonly #prev: HTMLButtonElement;
  readonly #next: HTMLButtonElement;
  readonly #scrubber: HTMLElement;
  readonly #fill: HTMLElement;
  readonly #knob: HTMLElement;
  readonly #ticks: SVGSVGElement;
  readonly #tip: HTMLElement;
  readonly #pos: HTMLElement;
  readonly #speed: HTMLButtonElement;
  #scrubbing: number | null = null;

  readonly #ctx: UiContext;

  constructor(ctx: UiContext) {
    this.#ctx = ctx;
    const c = ctx.controller;
    this.#prev = iconButton('skip-back', '', () => c.stepReplay(-1), { class: 'icon-btn' });
    this.#play = iconButton('play', '', () => c.togglePlay(), { class: 'icon-btn play' });
    this.#next = iconButton('skip-forward', '', () => c.stepReplay(1), { class: 'icon-btn' });
    this.#fill = h('div', { class: 'fill' });
    this.#knob = h('div', { class: 'knob' });
    this.#ticks = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.#ticks.setAttribute('class', 'ticks');
    this.#ticks.setAttribute('viewBox', `0 0 ${TICK_W} 14`);
    this.#ticks.setAttribute('preserveAspectRatio', 'none');
    this.#ticks.setAttribute('aria-hidden', 'true');
    this.#tip = h('div', { class: 'scrub-tip card', hidden: true });
    this.#scrubber = h(
      'div',
      { class: 'scrubber', role: 'slider', tabindex: '0', 'aria-valuemin': '0' },
      h('div', { class: 'track' }, this.#fill),
      this.#ticks,
      this.#knob,
      this.#tip,
    );
    this.#bindScrubber();
    this.#pos = h('span', { class: 'pos', 'aria-hidden': 'true' });
    this.#speed = h('button', { type: 'button', class: 'speed', onclick: () => c.cycleSpeed() });
    this.el = h(
      'div',
      { class: 'transport card', role: 'toolbar' },
      this.#prev,
      this.#play,
      this.#next,
      this.#scrubber,
      this.#pos,
      this.#speed,
    );
    this.finished = h('div', { class: 'finished card', role: 'status', hidden: true });
  }

  update(topics: ReadonlySet<Topic>): void {
    const tr = this.#ctx.tr();
    const all = topics.has('status') || topics.has('data') || topics.has('locale');
    if (all) this.#renderLabels(tr);
    if (all || topics.has('theme')) this.#renderTicks();
    if (all || topics.has('mode')) this.el.hidden = this.#ctx.controller.mode !== 'replay';
    if (all || topics.has('mode') || topics.has('replay')) this.#render(tr);
  }

  #renderLabels(tr: Translator): void {
    relabel(this.#prev, `${tr.t('detail.prev')} (←)`);
    relabel(this.#next, `${tr.t('detail.next')} (→)`);
    attr(this.el, 'aria-label', tr.t('replay.label'));
    attr(this.#scrubber, 'aria-label', tr.t('replay.scrubber'));
  }

  #render(tr: Translator): void {
    const c = this.#ctx.controller;
    const clock = c.clock;
    if (c.mode !== 'replay' || !clock || !c.scene) {
      this.finished.hidden = true;
      return;
    }
    const p = clock.progress;
    this.#fill.style.transform = `scaleX(${p})`;
    this.#knob.style.left = `${p * 100}%`;
    const position = clock.position();
    const total = clock.total;
    setText(this.#pos, tr.t('replay.position', { i: position, n: total }));
    attr(this.#scrubber, 'aria-valuemax', String(Math.round(clock.duration)));
    attr(this.#scrubber, 'aria-valuenow', String(Math.round(clock.t)));
    attr(this.#scrubber, 'aria-valuetext', tr.t('replay.position', { i: position, n: total }));
    const playing = clock.playing;
    if (this.#play.dataset.state !== String(playing)) {
      this.#play.dataset.state = String(playing);
      replace(this.#play, icon(playing ? 'pause' : 'play'));
    }
    relabel(this.#play, `${tr.t(playing ? 'replay.pause' : 'replay.play')} (Space)`);
    setText(this.#speed, `${clock.speed}×`);
    relabel(this.#speed, tr.t('replay.speed', { s: `${clock.speed}×` }));
    this.#prev.disabled = clock.t <= 0;
    this.#next.disabled = clock.t >= clock.duration;
    const finished = clock.finished;
    this.finished.hidden = !finished;
    if (finished && this.finished.childElementCount === 0) {
      replace(
        this.finished,
        icon('check-circle'),
        h('span', { text: tr.t('replay.finished') }),
        h(
          'button',
          { type: 'button', class: 'btn', onclick: () => c.restart() },
          icon('restart'),
          tr.t('replay.restart'),
        ),
      );
    } else if (!finished && this.finished.childElementCount > 0) {
      // Restart was pressed from the pill: keep focus in the transport.
      replaceKeepingFocus(this.#ctx.root, this.finished, this.#play);
    }
  }

  #renderTicks(): void {
    const c = this.#ctx.controller;
    const clock = c.clock;
    const scene = c.scene;
    while (this.#ticks.firstChild) this.#ticks.removeChild(this.#ticks.firstChild);
    if (!clock || !scene || clock.duration <= 0) return;
    const paths = new Map<ChangeFamily, string[]>();
    for (const w of clock.timeline.windows) {
      const fam = scene.hunks[w.hunk]?.family;
      if (!fam) continue;
      const x = ((w.start / clock.duration) * TICK_W).toFixed(1);
      let list = paths.get(fam);
      if (!list) {
        list = [];
        paths.set(fam, list);
      }
      list.push(`M${x} 2V12`);
    }
    for (const [fam, d] of paths) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d.join(''));
      p.setAttribute('stroke', `var(--kgdiff-${fam})`);
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      this.#ticks.appendChild(p);
    }
  }

  #bindScrubber(): void {
    const timeAt = (clientX: number): number => {
      const clock = this.#ctx.controller.clock;
      const r = this.#scrubber.getBoundingClientRect();
      if (!clock || r.width <= 0) return 0;
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * clock.duration;
    };
    this.#scrubber.addEventListener('pointerdown', (e) => {
      this.#scrubbing = e.pointerId;
      this.#scrubber.setPointerCapture?.(e.pointerId);
      this.#ctx.controller.pause();
      this.#ctx.controller.seek(timeAt(e.clientX));
    });
    this.#scrubber.addEventListener('pointermove', (e) => {
      if (this.#scrubbing === e.pointerId) this.#ctx.controller.seek(timeAt(e.clientX));
      this.#showTip(e.clientX, timeAt(e.clientX));
    });
    const end = (e: PointerEvent): void => {
      if (this.#scrubbing === e.pointerId) this.#scrubbing = null;
    };
    this.#scrubber.addEventListener('pointerup', end);
    this.#scrubber.addEventListener('pointercancel', end);
    this.#scrubber.addEventListener('pointerleave', () => {
      this.#tip.hidden = true;
    });
    this.#scrubber.addEventListener('keydown', (e) => {
      const c = this.#ctx.controller;
      if (e.key === 'Home') c.seek(0);
      else if (e.key === 'End') c.seek(c.clock?.duration ?? 0);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  #showTip(clientX: number, t: number): void {
    const c = this.#ctx.controller;
    const clock = c.clock;
    const scene = c.scene;
    if (!clock || !scene) return;
    // Nearest window start: the tick under the pointer.
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (const w of clock.timeline.windows) {
      const d = Math.abs(w.start - t);
      if (d < bestD) {
        bestD = d;
        best = w.hunk;
      }
    }
    const hunk = scene.hunks[best];
    if (!hunk) {
      this.#tip.hidden = true;
      return;
    }
    const r = this.#scrubber.getBoundingClientRect();
    this.#tip.hidden = false;
    this.#tip.style.left = `${clientX - r.left}px`;
    if (this.#tip.dataset.hunk !== hunk.id) {
      this.#tip.dataset.hunk = hunk.id;
      replace(
        this.#tip,
        h('span', { class: 'glyph-box', 'data-family': hunk.family, text: sceneHunkGlyph(hunk) }),
        h('span', { text: hunk.title }),
      );
    }
  }
}

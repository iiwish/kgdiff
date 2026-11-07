/**
 * Shadow-DOM styles, one constructable stylesheet parsed once and shared by every shadow root
 * that adopts it. Colors, fonts and motion are the `--kgdiff-*` tokens a root sets (`theme.ts`);
 * the sheet only references `var(--kgdiff-…)`. Spacing follows a 4 / 8 px grid; borders are
 * hairlines.
 */
import type { ChangeFamily } from '@kgdiff/scene';

export const FAMILIES: readonly ChangeFamily[] = [
  'added',
  'removed',
  'content',
  'structure',
  'identity',
];

const familyRules = [...FAMILIES, 'neutral' as const]
  .map((f) =>
    f === 'neutral'
      ? `[data-family="neutral"] { --fam-base: var(--kgdiff-neutral); --fam-soft: var(--kgdiff-hover); --fam-text: var(--kgdiff-text-secondary); }`
      : `[data-family="${f}"] { --fam-base: var(--kgdiff-${f}); --fam-soft: var(--kgdiff-${f}-soft); --fam-text: var(--kgdiff-${f}-text); }`,
  )
  .join('\n');

export const STYLES = /* css */ `
:host {
  all: initial;
  display: block;
  position: relative;
  height: 100%;
  min-height: 420px;
  contain: content;
  font-family: var(--kgdiff-font);
  font-size: 13px;
  line-height: 1.45;
  color: var(--kgdiff-text);
  background: var(--kgdiff-background);
  -webkit-font-smoothing: antialiased;
}
:host([hidden]) { display: none; }
/* chrome="none" shows the graph alone: small embeds (a 320 px strip) are fine. */
:host([chrome="none"]) { min-height: 120px; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input { font: inherit; color: inherit; letter-spacing: inherit; }
button {
  margin: 0; padding: 0; border: 0; background: none; cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
button:disabled { cursor: default; opacity: 0.4; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--kgdiff-accent); outline-offset: 2px; }
.icon { width: 16px; height: 16px; flex: none; display: block; }
.sr-only {
  position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
kbd {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 5px; border-radius: 5px;
  font: 500 11px/1 var(--kgdiff-font-mono); color: var(--kgdiff-text-secondary);
  background: var(--kgdiff-kbd); box-shadow: inset 0 0 0 1px var(--kgdiff-border), inset 0 -1px 0 var(--kgdiff-border);
}
.scroll { overflow: auto; scrollbar-width: thin; scrollbar-color: var(--kgdiff-border-strong) transparent; }

/* ── Root layout ─────────────────────────────────────────────────────────── */
.root {
  position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden;
  background: var(--kgdiff-background);
}
.body { position: relative; flex: 1; min-height: 0; display: flex; container-type: inline-size; }
.stage-wrap { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; background: var(--kgdiff-background); container-type: inline-size; }
.stage { position: absolute; inset: 0; }
.stage canvas { outline: none; }
.stage canvas:focus-visible { outline: 2px solid var(--kgdiff-accent); outline-offset: -2px; }
.chrome { position: absolute; inset: 0; pointer-events: none; }
.chrome > * { pointer-events: auto; }
/* Until a diff is ready only the page's slotted content shows. */
.chrome[data-ready="false"] > :not(.corner, .dock), .chrome[data-ready="false"] .corner > :not(slot),
.chrome[data-ready="false"] .dock > :not(slot) { display: none !important; }
/* <kgdiff-stage>: the page's content in the corners, further from the corner than the chrome. */
.corner { position: absolute; z-index: 2; display: flex; flex-direction: column; gap: 8px; max-width: calc(50% - 24px); pointer-events: none; }
.corner > * { pointer-events: auto; }
.corner.top-start { top: 12px; left: 12px; align-items: flex-start; }
.corner.top-end { top: 12px; right: 12px; align-items: flex-end; }
.corner.bottom-start { bottom: 16px; left: 16px; align-items: flex-start; }
.corner.bottom-end { bottom: 16px; right: 16px; align-items: flex-end; }
.corner > .float { position: static; }
/* A minimap slotted in replaces the stage's own: hidden while everything is in view, as it is. */
::slotted(kgdiff-minimap:state(overview)) { display: none; }
/* <kgdiff-viewer>: the top corners sit under the title and the actions it shows. */
.stage-wrap[data-hud~="title"] .corner.top-start, .stage-wrap[data-hud~="actions"] .corner.top-end { top: 64px; }

/* ── Buttons ─────────────────────────────────────────────────────────────── */
.icon-btn {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 32px; height: 32px; border-radius: 8px; color: var(--kgdiff-text-secondary);
  transition: background var(--kgdiff-fast) var(--kgdiff-ease), color var(--kgdiff-fast) var(--kgdiff-ease);
}
.icon-btn:hover { background: var(--kgdiff-hover); color: var(--kgdiff-text); }
.icon-btn:active { background: var(--kgdiff-press); }
.icon-btn[aria-pressed="true"], .icon-btn[aria-expanded="true"] { background: var(--kgdiff-press); color: var(--kgdiff-text); }
.icon-btn.sm { width: 28px; height: 28px; border-radius: 7px; }
.btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: 7px; font-size: 12px; font-weight: 500; color: var(--kgdiff-text);
  background: var(--kgdiff-hover); box-shadow: inset 0 0 0 1px var(--kgdiff-border);
  transition: background var(--kgdiff-fast) var(--kgdiff-ease), box-shadow var(--kgdiff-fast) var(--kgdiff-ease);
}
.btn:hover { background: var(--kgdiff-press); box-shadow: inset 0 0 0 1px var(--kgdiff-border-strong); }
.link-btn { min-height: 28px; color: var(--kgdiff-accent-text); font-weight: 500; font-size: 12px; border-radius: 4px; }
.link-btn:hover { text-decoration: underline; text-underline-offset: 3px; }

/* ── HUD: title (top-left) and actions (top-right), over the canvas ──────── */
.hud { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
.hud > * { pointer-events: auto; }
.hud-title {
  position: absolute; top: 12px; left: 12px; max-width: calc(100% - 184px); height: 40px;
  display: flex; align-items: center; gap: 10px; padding: 0 14px 0 10px;
}
.hud-title[data-titled="false"] .header-sep { display: none; }
.hud-end { position: absolute; top: 12px; right: 12px; }
.hud-actions { display: flex; align-items: center; gap: 2px; padding: 4px; }
.brand { display: flex; align-items: center; gap: 8px; flex: none; color: var(--kgdiff-text); }
.brand-mark { width: 20px; height: 20px; display: block; }
.brand-name { font-size: 14px; font-weight: 650; letter-spacing: -0.01em; }
.header-sep { width: 1px; height: 18px; background: var(--kgdiff-border-strong); flex: none; }
.versions { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 0 1 auto; font-size: 13px; overflow: hidden; }
.versions .name { font-weight: 550; color: var(--kgdiff-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.versions .arrow { color: var(--kgdiff-text-muted); flex: none; }
.versions .side { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tag {
  display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: 5px; flex: none;
  font: 500 11px/1 var(--kgdiff-font-mono); color: var(--kgdiff-text-secondary); background: var(--kgdiff-hover);
  box-shadow: inset 0 0 0 1px var(--kgdiff-border); white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis;
}

.segmented {
  position: relative; display: inline-flex; align-items: center; gap: 2px; height: 32px; padding: 2px; flex: none;
  border-radius: 9px; background: var(--kgdiff-hover); box-shadow: inset 0 0 0 1px var(--kgdiff-border);
}
.segmented .thumb {
  position: absolute; top: 2px; bottom: 2px; left: 0; width: 0; border-radius: 7px;
  background: var(--kgdiff-raised); box-shadow: 0 1px 2px rgba(0,0,0,0.12), inset 0 0 0 1px var(--kgdiff-border-strong);
  transition: transform var(--kgdiff-base) var(--kgdiff-ease), width var(--kgdiff-base) var(--kgdiff-ease);
}
.seg {
  position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: 7px; font-size: 12.5px; font-weight: 500; color: var(--kgdiff-text-secondary); white-space: nowrap;
  transition: color var(--kgdiff-fast) var(--kgdiff-ease);
}
.seg:hover { color: var(--kgdiff-text); }
.seg[aria-checked="true"] { color: var(--kgdiff-text); }
.seg .icon { opacity: 0.9; }


${familyRules}

/* ── Floating chrome ─────────────────────────────────────────────────────── */
.card {
  background: var(--kgdiff-overlay); border-radius: 12px; box-shadow: var(--kgdiff-shadow), 0 0 0 1px var(--kgdiff-border);
  backdrop-filter: blur(16px) saturate(140%);
}
.float { position: absolute; }
.bottom-left { bottom: 16px; left: 16px; }
.bottom-right { bottom: 16px; right: 16px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px;
  font-size: 12px; font-weight: 600; color: var(--kgdiff-text-secondary); letter-spacing: 0.01em;
}

.map-cluster { display: flex; align-items: flex-end; gap: 8px; }
.zoom-bar { display: flex; flex-direction: column; padding: 2px; gap: 2px; }
.zoom-bar .icon-btn { width: 30px; height: 30px; }
.minimap-host { position: relative; width: 184px; height: 128px; border-radius: 12px; box-shadow: 0 0 0 1px var(--kgdiff-border);
  animation: fade var(--kgdiff-base) var(--kgdiff-ease); }
/* Everything is in view: the minimap has nothing to add. */
.minimap-host[data-hidden="true"] { display: none; }
.minimap-host canvas { border-radius: 12px; }

.legend { padding: 6px; min-width: 0; }
.legend-head { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px 0 8px; font-size: 11px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--kgdiff-text-muted); border-radius: 7px; width: 100%; }
.legend-head:hover { color: var(--kgdiff-text-secondary); background: var(--kgdiff-hover); }
.legend-head .icon { width: 14px; height: 14px; margin-left: auto; transition: transform var(--kgdiff-base) var(--kgdiff-ease); }
.legend[data-open="false"] .legend-head .icon { transform: rotate(180deg); }
.legend[data-open="false"] .legend-body { display: none; }
.legend[data-open="false"] { padding: 2px; }
.legend-body { display: grid; gap: 2px; padding: 2px 4px 4px; }
.legend-row { display: grid; grid-template-columns: 22px auto; align-items: center; column-gap: 8px; height: 26px; padding: 0 10px 0 4px; border-radius: 6px; cursor: default; }
.legend-row .name { font-size: 12px; font-weight: 550; color: var(--kgdiff-text); }
.swatch { width: 22px; height: 22px; display: block; }
.mini-legend { display: none; }
.stage-wrap[data-legend="mini"] .mini-legend {
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px 12px; bottom: 8px; left: 12px; max-width: calc(100% - 24px);
  font-size: 11px; line-height: 16px; color: var(--kgdiff-text-secondary);
}
.mini-item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.mini-item .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--fam-base); }
.mini-item[data-family="removed"] .dot { background: none; box-shadow: inset 0 0 0 1.5px var(--fam-base); }
.stage-wrap[data-legend="mini"] .legend, .stage-wrap[data-legend="none"] .legend { display: none; }

.caption {
  max-width: min(560px, 100%); display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px 0 6px;
  font-size: 12.5px; font-weight: 550;
}
.caption .text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.caption .count { color: var(--kgdiff-text-muted); font-weight: 500; font-variant-numeric: tabular-nums; flex: none; }
.caption[data-empty="true"] { display: none; }

.glyph-box {
  display: inline-flex; align-items: center; justify-content: center; flex: none; width: 20px; height: 20px; border-radius: 6px;
  font-size: 12px; font-weight: 700; line-height: 1; color: var(--fam-text); background: var(--fam-soft);
}

/* View dock (bottom center): replay's finished pill, caption and transport stack above the bar. */
.chrome > .dock {
  position: absolute; left: 16px; right: 16px; bottom: 16px; display: flex; flex-direction: column; align-items: center;
  gap: 8px; pointer-events: none;
}
.dock > * { pointer-events: auto; }
.dock-bar { display: flex; align-items: center; gap: 4px; height: 44px; padding: 0 6px; max-width: 100%; }
.dock-sep { width: 1px; height: 20px; margin: 0 2px; flex: none; background: var(--kgdiff-border-strong); }
.scope-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 9px; flex: none;
  font-size: 12.5px; font-weight: 500; color: var(--kgdiff-text-secondary); white-space: nowrap;
  transition: background var(--kgdiff-fast) var(--kgdiff-ease), color var(--kgdiff-fast) var(--kgdiff-ease), box-shadow var(--kgdiff-fast) var(--kgdiff-ease);
}
.scope-btn:hover { color: var(--kgdiff-text); background: var(--kgdiff-hover); }
.scope-btn[aria-pressed="true"] { color: var(--kgdiff-accent-text); background: var(--kgdiff-accent-soft); box-shadow: inset 0 0 0 1px var(--kgdiff-accent-soft); }
.scope-btn[aria-disabled="true"] { cursor: default; }
.context { display: inline-flex; align-items: center; gap: 8px; padding-left: 2px; flex: none; animation: reveal var(--kgdiff-base) var(--kgdiff-ease); }
@keyframes reveal { from { opacity: 0; transform: translateX(-6px); } }
.context .label { font-size: 12px; font-weight: 550; color: var(--kgdiff-text-muted); white-space: nowrap; }
.context .opts { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--kgdiff-hover); }
.context .opt { width: 28px; height: 28px; border-radius: 6px; font-size: 12px; font-weight: 600; color: var(--kgdiff-text-secondary); font-variant-numeric: tabular-nums; }
.context .opt:hover { color: var(--kgdiff-text); }
.context .opt[aria-checked="true"] { background: var(--kgdiff-raised); color: var(--kgdiff-text); box-shadow: inset 0 0 0 1px var(--kgdiff-border-strong); }
.context .expand { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px 0 8px; border-radius: 7px; font-size: 12px; font-weight: 600; color: var(--kgdiff-text-secondary); box-shadow: inset 0 0 0 1px var(--kgdiff-border-strong); font-variant-numeric: tabular-nums; }
.context .expand:hover:not(:disabled) { color: var(--kgdiff-text); background: var(--kgdiff-hover); }
.context .expand .icon { width: 14px; height: 14px; }
/* Narrower canvases keep the dock clear of the legend and the minimap: labels give way to icons
   (each control keeps its name as a tooltip). */
@container (max-width: 1180px) { .context .label { display: none; } }
@container (max-width: 1000px) { .dock-bar .seg .lbl { display: none; } .dock-bar .seg { padding: 0 9px; } }
@container (max-width: 640px) { .scope-btn .lbl { display: none; } .scope-btn { padding: 0 9px; } }

/* Swipe */
.swipe { position: absolute; inset: 0; pointer-events: none; }
.swipe .divider {
  position: absolute; top: 0; bottom: 0; left: 0; width: 24px; margin-left: -12px; cursor: ew-resize; pointer-events: auto;
  touch-action: none; display: flex; justify-content: center;
}
.swipe .divider::before { content: ''; width: 1.5px; height: 100%; background: var(--kgdiff-accent); opacity: 0.85; box-shadow: 0 0 12px var(--kgdiff-accent-soft); }
.swipe .handle {
  position: absolute; top: 50%; left: 50%; width: 32px; height: 32px; margin: -16px 0 0 -16px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center; gap: 0; color: var(--kgdiff-accent-text);
  background: var(--kgdiff-overlay); box-shadow: var(--kgdiff-shadow), 0 0 0 1.5px var(--kgdiff-accent);
  backdrop-filter: blur(16px);
  transition: transform var(--kgdiff-fast) var(--kgdiff-ease);
}
.swipe .handle .icon { width: 12px; height: 12px; }
.swipe .divider:hover .handle, .swipe .divider.dragging .handle { transform: scale(1.08); }
.swipe .divider:focus-visible { outline: none; }
.swipe .divider:focus-visible .handle { box-shadow: var(--kgdiff-shadow), 0 0 0 2px var(--kgdiff-accent), 0 0 0 5px var(--kgdiff-accent-soft); }
/* Below the HUD's title and actions. */
.swipe .side-chip { position: absolute; top: 64px; pointer-events: none; }
.swipe .side-chip.before { left: 12px; }
.swipe .side-chip.after { right: 12px; }

/* Replay transport (in the dock, clear of the legend and the minimap) */
.transport {
  width: min(600px, calc(100% - 464px)); min-width: min(360px, 100%);
  display: flex; align-items: center; gap: 4px; height: 48px; padding: 0 8px;
}
.transport .play { width: 36px; height: 36px; border-radius: 10px; color: var(--kgdiff-text); }
.transport .play .icon { width: 18px; height: 18px; }
.transport .pos { flex: none; min-width: 64px; text-align: center; font-size: 12px; font-weight: 550; color: var(--kgdiff-text-secondary); font-variant-numeric: tabular-nums; }
.transport .speed { flex: none; height: 28px; min-width: 44px; padding: 0 8px; border-radius: 7px; font-size: 12px; font-weight: 600; color: var(--kgdiff-text-secondary); font-variant-numeric: tabular-nums; box-shadow: inset 0 0 0 1px var(--kgdiff-border); }
.transport .speed:hover { color: var(--kgdiff-text); background: var(--kgdiff-hover); }
.scrubber { position: relative; flex: 1; height: 36px; margin: 0 8px; cursor: pointer; touch-action: none; border-radius: 6px; }
.scrubber .track { position: absolute; left: 0; right: 0; top: 50%; height: 4px; margin-top: -2px; border-radius: 2px; background: var(--kgdiff-track); overflow: hidden; }
.scrubber .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; transform-origin: left; background: var(--kgdiff-accent); opacity: 0.85; }
.scrubber .ticks { position: absolute; left: 0; right: 0; top: 50%; height: 14px; margin-top: -7px; width: 100%; pointer-events: none; overflow: visible; }
.scrubber .knob {
  position: absolute; top: 50%; left: 0; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
  background: var(--kgdiff-text); box-shadow: 0 1px 4px rgba(0,0,0,0.35), 0 0 0 3px var(--kgdiff-accent-soft); pointer-events: none;
}
.scrubber:focus-visible { outline-offset: 0; }
.scrub-tip {
  position: absolute; bottom: 100%; margin-bottom: 10px; transform: translateX(-50%); max-width: 320px; padding: 6px 10px;
  font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
  display: flex; align-items: center; gap: 6px;
}
.finished {
  display: flex; align-items: center; gap: 10px;
  height: 36px; padding: 0 6px 0 12px; font-size: 12.5px; font-weight: 550; color: var(--kgdiff-text);
  animation: rise var(--kgdiff-base) var(--kgdiff-ease);
}
.finished .icon { color: var(--kgdiff-accent-text); }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }

/* Tooltip */
.tooltip {
  position: absolute; left: 0; top: 0; z-index: 4; width: max-content; max-width: 300px; padding: 10px 12px; pointer-events: none;
  border-radius: 10px; opacity: 0; transition: opacity var(--kgdiff-fast) var(--kgdiff-ease);
}
.tooltip[data-open="true"] { opacity: 1; }
.tooltip .t-label { font-size: 13px; font-weight: 600; color: var(--kgdiff-text); overflow-wrap: anywhere; }
.tooltip .t-old { font-size: 12px; color: var(--kgdiff-text-muted); text-decoration: line-through; overflow-wrap: anywhere; }
.tooltip .t-id { margin-top: 2px; font: 11px/1.4 var(--kgdiff-font-mono); color: var(--kgdiff-text-muted); overflow-wrap: anywhere; }
.tooltip .t-status { margin-top: 8px; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 550; color: var(--fam-text); }
.tooltip .t-status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fam-base); flex: none; }
.tooltip .t-sum { margin-top: 4px; font-size: 12px; color: var(--kgdiff-text-secondary); overflow-wrap: anywhere; }
.tooltip .t-hint { margin-top: 6px; font-size: 11px; color: var(--kgdiff-text-muted); }

/* States (loading / identical / error / empty) */
.state {
  position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; padding: 24px;
  pointer-events: none;
}
.state > * { pointer-events: auto; }
.state.blocking { background: var(--kgdiff-background); }
.state-card { width: min(380px, 100%); padding: 24px; text-align: left; }
.state-card .state-icon {
  width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center;
  color: var(--kgdiff-accent-text); background: var(--kgdiff-accent-soft); margin-bottom: 16px;
}
.state-card .state-icon .icon { width: 20px; height: 20px; }
.state-card.error .state-icon { color: var(--kgdiff-removed-text); background: var(--kgdiff-removed-soft); }
.state-card.ok .state-icon { color: var(--kgdiff-added-text); background: var(--kgdiff-added-soft); }
.state-card h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.state-card p { margin: 6px 0 0; color: var(--kgdiff-text-secondary); font-size: 13px; }
.state-card details { margin-top: 16px; font-size: 12px; color: var(--kgdiff-text-secondary); }
.state-card summary { cursor: pointer; font-weight: 550; color: var(--kgdiff-text-secondary); border-radius: 4px; width: max-content; }
.state-card pre {
  margin: 8px 0 0; max-height: 200px; padding: 10px 12px; border-radius: 8px; background: var(--kgdiff-input);
  font: 11.5px/1.5 var(--kgdiff-font-mono); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--kgdiff-text-secondary);
  box-shadow: inset 0 0 0 1px var(--kgdiff-border);
}
.steps { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 10px; }
.steps li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--kgdiff-text-muted); transition: color var(--kgdiff-base) var(--kgdiff-ease); }
.steps li[data-state="active"] { color: var(--kgdiff-text); font-weight: 550; }
.steps li[data-state="done"] { color: var(--kgdiff-text-secondary); }
.steps .mark { width: 18px; height: 18px; flex: none; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: inset 0 0 0 1.5px var(--kgdiff-border-strong); }
.steps li[data-state="done"] .mark { background: var(--kgdiff-accent-soft); box-shadow: none; color: var(--kgdiff-accent-text); }
.steps li[data-state="done"] .mark .icon { width: 12px; height: 12px; }
.steps li[data-state="active"] .mark { box-shadow: inset 0 0 0 1.5px var(--kgdiff-accent-soft); border-top: 1.5px solid var(--kgdiff-accent); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.skeleton-grid {
  position: absolute; inset: 0;
  background-image: radial-gradient(var(--kgdiff-skeleton-hi) 1.2px, transparent 1.4px); background-size: 24px 24px;
  mask-image: radial-gradient(ellipse at center, #000 20%, transparent 75%);
  animation: breathe 2.4s ease-in-out infinite;
}
@keyframes breathe { 50% { opacity: 0.45; } }

/* ── Sidebar ─────────────────────────────────────────────────────────────── */
.sidebar {
  /* The canvas keeps at least 320 px next to it. */
  --sb-w: min(var(--sidebar-w, 360px), max(280px, 100cqw - 320px));
  position: relative; z-index: 2; flex: none; width: var(--sb-w); display: flex; overflow: hidden;
  background: var(--kgdiff-panel); border-left: 1px solid var(--kgdiff-border);
  transition: width var(--kgdiff-base) var(--kgdiff-ease), border-color var(--kgdiff-base) var(--kgdiff-ease);
}
.sidebar.dragging { transition: none; }
.sidebar[data-open="false"] { width: 0; border-left-color: transparent; }
.sidebar-inner { width: var(--sb-w); flex: none; display: flex; flex-direction: column; min-height: 0; }
.sheet-handle { display: none; }
/* Separators: the sidebar's width (its left edge) and the list / detail split. */
.sb-resize { position: absolute; z-index: 3; top: 0; bottom: 0; left: 0; width: 6px; cursor: ew-resize; touch-action: none; }
.sb-split { position: relative; z-index: 1; flex: none; height: 0; cursor: ns-resize; touch-action: none; }
.sb-split::before { content: ""; position: absolute; left: 0; right: 0; top: -4px; height: 8px; }
.sb-resize:hover, .sb-resize:focus-visible, .sidebar.dragging .sb-resize { box-shadow: inset 2px 0 0 var(--kgdiff-accent); }
.sb-split:hover::after, .sb-split:focus-visible::after {
  content: ""; position: absolute; left: 0; right: 0; top: -1px; height: 2px; background: var(--kgdiff-accent);
}
.sb-resize:focus-visible, .sb-split:focus-visible { outline: none; }
.sb-head { flex: none; padding: 12px 12px 8px; display: grid; gap: 10px; border-bottom: 1px solid var(--kgdiff-border); }
.sb-row { display: flex; align-items: center; gap: 2px; min-width: 0; }
.sb-row > .sb-title { flex: 1; min-width: 0; }
.sb-row > .icon-btn { width: 24px; height: 24px; border-radius: 6px; }
.list-toggle .icon { transition: transform var(--kgdiff-base) var(--kgdiff-ease); }
.list-toggle[aria-expanded="false"] .icon { transform: rotate(180deg); }
.filters-btn[data-active="true"] { color: var(--kgdiff-accent-text); }
.filters-wrap:has(> .filters[hidden]) { display: none; }
.sb-title { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 2px; }
.sb-title h2 { margin: 0; font-size: 13px; font-weight: 650; }
.count-badge {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 9px; font-size: 11px; font-weight: 600;
  color: var(--kgdiff-text-secondary); background: var(--kgdiff-hover); box-shadow: inset 0 0 0 1px var(--kgdiff-border); font-variant-numeric: tabular-nums;
}
.progress { margin-left: auto; display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--kgdiff-text-muted); font-variant-numeric: tabular-nums; }
.progress .bar { width: 64px; height: 4px; border-radius: 2px; background: var(--kgdiff-track); overflow: hidden; }
.progress .bar > div { height: 100%; width: 100%; transform-origin: left; background: var(--kgdiff-accent); border-radius: 2px; transition: transform var(--kgdiff-base) var(--kgdiff-ease); }
.progress[data-complete="true"] { color: var(--kgdiff-accent-text); }

.search { position: relative; display: flex; align-items: center; height: 32px; border-radius: 8px; background: var(--kgdiff-input);
  box-shadow: inset 0 0 0 1px var(--kgdiff-border); transition: box-shadow var(--kgdiff-fast) var(--kgdiff-ease); }
.search:focus-within { box-shadow: inset 0 0 0 1px var(--kgdiff-accent), 0 0 0 3px var(--kgdiff-accent-soft); }
.search > .icon { position: absolute; left: 10px; color: var(--kgdiff-text-muted); pointer-events: none; }
.search input {
  flex: 1; min-width: 0; height: 100%; padding: 0 64px 0 32px; border: 0; background: transparent; font-size: 13px; color: var(--kgdiff-text);
}
.search input::placeholder { color: var(--kgdiff-text-muted); }
.search input::-webkit-search-cancel-button { display: none; }
.search kbd { position: absolute; right: 8px; }
.search .clear { position: absolute; right: 2px; width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--kgdiff-text-muted); }
.search .clear:hover { color: var(--kgdiff-text); background: var(--kgdiff-hover); }

.filters { display: flex; flex-wrap: wrap; gap: 4px; }
.fchip {
  display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 8px 0 7px; border-radius: 14px;
  font-size: 11.5px; font-weight: 550; color: var(--kgdiff-text-secondary); box-shadow: inset 0 0 0 1px var(--kgdiff-border);
  transition: background var(--kgdiff-fast) var(--kgdiff-ease), box-shadow var(--kgdiff-fast) var(--kgdiff-ease), color var(--kgdiff-fast) var(--kgdiff-ease);
}
.fchip:hover { background: var(--kgdiff-hover); color: var(--kgdiff-text); }
.fchip .swatch { width: 16px; height: 16px; margin: 0 -1px; }
.fchip .n { color: var(--kgdiff-text-muted); font-variant-numeric: tabular-nums; font-weight: 500; }
.fchip[aria-pressed="true"] { background: var(--fam-soft); color: var(--fam-text); box-shadow: inset 0 0 0 1px var(--fam-base); }
.fchip[aria-pressed="true"] .n { color: var(--fam-text); opacity: 0.8; }
.fchip:disabled { opacity: 0.35; }

.list-wrap { position: relative; flex: 1 1 50%; min-height: 96px; display: flex; flex-direction: column; }
.list { position: relative; flex: 1; min-height: 0; outline: none; }
.list:focus-visible { outline: none; }
.list:focus-visible:not(:has(.row[aria-selected="true"])) { box-shadow: inset 0 0 0 2px var(--kgdiff-accent); }
.list:focus-visible .row[aria-selected="true"] { box-shadow: inset 0 0 0 2px var(--kgdiff-accent); }
.list-inner { position: relative; width: 100%; }
.row {
  position: absolute; left: 8px; right: 8px; height: 52px; display: flex; align-items: center; gap: 10px; padding: 0 6px 0 14px;
  border-radius: 8px; cursor: pointer; user-select: none; -webkit-user-select: none;
  transition: background var(--kgdiff-fast) var(--kgdiff-ease), box-shadow var(--kgdiff-fast) var(--kgdiff-ease);
}
.row::before { content: ''; position: absolute; left: 4px; top: 10px; bottom: 10px; width: 3px; border-radius: 2px; background: var(--fam-base); }
.row:hover { background: var(--kgdiff-hover); }
.row[aria-selected="true"] { background: var(--kgdiff-selected); box-shadow: inset 0 0 0 1px var(--kgdiff-accent), 0 1px 2px rgba(0,0,0,0.06); }
.row .txt { flex: 1; min-width: 0; display: grid; gap: 1px; }
.row .title { font-size: 13px; font-weight: 500; color: var(--kgdiff-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .sub { font-size: 12px; color: var(--kgdiff-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 17px; }
.row[data-reviewed="true"] .title { color: var(--kgdiff-text-secondary); }
.row[data-reviewed="true"] .glyph-box { opacity: 0.7; }
.rv {
  flex: none; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer;
}
.rv .ring {
  width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  box-shadow: inset 0 0 0 1.5px var(--kgdiff-control-border); color: transparent;
  transition: background var(--kgdiff-fast) var(--kgdiff-ease), box-shadow var(--kgdiff-fast) var(--kgdiff-ease), color var(--kgdiff-fast) var(--kgdiff-ease), transform var(--kgdiff-fast) var(--kgdiff-ease);
}
.rv .ring .icon { width: 12px; height: 12px; }
.rv:hover .ring { box-shadow: inset 0 0 0 1.5px var(--kgdiff-accent); color: var(--kgdiff-text-muted); }
.rv[data-pressed="true"] .ring { background: var(--kgdiff-accent); box-shadow: none; color: var(--kgdiff-background); }
.rv[data-pressed="true"]:active .ring { transform: scale(0.9); }
.group {
  position: absolute; left: 0; right: 0; height: 32px; display: flex; align-items: center; gap: 8px; padding: 10px 16px 0 22px;
  font-size: 11px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--kgdiff-text-muted);
}
.group .n { font-weight: 500; letter-spacing: 0; font-variant-numeric: tabular-nums; }
.sticky {
  position: absolute; top: 0; left: 0; right: 0; z-index: 1; height: 32px; background: var(--kgdiff-panel);
  box-shadow: 0 1px 0 var(--kgdiff-border); pointer-events: none;
}
.sticky .group { position: static; height: 32px; padding-top: 0; }
.sticky[data-shadow="false"] { box-shadow: none; }
.list-empty { padding: 32px 24px; text-align: center; color: var(--kgdiff-text-muted); font-size: 12.5px; display: grid; gap: 10px; justify-items: center; }
.skeleton-row { height: 52px; margin: 0 8px; padding: 0 14px; display: flex; align-items: center; gap: 10px; }
.skeleton-row .b { flex: 1; max-width: 70%; height: 10px; border-radius: 5px; background: var(--kgdiff-skeleton); }
.skeleton-row:nth-child(even) .b { max-width: 52%; }
.skeleton-row .g { width: 20px; height: 20px; border-radius: 6px; background: var(--kgdiff-skeleton); flex: none; }
.shimmer { animation: breathe 1.6s ease-in-out infinite; }

.results { padding: 4px 0 8px; }
.results-head { padding: 8px 16px 6px; font-size: 11px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--kgdiff-text-muted); }
.result {
  display: flex; align-items: center; gap: 10px; width: calc(100% - 16px); margin: 0 8px; height: 44px; padding: 0 10px; border-radius: 8px;
  text-align: left;
}
.result:hover, .result[aria-selected="true"] { background: var(--kgdiff-hover); }
.result[aria-selected="true"] { box-shadow: inset 0 0 0 1px var(--kgdiff-border-strong); }
.result .sdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--fam-base); }
.result[data-family="neutral"] .sdot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--kgdiff-neutral-stroke); }
.result .txt { flex: 1; min-width: 0; display: grid; }
.result .title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.result .sub { font: 11px/1.4 var(--kgdiff-font-mono); color: var(--kgdiff-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.result mark { background: var(--kgdiff-accent-soft); color: inherit; border-radius: 3px; padding: 0 1px; }
.result .status { font-size: 11.5px; color: var(--fam-text); flex: none; }

/* ── Detail panel ────────────────────────────────────────────────────────── */
.detail-wrap { flex: 0 1 auto; max-height: 58%; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--kgdiff-border); background: var(--kgdiff-panel); }
.detail-wrap:has(> .detail[hidden]) { display: none; }
.detail-wrap[data-state="collapsed"] { flex: none; }
.detail-wrap[data-state="collapsed"] > .detail { display: none; }
/* The list is folded: the detail panel takes the room. */
.sidebar[data-list="folded"] .detail-wrap { flex: 1 1 auto; max-height: none; }
/* The user dragged the split. */
.sidebar[data-split] .detail-wrap:not([data-state="collapsed"]) { flex: none; height: calc(var(--detail-share) * 100%); max-height: none; }
.detail-bar {
  flex: none; display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 10px 0 16px;
  font-size: 11px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--kgdiff-text-muted);
}
.detail-bar:hover { color: var(--kgdiff-text-secondary); background: var(--kgdiff-hover); }
.detail-bar .icon { width: 14px; height: 14px; margin-left: auto; transition: transform var(--kgdiff-base) var(--kgdiff-ease); }
.detail-bar[aria-expanded="false"] .icon { transform: rotate(180deg); }
.detail { flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; background: var(--kgdiff-panel); }
.detail-wrap > .detail:not([data-empty="true"]) { flex: 1 1 auto; }
.detail[data-empty="true"] { flex: none; }
.detail-empty { padding: 16px; display: flex; align-items: center; gap: 12px; color: var(--kgdiff-text-muted); font-size: 12.5px; }
.detail-empty .icon { color: var(--kgdiff-text-muted); }
.detail-empty .sub { font-size: 11.5px; margin-top: 2px; }
.detail-scroll { flex: 1; min-height: 0; padding: 14px 16px 20px; }
.d-top { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.fam-pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px 0 6px; border-radius: 6px; font-size: 11.5px; font-weight: 600; color: var(--fam-text); background: var(--fam-soft); }
.fam-pill .g { font-weight: 700; }
.d-nav { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.d-title { margin: 0; font-size: 14.5px; line-height: 1.4; font-weight: 600; letter-spacing: -0.005em; overflow-wrap: anywhere; }
.d-sub { margin-top: 4px; font-size: 12.5px; color: var(--kgdiff-text-secondary); overflow-wrap: anywhere; }
.rv-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 6px; border-radius: 7px; font-size: 12px; font-weight: 550; color: var(--kgdiff-text-secondary); box-shadow: inset 0 0 0 1px var(--kgdiff-border); margin-right: 4px; }
.rv-btn:hover { color: var(--kgdiff-text); background: var(--kgdiff-hover); }
.rv-btn .ring { width: 16px; height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: inset 0 0 0 1.5px var(--kgdiff-control-border); color: transparent; }
.rv-btn .ring .icon { width: 11px; height: 11px; }
.rv-btn[aria-pressed="true"] { color: var(--kgdiff-accent-text); box-shadow: inset 0 0 0 1px var(--kgdiff-accent); background: var(--kgdiff-accent-soft); }
.rv-btn[aria-pressed="true"] .ring { background: var(--kgdiff-accent); box-shadow: none; color: var(--kgdiff-background); }
.section { margin-top: 18px; }
.section > h3 { margin: 0 0 8px; font-size: 11px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--kgdiff-text-muted); display: flex; align-items: center; gap: 6px; }
.section > h3 .n { font-weight: 500; letter-spacing: 0; }
.kv { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 6px 12px; font-size: 12.5px; align-items: baseline; }
.kv dt { color: var(--kgdiff-text-muted); }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.id-text { font: 12px/1.5 var(--kgdiff-font-mono); color: var(--kgdiff-text); overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.vchip { display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 2px 8px; border-radius: 6px; font-size: 12px; background: var(--kgdiff-hover); box-shadow: inset 0 0 0 1px var(--kgdiff-border); overflow-wrap: anywhere; }
.vchip.add { color: var(--kgdiff-added-text); background: var(--kgdiff-added-soft); box-shadow: none; }
.vchip.del { color: var(--kgdiff-removed-text); background: var(--kgdiff-removed-soft); box-shadow: none; text-decoration: line-through; text-decoration-thickness: 1px; }
.vchip .sign { font-weight: 700; text-decoration: none; display: inline-block; }
.pair { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; }
.pair .b, .line.old { color: var(--kgdiff-text-secondary); }
.pair .arr { color: var(--kgdiff-text-muted); }
.line { display: grid; grid-template-columns: 10px minmax(0, 1fr); gap: 6px; align-items: baseline; }
.line .sign { font: 600 12px/1 var(--kgdiff-font-mono); text-align: center; }
.line.old .sign { color: var(--kgdiff-removed-text); }
.line.new .sign { color: var(--kgdiff-added-text); }
del.hl { text-decoration: line-through; text-decoration-color: var(--kgdiff-removed); background: var(--kgdiff-removed-soft); color: var(--kgdiff-removed-text); border-radius: 3px; padding: 0 1px; }
ins.hl { text-decoration: none; background: var(--kgdiff-added-soft); color: var(--kgdiff-added-text); border-radius: 3px; padding: 0 1px; }
.attrs { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; table-layout: fixed; }
.attrs td { vertical-align: baseline; padding: 6px 8px 6px 0; border-top: 1px solid var(--kgdiff-border); overflow-wrap: anywhere; }
.attrs tr:first-child td { border-top: 0; padding-top: 0; }
.attrs td > * + * { margin-top: 4px; }
.attrs td.k { color: var(--kgdiff-text-secondary); }
.attrs col.k { width: 28%; }
.val { white-space: pre-wrap; }
.val.clamped { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.more { margin-top: 2px; }
.disclosure { display: inline-flex; align-items: center; gap: 4px; min-height: 28px; margin-top: 4px; font-size: 12px; color: var(--kgdiff-text-secondary); border-radius: 4px; }
.disclosure:hover { color: var(--kgdiff-text); }
.disclosure .icon { width: 12px; height: 12px; transition: transform var(--kgdiff-base) var(--kgdiff-ease); }
.disclosure[aria-expanded="true"] .icon { transform: rotate(180deg); }
.rels { display: grid; gap: 2px; }
.rel { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 6px 8px; margin: 0 -8px; border-radius: 7px; text-align: left; font-size: 12.5px; line-height: 1.5; width: calc(100% + 16px); }
.rel:hover { background: var(--kgdiff-hover); }
.rel .sign { flex: none; width: 12px; font: 600 12px/1.5 var(--kgdiff-font-mono); color: var(--fam-text); text-align: center; }
.rel .s { min-width: 0; overflow-wrap: anywhere; }
.rel .node { font-weight: 550; }
.rel .pred { color: var(--kgdiff-text-secondary); white-space: nowrap; }
.rel .was { color: var(--kgdiff-text-muted); }
.rel.removed .s { text-decoration: line-through; text-decoration-color: var(--kgdiff-text-muted); color: var(--kgdiff-text-secondary); }
.nodes { display: grid; gap: 2px; }
.node-link { display: flex; align-items: center; gap: 8px; width: calc(100% + 16px); margin: 0 -8px; padding: 5px 8px; border-radius: 7px; text-align: left; font-size: 12.5px; }
.node-link:hover { background: var(--kgdiff-hover); }
.node-link[aria-current="true"] { background: var(--kgdiff-hover); box-shadow: inset 0 0 0 1px var(--kgdiff-border-strong); }
.node-link .sdot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--fam-base); }
.node-link .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.node-link .meta { flex: none; color: var(--kgdiff-text-muted); font-size: 11.5px; }
.comp { display: grid; gap: 6px; }
.comp-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; flex-wrap: wrap; }
.comp-row .arrow { color: var(--kgdiff-text-muted); }
.comp-row .note { color: var(--kgdiff-text-muted); font-size: 11.5px; }
.bars { display: grid; gap: 6px; }
.bar-row { display: grid; grid-template-columns: 84px minmax(0, 1fr) 40px; align-items: center; gap: 10px; font-size: 12px; }
.bar-row .lbl { color: var(--kgdiff-text-secondary); }
.bar-row .track { height: 6px; border-radius: 3px; background: var(--kgdiff-track); overflow: hidden; }
.bar-row .fill { height: 100%; border-radius: 3px; background: var(--kgdiff-identity); }
.bar-row .v { text-align: right; color: var(--kgdiff-text-secondary); font-variant-numeric: tabular-nums; }
.note-line { font-size: 12px; color: var(--kgdiff-text-muted); margin-top: 6px; }

/* ── Popovers ────────────────────────────────────────────────────────────── */
.menu {
  position: absolute; z-index: 10; top: calc(100% + 8px); right: 0; width: 240px; padding: 6px; border-radius: 12px;
  animation: pop var(--kgdiff-fast) var(--kgdiff-ease);
}
@keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
.menu-group + .menu-group { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--kgdiff-border); }
.menu-label { padding: 6px 8px 4px; font-size: 11px; font-weight: 650; letter-spacing: 0.06em; text-transform: uppercase; color: var(--kgdiff-text-muted); }
.menu-item { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border-radius: 7px; font-size: 13px; color: var(--kgdiff-text); text-align: left; }
.menu-item:hover, .menu-item:focus-visible { background: var(--kgdiff-hover); outline: none; }
.menu-item .icon { color: var(--kgdiff-text-secondary); }
.menu-item .check { margin-left: auto; color: var(--kgdiff-accent-text); opacity: 0; }
.menu-item[aria-checked="true"] .check { opacity: 1; }
.menu-item .sw { display: inline-flex; gap: 2px; }
.menu-item .sw i { width: 6px; height: 6px; border-radius: 50%; display: block; }

.overlay-scrim {
  position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: var(--kgdiff-scrim); animation: fade var(--kgdiff-fast) var(--kgdiff-ease);
}
@keyframes fade { from { opacity: 0; } }
.dialog { width: min(640px, 100%); max-height: 100%; display: flex; flex-direction: column; border-radius: 14px; animation: pop var(--kgdiff-base) var(--kgdiff-ease); }
.dialog-head { display: flex; align-items: center; gap: 10px; padding: 14px 12px 10px 20px; }
.dialog-head h2 { margin: 0; font-size: 15px; font-weight: 650; }
.dialog-head .icon-btn { margin-left: auto; }
.dialog-body { padding: 0 20px 18px; }
.keys { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 24px; }
.key-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; border-bottom: 1px solid var(--kgdiff-border); font-size: 12.5px; color: var(--kgdiff-text-secondary); }
.key-row .ks { display: inline-flex; align-items: center; gap: 3px; flex: none; color: var(--kgdiff-text-muted); font-size: 11px; }

/* ── Panel states: a region not open is not shown (the legend folds to its head) ── */
[data-panel="hidden"], [data-panel="collapsed"]:not(.legend, .mini-legend) { display: none !important; }

/* ── chrome="none": the graph, its hover tooltip and the legend line only ──── */
/* The regions are hidden by the preset's panel states; the step caption and the swipe chips
   belong to the canvas. */
.root[data-chrome="none"] .caption, .root[data-chrome="none"] .side-chip { display: none !important; }
.stage-wrap[data-selectable="false"] .tooltip .t-hint { display: none; }

/* ── Compact (< 760 px): bottom sheet ────────────────────────────────────── */
.root[data-compact="true"] .body { flex-direction: column; }
.root[data-compact="true"] .sidebar {
  width: auto; height: var(--sheet-h, 40%); min-height: 0; border-left: 0; border-top: 1px solid var(--kgdiff-border);
  border-radius: 14px 14px 0 0; margin-top: -14px; box-shadow: 0 -8px 24px rgba(0,0,0,0.18);
  transition: height var(--kgdiff-base) var(--kgdiff-ease);
}
.root[data-compact="true"] .sidebar.dragging { transition: none; }
.root[data-compact="true"] .sidebar[data-open="false"] { height: 0; border-top-color: transparent; box-shadow: none; }
.root[data-compact="true"] .sidebar-inner { width: 100%; }
.root[data-compact="true"] .sb-resize { display: none; }
.root[data-compact="true"] .sheet-handle {
  display: flex; flex: none; justify-content: center; align-items: center; height: 28px; cursor: ns-resize; touch-action: none; border-radius: 14px 14px 0 0;
}
.root[data-compact="true"] .sheet-handle::before { content: ""; width: 36px; height: 4px; border-radius: 2px; background: var(--kgdiff-control-border); }
.root[data-compact="true"] .sb-head { padding-top: 4px; }
.root[data-compact="true"] .versions, .root[data-compact="true"] .header-sep,
.root[data-compact="true"] .brand-name { display: none; }
.root[data-compact="true"] .hud-title { padding: 0 10px; }
.root[data-compact="true"] .minimap-host, .root[data-compact="true"] .legend { display: none; }
/* Zoom controls move under the actions, clear of the full-width replay transport (fixed: the
   stage, a size container, contains them), and the page's top-end content under them. The page's
   bottom content rises over the full-width dock, and the transport above it in replay. */
.root[data-compact="true"] .map-cluster { position: fixed; top: 64px; bottom: auto; right: 12px; }
.root[data-compact="true"] .corner.top-end { top: 174px; }
.root[data-compact="true"] .corner.bottom-start, .root[data-compact="true"] .corner.bottom-end { bottom: 82px; }
.root[data-compact="true"][data-mode="replay"] .corner.bottom-start,
.root[data-compact="true"][data-mode="replay"] .corner.bottom-end { bottom: 134px; }
/* The bottom sheet's rounded top overlaps the canvas. */
.root[data-compact="true"] .chrome > .dock { left: 12px; right: 12px; bottom: 26px; }
.root[data-compact="true"] .transport { width: 100%; min-width: 0; }
.root[data-compact="true"] .transport .pos { min-width: 48px; }
.root[data-compact="true"] .detail-wrap { max-height: 50%; }
.root[data-narrow="true"] .versions .tag, .root[data-narrow="true"] .versions .arrow { display: none; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; animation-iteration-count: 1 !important; transition-duration: 1ms !important; }
  .skeleton-grid, .shimmer { animation: none; }
}
`;

/** What every element's host starts from (`all: initial` also resets the shared `:host` rule). */
const HOST =
  'all: initial; font-family: var(--kgdiff-font); font-size: 13px; line-height: 1.45; color: var(--kgdiff-text); -webkit-font-smoothing: antialiased;';

/** The elements of RFC 0001 §3, by the name after `kgdiff-`. */
export type ElementName =
  | 'root'
  | 'stage'
  | 'change-list'
  | 'change-detail'
  | 'search'
  | 'filters'
  | 'view-dock'
  | 'transport'
  | 'legend'
  | 'zoom'
  | 'minimap'
  | 'title'
  | 'actions';

/** Each element's host rules, adopted after the shared sheet (`<kgdiff-root>`: instead of it). */
const ELEMENT_STYLES: Readonly<Record<ElementName, string>> = {
  root: /* css */ `
:host { display: contents; }
[hidden] { display: none !important; }
.sr-only {
  position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}`,
  stage: /* css */ `
:host { ${HOST} display: block; position: relative; height: 100%; min-height: 240px; contain: content; background: var(--kgdiff-background); }
:host([hidden]) { display: none; }
.stage-wrap { position: absolute; inset: 0; }`,
  'change-list': /* css */ `
:host { ${HOST} display: flex; flex-direction: column; min-height: 0; background: var(--kgdiff-panel); }
:host([hidden]) { display: none; }
.change-list { flex: 1; min-height: 0; display: flex; flex-direction: column; }`,
  'change-detail': /* css */ `
:host { ${HOST} display: flex; flex-direction: column; min-height: 0; background: var(--kgdiff-panel); }
:host([hidden]) { display: none; }
.detail { flex: 1 1 auto; }`,
  search: /* css */ `
:host { ${HOST} display: block; position: relative; }
:host([hidden]) { display: none; }
/* Standalone, the results open below the box. */
.results {
  position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 10; max-height: min(60vh, 420px);
  border-radius: 12px; background: var(--kgdiff-raised); box-shadow: var(--kgdiff-shadow), 0 0 0 1px var(--kgdiff-border);
}`,
  filters: /* css */ `
:host { ${HOST} display: block; }
:host([hidden]) { display: none; }`,
  'view-dock': /* css */ `
:host { ${HOST} display: inline-block; max-width: 100%; container-type: inline-size; }
:host([hidden]) { display: none; }`,
  transport: /* css */ `
:host { ${HOST} display: block; width: min(600px, 100%); }
:host([hidden]) { display: none; }
.stack { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.transport { width: 100%; min-width: 0; }`,
  legend: /* css */ `
:host { ${HOST} display: inline-block; }
:host([hidden]) { display: none; }
.legend.float, .mini-legend.float { position: static; }
.mini-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 12px; font-size: 11px; line-height: 16px; color: var(--kgdiff-text-secondary); }`,
  zoom: /* css */ `
:host { ${HOST} display: inline-block; }
:host([hidden]) { display: none; }`,
  minimap: /* css */ `
:host { ${HOST} display: block; position: relative; width: 184px; height: 128px; }
:host([hidden]) { display: none; }
.minimap-host { width: 100%; height: 100%; }`,
  title: /* css */ `
:host { ${HOST} display: inline-block; max-width: 100%; }
:host([hidden]) { display: none; }
.hud-title { position: static; max-width: none; }`,
  actions: /* css */ `
:host { ${HOST} display: inline-block; position: relative; }
:host([hidden]) { display: none; }
.hud-end { position: relative; top: auto; right: auto; }
/* The dialog covers the page, not the element. */
.overlay-scrim { position: fixed; z-index: 1000; }`,
};

const elementSheets = new WeakMap<Document, Map<ElementName, CSSStyleSheet>>();

/** The host rules of the element `name` as a stylesheet of `doc`, parsed once per document. */
export function elementSheet(doc: Document, name: ElementName): CSSStyleSheet {
  let byName = elementSheets.get(doc);
  if (!byName) {
    byName = new Map();
    elementSheets.set(doc, byName);
  }
  let sheet = byName.get(name);
  if (!sheet) {
    sheet = sheetFor(doc, ELEMENT_STYLES[name]);
    byName.set(name, sheet);
  }
  return sheet;
}

/**
 * A stylesheet of `doc` holding `css`. A constructed sheet can only be adopted in the document
 * it was made for, so it is made with that document's own `CSSStyleSheet` (a viewer moved into
 * an iframe or a popup gets sheets of its new document).
 */
export function sheetFor(doc: Document, css: string): CSSStyleSheet {
  const Sheet = (doc.defaultView as (Window & typeof globalThis) | null)?.CSSStyleSheet;
  const sheet = new (Sheet ?? CSSStyleSheet)();
  sheet.replaceSync(css);
  return sheet;
}

const shared = new WeakMap<Document, CSSStyleSheet>();

/** `STYLES` as a stylesheet of `doc`, parsed once per document. */
export function stylesheet(doc: Document): CSSStyleSheet {
  let sheet = shared.get(doc);
  if (!sheet) {
    sheet = sheetFor(doc, STYLES);
    shared.set(doc, sheet);
  }
  return sheet;
}

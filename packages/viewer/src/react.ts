/**
 * React 19's JSX types for the viewer's elements (RFC 0001 §8). Generated from
 * custom-elements.json by scripts/manifest.ts: do not edit; run
 * `pnpm --filter @kgdiff/viewer manifest` after changing the sources.
 *
 * A TypeScript project with React 19 enables them once, anywhere:
 *
 *   import type {} from '@kgdiff/viewer/react';
 *
 * Props are the elements' properties (React 19 sets a prop as the property the element has,
 * and as an attribute otherwise), their attributes without a property, and the roots' events
 * as React 19 listens to them: `onkgdiff-select`. Methods go through a `ref`.
 *
 * @experimental In 0.6; stable from 0.7 (RFC 0001, decision 7), as the elements it describes.
 */
import type { HTMLAttributes, Ref } from 'react';
import type { KgdiffEventMap } from './index.js';

/** The element of a tag: a prop's type is its property's. */
type Tag<T extends keyof HTMLElementTagNameMap> = HTMLElementTagNameMap[T];

/** What every element takes: React's HTML attributes and a ref to the element. */
type Props<T extends keyof HTMLElementTagNameMap> = HTMLAttributes<Tag<T>> & { ref?: Ref<Tag<T>> };

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      /**
       * `<kgdiff-viewer>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-viewer
       */
      'kgdiff-viewer': Props<'kgdiff-viewer'> & {
        /**
         * Reflected to the `chrome` attribute. `none` shows the graph alone: no title, actions,
         * view dock (with the step caption and playback bar), change list, zoom buttons, minimap or
         * legend card; the hover tooltip and a one-line legend stay. Clicks and keyboard shortcuts
         * do nothing, the minimum height drops from 420px to 120px, and the view stays fitted: when
         * the canvas is resized (unless the user panned or zoomed since) and at the start of every
         * loop. Labels are never cut at the edge: one pushed from its spot by a neighbour moves
         * inside or is left out. Default `full`.
         */
        chrome?: Tag<'kgdiff-viewer'>['chrome'];
        /**
         * Reflected to the `legend` attribute: `full` (the card), `mini` (one line: the families
         * this diff has, then unchanged), `none`. Default `auto`: `full`, or `mini` with
         * `chrome="none"`.
         */
        legend?: Tag<'kgdiff-viewer'>['legend'];
        /**
         * The page's declaration of panel states, reflected to the `panels` attribute: a string
         * (`"detail:collapsed minimap:hidden"`) or an object (`{ detail: 'collapsed' }`); reading
         * it gives the object. Regions not named keep their state; entries that name no region or
         * state are ignored with a warning. It wins over what the user chose before (remembered)
         * and a report's `view.panels`; the user can still open and close collapsed regions, and
         * declaring the same again keeps what they did. The presets `sidebar="closed"` (list,
         * detail, search and filters collapsed), `header="compact"` (title hidden) and
         * `chrome="none"` (everything but the canvas and the legend hidden) are panel states too;
         * `panels` wins over them for the regions it names. The states every region has now are in
         * `layout`.
         */
        panels?: Tag<'kgdiff-viewer'>['panels'] | string;
        /**
         * Reflected to the `persist` attribute. `local` (the default): the layout remembers the
         * user's panel states, sizes, theme, palette and language in `localStorage` (under
         * `persistKey`, shared by the viewers of the origin with the same key). `none`: it
         * remembers nothing.
         */
        persist?: Tag<'kgdiff-viewer'>['persist'];
        /**
         * Reflected to the `persist-key` attribute: the `localStorage` key the layout remembers
         * under. Viewers with the same key share what they remember; give each app on a shared
         * origin (a GitHub Pages user site, say) a key of its own. Default `kgdiff:viewer`.
         */
        persistKey?: Tag<'kgdiff-viewer'>['persistKey'];
        /**
         * Reflected to the `mode` attribute. Default `overlay`.
         */
        mode?: Tag<'kgdiff-viewer'>['mode'];
        /**
         * Reflected to the `scope` attribute. Default `all` (`changes` for large graphs). Fixed to
         * `changes` when the layout covers only the changes.
         */
        scope?: Tag<'kgdiff-viewer'>['scope'];
        /**
         * Reflected to the `theme` attribute. Default `auto`.
         */
        theme?: Tag<'kgdiff-viewer'>['theme'];
        /**
         * Reflected to the `palette` attribute. Default `default`.
         */
        palette?: Tag<'kgdiff-viewer'>['palette'];
        /**
         * Reflected to the `locale` attribute. Default from `navigator.language`.
         */
        locale?: Tag<'kgdiff-viewer'>['locale'];
        /**
         * Reflected to the boolean `loop` attribute. In `replay` mode the replay plays by itself
         * and starts again `loopDelay` ms after it ends. `pause()` stops it until `play()`. Default
         * false.
         */
        loop?: Tag<'kgdiff-viewer'>['loop'];
        /**
         * Reflected to `loop-delay`: ms between the end of a looping replay and its restart.
         * Default 1200.
         */
        loopDelay?: Tag<'kgdiff-viewer'>['loopDelay'];
        /**
         * With `loop`, the replay pauses while the pointer is over the graph and continues when it
         * leaves (a mouse or pen; not touch). Reflected as `pause-on-hover="false"` when off.
         * Default true.
         */
        pauseOnHover?: Tag<'kgdiff-viewer'>['pauseOnHover'];
        /**
         * Reflected to the `shortcuts` attribute: where the keyboard shortcuts apply. `scoped` (the
         * default): while focus is inside the root, or in an element bound to it with `for` (those
         * forward their keys). `global`: also when nothing on the page has focus (for full-page
         * viewers such as HTML reports), for the first such root, except the keys pages scroll with
         * (arrows, Home / End, Page Up / Down, Space); the boolean `global-shortcuts` attribute is
         * an alias. `none`: no shortcuts (a focused change list keeps its arrow keys, Home / End
         * and Enter).
         */
        shortcuts?: Tag<'kgdiff-viewer'>['shortcuts'];
        /**
         * **Experimental:** The shortcut names (`ShortcutName`) are new in 0.6. Single keys of the
         * keyboard map bound to another shortcut, or unbound with `null`: `{ x: null, r: 'review'
         * }`. The `keymap` attribute takes the same as text, `"x:none r:review"` (`Space` names the
         * space bar). Keys are `KeyboardEvent.key` values; a letter stands for both its cases
         * unless the other case is named too; keys not named keep the default map; entries naming
         * no shortcut are ignored with a warning.
         */
        keymap?: Tag<'kgdiff-viewer'>['keymap'] | string;
        /**
         * Set a precomputed report (no diff / layout work in the browser).
         */
        payload?: Tag<'kgdiff-viewer'>['payload'];
        /**
         * Keep the selection, mode and scope in the page's URL hash
         * (`#kgdiff=hunk:<id>;mode:<mode>;scope:<scope>`) and follow it: deep links.
         */
        'sync-hash'?: boolean;
        /**
         * A preset: `closed` starts with the sidebar folded (`\` and the sidebar button open it),
         * `open` with its four regions open. Reflects the sidebar's state once the user toggles it.
         */
        sidebar?: 'open' | 'closed';
        /**
         * A preset: `compact` leaves the brand and the compared names out of the canvas, for hosts
         * that show their own (`panels="title:hidden"`).
         */
        header?: 'compact';
        /**
         * The same as `shortcuts="global"`.
         */
        'global-shortcuts'?: boolean;
        /**
         * A diff is shown, from `load()` or a `payload`; `stats` counts its nodes, edges and
         * changes.
         */
        'onkgdiff-ready'?: (event: KgdiffEventMap['kgdiff-ready']) => void;
        /**
         * The selection changed: a change (`hunk`, its id, with the node chosen in it if any), a
         * node alone (`hunk` null), or nothing (both null).
         */
        'onkgdiff-select'?: (event: KgdiffEventMap['kgdiff-select']) => void;
        /**
         * The mode or the scope changed, by the user, a key or the host.
         */
        'onkgdiff-mode'?: (event: KgdiffEventMap['kgdiff-mode']) => void;
        /**
         * A change was marked reviewed, or not; `progress` is the review state after it.
         */
        'onkgdiff-review'?: (event: KgdiffEventMap['kgdiff-review']) => void;
        /**
         * Loading or showing a diff failed; `error` is a `KgdiffError` for bad input.
         */
        'onkgdiff-error'?: (event: KgdiffEventMap['kgdiff-error']) => void;
        /**
         * Playback reached the end of the replay (not fired for seeking or stepping there). `loop`:
         * it starts again after `loopDelay` ms; set `loop = false` or call `pause()` to stop it.
         */
        'onkgdiff-replay-end'?: (event: KgdiffEventMap['kgdiff-replay-end']) => void;
        /**
         * The default layout changed: a panel opened, collapsed or was hidden, or a size changed
         * (once a drag ends). `source`: the user did it in the viewer, or the host (attributes,
         * properties, a report's `view.panels`).
         */
        'onkgdiff-layout'?: (event: KgdiffEventMap['kgdiff-layout']) => void;
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-root>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-root
       */
      'kgdiff-root': Props<'kgdiff-root'> & {
        /**
         * Reflected to the `mode` attribute. Default `overlay`.
         */
        mode?: Tag<'kgdiff-root'>['mode'];
        /**
         * Reflected to the `scope` attribute. Default `all` (`changes` for large graphs). Fixed to
         * `changes` when the layout covers only the changes.
         */
        scope?: Tag<'kgdiff-root'>['scope'];
        /**
         * Reflected to the `theme` attribute. Default `auto`.
         */
        theme?: Tag<'kgdiff-root'>['theme'];
        /**
         * Reflected to the `palette` attribute. Default `default`.
         */
        palette?: Tag<'kgdiff-root'>['palette'];
        /**
         * Reflected to the `locale` attribute. Default from `navigator.language`.
         */
        locale?: Tag<'kgdiff-root'>['locale'];
        /**
         * Reflected to the boolean `loop` attribute. In `replay` mode the replay plays by itself
         * and starts again `loopDelay` ms after it ends. `pause()` stops it until `play()`. Default
         * false.
         */
        loop?: Tag<'kgdiff-root'>['loop'];
        /**
         * Reflected to `loop-delay`: ms between the end of a looping replay and its restart.
         * Default 1200.
         */
        loopDelay?: Tag<'kgdiff-root'>['loopDelay'];
        /**
         * With `loop`, the replay pauses while the pointer is over the graph and continues when it
         * leaves (a mouse or pen; not touch). Reflected as `pause-on-hover="false"` when off.
         * Default true.
         */
        pauseOnHover?: Tag<'kgdiff-root'>['pauseOnHover'];
        /**
         * Reflected to the `shortcuts` attribute: where the keyboard shortcuts apply. `scoped` (the
         * default): while focus is inside the root, or in an element bound to it with `for` (those
         * forward their keys). `global`: also when nothing on the page has focus (for full-page
         * viewers such as HTML reports), for the first such root, except the keys pages scroll with
         * (arrows, Home / End, Page Up / Down, Space); the boolean `global-shortcuts` attribute is
         * an alias. `none`: no shortcuts (a focused change list keeps its arrow keys, Home / End
         * and Enter).
         */
        shortcuts?: Tag<'kgdiff-root'>['shortcuts'];
        /**
         * **Experimental:** The shortcut names (`ShortcutName`) are new in 0.6. Single keys of the
         * keyboard map bound to another shortcut, or unbound with `null`: `{ x: null, r: 'review'
         * }`. The `keymap` attribute takes the same as text, `"x:none r:review"` (`Space` names the
         * space bar). Keys are `KeyboardEvent.key` values; a letter stands for both its cases
         * unless the other case is named too; keys not named keep the default map; entries naming
         * no shortcut are ignored with a warning.
         */
        keymap?: Tag<'kgdiff-root'>['keymap'] | string;
        /**
         * Set a precomputed report (no diff / layout work in the browser).
         */
        payload?: Tag<'kgdiff-root'>['payload'];
        /**
         * Keep the selection, mode and scope in the page's URL hash
         * (`#kgdiff=hunk:<id>;mode:<mode>;scope:<scope>`) and follow it: deep links.
         */
        'sync-hash'?: boolean;
        /**
         * The same as `shortcuts="global"`.
         */
        'global-shortcuts'?: boolean;
        /**
         * A diff is shown, from `load()` or a `payload`; `stats` counts its nodes, edges and
         * changes.
         */
        'onkgdiff-ready'?: (event: KgdiffEventMap['kgdiff-ready']) => void;
        /**
         * The selection changed: a change (`hunk`, its id, with the node chosen in it if any), a
         * node alone (`hunk` null), or nothing (both null).
         */
        'onkgdiff-select'?: (event: KgdiffEventMap['kgdiff-select']) => void;
        /**
         * The mode or the scope changed, by the user, a key or the host.
         */
        'onkgdiff-mode'?: (event: KgdiffEventMap['kgdiff-mode']) => void;
        /**
         * A change was marked reviewed, or not; `progress` is the review state after it.
         */
        'onkgdiff-review'?: (event: KgdiffEventMap['kgdiff-review']) => void;
        /**
         * Loading or showing a diff failed; `error` is a `KgdiffError` for bad input.
         */
        'onkgdiff-error'?: (event: KgdiffEventMap['kgdiff-error']) => void;
        /**
         * Playback reached the end of the replay (not fired for seeking or stepping there). `loop`:
         * it starts again after `loopDelay` ms; set `loop = false` or call `pause()` to stop it.
         */
        'onkgdiff-replay-end'?: (event: KgdiffEventMap['kgdiff-replay-end']) => void;
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-stage>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-stage
       */
      'kgdiff-stage': Props<'kgdiff-stage'> & {
        /**
         * The states of the built-in chrome (`dock`, `transport`, `legend`, `zoom`, `minimap`),
         * reflected to the `panels` attribute, in the syntax of `<kgdiff-viewer>`'s `panels`:
         * `"minimap:hidden zoom:hidden"` or `{ minimap: 'hidden' }`; reading it gives the object.
         * Other regions are ignored with a warning. Default: all open, the legend collapsed.
         */
        panels?: Tag<'kgdiff-stage'>['panels'] | string;
        /**
         * Reflected to the `version` attribute: the version this stage draws whatever the root's
         * mode, `before` or `after` (two stages of one root side by side), or null to follow the
         * mode. Another value is ignored with a warning. Each stage has its own camera; the
         * selection, hover, filters and search are the root's, so both bring the same change into
         * view.
         */
        version?: Tag<'kgdiff-stage'>['version'];
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-stage'>['htmlFor'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-change-list>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-change-list
       */
      'kgdiff-change-list': Props<'kgdiff-change-list'> & {
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-change-list'>['htmlFor'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-change-detail>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-change-detail
       */
      'kgdiff-change-detail': Props<'kgdiff-change-detail'> & {
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-change-detail'>['htmlFor'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-search>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-search
       */
      'kgdiff-search': Props<'kgdiff-search'> & {
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-search'>['htmlFor'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-filters>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-filters
       */
      'kgdiff-filters': Props<'kgdiff-filters'> & {
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-filters'>['htmlFor'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-view-dock>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-view-dock
       */
      'kgdiff-view-dock': Props<'kgdiff-view-dock'> & {
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-view-dock'>['htmlFor'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-transport>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-transport
       */
      'kgdiff-transport': Props<'kgdiff-transport'> & {
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-transport'>['htmlFor'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-legend>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-legend
       */
      'kgdiff-legend': Props<'kgdiff-legend'> & {
        /**
         * Reflected to `variant`: `full` (default) or `mini`; another value reads `full`.
         */
        variant?: Tag<'kgdiff-legend'>['variant'];
        /**
         * Reflected to the boolean `open`: whether the card is open (the user's toggle too).
         */
        open?: Tag<'kgdiff-legend'>['open'];
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-legend'>['htmlFor'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-zoom>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-zoom
       */
      'kgdiff-zoom': Props<'kgdiff-zoom'> & {
        /**
         * Reflects the `stage` attribute: the id of the stage to act on, or '' (no attribute;
         * setting '' removes it) for the nearest one around the element. Changing it binds again.
         */
        stage?: Tag<'kgdiff-zoom'>['stage'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-minimap>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-minimap
       */
      'kgdiff-minimap': Props<'kgdiff-minimap'> & {
        /**
         * Reflects the `stage` attribute: the id of the stage to act on, or '' (no attribute;
         * setting '' removes it) for the nearest one around the element. Changing it binds again.
         */
        stage?: Tag<'kgdiff-minimap'>['stage'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-title>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-title
       */
      'kgdiff-title': Props<'kgdiff-title'> & {
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-title'>['htmlFor'];
      };
      /**
       * **Experimental:** In 0.6; stable from 0.7 (RFC 0001, decision 7). `<kgdiff-actions>`:
       * https://github.com/iiwish/kgdiff/blob/main/docs/viewer-elements.md#kgdiff-actions
       */
      'kgdiff-actions': Props<'kgdiff-actions'> & {
        /**
         * Reflects the `for` attribute, as on `<label>` and `<output>`: the id of the root to show,
         * or '' (no attribute; setting '' removes it) for the nearest one around the element.
         * Changing it binds again.
         */
        htmlFor?: Tag<'kgdiff-actions'>['htmlFor'];
      };
    }
  }
}

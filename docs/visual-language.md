# kgdiff visual language

What a graph diff looks like, precisely enough that every renderer draws it the same way.
Implemented once in `@kgdiff/scene` (tokens + `VisualResolver`); renderers only draw primitives.

## Principles

1. **Color is meaning.** Exactly five change families plus neutral. No decorative color.
2. **Quiet context, loud change.** Unchanged elements recede (low contrast, thin, small labels)
   so a 2,000-node graph with 12 changes reads as 12 changes.
3. **Never color alone.** Every family has a shape / stroke / typographic cue too, so the diff
   survives grayscale printing and color-vision deficiencies.
4. **The ghost stays where it was.** Removed things are drawn as hollow dashed ghosts in their
   original place; nothing ever just vanishes in overlay.
5. **Motion explains structure.** Merges move, retargets swing, additions grow from their
   neighbours. Motion is choreographed, never decorative, and fully optional (reduced motion).
6. **Premium, calm, legible.** Dark theme feels like a night sky (soft glows); light theme feels
   like paper (crisp rings). Same grammar, same hierarchy.

## Meaning families

| Family      | Means                                                                               | Node cue (besides color)                                                          | Edge cue                                                                           |
| ----------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `added`     | only in after                                                                       | solid fill + halo (glow / offset ring)                                            | solid, 1.75 px, grows from the existing endpoint in replay                         |
| `removed`   | only in before                                                                      | hollow dashed ghost, label struck through                                         | dashed `4 3`, retracts in replay                                                   |
| `content`   | same thing, new content: rename, attrs, types, aliases, deprecation                 | solid fill + concentric ring; badge `+2 −1 ~1`; old name struck under the new one | solid 1.75 px (label / attrs changed)                                              |
| `structure` | same thing, new place: hierarchy move, retarget, predicate change, relation changes | solid fill + ring                                                                 | new edge solid; old edge as a faint dashed ghost; pivot dot at the shared endpoint |
| `identity`  | which thing changed: merge, split, rekey, suggestion                                | target: ring + halo; sources: hollow dashed ghost; arc arrow source → target      | carried edges tinted; collapsed duplicates dashed                                  |
| `neutral`   | unchanged context                                                                   | small, low-contrast fill, no ring                                                 | hairline 1 px                                                                      |

Node family is chosen from its **primary facet**: added / removed by status; then `mergedInto` /
`mergeTarget` / `splitFrom` / `splitInto` / `rekey` → identity; `move` → structure; anything
else → content. Deprecated nodes are content-colored, desaturated, struck through, with an arc
to their replacement (identity color) when `replacedBy` is known.

## Color tokens

Values are final unless a contrast test fails; tests in `@kgdiff/scene` assert:
`family.*.base` ≥ 3:1 against `canvas.background`, `family.*.text` and `text.primary` /
`text.secondary` ≥ 4.5:1 against `surface.panel` and `canvas.background`, `text.muted` ≥ 3:1.

### Dark ("night") — default

| Token                                    | Value                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| canvas.background                        | `#0B0E14`                                                                       |
| canvas.grid                              | `rgba(148, 163, 184, 0.07)`                                                     |
| surface.panel / raised                   | `#11151D` / `#171C26`                                                           |
| surface.overlay                          | `rgba(17, 21, 29, 0.78)` (with 16 px backdrop blur)                             |
| surface.border / borderStrong            | `rgba(255,255,255,0.07)` / `rgba(255,255,255,0.13)`                             |
| surface.shadow                           | `0 8px 32px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset`             |
| text primary / secondary / muted         | `#E7EBF3` / `#A6AFBF` / `#7A8495`                                               |
| accent base / strong / soft / text       | `#7C9CFF` / `#A3BAFF` / `rgba(124,156,255,0.16)` / `#A9BEFF`                    |
| neutral node / nodeStroke / edge / label | `#4B5568` / `#5E687C` / `#323A4A` / `#7A8495`                                   |
| added                                    | base `#34D399`, strong `#6EE7B7`, soft `rgba(52,211,153,0.16)`, text `#6EE7B7`  |
| removed                                  | base `#F87171`, strong `#FCA5A5`, soft `rgba(248,113,113,0.15)`, text `#FCA5A5` |
| content                                  | base `#FBBF24`, strong `#FCD34D`, soft `rgba(251,191,36,0.15)`, text `#FCD34D`  |
| structure                                | base `#38BDF8`, strong `#7DD3FC`, soft `rgba(56,189,248,0.15)`, text `#7DD3FC`  |
| identity                                 | base `#A78BFA`, strong `#C4B5FD`, soft `rgba(167,139,250,0.17)`, text `#C4B5FD` |

### Light ("paper")

| Token                                    | Value                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| canvas.background                        | `#F7F8FA`                                                                      |
| canvas.grid                              | `rgba(15, 23, 42, 0.07)`                                                       |
| surface.panel / raised                   | `#FFFFFF` / `#FFFFFF`                                                          |
| surface.overlay                          | `rgba(255, 255, 255, 0.82)`                                                    |
| surface.border / borderStrong            | `rgba(15,23,42,0.08)` / `rgba(15,23,42,0.15)`                                  |
| surface.shadow                           | `0 8px 28px rgba(15,23,42,0.10), 0 1px 2px rgba(15,23,42,0.06)`                |
| text primary / secondary / muted         | `#0F172A` / `#475569` / `#687284`                                              |
| accent                                   | base `#3B5BDB`, strong `#2F49B5`, soft `rgba(59,91,219,0.10)`, text `#2F49B5`  |
| neutral node / nodeStroke / edge / label | `#A7B0BF` / `#8C96A8` / `#D3D9E2` / `#687284`                                  |
| added                                    | base `#16A34A`, strong `#15803D`, soft `rgba(22,163,74,0.11)`, text `#147A3A`  |
| removed                                  | base `#DC2626`, strong `#B91C1C`, soft `rgba(220,38,38,0.09)`, text `#B91C1C`  |
| content                                  | base `#D87506`, strong `#B45309`, soft `rgba(217,119,6,0.11)`, text `#92400E`  |
| structure                                | base `#0284C7`, strong `#0369A1`, soft `rgba(2,132,199,0.10)`, text `#075985`  |
| identity                                 | base `#7C3AED`, strong `#6D28D9`, soft `rgba(124,58,237,0.10)`, text `#5B21B6` |

### Color-vision-deficiency palette (`palette: 'colorblind'`)

Okabe–Ito based; same tokens, family colors replaced (dark / light):

| Family    | Dark base / text      | Light base / text     |
| --------- | --------------------- | --------------------- |
| added     | `#56B4E9` / `#8FD0F5` | `#0072B2` / `#005A8C` |
| removed   | `#E69F00` / `#F5C45C` | `#D55E00` / `#A84A00` |
| content   | `#F0E442` / `#F5EC85` | `#9A8700` / `#6E6100` |
| structure | `#009E73` / `#3CC79E` | `#00805C` / `#006248` |
| identity  | `#CC79A7` / `#E0A6C6` | `#A3477F` / `#83335F` |

### CSS tokens

The viewer's colors and fonts are CSS custom properties set on its root (`<kgdiff-viewer>`,
`<kgdiff-root>`): the canvas and the panels both draw with them, so a page that overrides one
(`kgdiff-viewer { --kgdiff-accent: #e8590c }`) restyles both
([Theming](interaction.md#theming)). The tokens below are public API from 0.6; others the
stylesheet uses (motion, hover and press tints) are not.

| CSS token                                                              | Theme token                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `--kgdiff-background`, `--kgdiff-grid`                                 | `canvas.background`, `canvas.grid`                   |
| `--kgdiff-panel`, `--kgdiff-raised`, `--kgdiff-overlay`                | `surface.panel`, `surface.raised`, `surface.overlay` |
| `--kgdiff-border`, `--kgdiff-border-strong`, `--kgdiff-control-border` | `surface.border`, `borderStrong`, `controlBorder`    |
| `--kgdiff-shadow`                                                      | `surface.shadow`                                     |
| `--kgdiff-text`, `--kgdiff-text-secondary`, `--kgdiff-text-muted`      | `text.primary`, `text.secondary`, `text.muted`       |
| `--kgdiff-accent`, `-strong`, `-soft`, `-text`                         | `accent.base`, `strong`, `soft`, `text`              |
| `--kgdiff-neutral`, `-stroke`, `-edge`, `-label`                       | `neutral.node`, `nodeStroke`, `edge`, `label`        |
| `--kgdiff-<family>`, `-strong`, `-soft`, `-text`                       | `family.<family>.base`, `strong`, `soft`, `text`     |
| `--kgdiff-font`, `--kgdiff-font-mono`                                  | `font.family`, `font.mono`                           |

`<family>` is `added`, `removed`, `content`, `structure` or `identity`, so for example
`--kgdiff-removed-soft`. Names are whole words, like the theme's (`--kgdiff-text-muted` for
`text.muted`). Colors may be written in any sRGB syntax the browser knows (names,
`hsl()`, `color-mix()`); the canvas normalizes them, and ignores, with a console warning, a
value it cannot draw (such as `oklch()`). The contrast guarantees above hold for the built-in
values only.

## Geometry

- Node radius (world): `nodeRadius(maxDegree) = clamp(4 + 2.2·√degree, 4, 14)` from `@kgdiff/layout`.
- Stroke widths are **screen px** (constant under zoom): neutral edge 1, changed edge 1.75,
  selected 2.5; node stroke 1.25; ring 1.5 at gap 3.5 px; ghost dash `3 2.5`; edge dash `4 3`.
- Arrowheads: 7 px long, 5 px wide, only on changed / selected edges or when zoom ≥ 1.2.
- Parallel edges between the same pair curve with curvature ±0.18·k (k = 1, 2, …).
- Halo: dark = radial glow radius `2.6·r`, alpha 0.32 (added / identity / selected); light =
  offset ring at `r + 5` px, 2 px, alpha 0.35.

## Typography

- Font stack: `Inter, "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
  "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif`;
  mono: `"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace`.
- Labels are screen-size: 12 px (changed: weight 600 in color `text.primary`; neutral: 400 in
  `neutral.label`), old names 11 px struck in `text.muted`, edge labels 10.5 px.
- Labels sit centered below the node (`offset = r·k + 5 px`); secondary label 14 px lower.
- Text halo: stroke the text first with `canvas.background` at 3 px, alpha 0.9, round joins.

## Level of detail and label placement

| Element             | Visible when                                                    |
| ------------------- | --------------------------------------------------------------- |
| changed node labels | zoom ≥ 0.35 (small scenes: 0.2), or the node's hunk is selected |
| neutral labels      | zoom ≥ 0.5, importance ≥ 0.7: ≥ 0.35 (small scenes: 0.25)       |
| edge labels         | changed edges at zoom ≥ 1.1; hovered / selected edge always     |
| badges              | zoom ≥ 1.2, or hunk selected                                    |
| arrowheads          | changed edges always; neutral at zoom ≥ 1.2                     |

A _small scene_ has ≤ 300 visible nodes (all nodes, or the focus set when focused). Labels of
the selected hunk, the hovered node and the selected node are always shown. Which of the
eligible labels are actually drawn is decided by collision culling, so low thresholds are safe.

Label collision: greedy in screen space per frame, by `priority` desc (selected hunk > hovered >
changed > importance); each label tries below, right, above, left; a label that fits nowhere is
skipped. Use a uniform grid for overlap tests (O(n)).

## Layer encodings

| Element        | `union` (overlay)                                                      | `before`                      | `after`                   |
| -------------- | ---------------------------------------------------------------------- | ----------------------------- | ------------------------- |
| added node     | added, full                                                            | hidden                        | added, full               |
| removed node   | ghost (removed)                                                        | removed, solid (what will go) | hidden                    |
| modified node  | content / structure ring, new label + struck old label                 | family ring, old label        | family ring, new label    |
| merge source   | ghost (identity) + arc → target                                        | identity solid                | hidden                    |
| merge target   | identity ring + halo, badge `⊕ n`                                      | neutral or own facet          | identity ring + halo      |
| retarget edge  | new solid (structure) + old dashed ghost (removed, alpha 0.45) + pivot | old edge only (structure)     | new edge only (structure) |
| carried edge   | after form tinted identity + faint dashed before form                  | before form (identity)        | after form (identity)     |
| collapsed edge | dashed identity, alpha 0.5                                             | identity                      | hidden                    |
| suggestion     | dotted identity line with `?` (if `showSuggestions`)                   | hidden                        | hidden                    |

**Selection spotlight.** With a selected hunk, its elements stay at full strength (and get
halos); its context nodes go to 70%; everything else to 18% (labels hidden). Transitions over
`motion.base`.

**Family filter.** Families not in `view.families` (when non-empty) render as neutral at 40%.

## Replay choreography

A hunk window `[start, end]` is split into: **spotlight** 0–18% (others dim to 30%, hunk pulses
once), **transform** 18–82%, **settle** 82–100% (final style; spotlight releases at the end).
Easing: `cubic-bezier(0.2, 0, 0, 1)` unless noted.

| Hunk             | Transform                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| remove           | edges retract toward the surviving endpoint (`progress 1→0`); node shrinks to 0.6·r and fades; ghost outline lingers to 60% then fades                   |
| add              | edges grow from the existing endpoint (`progress 0→1`), then the node pops (scale 0 → 1.08 → 1, back-out), then its label fades in                       |
| merge            | sources travel on a gentle arc to the target (ease-in-out); their edges follow; on arrival sources fade, the target ring flashes and its badge counts up |
| split            | targets emerge from the source and travel out to their positions; carried edges follow                                                                   |
| modify           | old label slides up 6 px and fades, new label rises in; ring flashes; badge ticks in                                                                     |
| relations / move | the edge end swings along an arc from old to new endpoint (structure color); old ghost fades                                                             |

Elements of hunks not yet played show their **before** state; played hunks show **after**.
`reducedMotion`: no travel or growth — crossfade between before and after styles over the
transform phase; camera cuts instead of flying.

Camera: the viewer flies to `hunk.bounds` at each window start when less than 70% of the bounds
are inside the viewport (van Wijk–Nuij, ρ = √2, duration `clamp(S·620 ms, 350, 1100)`).

## Background, minimap, chrome

- Dot grid: 1.2 px dots every 24 world units, faded out below zoom 0.4 (switch to 96-unit
  spacing) to avoid moiré.
- Minimap: 184 × 128 px floating card (overlay surface, 12 px radius); neutral nodes as 1 px dots
  at 35%, changed nodes as 2 px dots in family color, viewport as a 1.25 px accent rectangle with
  soft fill; click / drag to navigate. Shown only while part of the content is out of view (with
  everything in view it has nothing to add).
- Floating chrome uses `surface.overlay` + blur, 12 px radius, `surface.shadow`, 1 px
  `surface.border`.

## Rendering quality bars

- Crisp at any DPR (canvas sized in device pixels; `pixelRatio ≤ 3`).
- Batch strokes by style (one `stroke()` per style bucket); halos drawn from cached sprites.
- Culling against the viewport with a margin; LOD hides what cannot be read.
- No layout thrash: one `ResizeObserver`; one `requestAnimationFrame` loop that sleeps when idle.
- 60 fps pan/zoom at 5k nodes / 10k edges; inertia on pan; zoom anchored at the cursor; pinch.

## Implementation reference (scene v0.1)

Exact values implemented in `@kgdiff/scene`; when this section and the overview above
disagree, this section wins.

### Derived tokens

- Light `content.base` is `#D87506` (`#D97706` measured 2.998:1 against `#F7F8FA`).
- Color-blind `strong`: dark = the family's `text`; light = midpoint of base and text — added
  `#00669F`, removed `#BF5400`, content `#847400`, structure `#007152`, identity `#933D6F`.
  Color-blind `soft` = base at the default palette's alpha for that family.
- Deprecated nodes: fill `desaturate(content.base, 0.6)`, stroke `desaturate(content.strong, 0.6)`,
  ring = fill, label struck through.

- Contrast rules (tested for all four theme/palette combinations): `text.primary`,
  `text.secondary`, `text.muted` and every `family.*.text` ≥ 4.5:1 against panel, raised and
  canvas, and `family.*.text` ≥ 4.5:1 over its own `soft` tint composited on those surfaces;
  `family.*.base`, `accent.base` and the new `surface.controlBorder` ≥ 3:1. Muted text is
  `#7A8495` (dark) / `#687284` (light); light `added.text` is `#147A3A`.
- `surface.controlBorder` (`#5E687C` dark, `#8690A3` light) outlines interactive controls
  (inputs, review toggles); `border` / `borderStrong` remain decorative hairlines.
- Resolver allocations: with a reused `out`, steady-state frames allocate no objects or arrays;
  replay may cause transient V8 number boxing (≈ 1–10 kB per frame on animated elements only),
  which is tolerated by design.

### Glyphs

Endpoints are node centers; `r1` / `r2` are stop radii. Glyph alpha is absolute; a glyph's label
alpha is relative to the glyph.

| Kind                | Meaning and style                                                                                                         | Stop radius | Shown                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------- |
| `merge-arrow`       | merge source → target; identity base, α 0.9, 1.5 px, curvature 0.25                                                       | r + 4       | union; in replay a trail following the source (α × 0.6) |
| `split-arrow`       | split source → each target; same style                                                                                    | r + 4       | as above                                                |
| `replacement-arrow` | deprecated node → replacement; same style                                                                                 | r + 4       | union and after; grows during replay u ∈ [0.4, 0.9]     |
| `edge-ghost`        | old form of a retargeted (removed color) or carried (identity color) edge; dash `4 3`, 1.75 px, α 0.45, own parallel slot | r           | union; fades during the replay swing                    |
| `pivot`             | structure base, 5 px dot on the kept endpoint's boundary, facing the new end                                              | 0           | union                                                   |
| `suggestion`        | identity base, dotted `1 3`, 1.25 px, α 0.85, curvature 0.12, `?` label (12 px / 600, minZoom 0.35)                       | r + 2       | union when `showSuggestions`                            |

`move-arrow` is reserved and no longer emitted.

### Collapsed groups

`+{n} unchanged` / `+{n} 个未变节点`; groups that contain changed nodes (hunk-scoped focus) read
`+{n} hidden` / `+{n} 个隐藏节点`. Numbers use `Intl.NumberFormat(locale)`.

### Halo

Dark: radial glow, radius `2.6·r` (world), α 0.32. Light: `radius = r`; the renderer draws a
2 px ring 5 px outside `r·k`, α 0.35. Both relative to the node alpha.

### Emphasis levels

| Situation                                 | Hunk        | Context | Others             |
| ----------------------------------------- | ----------- | ------- | ------------------ |
| Selected hunk (scaled by `view.emphasis`) | 100% + halo | 70%     | 18%, labels hidden |
| Replay (window envelope)                  | 100%        | 70%     | 30%                |

Context edges are non-hunk edges whose endpoints are all in the hunk or its context. Selected
hunk edges: 2.5 px, z 3, arrows and labels always visible. Fixed levels: family-filtered 40%,
focus context 55%, edge ghost 45%, collapsed edge 50%. `view.emphasis` ∈ [0, 1] is animated
0 → 1 by the viewer over `motion.base` when the selection changes; `FrameVisuals.spotlight`
equals it.

### Replay sub-timings (`CHOREO`)

`u` is progress within the transform phase (window 18–82%).

- **remove**: edges retract [0, 0.4]; node shrinks to 0.6·r, fill fades to background, becomes a
  dashed ghost, label struck [0.25, 0.55]; the ghost lingers to 60% of the window (u ≈ 0.656)
  then fades out by u = 1.
- **add**: edges to new nodes grow from the existing end [0, 0.45]; node pops [0.35, 0.75]
  (back-out, s = 1.5, peak 1.08); edges between two new nodes [0.6, 0.9]; label fades in
  [0.7, 0.85].
- **merge**: source j of n departs at 0.15·j/(n−1), travels 0.55 on a 0.25 arc (ease-in-out),
  fades within 0.12 after arrival; edges follow; collapsed edges fade with the source; target
  crossfades [0.55, 0.85], ring flash [0.7, 1] (1.5 → 3 → 1.5 px), `⊕` badge counts up per
  arrival; new edges [0.7, 0.95].
- **split**: target j departs at 0.05 + 0.15·j/(n−1), travels 0.55 from the source growing
  0.5·r → r; surviving source crossfades [0.6, 0.9], ring flash [0.7, 1].
- **modify**: style crossfade [0.3, 0.7]; old label rises 6 px and fades [0.1, 0.5], new label
  rises in from 6 px below [0.3, 0.7]; ring flash [0.4, 0.8]; badge from u ≥ 0.6.
- **relations / move**: removed edges retract [0, 0.4]; retargeted edges swing around the pivot
  [0.1, 0.8]; added edges [0.35, 0.85]; relabelled edges switch at the midpoint with a +1 px
  width flash [0.2, 0.7].
- **reduced motion**: crossfade only during the whole transform phase.
- **chapters**: duration `pace · clamp(1.2 + log₂ n, 1.2, 4)`, stagger span `35% · (n−1)/n`,
  160 ms between chapters, one spotlight group per chapter.

/**
 * @kgdiff/scene: diff semantics → visual primitives.
 *
 * The visual language these functions implement is specified in docs/visual-language.md
 * (tokens, encodings, motion); ordering, timeline and focus in docs/algorithms.md §10–11.
 */
export { buildScene } from './build.js';
export { contrastRatio } from './color.js';
export { computeFocus } from './focus.js';
export { frameBounds } from './frame.js';
export { createVisualResolver } from './resolver.js';
export { hunkFamily } from './roles.js';
export {
  evenShapeDash,
  isNodeShape,
  NODE_SHAPES,
  shapeApothem,
  shapeDistance,
  shapeGauge,
  shapeVertexRadius,
  shapeVertices,
} from './shapes.js';
export { getTheme } from './theme.js';
export * from './types.js';
export { createViewState } from './view.js';

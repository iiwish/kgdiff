/**
 * Looking hunks up by what a host knows: the id of a node.
 */
import type { Scene } from './types.js';

/**
 * The hunk (index into `scene.hunks`) that changes the node with this id, or -1 when no hunk
 * does or the scene has no such node.
 *
 * `id` is a union id, or a node id of either version: a node of the later version has its own
 * id as its union id, and so does a removed node, unless the later version gives its id to
 * another node; it is then `id@before` (docs/algorithms.md, "Hunk ids"). So `id` names the later
 * version's node when there is one, else the earlier version's: the hunk of `id`, else of
 * `id@before`. A node whose id changed between the versions is named by its later id. O(1).
 */
export function hunkOfNode(scene: Pick<Scene, 'nodes' | 'nodeIndex'>, id: string): number {
  const i = scene.nodeIndex.get(id) ?? scene.nodeIndex.get(`${id}@before`);
  return i === undefined ? -1 : (scene.nodes[i]?.hunk ?? -1);
}

<script lang="ts">
import '@kgdiff/viewer';
import type { GraphSource, KgdiffViewerElement, ViewerPanels } from '@kgdiff/viewer';

interface Props {
  before: GraphSource;
  after: GraphSource;
  onselect: (hunk: string | null) => void;
}

let { before, after, onselect }: Props = $props();
let viewer = $state<KgdiffViewerElement>();
const panels: ViewerPanels = { detail: 'collapsed' };

$effect(() => {
  void viewer?.load({ before, after });
});
</script>

<kgdiff-viewer
  bind:this={viewer}
  theme="auto"
  {panels}
  keymap={{ x: null, r: 'review' }}
  style="height: 640px"
  onkgdiff-select={(event: CustomEvent<{ hunk: string | null }>) => onselect(event.detail.hunk)}
></kgdiff-viewer>
